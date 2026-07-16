/**
 * devices.js
 * CRUD de relojes biométricos ZKTeco + operaciones directas.
 */
const router  = require('express').Router();
const net     = require('net');
const { authenticate, authorize, requireSuperAdmin } = require('../middleware/auth');
const { sequelize } = require('../config/database');

router.use(authenticate);

// ─── Ping TCP ─────────────────────────────────────────────────
function pingDevice(ip, port, timeout = 3000) {
  return new Promise(resolve => {
    const start  = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on('connect', () => { socket.destroy(); resolve({ status: 'online',  latency: Date.now() - start }); });
    socket.on('timeout', () => { socket.destroy(); resolve({ status: 'offline', latency: null }); });
    socket.on('error',   () => { socket.destroy(); resolve({ status: 'offline', latency: null }); });
    socket.connect(port, ip);
  });
}

// Pausa util para reintentos
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Serializar cualquier tipo de error como string legible
function fmtErr(err) {
  if (!err) return 'Error desconocido';
  // Objeto ZKLib: { err: Error, ip: string, command: string }
  if (err && typeof err === 'object' && 'command' in err) {
    const inner = err.err?.message || err.err?.code || '';
    if (err.command === 'TCP CONNECT') {
      return `No se pudo conectar al reloj${inner ? ': ' + inner : '. Verifique la red.'}`;
    }
    if (inner && inner.includes('TIMEOUT_ON_WRITING_MESSAGE') || err.message?.includes('TIMEOUT_ON_WRITING')) {
      return `El reloj aceptó la conexión TCP pero no respondió al protocolo ZKTeco [${err.command || 'CMD'}]. `
           + `Posibles causas: (1) otro software tiene la sesión activa, (2) el reloj tiene contraseña de comunicación configurada, `
           + `(3) el firmware del reloj no es compatible. Error interno: ${inner || 'TIMEOUT_ON_WRITING_MESSAGE'}`;
    }
    return `Error protocolo ZKTeco [${err.command}]${inner ? ': ' + inner : ': sin respuesta del dispositivo.'}`;
  }
  if (err.message) {
    if (err.message.includes('TIMEOUT_ON_WRITING_MESSAGE')) {
      return 'El reloj aceptó TCP pero no respondió al protocolo ZKTeco. '
           + 'Verifique: (1) ningún otro software conectado al reloj, (2) sin contraseña de comunicación configurada en el reloj.';
    }
    return err.message;
  }
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * Abre una conexión ZKTeco según el connection_mode configurado del device:
 *   - 'tcp'  → fuerza TCP (ZKLibTCP directo)
 *   - 'udp'  → fuerza UDP (ZKLibUDP directo)  — para modelos antiguos (GT200)
 *   - 'auto' → usa ZKLib que prueba TCP y cae a UDP (default)
 *
 * El cliente devuelto expone los mismos métodos que ZKLib: getInfo(),
 * getUsers(), getAttendances(), executeCmd(), disconnect(), etc.
 */
async function openZK(device) {
  const timeout = parseInt(device.timeout_ms || 12000);
  const mode = String(device.connection_mode || 'auto').toLowerCase();

  if (mode === 'udp') {
    const ZKLibUDP = require('node-zklib/zklibudp');
    const c = new ZKLibUDP(device.ip_address, device.port, timeout, 0);
    await c.createSocket();
    await c.connect();
    return c;
  }
  if (mode === 'tcp') {
    const ZKLibTCP = require('node-zklib/zklibtcp');
    const c = new ZKLibTCP(device.ip_address, device.port, timeout);
    await c.createSocket();
    await c.connect();
    return c;
  }
  // auto
  const ZKLib = require('node-zklib');
  const zk = new ZKLib(device.ip_address, device.port, timeout, 0);
  await zk.createSocket();
  return zk;
}

/**
 * Helper: conectar ZKLib, ejecutar fn, desconectar.
 * Reintenta hasta maxAttempts veces si el dispositivo está ocupado.
 */
async function withZK(device, fn, { maxAttempts = 3, delayMs = 3000 } = {}) {
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let zk;
    try {
      zk = await openZK(device);
      const result = await fn(zk);
      try { await zk.disconnect(); } catch {}
      return result;
    } catch (err) {
      if (zk) { try { await zk.disconnect(); } catch {} }
      lastErr = err;

      const msg = err?.message || err?.err?.message || '';
      const isBusy = msg.includes('TIMEOUT_ON_WRITING') || msg.includes('TIMEOUT_ON_WRITING_MESSAGE');
      const isConnRefused = msg.includes('ECONNREFUSED') || (err && 'command' in err && err.command === 'TCP CONNECT');

      if (isConnRefused) break;
      if (isBusy && attempt < maxAttempts) { await sleep(delayMs); continue; }
      break;
    }
  }

  if (lastErr && typeof lastErr === 'object' && 'command' in lastErr) {
    throw new Error(fmtErr(lastErr));
  }
  throw lastErr instanceof Error ? lastErr : new Error(fmtErr(lastErr));
}

