/**
 * ZKTeco Bridge Service
 * Conexión DIRECTA a los relojes biométricos — sin depender del
 * ZK Attendance Management Program.
 *
 * Relojes configurados:
 *   - Reloj test:   x.x.x.x:4370  (3000T-C/ID, MachineNo: 101)
 *
 * Modos de operación:
 *   1. PUSH  — El reloj envía marcajes en tiempo real (puerto 8080)
 *   2. POLL  — El Bridge jala datos del reloj cada N segundos (ZKLib)
 */

require('dotenv').config();
const express = require('express');
const { createClient } = require('redis');
const winston = require('winston');
const { buildPushStatusFor } = require('./pushStatusContract');

const { syncDevice, connectToDevice, getDeviceUsers, diagnoseDevice } = require('./zkManager');
const { startPushServer, pushState, resolvePushPort } = require('./pushServer');
const { discoverSubnet, probeHost }  = require('./discovery');

// ─── Logger ─────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level}] ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// ─── Relojes configurados ───────────────────────────────────────
// La resolución y la validación viven en deviceRegistry.js, que además
// documenta la fuente canónica actual (entorno, NO MySQL).
//
// Acá había un DEFAULT_DEVICES con un "Reloj test" que se usaba cuando faltaba
// ZKTECO_DEVICES. Un Bridge de producción no puede inventar un dispositivo:
// /health informaba `devices: 1` sin que existiera ningún reloj.
const { resolveDevices, buildHealth, configurationSummary, PROBLEM } = require('./deviceRegistry');

// ─── Redis ──────────────────────────────────────────────────────
let redis;

async function initRedis() {
  redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  redis.on('error', err => logger.error('Redis: ' + err.message));
  await redis.connect();
  logger.info('✅ Redis conectado');
}

// ─── Publicar evento de asistencia en tiempo real ───────────────
// Escribe SIEMPRE al stream durable (log capado, replayable ante caídas del
// core) y publica al canal pub/sub (consumo clásico en tiempo real). El core
// decide cuál consumir según ATTENDANCE_STREAM_ENABLED; el bridge alimenta
// ambos para que el cambio de modo no requiera tocar el bridge.
async function publishAttendance(event) {
  if (!redis?.isReady) return;
  const payload = JSON.stringify(event);
  try {
    // MAXLEN aproximado (~10k) para acotar memoria del stream.
    await redis.xAdd('stream:attendance', '*', { payload }, { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 10000 } });
  } catch (err) {
    logger.error('No se pudo escribir en stream:attendance: ' + err.message);
  }
  await redis.publish('attendance:new', payload);
  logger.info(`📡 Marcaje: ${event.deviceName || event.deviceIp} | Empleado: ${event.employeeCode} | ${event.timestamp}`);
}

async function publishDeviceStatus(device, status, error = null) {
  if (!redis?.isReady) return;
  await redis.publish('device:status', JSON.stringify({
    deviceId:   device.id,
    deviceName: device.name,
    ip:         device.ip,
    status,
    error,
    lastSeen:   new Date().toISOString()
  }));

  // Cache del estado en Redis para el dashboard
  await redis.set(
    `device:status:${device.id}`,
    JSON.stringify({ status, lastSeen: new Date().toISOString(), error }),
    { EX: 120 }
  );
}

// ─── Estado de sincronización por reloj ─────────────────────────
const deviceState = {};  // { [deviceId]: { lastSync, newRecords } }

// ─── Polling de un reloj ─────────────────────────────────────────
async function pollDevice(device) {
  const lastSync = deviceState[device.id]?.lastSync;
  try {
    logger.info(`🔄 Polling ${device.name} (${device.ip})...`);
    const records = await syncDevice(device, lastSync);

    if (records.length > 0) {
      logger.info(`✅ ${device.name}: ${records.length} marcaje(s) nuevos`);
      deviceState[device.id] = { lastSync: new Date().toISOString(), newRecords: records.length };

      for (const r of records) {
        await publishAttendance({
          employeeCode: String(r.userId),
          timestamp:    new Date(r.timestamp).toISOString(),
          deviceId:     device.id,
          deviceName:   device.name,
          deviceIp:     device.ip,
          type:         mapZKState(r.state),
          raw:          r
        });
      }
    } else {
      logger.info(`${device.name}: sin cambios nuevos`);
      deviceState[device.id] = { ...deviceState[device.id], lastSync: new Date().toISOString() };
    }

    await publishDeviceStatus(device, 'online');
  } catch (err) {
    logger.error(`❌ Error en ${device.name}: ${err.message}`);
    await publishDeviceStatus(device, 'offline', err.message);
  }
}

