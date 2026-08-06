/**
 * pushServer.js
 * Servidor HTTP para recibir datos en modo PUSH desde relojes ZKTeco.
 *
 * Configuración en el reloj ZKTeco:
 *   - Comm → Cloud Server Setting (ADMS)
 *   - Server Address: IP del servidor Bridge
 *   - Server Port: 8080
 *   - HTTPS: OFF — Proxy: OFF
 *   - Reboot del reloj
 *
 * El reloj hace GET a /iclock/cdata para registrarse, luego
 * POST a /iclock/cdata con los marcajes en formato TSV (text/plain).
 */

const express = require('express');

// Estado en memoria: último heartbeat y último marcaje recibido por SN/IP
const pushState = {};   // { [sn]: { lastSeen, lastPunch, punches, ip } }

function mapZKStatus(status) {
  const n = parseInt(status);
  const map = { 0: 'in', 1: 'out', 2: 'break_start', 3: 'break_end', 4: 'in', 5: 'out' };
  return map[n] ?? 'unknown';
}

// Whitelist de SN autorizados (opcional — si está vacío, todos permitidos)
function getWhitelist() {
  const wl = process.env.ZKTECO_PUSH_WHITELIST || '';
  return wl.split(',').map(s => s.trim()).filter(Boolean);
}

function isAllowed(sn) {
  const wl = getWhitelist();
  if (wl.length === 0) return true;
  return wl.includes(String(sn));
}

/**
 * Puerto del servidor PUSH — UNA sola forma de resolverlo.
 *
 * Acá se leía `PUSH_PORT` mientras el health del Bridge leía
 * `ZKTECO_PUSH_PORT`: con la segunda definida, /health anunciaba un puerto en
 * el que nadie escuchaba. Se acepta el nombre documentado y se mantiene el
 * heredado como alias para no romper una instalación que ya lo use.
 */
function resolvePushPort(env = process.env) {
  const crudo = env.ZKTECO_PUSH_PORT || env.PUSH_PORT || '8080';
  const n = parseInt(String(crudo).trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 8080;
}

function startPushServer(publishAttendance, logger, opts = {}) {
  const { redis } = opts;
  const app = express();

  // Dedupe vía Redis SET con TTL — clave: push:dedupe:<SN>:<userId>:<timestamp>
  async function alreadySeen(sn, userId, ts) {
    if (!redis?.isReady) return false;
    const key = `push:dedupe:${sn}:${userId}:${ts}`;
    try {
      // SET NX con TTL 24 h: si la clave ya existía, devuelve null
      const set = await redis.set(key, '1', { NX: true, EX: 86400 });
      return set === null; // null = ya existía = duplicado
    } catch (e) {
      logger.warn(`dedupe Redis falló: ${e.message}`);
      return false;
    }
  }

  // ZKTeco envía payloads como text/plain; forzar parseo crudo.
  app.use('/iclock', express.text({ type: '*/*', limit: '5mb' }));

  // Registro inicial del reloj
  app.get('/iclock/cdata', (req, res) => {
    const { SN, options } = req.query;
    const ip = req.ip?.replace(/^::ffff:/, '');

    if (!isAllowed(SN)) {
      logger.warn(`⛔ SN=${SN} (${ip}) rechazado — no está en ZKTECO_PUSH_WHITELIST`);
      return res.status(403).type('text/plain').send('FORBIDDEN');
    }

    pushState[SN] = { ...(pushState[SN] || {}), lastSeen: new Date().toISOString(), ip };
    logger.info(`🔌 Reloj ZKTeco registrado vía PUSH — SN: ${SN} (${ip})`);

    res.type('text/plain').send([
      `GET OPTION FROM: ${SN}`,
      'ATTLOGStamp=None',
      'OPERLOGStamp=9999',
      'ATTPHOTOStamp=None',
      'ErrorDelay=30',
      'Delay=1',
      'TransTimes=00:00;14:05',
      'TransInterval=1',
      'TransFlag=TransData AttLog OpLog',
      'TimeZone=-3',
      'Realtime=1',
      'Encrypt=None'
    ].join('\n'));
  });

  // POST con los marcajes
  app.post('/iclock/cdata', async (req, res) => {
    const { SN, table } = req.query;
    const ip = req.ip?.replace(/^::ffff:/, '');

    if (!isAllowed(SN)) {
      return res.status(403).type('text/plain').send('FORBIDDEN');
    }

    const body = typeof req.body === 'string' ? req.body : (req.body?.toString?.() || '');
    pushState[SN] = { ...(pushState[SN] || {}), lastSeen: new Date().toISOString(), ip };

    if (table === 'ATTLOG' && body.trim()) {
      const lines = body.split(/\r?\n/).filter(Boolean);
      let parsed = 0, deduped = 0;

      for (const line of lines) {
        // ZKTeco ATTLOG: UserID \t DateTime \t Status \t Verify \t WorkCode \t Reserved1 \t Reserved2
        const parts = line.trim().split('\t');
        if (parts.length < 2) continue;

        const [userId, timestamp, status, verify, workCode] = parts;
        try {
          const ts = new Date(timestamp.trim().replace(' ', 'T'));
          if (isNaN(ts.getTime())) continue;

          // Dedupe: si ya vimos este (SN, userId, timestamp) en las últimas 24 h, saltar
          const dup = await alreadySeen(SN, userId.trim(), ts.toISOString());
          if (dup) { deduped++; continue; }

          await publishAttendance({
            employeeCode: userId.trim(),
            timestamp:    ts.toISOString(),
            deviceIp:     ip,
            deviceSn:     SN,
            deviceId:     null,
            type:         mapZKStatus(status),
            raw: {
              sn: SN, userId: userId.trim(), timestamp: timestamp.trim(),
              status: status, verify: verify, workCode: workCode
            }
          });
          parsed++;
        } catch (err) {
          logger.error(`Error parseando línea PUSH: ${line} — ${err.message}`);
        }
      }

      pushState[SN].lastPunch = new Date().toISOString();
      pushState[SN].punches = (pushState[SN].punches || 0) + parsed;
      logger.info(`📥 PUSH de SN=${SN} (${ip}): ${parsed}/${lines.length} procesados, ${deduped} duplicados`);
    }

    res.type('text/plain').send('OK');
  });

  // Heartbeat — el reloj pregunta si hay comandos pendientes
  app.get('/iclock/getrequest', (req, res) => {
    const { SN } = req.query;
    const ip = req.ip?.replace(/^::ffff:/, '');
    if (SN) pushState[SN] = { ...(pushState[SN] || {}), lastSeen: new Date().toISOString(), ip };
    res.type('text/plain').send('OK');
  });

  app.post('/iclock/devicecmd', (req, res) => {
    res.type('text/plain').send('OK');
  });

  // Endpoint interno para consultar estado PUSH (usado por la API)
  app.get('/push-state', (req, res) => res.json(pushState));

  const PUSH_PORT = resolvePushPort();
  app.listen(PUSH_PORT, () => {
    logger.info(`📡 Servidor PUSH ZKTeco escuchando en puerto ${PUSH_PORT}`);
  });

  return { pushState };
}

module.exports = { startPushServer, pushState, resolvePushPort };
