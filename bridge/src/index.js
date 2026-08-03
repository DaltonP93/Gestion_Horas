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

const { syncDevice, connectToDevice, getDeviceUsers, diagnoseDevice } = require('./zkManager');
const { startPushServer, pushState } = require('./pushServer');
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

// ─── Relojes configurados (se pueden sobreescribir con ZKTECO_DEVICES) ──
const DEFAULT_DEVICES = [
  { id: 101, name: 'Reloj test',  ip: 'x.x.x.x', port: 4370 },
];

function getDevices() {
  const envDevices = process.env.ZKTECO_DEVICES;
  if (envDevices) {
    return envDevices.split(',').map((entry, idx) => {
      const [ip, port] = entry.trim().split(':');
      return { id: idx + 1, name: `Reloj ${idx + 1}`, ip, port: parseInt(port || '4370') };
    });
  }
  return DEFAULT_DEVICES;
}

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
function startBridgeApi(devices) {
  const app = express();
  app.use(express.json());

  // Health check (sin autenticación — solo expone conteo de relojes)
  app.get('/health', (req, res) => {
    res.json({
      status:    'ok',
      devices:   devices.length,
      timestamp: new Date().toISOString()
    });
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

  app.get('/devices/:id/push-state', (req, res) => {
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

  const devices = getDevices();
  logger.info(`\n${'═'.repeat(50)}`);
  logger.info('🕐 ZKTeco Bridge — Sistema de Asistencia');
  logger.info(`${'═'.repeat(50)}`);
  devices.forEach(d => logger.info(`  📍 ${d.name.padEnd(18)} ${d.ip}:${d.port}`));
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
  const autoPoll = process.env.ZKTECO_AUTO_POLL === 'true';
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
  startBridgeApi(devices);
}

main().catch(err => {
  logger.error('Error fatal: ' + err.message);
  process.exit(1);
});