// GET /api/devices/:id/push-status — ¿está el reloj enviando marcajes por PUSH?
router.get('/:id/push-status', authorize('admin','gestor','hr'), async (req, res) => {
  const [[device]] = await sequelize.query('SELECT * FROM devices WHERE id=?', { replacements: [req.params.id] });
  if (!device) return res.status(404).json({ error: 'Reloj no encontrado' });

  const bridgeUrl = process.env.BRIDGE_URL || 'http://localhost:8081';
  try {
    const r = await fetch(`${bridgeUrl}/devices/${device.id}/push-state`);
    if (!r.ok) throw new Error(`Bridge respondió ${r.status}`);
    const payload = await r.json();

    // Último marcaje recibido por PUSH en las últimas 24 h según attendance_logs
    const [[last]] = await sequelize.query(`
      SELECT MAX(timestamp) AS last_push
      FROM attendance_logs
      WHERE device_id = ? AND timestamp >= NOW() - INTERVAL 24 HOUR
    `, { replacements: [device.id] });

    const state = payload?.state || null;
    const lastSeen = state?.lastSeen ? new Date(state.lastSeen) : null;
    const now = Date.now();
    const activeMs = 5 * 60 * 1000;
    const pushActive = lastSeen && (now - lastSeen.getTime()) < activeMs;

    res.json({
      device: device.name,
      ip: device.ip_address,
      pushActive: !!pushActive,
      sn: state?.sn || null,
      lastSeen: state?.lastSeen || null,
      lastPunch: state?.lastPunch || null,
      punches24h: last?.last_push ? 1 : 0,
      lastPunchInDb: last?.last_push || null
    });
  } catch (err) {
    res.status(502).json({ error: `No se pudo consultar el Bridge: ${err.message}` });
  }
});

