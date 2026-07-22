/**
 * devices.js
 * CRUD de relojes biométricos ZKTeco + operaciones directas.
 */
const router  = require('express').Router();
const net     = require('net');
const { authenticate, authorize, requireSuperAdmin } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const { reprocessUnmapped, linkEmployeeDevice } = require('../services/deviceMapping');
const audit = require('../services/audit');

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

  // Paso 4 — Comm Key. IMPORTANTE: node-zklib NO envía la commkey (CMD_AUTH) al
  // conectar; sólo manda CMD_CONNECT vacío. Si el reloj TIENE contraseña de
  // comunicación, acepta el socket pero rechaza los comandos → TIMEOUT_ON_WRITING.
  // Es decir: por PULL no se puede leer un reloj con Comm Key activa.
  const commKeyTimeout = !tcpZk.ok && !udpZk.ok &&
    /TIMEOUT_ON_WRITING|timeout/i.test(`${tcpZk.err || ''} ${udpZk.err || ''}`);
  result.steps.push({
    step: 'comm_key',
    ok: !result.has_commkey && !commKeyTimeout,
    detail: result.has_commkey
      ? 'Hay comm_password configurada en SisHoras, pero la lectura por PULL (node-zklib) NO autentica Comm Key.'
      : (commKeyTimeout
        ? 'El patrón de error (socket OK + TIMEOUT_ON_WRITING) es típico de reloj con Comm Key activa o tomado por Attendance Management.'
        : 'Sin indicios de bloqueo por Comm Key.'),
  });

  // Paso 5 — Disponibilidad PUSH/ADMS (vía bridge). Para GT200/Granding con
  // Push Service + ADMS, la vía recomendada es que el reloj EMPUJE las marcas a
  // SisHoras en vez de leerlas por pull.
  const push = await (async () => {
    const bridgeUrl = process.env.BRIDGE_URL || 'http://localhost:8081';
    try {
      const r = await fetch(`${bridgeUrl}/devices/${device.id}/push-state`, { signal: AbortSignal.timeout(4000) });
      if (r.status === 401 || r.status === 403) {
        return { available: null, protected: true, detail: `El endpoint push-state del bridge está protegido (${r.status}); no bloquea la lectura directa. Para verlo, el bridge necesita exponer un health público o un token interno.` };
      }
      if (!r.ok) return { available: false, detail: `bridge respondió ${r.status}` };
      const payload = await r.json();
      const st = payload?.state || null;
      const lastSeen = st?.lastSeen ? new Date(st.lastSeen) : null;
      const active = lastSeen && (Date.now() - lastSeen.getTime()) < 10 * 60 * 1000;
      return { available: true, pushing: !!active, lastSeen: st?.lastSeen || null, sn: st?.sn || null };
    } catch (e) {
      return { available: false, detail: 'bridge no disponible (' + (e.message || e) + ')' };
    }
  })();
  result.push = push;
  result.steps.push({
    step: 'push_adms',
    ok: !!push.pushing,
    detail: push.pushing ? `El reloj está EMPUJANDO marcas (last seen ${push.lastSeen})`
      : push.available ? 'El bridge PUSH está disponible pero este reloj no está empujando todavía.'
        : `PUSH no verificable: ${push.detail || 'bridge no disponible'}`,
  });

  // Recomendación
  if (tcpZk.ok && udpZk.ok) {
    result.recommendation = 'TCP y UDP responden. Use connection_mode=auto o tcp (recomendado).';
  } else if (tcpZk.ok) {
    result.recommendation = 'Solo TCP responde. Configure connection_mode=tcp.';
  } else if (udpZk.ok) {
    result.recommendation = 'Solo UDP responde (típico en modelos antiguos como GT200). Configure connection_mode=udp.';
  } else {
    // Ningún handshake ZKTeco responde: pull inviable si hay Comm Key.
    result.recommendation =
      'TCP acepta socket pero ningún handshake ZKTeco responde. En este modelo (GT200/Granding) las causas más probables son: '
      + '(1) Comm Key (contraseña de comunicación) activa en el reloj — node-zklib NO la autentica, así que por PULL no se puede leer: '
      + 'quitá la Comm Key en el reloj (Menú → Comunicación → Seguridad) o dejala en 0; '
      + '(2) otro software (Attendance Management) tomó la sesión — cerralo; '
      + '(3) usar la vía PUSH/ADMS: el reloj ya tiene Push Service + ADMS — configurá "Ajustes Servidor Cloud" del reloj apuntando a SisHoras '
      + `(host del bridge, puerto ${process.env.BRIDGE_PUSH_PORT || '8080'}) para que EMPUJE las marcas sin depender del pull.`;
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

// Lectura directa de relojes: lógica en services/zktecoReader.js (compartida
// con el script scripts/read-zkteco-now.js).
const { backupDeviceDirect, backupAllDevices } = require('../services/zktecoReader');

// Normaliza el rango pedido (from/to en 'YYYY-MM-DD'); default: últimos 3 días.
function readRange(req) {
  const b = { ...req.query, ...req.body };
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const to = isDate(b.to) ? b.to : new Date().toISOString().slice(0, 10);
  const from = isDate(b.from) ? b.from : new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  return { from, to };
}

// Intentos de lectura por reloj (mitiga buffers inestables). Default 2 desde la
// UI para no exceder el timeout de Nginx; configurable por body/query.
function readAttempts(req) {
  const raw = parseInt((req.body && req.body.attempts) ?? req.query.attempts, 10);
  if (isNaN(raw)) return 2;
  return Math.min(5, Math.max(1, raw));
}

// POST /api/devices/:id/backup — lectura directa del reloj → SisHoras.
// Body/query: { from, to } (rango en hora Paraguay), push_att2000 (legacy).
router.post('/:id/backup', authorize('admin','gestor'), async (req, res) => {
  const [[device]] = await sequelize.query('SELECT * FROM devices WHERE id=?', { replacements: [req.params.id] });
  if (!device) return res.status(404).json({ error: 'Reloj no encontrado' });
  if (!device.ip_address || !String(device.ip_address).trim()) {
    return res.status(400).json({ error: 'El reloj no tiene IP configurada (no operativo).' });
  }
  const pushAtt2000 = req.query.push_att2000 === 'true' || req.body.push_att2000 === true;
  const { from, to } = readRange(req);
  try {
    const report = await backupDeviceDirect(device, { from, to, pushAtt2000, recalc: true, attempts: readAttempts(req) });
    res.json({ ok: true, from, to, ...report });
  } catch (err) {
    // Siempre JSON, incluso ante error/timeout del reloj.
    res.status(200).json({ ok: false, device_id: device.id, device: device.name, from, to, error: fmtErr(err) });
  }
});

// POST /api/devices/backup-all — leer TODOS los relojes válidos → SisHoras.
// Procesa uno por uno con timeout por reloj; si uno falla, sigue con los demás
// y SIEMPRE devuelve JSON con el resultado parcial por reloj.
// Para lecturas largas usar el script scripts/read-zkteco-now.js (sin Nginx).
router.post('/backup-all', authorize('admin','gestor'), async (req, res) => {
  const { from, to } = readRange(req);
  try {
    const out = await backupAllDevices({ from, to, recalc: true, readTimeoutMs: 45000, attempts: readAttempts(req) });
    res.json({ ok: true, from, to, ...out });
  } catch (err) {
    res.status(200).json({ ok: false, from, to, error: fmtErr(err) });
  }
});

// GET /api/devices/unmapped — marcas crudas SIN empleado (staging), agrupadas
// por (reloj, device_user_id). Query: { from, to, device_id }.
router.get('/unmapped', authorize('admin','gestor','hr'), async (req, res) => {
  const { buildEmployeeMatcher } = require('../services/zktecoReader');
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const where = ["r.mapping_status = 'unmapped'"];
  const repl = [];
  if (isDate(req.query.from)) { where.push('r.record_time_py >= ?'); repl.push(`${req.query.from} 00:00:00`); }
  if (isDate(req.query.to))   { where.push('r.record_time_py <= ?'); repl.push(`${req.query.to} 23:59:59`); }
  if (req.query.device_id)    { where.push('r.device_id = ?'); repl.push(parseInt(req.query.device_id, 10)); }
  try {
    const [rows] = await sequelize.query(
      `SELECT r.device_id, d.name AS device_name, r.device_user_id,
              MIN(r.user_sn) AS user_sn, COUNT(*) AS marcas,
              MIN(r.record_time_py) AS first_py, MAX(r.record_time_py) AS last_py
       FROM raw_device_punches r
       LEFT JOIN devices d ON d.id = r.device_id
       WHERE ${where.join(' AND ')}
       GROUP BY r.device_id, d.name, r.device_user_id
       ORDER BY marcas DESC LIMIT 500`,
      { replacements: repl }
    );
    const matcher = await buildEmployeeMatcher();
    const items = rows.map(r => {
      const alt = matcher.any.get(String(r.device_user_id));
      return { ...r, candidate: alt ? { id: alt.id, via: alt.via, status: alt.status } : null };
    });
    // Totales para la cabecera: acumuladas vs recibidas HOY (hora Paraguay).
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Asuncion' }).format(new Date());
    const [[tot]] = await sequelize.query(
      `SELECT COUNT(*) AS marks, SUM(LEFT(r.record_time_py, 10) = ?) AS today_marks
       FROM raw_device_punches r WHERE ${where.join(' AND ')}`,
      { replacements: [today, ...repl] }
    );
    res.json({
      ok: true, count: items.length, items,
      totals: { marks: Number(tot?.marks) || 0, today: Number(tot?.today_marks) || 0 },
    });
  } catch (err) {
    res.status(200).json({ ok: false, error: fmtErr(err) });
  }
});

// POST /api/devices/map — vincular un deviceUserId a un empleado (crea/activa
// employee_device_map) y reprocesa las marcas crudas de ese usuario.
// Body: { employee_id, device_user_id, device_id? }.
router.post('/map', authorize('admin','gestor'), async (req, res) => {
  const employeeId = parseInt(req.body.employee_id, 10);
  const deviceUserId = String(req.body.device_user_id || '').trim();
  const deviceId = req.body.device_id != null && req.body.device_id !== '' ? parseInt(req.body.device_id, 10) : null;
  if (isNaN(employeeId) || !deviceUserId) {
    return res.status(400).json({ error: 'employee_id y device_user_id son obligatorios.' });
  }
  try {
    const [[emp]] = await sequelize.query("SELECT id, status FROM employees WHERE id=?", { replacements: [employeeId] });
    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado.' });
    const summary = await linkEmployeeDevice({ employeeId, deviceUserId, deviceId, createdBy: req.user?.id || null });
    audit.log({ req, user: req.user, action: 'biometric.link', entity: 'employee', entity_id: employeeId,
      details: { device_user_id: deviceUserId, device_id: deviceId, ...summary } });
    res.json({ ok: true, employee_id: employeeId, device_user_id: deviceUserId, ...summary });
  } catch (err) {
    res.status(200).json({ ok: false, error: fmtErr(err) });
  }
});

// POST /api/devices/reprocess-unmapped — reprocesar marcas sin empleado por rango.
router.post('/reprocess-unmapped', authorize('admin','gestor'), async (req, res) => {
  const { from, to } = readRange(req);
  try {
    const summary = await reprocessUnmapped({ from, to });
    res.json({ ok: true, from, to, ...summary });
  } catch (err) {
    res.status(200).json({ ok: false, from, to, error: fmtErr(err) });
  }
});

// GET /api/devices/coverage-today — cobertura por reloj para HOY (hora Paraguay).
// Read-only: marcas/empleados importados por reloj + salud (last_sync, 0 marcas).
// Sirve para NO dar la impresión de que el total del día es completo si algún
// reloj no fue leído.
function _todayPY() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Asuncion' }).format(new Date());
}
router.get('/coverage-today', authorize('admin','gestor','hr'), async (req, res) => {
  const today = _todayPY();
  try {
    const [rows] = await sequelize.query(`
      SELECT d.id, d.name, d.ip_address, d.status, d.last_sync,
             COUNT(al.id)                    AS marks_today,
             COUNT(DISTINCT al.employee_id)  AS employees_today,
             MAX(al.timestamp)               AS last_mark
      FROM devices d
      LEFT JOIN attendance_logs al ON al.device_id = d.id AND DATE(al.timestamp) = ?
      WHERE d.ip_address IS NOT NULL AND TRIM(d.ip_address) <> ''
      GROUP BY d.id, d.name, d.ip_address, d.status, d.last_sync
      ORDER BY d.id
    `, { replacements: [today] });

    const STALE_MS = 26 * 3600 * 1000;  // ~26h sin sincronizar = sospechoso
    const now = Date.now();
    const devices = rows.map(r => {
      const marks = Number(r.marks_today) || 0;
      const lastSyncMs = r.last_sync ? new Date(r.last_sync).getTime() : null;
      const stale = !lastSyncMs || (now - lastSyncMs) > STALE_MS;
      const suspect = marks === 0 || stale || r.status === 'error';
      return {
        id: r.id, name: r.name, ip: r.ip_address, status: r.status,
        last_sync: r.last_sync, last_mark: r.last_mark,
        marks_today: marks, employees_today: Number(r.employees_today) || 0,
        stale, suspect,
      };
    });
    const suspects = devices.filter(d => d.suspect);
    res.json({
      ok: true, date: today,
      total_devices: devices.length,
      devices_with_marks: devices.filter(d => d.marks_today > 0).length,
      devices_suspect: suspects.length,
      complete: suspects.length === 0,   // false → el día puede estar incompleto
      devices,
    });
  } catch (err) {
    res.status(200).json({ ok: false, error: fmtErr(err) });
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

// GET /api/devices/sync-status — estado por reloj: marcas de HOY + última lectura
// registrada (device_sync_runs). Para Config → Relojes: ver si cada reloj aporta
// marcas, su último error, intentos y duración. Read-only.
router.get('/sync-status', authorize('admin','gestor','hr'), async (req, res) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Asuncion' }).format(new Date());
  try {
    // Marcas/empleados de hoy por reloj.
    const [marks] = await sequelize.query(`
      SELECT d.id,
             COUNT(al.id) AS marks_today,
             COUNT(DISTINCT al.employee_id) AS employees_today,
             MAX(al.timestamp) AS last_mark
      FROM devices d
      LEFT JOIN attendance_logs al ON al.device_id = d.id AND DATE(al.timestamp) = ?
      GROUP BY d.id
    `, { replacements: [today] });
    const marksById = new Map(marks.map(m => [m.id, m]));

    // Última corrida registrada por reloj (si existe la tabla de auditoría).
    let lastRunById = new Map();
    const [[tbl]] = await sequelize.query(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='device_sync_runs'`
    );
    if ((tbl?.n || 0) > 0) {
      const [runs] = await sequelize.query(`
        SELECT r.* FROM device_sync_runs r
        JOIN (SELECT device_id, MAX(id) AS mx FROM device_sync_runs GROUP BY device_id) t
          ON t.mx = r.id
      `);
      lastRunById = new Map(runs.map(r => [r.device_id, r]));
    }

    const [devices] = await sequelize.query(
      "SELECT id, name, ip_address, status, last_sync FROM devices WHERE ip_address IS NOT NULL AND TRIM(ip_address) <> '' ORDER BY id"
    );
    // Recomendación operativa según el error de la última lectura.
    const recommendFor = (msg) => {
      const m = String(msg || '');
      if (/TIMEOUT_ON_WRITING/i.test(m))
        return 'El reloj acepta TCP pero no responde al protocolo ZKTeco. Revisar: (1) que ningún otro software (p.ej. Attendance Management) tenga tomado el equipo, (2) contraseña de comunicación del reloj, (3) red y puerto 4370.';
      if (/ECONNREFUSED/i.test(m)) return 'Conexión rechazada: verificar IP y puerto 4370, y que el reloj esté encendido en red.';
      if (/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN/i.test(m)) return 'Reloj inalcanzable en la red: verificar IP, cableado/switch y VLAN.';
      if (/timeout/i.test(m)) return 'Sin respuesta del reloj (timeout): verificar red, puerto 4370 y que no esté tomado por otro software.';
      return null;
    };

    const STALE_MS = 26 * 3600 * 1000, now = Date.now();
    const items = devices.map(d => {
      const m = marksById.get(d.id) || {};
      const run = lastRunById.get(d.id) || null;
      const marks_today = Number(m.marks_today) || 0;
      const lastSyncMs = d.last_sync ? new Date(d.last_sync).getTime() : null;
      const stale = !lastSyncMs || (now - lastSyncMs) > STALE_MS;
      const failing = run && (run.status === 'error' || run.status === 'timeout');
      const partialRun = run && run.status === 'partial';
      return {
        id: d.id, name: d.name, ip: d.ip_address, status: d.status,
        last_sync: d.last_sync, last_mark: m.last_mark || null,
        marks_today, employees_today: Number(m.employees_today) || 0,
        stale, failing: !!failing, partial: !!partialRun,
        suspect: marks_today === 0 || stale || d.status === 'error' || !!failing || !!partialRun,
        recommendation: failing ? recommendFor(run.error_message) : null,
        last_run: run ? {
          status: run.status, started_at: run.started_at, finished_at: run.finished_at,
          imported: run.imported_count, in_range: run.in_range_count, unmapped: run.unmapped_count,
          attempts: run.attempts, attempts_requested: run.attempts_requested ?? run.attempts,
          duration_ms: run.duration_ms, error: run.error_message,
          first_valid: run.first_valid_time, last_valid: run.last_valid_time,
        } : null,
      };
    });
    res.json({ ok: true, date: today, complete: items.every(i => !i.suspect), items });
  } catch (err) {
    res.status(200).json({ ok: false, error: fmtErr(err) });
  }
});

module.exports = router;