// ZKTeco punch_state:
//   0 = Check In (entrada)
//   1 = Check Out (salida)
//   2 = Break Out
//   3 = Break In
//   4 = Overtime In
//   5 = Overtime Out
function mapZKState(state) {
  const map = { 0: 'in', 1: 'out', 2: 'break_start', 3: 'break_end', 4: 'in', 5: 'out' };
  return map[state] ?? 'unknown';
}

// ─── API HTTP del Bridge (health + status) ──────────────────────
function startBridgeApi(devices, resolution) {
  const app = express();
  app.use(express.json());

  // Health check — sin autenticación, así que sin IP, sin serial y sin nombres
  // de reloj: es lo primero que ve cualquiera que alcance el puerto.
  //
  // Devuelve 200 incluso degradado: el proceso ESTÁ vivo, y lo que falta es
  // configuración. Un 503 acá haría que /api/health/detailed reportara el
  // bridge como inalcanzable, que es un diagnóstico distinto y equivocado.
  app.get('/health', (req, res) => {
    res.json(buildHealth(resolution, {
      pushEnabled: true,
      // Mismo resolvedor que usa el servidor PUSH: si divergieran, /health
      // anunciaría un puerto en el que nadie escucha.
      pushPort: resolvePushPort(),
    }));
  });

  // ── Autenticación de la API del bridge ──────────────────────────
  // La API del bridge controla hardware y escanea la LAN; debe estar
  // protegida. Se exige la cabecera `x-api-key` == BRIDGE_API_KEY en
  // todas las rutas salvo /health. Si la clave no está configurada, se
  // registra una advertencia y se deniega (fail-closed) para no exponer
  // el control de relojes ni el escaneo de subred.
  const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
  if (!BRIDGE_API_KEY) {
    logger.error('⚠️  BRIDGE_API_KEY no configurada: la API del bridge rechazará todas las peticiones (excepto /health).');
  }
  app.use((req, res, next) => {
    const provided = req.get('x-api-key');
    if (BRIDGE_API_KEY && provided && provided === BRIDGE_API_KEY) return next();
    return res.status(401).json({ error: 'No autorizado' });
  });

  // Estado de los relojes
  app.get('/devices', (req, res) => {
    res.json(devices.map(d => ({
      ...d,
      state: deviceState[d.id] || { status: 'unknown' }
    })));
  });

  // Forzar sync inmediato de un reloj
  app.post('/devices/:id/sync', async (req, res) => {
    const device = devices.find(d => d.id == req.params.id);
    if (!device) return res.status(404).json({ error: 'Reloj no encontrado' });
    pollDevice(device).catch(() => {});
    res.json({ message: `Sync iniciado en ${device.name}` });
  });

  // Probar conectividad con un reloj
  // Body opcional: { connection_mode, comm_password, timeout_ms, port }
  // — permite probar parámetros sin guardar
  app.get('/devices/:id/ping', async (req, res) => {
    const device = devices.find(d => d.id == req.params.id);
    if (!device) return res.status(404).json({ error: 'Reloj no encontrado' });
    const result = await connectToDevice({ ...device, ...(req.query || {}) });
    res.json({ device: device.name, ...result });
  });

  app.post('/devices/:id/ping', async (req, res) => {
    const device = devices.find(d => d.id == req.params.id);
    if (!device) return res.status(404).json({ error: 'Reloj no encontrado' });
    const result = await connectToDevice({ ...device, ...(req.body || {}) });
    res.json({ device: device.name, ...result });
  });

  // Diagnóstico detallado paso a paso
  app.post('/devices/:id/diagnose', async (req, res) => {
    const device = devices.find(d => d.id == req.params.id);
    if (!device) return res.status(404).json({ error: 'Reloj no encontrado' });
    try {
      const report = await diagnoseDevice({ ...device, ...(req.body || {}) });
      res.json({ device: device.name, ...report });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Diagnóstico "ad-hoc" por IP directa (sin device registrado)
  // Body: { ip, port?, connection_mode?, comm_password?, timeout_ms? }
  app.post('/diagnose', async (req, res) => {
    const { ip, port, connection_mode, comm_password, timeout_ms } = req.body || {};
    if (!ip) return res.status(400).json({ error: 'ip requerido' });
    try {
      const report = await diagnoseDevice({ ip, port, connection_mode, comm_password, timeout_ms });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── LAN Discovery ────────────────────────────────────────────────
  // GET  /discovery?subnet=172.16.20&port=4370  — escanea la subred
  // POST /discovery/probe   { ip, port? }       — probar una IP puntual
  app.get('/discovery', async (req, res) => {
    const subnet = req.query.subnet || process.env.DISCOVERY_SUBNET;
    const port   = parseInt(req.query.port || '4370', 10);
    if (!subnet) return res.status(400).json({ error: 'Parámetro subnet requerido (ej: 172.16.20)' });
    const progress = [];
    try {
      const found = await discoverSubnet(subnet, port, (done, total) => {
        progress.push({ done, total });
      });
      res.json({ ok: true, subnet, port, found, scanned: 254, total_found: found.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/discovery/probe', async (req, res) => {
    const { ip, port = 4370 } = req.body || {};
    if (!ip) return res.status(400).json({ error: 'ip requerido' });
    const result = await probeHost(ip, port);
    res.json({ ok: true, reachable: !!result, ...(result || { ip, port }) });
  });

  // Estado de los relojes vía PUSH ADMS (últimos heartbeats/marcajes recibidos)
  app.get('/push-state', (req, res) => {
    res.json(pushState);
  });

  // Contrato explícito con la API — ver docs/bridge-push-status-contract.md.
  // Se consulta por serial o IP, no por id: el id del Bridge sale de la
  // posición dentro de ZKTECO_DEVICES y no tiene relación con devices.id
  // de MySQL, así que preguntar por id sólo acertaba por casualidad.
  app.get('/push-status', (req, res) => {
    const serial = (req.query.serial || '').toString().trim();
    const ip     = (req.query.ip || '').toString().trim();
    if (!serial && !ip) {
      return res.status(400).json({ error: 'serial o ip requerido' });
    }

    // Ésta es la ruta que consume la API (fetchPushStatus), no la heredada
    // /devices/:id/push-state. Sin esta comprobación acá, un Bridge sin
    // relojes respondía 200 con found:false y la API informaba "never_seen":
    // el operador leía "el reloj nunca se vio" cuando el problema real es que
    // no hay ningún reloj configurado.
    const faltaConfig = configurationSummary(resolution);
    if (faltaConfig) return res.status(503).json({ error: 'Bridge sin configurar', ...faltaConfig });

    res.json(buildPushStatusFor(pushState, { serial, ip }));
  });

  app.get('/devices/:id/push-state', (req, res) => {
    // "No hay relojes configurados" y "ese reloj no existe" son diagnósticos
    // distintos, y devolver 404 para los dos manda a buscar el problema al
    // lugar equivocado.
    const faltaConfig = configurationSummary(resolution);
    if (faltaConfig) return res.status(503).json({ error: 'Bridge sin configurar', ...faltaConfig });

    const device = devices.find(d => d.id == req.params.id);
    if (!device) return res.status(404).json({ error: 'Reloj no encontrado' });
    // Buscar por IP del dispositivo — el SN del reloj registrado debe coincidir o la IP
    const byIp = Object.entries(pushState).find(([sn, s]) => s.ip === device.ip);
    const state = byIp ? { sn: byIp[0], ...byIp[1] } : null;
    res.json({ device: device.name, ip: device.ip, state });
  });

  // Obtener usuarios registrados en un reloj
  app.get('/devices/:id/users', async (req, res) => {
    const device = devices.find(d => d.id == req.params.id);
    if (!device) return res.status(404).json({ error: 'Reloj no encontrado' });
    const users = await getDeviceUsers(device);
    res.json({ device: device.name, users, total: users.length });
  });

  // Puerto 8081 para la API del bridge (8080 es el servidor PUSH de los relojes).
  // Bind a loopback por defecto: la API la consume el core en el mismo host.
  // Configurable con BRIDGE_API_PORT / BRIDGE_BIND para topologías distintas.
  const PORT = parseInt(process.env.BRIDGE_API_PORT || '8081', 10);
  const BIND = process.env.BRIDGE_BIND || '127.0.0.1';
  app.listen(PORT, BIND, () => logger.info(`🌐 Bridge API en ${BIND}:${PORT}`));
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  await initRedis();

  const resolution = resolveDevices(process.env);
  const devices = resolution.devices;

  logger.info(`\n${'═'.repeat(50)}`);
  logger.info('🕐 ZKTeco Bridge — Sistema de Asistencia');
  logger.info(`${'═'.repeat(50)}`);

  // Los problemas de configuración se dicen en voz alta. El arranque silencioso
  // con un reloj inventado es exactamente lo que este módulo vino a eliminar.
  for (const p of resolution.problems) {
    const detalle = p.detail ? ` (${p.detail})` : '';
    const entrada = p.entry !== undefined ? ` [entrada ${p.entry + 1}]` : '';
    if (p.code === PROBLEM.TEST_DEVICE_IN_PRODUCTION) {
      logger.error('❌ BRIDGE_ALLOW_TEST_DEVICE=true ignorado: no se admite un reloj ficticio con NODE_ENV=production.');
    } else {
      logger.error(`❌ ZKTECO_DEVICES${entrada}: ${p.code}${detalle}`);
    }
  }

  if (devices.length === 0) {
    logger.error('❌ Sin relojes configurados. El Bridge queda DEGRADADO:');
    logger.error('   • /health responde status=degraded y configured_devices=0');
    logger.error('   • no se intenta ninguna conexión a ningún reloj');
    logger.error('   • configurar ZKTECO_DEVICES en bridge/.env, por ejemplo:');
    logger.error('     ZKTECO_DEVICES=Gerencia@10.0.0.11:4370,Comedor@10.0.0.12:4370');
  } else {
    // El nombre y el puerto alcanzan para operar; la IP completa no se escribe
    // en un log que se rota y se comparte.
    devices.forEach(d => logger.info(
      `  📍 ${d.name.padEnd(18)} puerto ${d.port}${d.test ? '  (FICTICIO — sólo desarrollo)' : ''}`));
  }
  logger.info(`   fuente: ${resolution.source} · relojes: ${devices.length}`);
  logger.info('');

  // Modo 1: Servidor PUSH (relojes envían datos en tiempo real)
  startPushServer(publishAttendance, logger, { redis });

  // Watcher: detectar relojes caídos y publicar alerta
  const HEARTBEAT_ALERT_MS = parseInt(process.env.HEARTBEAT_ALERT_MS || String(15 * 60 * 1000));
  const alertedDown = new Set();
  setInterval(async () => {
    const now = Date.now();
    for (const [sn, state] of Object.entries(pushState)) {
      const last = state.lastSeen ? new Date(state.lastSeen).getTime() : 0;
      const downtime = now - last;
      if (downtime > HEARTBEAT_ALERT_MS && !alertedDown.has(sn)) {
        alertedDown.add(sn);
        logger.error(`🚨 Reloj SN=${sn} (${state.ip}) sin heartbeat hace ${Math.round(downtime/60000)} min`);
        if (redis?.isReady) {
          await redis.publish('device:alert', JSON.stringify({
            type: 'heartbeat_lost', sn, ip: state.ip,
            lastSeen: state.lastSeen, downtimeMs: downtime
          })).catch(() => {});
        }
      } else if (downtime < HEARTBEAT_ALERT_MS && alertedDown.has(sn)) {
        alertedDown.delete(sn);
        logger.info(`✅ Reloj SN=${sn} (${state.ip}) recuperado`);
        if (redis?.isReady) {
          await redis.publish('device:alert', JSON.stringify({
            type: 'heartbeat_recovered', sn, ip: state.ip
          })).catch(() => {});
        }
      }
    }
  }, 60000); // chequear cada minuto

  // Modo 2: Polling periódico por ZKLib
  // DESACTIVADO por defecto — requiere ZKTECO_AUTO_POLL=true en .env
  // El protocolo ZKTeco solo admite UNA conexión TCP simultánea.
  // Con polling activo, la API no puede conectar a los relojes bajo demanda.
  // Sin relojes no se hace polling: no hay a dónde conectarse. Antes, con el
  // reloj inventado, esto abría sockets contra una IP que no es de nadie.
  const autoPoll = process.env.ZKTECO_AUTO_POLL === 'true' && devices.length > 0;
  if (process.env.ZKTECO_AUTO_POLL === 'true' && devices.length === 0) {
    logger.error('⏸️  Auto-polling pedido pero no hay relojes configurados: no se inicia.');
  }
  if (autoPoll) {
    const intervalMs = parseInt(process.env.ZKTECO_POLL_INTERVAL || '60000');
    logger.info(`🔁 Auto-polling activo cada ${intervalMs / 1000}s vía ZKLib`);
    for (let i = 0; i < devices.length; i++) {
      setTimeout(() => pollDevice(devices[i]), i * 5000);
    }
    setInterval(async () => {
      for (const device of devices) {
        await pollDevice(device).catch(() => {});
      }
    }, intervalMs);
  } else {
    logger.info('⏸️  Auto-polling desactivado (ZKTECO_AUTO_POLL=true para activar)');
    logger.info('   Los relojes se conectan bajo demanda desde la UI.');
  }

  // API del Bridge
  startBridgeApi(devices, resolution);
}

main().catch(err => {
  logger.error('Error fatal: ' + err.message);
  process.exit(1);
});