// GET/POST /api/devices/:id/diagnose — diagnóstico detallado paso a paso
// Prueba: (1) TCP socket raw, (2) handshake ZKTeco TCP, (3) handshake ZKTeco UDP
// y devuelve una recomendación de connection_mode adecuado.
// POST body opcional: { connection_mode, comm_password, timeout_ms } para probar
// parámetros sin persistirlos.
async function handleDiagnose(req, res) {
  const [[device]] = await sequelize.query('SELECT * FROM devices WHERE id=?', { replacements: [req.params.id] });
  if (!device) return res.status(404).json({ error: 'Reloj no encontrado' });

  const overrides = req.body || {};
  const ip = overrides.ip_address || device.ip_address;
  const port = parseInt(overrides.port || device.port || 4370);
  const timeout = parseInt(overrides.timeout_ms || device.timeout_ms || 8000);

  const result = {
    device: device.name,
    ip, port,
    mode_configured: overrides.connection_mode || device.connection_mode || 'auto',
    timeout_ms: timeout,
    has_commkey: !!(overrides.comm_password || device.comm_password),
    steps: [],
  };

  // Paso 1 — TCP socket raw
  const tcpOk = await pingDevice(ip, port, 3000);
  result.steps.push({ step: 'tcp_socket', ok: tcpOk.status === 'online', detail: tcpOk.status === 'online' ? `latencia ${tcpOk.latency}ms` : 'timeout/no alcanzable' });

  if (tcpOk.status !== 'online') {
    result.recommendation = 'El reloj no es alcanzable por TCP. Verificar red / firewall / que el reloj esté encendido.';
    result.summary = result.steps.map(s => `${s.ok ? '✓' : '✗'} ${s.step}`).join(' · ');
    return res.json(result);
  }

  // Paso 2 — ZKTeco TCP handshake
  const tcpZk = await (async () => {
    try {
      const ZKLibTCP = require('node-zklib/zklibtcp');
      const c = new ZKLibTCP(ip, port, Math.min(timeout, 8000));
      await c.createSocket();
      await c.connect();
      try { await c.getInfo(); } catch {}
      try { await c.disconnect(); } catch {}
      return { ok: true };
    } catch (err) {
      return { ok: false, err: err?.message || err?.err?.message || String(err) };
    }
  })();
  result.steps.push({ step: 'zkteco_tcp_handshake', ok: tcpZk.ok, detail: tcpZk.err || 'handshake TCP OK' });

  // Paso 3 — ZKTeco UDP handshake
  const udpZk = await (async () => {
    try {
      const ZKLibUDP = require('node-zklib/zklibudp');
      const c = new ZKLibUDP(ip, port, Math.min(timeout, 8000), 0);
      await c.createSocket();
      await c.connect();
      try { await c.getInfo(); } catch {}
      try { await c.disconnect(); } catch {}
      return { ok: true };
    } catch (err) {
      return { ok: false, err: err?.message || err?.err?.message || String(err) };
    }
  })();
  result.steps.push({ step: 'zkteco_udp_handshake', ok: udpZk.ok, detail: udpZk.err || 'handshake UDP OK' });

  // Recomendación
  if (tcpZk.ok && udpZk.ok) {
    result.recommendation = 'TCP y UDP responden. Use connection_mode=auto o tcp (recomendado).';
  } else if (tcpZk.ok) {
    result.recommendation = 'Solo TCP responde. Configure connection_mode=tcp.';
  } else if (udpZk.ok) {
    result.recommendation = 'Solo UDP responde (típico en modelos antiguos como GT200). Configure connection_mode=udp.';
  } else {
    result.recommendation = 'TCP acepta socket pero ningún handshake ZKTeco responde. Causas probables: '
      + '(1) otro software (Attendance Management) conectado — cerrarlo; '
      + '(2) contraseña de comunicación configurada en el reloj — ingresarla en comm_password; '
      + '(3) firmware incompatible con ZKProtocol.';
  }
  result.summary = result.steps.map(s => `${s.ok ? '✓' : '✗'} ${s.step}`).join(' · ');
  res.json(result);
}

router.get('/:id/diagnose', authorize('admin','gestor'), handleDiagnose);
router.post('/:id/diagnose', authorize('admin','gestor'), handleDiagnose);

// GET /api/devices
router.get('/', authorize('admin','gestor','hr'), async (req, res) => {
  try {
    const [rows] = await sequelize.query('SELECT * FROM devices ORDER BY name');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: fmtErr(err) }); }
});

// GET /api/devices/ping-all
router.get('/ping-all', authorize('admin','gestor','hr'), async (req, res) => {
  try {
    let [devices] = await sequelize.query('SELECT * FROM devices');
    if (!devices.length) {
      const DEFAULTS = [
        { name: 'Reloj Comedor',  ip_address: '172.16.20.160', port: 4370, location: 'Comedor' },
        { name: 'Reloj Lavadero', ip_address: '172.16.20.161', port: 4370, location: 'Lavadero' },
        { name: 'Reloj Gerencia', ip_address: '172.16.20.162', port: 4370, location: 'Gerencia' },
      ];
      for (const d of DEFAULTS) {
        await sequelize.query(
          'INSERT IGNORE INTO devices (name, ip_address, port, location) VALUES (?,?,?,?)',
          { replacements: [d.name, d.ip_address, d.port, d.location] }
        ).catch(() => {});
      }
      [devices] = await sequelize.query('SELECT * FROM devices');
    }
    const results = await Promise.all(devices.map(async d => {
      const { status, latency } = await pingDevice(d.ip_address, d.port);
      await sequelize.query(
        'UPDATE devices SET status=?, last_sync=NOW() WHERE id=?',
        { replacements: [status, d.id] }
      ).catch(() => {});
      return { ...d, status, latency };
    }));
    res.json(results);
  } catch (err) { res.status(500).json({ error: fmtErr(err) }); }
});

// Normalizar connection_mode
function normMode(m) {
  const v = String(m || '').toLowerCase().trim();
  return ['auto', 'tcp', 'udp'].includes(v) ? v : null;
}

// POST /api/devices
router.post('/', requireSuperAdmin, async (req, res) => {
  try {
    const {
      name, ip_address, port = 4370, location, serial_no,
      connection_mode, comm_password, timeout_ms,
    } = req.body;
    if (!name || !ip_address) return res.status(400).json({ error: 'Nombre e IP son requeridos' });
    const mode = normMode(connection_mode) || 'auto';
    const [result] = await sequelize.query(
      `INSERT INTO devices (name, ip_address, port, location, serial_no,
                            connection_mode, comm_password, timeout_ms)
       VALUES (?,?,?,?,?,?,?,?)`,
      {
        replacements: [
          name, ip_address, port, location || null, serial_no || null,
          mode, comm_password || null, parseInt(timeout_ms) || 10000,
        ],
      }
    );
    res.status(201).json({ id: result.insertId, message: 'Reloj agregado' });
  } catch (err) { res.status(500).json({ error: fmtErr(err) }); }
});

// PUT /api/devices/:id
router.put('/:id', requireSuperAdmin, async (req, res) => {
  try {
    const {
      name, ip_address, port, location, serial_no,
      connection_mode, comm_password, timeout_ms,
    } = req.body;
    const mode = connection_mode === undefined ? null : (normMode(connection_mode) || 'auto');
    await sequelize.query(
      `UPDATE devices SET
        name=COALESCE(?,name), ip_address=COALESCE(?,ip_address),
        port=COALESCE(?,port), location=COALESCE(?,location),
        serial_no=COALESCE(?,serial_no),
        connection_mode=COALESCE(?,connection_mode),
        comm_password=CASE WHEN ? IS NULL THEN comm_password ELSE ? END,
        timeout_ms=COALESCE(?,timeout_ms)
       WHERE id=?`,
      {
        replacements: [
          name, ip_address, port, location, serial_no,
          mode,
          comm_password === undefined ? null : (comm_password || null),
          comm_password === undefined ? null : (comm_password || null),
          timeout_ms === undefined ? null : parseInt(timeout_ms),
          req.params.id,
        ],
      }
    );
    res.json({ message: 'Reloj actualizado' });
  } catch (err) { res.status(500).json({ error: fmtErr(err) }); }
});

// DELETE /api/devices/:id
router.delete('/:id', requireSuperAdmin, async (req, res) => {
  try {
    await sequelize.query('DELETE FROM devices WHERE id=?', { replacements: [req.params.id] });
    res.json({ message: 'Reloj eliminado' });
  } catch (err) { res.status(500).json({ error: fmtErr(err) }); }
});

// GET /api/devices/invalid — relojes inválidos (sin IP): no operativos.
router.get('/invalid', authorize('admin','gestor','hr'), async (req, res) => {
  try {
    const [rows] = await sequelize.query(`
      SELECT d.id, d.name, d.ip_address, d.sensor_id, d.last_sync,
             (SELECT COUNT(*) FROM attendance_logs al WHERE al.device_id = d.id) AS logs
      FROM devices d
      WHERE d.ip_address IS NULL OR TRIM(d.ip_address) = ''
      ORDER BY d.id`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: fmtErr(err) }); }
});

// POST /api/devices/cleanup-invalid — elimina relojes sin IP que NUNCA
// sincronizaron y no tienen marcajes asociados (ej. el duplicado id=16).
// Los que sí tienen marcajes no se borran (se informan) para no perder datos.
router.post('/cleanup-invalid', requireSuperAdmin, async (req, res) => {
  try {
    const [invalid] = await sequelize.query(`
      SELECT d.id, d.name,
             (SELECT COUNT(*) FROM attendance_logs al WHERE al.device_id = d.id) AS logs
      FROM devices d
      WHERE d.ip_address IS NULL OR TRIM(d.ip_address) = ''`);
    const deletable = invalid.filter(d => Number(d.logs) === 0).map(d => d.id);
    const kept = invalid.filter(d => Number(d.logs) > 0);
    let deleted = 0;
    if (deletable.length) {
      const [r] = await sequelize.query(
        `DELETE FROM devices WHERE id IN (${deletable.map(() => '?').join(',')})`,
        { replacements: deletable });
      deleted = r?.affectedRows ?? deletable.length;
    }
    res.json({
      ok: true, deleted, deleted_ids: deletable,
      kept_with_logs: kept.map(d => ({ id: d.id, name: d.name, logs: d.logs })),
      message: `${deleted} reloj(es) inválido(s) eliminado(s).` +
        (kept.length ? ` ${kept.length} conservado(s) por tener marcajes asociados.` : ''),
    });
  } catch (err) { res.status(500).json({ error: fmtErr(err) }); }
});

// GET /api/devices/:id/info — info completa del reloj vía ZKLib
// Si el reloj está ocupado, devuelve datos parciales de la BD (no 500).
router.get('/:id/info', authorize('admin','gestor','hr'), async (req, res) => {
  const [[device]] = await sequelize.query('SELECT * FROM devices WHERE id=?', { replacements: [req.params.id] });
  if (!device) return res.status(404).json({ error: 'Reloj no encontrado' });

  // ── Datos base que siempre devolvemos (desde la BD) ──────────
  const baseInfo = {
    ok: true,
    device: device.name,
    ip: device.ip_address,
    port: device.port,
    location: device.location,
    serialNumber: device.serial_no || null,
    _source: 'db',      // indica que son datos de la BD, no en vivo
  };

  try {
    const result = await withZK(device, async zk => {
      const info = {};

      // ── 1. getInfo() — campos básicos (userCounts, logCounts, logCapacity) ──
      try {
        const basic = await zk.getInfo();
        Object.assign(info, basic);
      } catch {}

      // ── 2. CMD_GET_FREE_SIZES (50) — conteos y capacidades extendidas ──────
      // Offsets confirmados en Gerencia (3000T-C FW 6.60):
      //   24=userCounts, 32=fpCount, 40=logCounts, 44=superLogCount
      //   52=faceCount, 56=adminCount, 72=logCapacity
      //   8=freeFpSlots, 12=freeUserSlots
      try {
        const buf = await zk.executeCmd(50, '');
        const safe = (off) => {
          try { return buf.length > off + 3 ? buf.readUIntLE(off, 4) : undefined; } catch { return undefined; }
        };
        const set = (k, v) => { if (v !== undefined) info[k] = v; };

        set('fpCount',       safe(32));
        set('superLogCount', safe(44));
        set('faceCount',     safe(52));
        set('adminCount',    safe(56));

        // Capacidades = slots libres + usados
        const freeFpCount   = safe(8);
        const freeUserCount = safe(12);
        if (freeUserCount !== undefined) set('userCapacity', freeUserCount + (info.userCounts || 0));
        if (freeFpCount   !== undefined) set('fpCapacity',   freeFpCount   + (info.fpCount   || 0));
      } catch {}

      // ── 3. CMD_OPTIONS_RRQ (11) — metadata del dispositivo ───────────────
      // ZKTeco devuelve "clave=valor\0"; necesita prefijo ~ para opciones de sistema.
      const parseOptVal = (buf) => {
        const raw = buf.slice(8).toString('ascii').replace(/\0/g, '').trim();
        return raw.includes('=') ? raw.substring(raw.indexOf('=') + 1).trim() : raw;
      };

      const metaKeys = [
        [['~ProductName',  'ProductName'],       'productName'],
        [['~FirmVer',      'FirmVer'],           'firmwareVersion'],
        [['~SerialNumber', 'SerialNumber'],       'serialNumber'],
        [['~Platform',     'Platform'],           'platform'],
        [['~ZKFPVersion'],                        'fpVersion'],
        [['~Produce_Time', 'ManufactureTime'],    'manufactureTime'],
      ];
      for (const [keys, field] of metaKeys) {
        for (const key of keys) {
          if (info[field]) break;
          try {
            const buf = await zk.executeCmd(11, key);
            const val = parseOptVal(buf);
            if (val) { info[field] = val; break; }
          } catch {}
        }
      }

      return info;
    }, { maxAttempts: 3, delayMs: 3000 });

    // Guardar serial en BD si lo obtuvimos
    if (result.serialNumber && !device.serial_no) {
      sequelize.query('UPDATE devices SET serial_no=? WHERE id=?',
        { replacements: [result.serialNumber, device.id] }).catch(() => {});
    }

    res.json({ ...baseInfo, ...result, _source: 'live' });

  } catch (err) {
    const msg = fmtErr(err);
    const isBusy = msg.includes('ocupado') || msg.includes('att2000') || msg.includes('TIMEOUT');

    // Si el reloj está ocupado, devolver 200 con datos parciales de la BD
    // para que el frontend pueda mostrar algo útil
    if (isBusy) {
      return res.json({
        ...baseInfo,
        _source: 'db',
        _warning: msg,
      });
    }

    res.status(503).json({ ok: false, error: msg });
  }
});

// GET /api/devices/:id/users
router.get('/:id/users', authorize('admin','gestor'), async (req, res) => {
  const [[device]] = await sequelize.query('SELECT * FROM devices WHERE id=?', { replacements: [req.params.id] });
  if (!device) return res.status(404).json({ error: 'Reloj no encontrado' });
  try {
    const users = await withZK(device, async zk => {
      const { data } = await zk.getUsers();
      return data;
    }, { maxAttempts: 3, delayMs: 3000 });
    res.json({ device: device.name, users, total: users.length });
  } catch (err) {
    res.status(503).json({ ok: false, error: fmtErr(err) });
  }
});

// POST /api/devices/:id/backup
// Query param: ?push_att2000=true  → también escribe en att2000.CHECKINOUT
router.post('/:id/backup', authorize('admin','gestor'), async (req, res) => {
  const [[device]] = await sequelize.query('SELECT * FROM devices WHERE id=?', { replacements: [req.params.id] });
  if (!device) return res.status(404).json({ error: 'Reloj no encontrado' });

  const pushAtt2000 = req.query.push_att2000 === 'true' || req.body.push_att2000 === true;

  try {
    const logs = await withZK(device, async zk => {
      const { data } = await zk.getAttendances();
      return data;
    }, { maxAttempts: 4, delayMs: 4000 });

    let imported = 0, skipped = 0;
    for (const log of logs) {
      const checkTime = new Date(log.attTime);
      const type = log.inOutStatus === 0 ? 'in' : 'out';
      const [[emp]] = await sequelize.query(
        'SELECT id FROM employees WHERE code=? AND status="active"',
        { replacements: [String(log.deviceUserId)] }
      );
      if (!emp) { skipped++; continue; }
      const [[existing]] = await sequelize.query(
        'SELECT id FROM attendance_logs WHERE employee_id=? AND `timestamp`=? AND source="device"',
        { replacements: [emp.id, checkTime] }
      );
      if (existing) { skipped++; continue; }
      await sequelize.query(
        'INSERT INTO attendance_logs (employee_id, device_id, `timestamp`, type, source) VALUES (?,?,?,?,?)',
        { replacements: [emp.id, device.id, checkTime, type, 'device'] }
      );
      imported++;
    }
    await sequelize.query('UPDATE devices SET last_sync=NOW() WHERE id=?', { replacements: [device.id] });

    // ── Opcional: también escribir en att2000.CHECKINOUT ──────────
    let att2000Result = null;
    if (pushAtt2000 && logs.length > 0) {
      try {
        const { writeCheckinOut } = require('../config/att2000');
        // Mapear formato ZKLib → formato esperado por writeCheckinOut
        const mapped = logs.map(l => ({
          userId:      l.deviceUserId,
          attTime:     l.attTime,
          inOutStatus: l.inOutStatus,
          sensorId:    device.id,
          verifyMode:  l.verifyType ?? 0,
        }));
        att2000Result = await writeCheckinOut(mapped);
      } catch (e) {
        att2000Result = { error: e.message };
      }
    }

    res.json({ ok: true, total: logs.length, imported, skipped, att2000: att2000Result });
  } catch (err) {
    res.status(503).json({ ok: false, error: fmtErr(err) });
  }
});

// POST /api/devices/:id/clear
router.post('/:id/clear', requireSuperAdmin, async (req, res) => {
  const [[device]] = await sequelize.query('SELECT * FROM devices WHERE id=?', { replacements: [req.params.id] });
  if (!device) return res.status(404).json({ error: 'Reloj no encontrado' });
  try {
    await withZK(device, zk => zk.clearAttendanceLog(), { maxAttempts: 3, delayMs: 3000 });
    res.json({ ok: true, message: `Registros eliminados del reloj ${device.name}` });
  } catch (err) {
    res.status(503).json({ ok: false, error: fmtErr(err) });
  }
});

// POST /api/devices/:id/disable
router.post('/:id/disable', requireSuperAdmin, async (req, res) => {
  const [[device]] = await sequelize.query('SELECT * FROM devices WHERE id=?', { replacements: [req.params.id] });
  if (!device) return res.status(404).json({ error: 'Reloj no encontrado' });
  try {
    await withZK(device, zk => zk.disableDevice(), { maxAttempts: 3, delayMs: 3000 });
    res.json({ ok: true, message: `Reloj ${device.name} deshabilitado` });
  } catch (err) {
    res.status(503).json({ ok: false, error: fmtErr(err) });
  }
});

// POST /api/devices/:id/enable
router.post('/:id/enable', requireSuperAdmin, async (req, res) => {
  const [[device]] = await sequelize.query('SELECT * FROM devices WHERE id=?', { replacements: [req.params.id] });
  if (!device) return res.status(404).json({ error: 'Reloj no encontrado' });
  try {
    await withZK(device, zk => zk.enableDevice(), { maxAttempts: 3, delayMs: 3000 });
    res.json({ ok: true, message: `Reloj ${device.name} habilitado` });
  } catch (err) {
    res.status(503).json({ ok: false, error: fmtErr(err) });
  }
});

// ─── Bridge Discovery proxy ────────────────────────────────────
// Reenvía al servicio bridge para no exponer su puerto directamente.
const http = require('http');

function bridgeRequest(method, path, body, res) {
  const bridgeUrl = new URL(process.env.BRIDGE_URL || 'http://localhost:8081');
  const opts = {
    hostname: bridgeUrl.hostname,
    port:     parseInt(bridgeUrl.port || '8081'),
    path,
    method,
    headers: {
      'Content-Type': 'application/json',
      // Autenticación con la API del bridge
      ...(process.env.BRIDGE_API_KEY ? { 'x-api-key': process.env.BRIDGE_API_KEY } : {}),
    },
    timeout: 45000,
  };
  const req2 = http.request(opts, r2 => {
    let data = '';
    r2.on('data', d => data += d);
    r2.on('end', () => {
      try { res.status(r2.statusCode).json(JSON.parse(data)); }
      catch { res.status(r2.statusCode).send(data); }
    });
  });
  req2.on('error', err => res.status(502).json({ error: 'Bridge no disponible: ' + err.message }));
  req2.on('timeout', () => { req2.destroy(); res.status(504).json({ error: 'Bridge timeout' }); });
  if (body) req2.write(JSON.stringify(body));
  req2.end();
}

// GET /api/devices/bridge/discovery?subnet=X.X.X&port=4370
router.get('/bridge/discovery',
  authorize('admin', 'super_admin'),
  (req, res) => {
    const { subnet, port = '4370' } = req.query;
    if (!subnet) return res.status(400).json({ error: 'subnet requerido' });
    bridgeRequest('GET', `/discovery?subnet=${encodeURIComponent(subnet)}&port=${port}`, null, res);
  }
);

// POST /api/devices/bridge/discovery/probe
router.post('/bridge/discovery/probe',
  authorize('admin', 'super_admin'),
  (req, res) => bridgeRequest('POST', '/discovery/probe', req.body, res)
);

module.exports = router;
