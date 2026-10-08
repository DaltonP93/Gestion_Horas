'use strict';

/**
 * zkStatePilot.it.test.js — INTEGRACIÓN del piloto aislado de estados por reloj
 * (scripts/zk-raw-state-pilot.js) con procesos reales:
 *
 *   - reloj simulado por TCP real (fixtures/fakeZkTcpServer.js): node-zklib
 *     completo, decodificadores reales; se observa qué comandos llegan y cuándo
 *     se cierra cada conexión;
 *   - Redis aislado (IT_REDIS_URL) con notificaciones de keyspace: al borrarse
 *     la clave del lock se registra cuántas conexiones seguían abiertas;
 *   - MySQL aislado con general_log: TODA sentencia del piloto queda registrada
 *     (también las que fallarían), por conexión. La de lectura sólo hace su
 *     sesión READ ONLY y SELECT; la del lock sólo las cuatro sentencias de SU
 *     fila de device_locks (lock dual Redis + MySQL). Ninguna otra escritura,
 *     DDL ni auditoría, tampoco asíncrona.
 *
 * Controles negativos: el helper habitual del worker sí intenta escribir en
 * audit_events con Redis (el detector lo ve), y el camino habitual con
 * Promise.race deja la conexión abierta al vencer (por eso el piloto aísla cada
 * lectura en un proceso hijo y espera su terminación).
 *
 * Requiere IT_DB=1, IT_REDIS_URL y credenciales de administración de la MySQL
 * de pruebas (IT_DB_ADMIN_USER/IT_DB_ADMIN_PASSWORD) para general_log. Si falta
 * Redis la suite FALLA (no se omite).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const { describeIT, makeConn, cfg } = require('./helper');
const { startFakeZkTcp } = require('./fixtures/fakeZkTcpServer');
const { startFreezableProxy, RESP, MYSQL } = require('./fixtures/freezableTcpProxy');
const { STOP_GRACE_MS, CLOSE_OP_MS } = require('../../src/services/zkPilot/runPilot');
const {
  RECORDS, USER_IDS, EXPECTED_TCP40, manyRecords, CUTOFF, AFTER_CUTOFF, withAlteredBeforeCutoff, DST_RECORDS, expectedCorteHuella,
} = require('./fixtures/pilotRecords');

jest.setTimeout(300000);

const API_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(API_ROOT, 'scripts', 'zk-raw-state-pilot.js');
const COMPARE = path.join(API_ROOT, 'scripts', 'zk-raw-state-pilot-compare.js');
/** Clave de pruebas de la huella del corte (64 hex), la misma en las corridas que se comparan. */
const CORTE_KEY = 'fedcba9876543210'.repeat(4);
const EARLY = path.join(__dirname, 'fixtures', 'zklibEarlyPreload.js');
const CHILD_MARK = ['zkPilot', 'readChild.js'].join(path.sep);
const REDIS_URL = process.env.IT_REDIS_URL;
const ADMIN = { user: process.env.IT_DB_ADMIN_USER || 'root', password: process.env.IT_DB_ADMIN_PASSWORD || 'testpw' };
const READ_COMMANDS = new Set(['CMD_CONNECT', 'CMD_FREE_DATA', 'CMD_DATA_WRRQ', 'CMD_DATA_RDY', 'CMD_EXIT']);
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|LOAD|CALL|LOCK|HANDLER|IMPORT|SET\s+GLOBAL)\b/i;
const ALLOWED_RE = /^\s*(SET SESSION TRANSACTION READ ONLY|SELECT\s)/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const limits = ({ attempts = 1, timeout = 20, max = 60, cooldown = 0, renew = 1 } = {}) => [
  '--attempts', String(attempts), '--attempt-timeout', String(timeout), '--max-duration', String(max),
  '--cooldown', String(cooldown), '--renew-seconds', String(renew),
];

/**
 * Grupos de proceso de los pilotos que lanzó ESTA suite: cada piloto corre en su propio grupo
 * (spawn detached) y su proceso de lectura lo hereda, aunque el piloto muera y lo adopte init.
 */
const pilotGroups = new Set();

/** Procesos de lectura vivos de los pilotos de esta suite (por línea de comando y grupo); otros pilotos del equipo no cuentan. */
function liveReadChildren() {
  const out = [];
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmd.includes(CHILD_MARK)) continue;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const pgrp = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
      if (pilotGroups.has(pgrp)) out.push(Number(pid));
    } catch { /* proceso terminado entre la lista y la lectura */ }
  }
  return out;
}

describeIT('piloto aislado de estados por reloj (integración)', () => {
  let conn;
  let admin;
  let harnessThreads;
  let redis;
  let sub;
  let tmpDir;
  let deviceId;
  let lockKey;
  let ip;
  let server;
  let seq = 0;
  const keyEvents = [];
  const uniq = `ZKP${Date.now().toString(36).toUpperCase()}`;

  const pilotEnv = (extra = {}) => ({
    PATH: process.env.PATH,
    TZ: process.env.TZ || 'America/Asuncion',
    DB_HOST: cfg.host, DB_PORT: String(cfg.port), DB_USER: cfg.user, DB_PASSWORD: cfg.password, DB_NAME: cfg.database,
    REDIS_URL,
    ...extra,
  });

  async function useServer(opts) {
    if (server) await server.close();
    server = await startFakeZkTcp({ host: ip, ...opts });
    await conn.query('UPDATE devices SET port = ? WHERE id = ?', [server.port, deviceId]);
    return server;
  }

  /**
   * Corre el piloto como proceso real; `during(child)` actúa mientras corre.
   * Si no termina en `killAfterMs`, se mata con SIGKILL y se informa `hung`.
   */
  async function runPilot({ args, env = {}, preload = null, during = null, id = String(deviceId), killAfterMs = 120000 }) {
    seq += 1;
    const outFile = path.join(tmpDir, `out-${seq}.json`);
    const argv = [...(preload ? ['-r', preload] : []), SCRIPT, '--device-id', id, ...args, '--out', outFile];
    const t0 = Date.now();
    const child = spawn(process.execPath, argv, { cwd: API_ROOT, env: pilotEnv(env), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    pilotGroups.add(child.pid);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    let hung = false;
    const killer = setTimeout(() => { hung = true; child.kill('SIGKILL'); }, killAfterMs);
    try {
      if (during) await during(child);
    } catch (e) {
      child.kill('SIGKILL');
      throw e;
    }
    const { code, signal } = await exited;
    clearTimeout(killer);
    const json = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
    return { code, signal, json, stdout, stderr, ms: Date.now() - t0, pid: child.pid, hung };
  }

  /** Corre el helper HABITUAL del worker (deviceLock.js) en un proceso propio: adquiere, informa y libera. */
  function habitualAcquire(env = {}) {
    const code = `
      const lock = require('./src/services/deviceLock');
      (async () => {
        const h = await lock.acquire(${deviceId}, { origin: 'it-habitual' });
        process.stdout.write(JSON.stringify({ backend: h ? h.backend : null }) + '\\n');
        if (h) await lock.release(h);
        await require('./src/config/database').sequelize.close();
        process.exit(0);
      })().catch(() => { process.stdout.write(JSON.stringify({ error: true }) + '\\n'); process.exit(1); });`;
    return new Promise((resolve) => {
      const p = spawn(process.execPath, ['-e', code], { cwd: API_ROOT, env: pilotEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      p.stdout.on('data', (d) => { stdout += d; });
      p.on('exit', (c) => {
        let parsed = null;
        try { parsed = JSON.parse(stdout.trim().split('\n').pop()); } catch { /* sin salida */ }
        resolve({ code: c, ...parsed });
      });
    });
  }

  /** Corre `fn` con general_log activo y devuelve las sentencias de OTROS hilos (el piloto). */
  async function auditSql(fn) {
    await admin.query("SET GLOBAL log_output = 'TABLE'");
    await admin.query('TRUNCATE TABLE mysql.general_log');
    await admin.query("SET GLOBAL general_log = 'ON'");
    let out;
    try {
      out = await fn();
    } finally {
      await admin.query("SET GLOBAL general_log = 'OFF'");
    }
    const [rows] = await admin.query(
      "SELECT thread_id, command_type, CONVERT(argument USING utf8mb4) AS arg FROM mysql.general_log ORDER BY event_time",
    );
    // El piloto se conecta siempre por TCP/IP. Las conexiones por socket Unix son
    // ajenas (p. ej. el healthcheck `mysqladmin ping` del contenedor de CI).
    const socketThreads = new Set(rows
      .filter((r) => r.command_type === 'Connect' && /using Socket/i.test(String(r.arg)))
      .map((r) => Number(r.thread_id)));
    const others = rows.filter((r) => !harnessThreads.has(Number(r.thread_id)) && !socketThreads.has(Number(r.thread_id)));
    const norm = (r) => String(r.arg).replace(/\s+/g, ' ').trim();
    const queries = others.filter((r) => ['Query', 'Prepare', 'Execute'].includes(r.command_type));
    const byThread = new Map();
    for (const r of queries) {
      const id = Number(r.thread_id);
      if (!byThread.has(id)) byThread.set(id, []);
      byThread.get(id).push(norm(r));
    }
    return {
      out,
      statements: queries.map(norm),
      byThread,
      connects: others.filter((r) => r.command_type === 'Connect').length,
    };
  }

  const expectReadOnly = (statements) => {
    expect(statements.filter((s) => WRITE_RE.test(s))).toEqual([]);
    expect(statements.filter((s) => !ALLOWED_RE.test(s))).toEqual([]);
  };
  /** Las ÚNICAS escrituras permitidas: las sentencias del lock sobre la fila propia de este reloj. */
  const lockSqlRes = () => [
    new RegExp(`^DELETE FROM device_locks WHERE device_id = ${deviceId} AND expires_at < NOW\\(\\)$`),
    new RegExp(`^INSERT INTO device_locks \\(device_id, token, owner, job_id, origin, acquired_at, expires_at\\) VALUES \\(${deviceId}, 'pilot:[0-9a-f]{32}', 'piloto:[^']{1,56}', NULL, 'piloto_estados', NOW\\(\\), DATE_ADD\\(NOW\\(\\), INTERVAL [0-9]+ SECOND\\)\\)$`),
    new RegExp(`^UPDATE device_locks SET expires_at = DATE_ADD\\(NOW\\(\\), INTERVAL [0-9]+ SECOND\\) WHERE device_id = ${deviceId} AND token = 'pilot:[0-9a-f]{32}'$`),
    new RegExp(`^DELETE FROM device_locks WHERE device_id = ${deviceId} AND token = 'pilot:[0-9a-f]{32}'$`),
  ];
  const isLockSql = (s) => lockSqlRes().some((re) => re.test(s));
  /** Sesión de la conexión del lock: zona de la app, autocommit, esperas cortas y verificación. */
  const LOCK_SESSION = [
    "SET SESSION time_zone = '-03:00', SESSION autocommit = 1, SESSION innodb_lock_wait_timeout = 2, SESSION lock_wait_timeout = 2",
    'SELECT @@session.time_zone AS tz, @@session.autocommit AS ac, @@global.read_only AS ro, @@global.super_read_only AS sro',
  ];
  /** Identidad de la sesión del lock (para matarla después SÓLO si sigue siendo ella): sólo lecturas. */
  const LOCK_IDENTITY_RES = [
    /^SELECT HOST AS host FROM information_schema\.PROCESSLIST WHERE ID = \d+$/,
    /^SHOW GLOBAL STATUS LIKE 'Uptime'$/,
  ];
  const isIdentitySql = (st) => LOCK_IDENTITY_RES.some((re) => re.test(st));
  /**
   * SQL del piloto por conexión: la de lectura sólo sesión READ ONLY + SELECT; la del lock (si se
   * abrió) sólo sentencias de su fila. Ninguna otra escritura, DDL ni auditoría.
   * Devuelve las sentencias de la conexión del lock.
   */
  const expectPilotSql = ({ byThread, statements }, { lockConn }) => {
    const threads = [...byThread.values()];
    const ro = threads.filter((s) => s[0] === 'SET SESSION TRANSACTION READ ONLY');
    const lk = threads.filter((s) => s[0] !== 'SET SESSION TRANSACTION READ ONLY');
    expect([ro.length, lk.length]).toEqual([1, lockConn ? 1 : 0]);
    expect(ro[0].filter((s) => !ALLOWED_RE.test(s))).toEqual([]);
    expect(ro[0].filter((s) => WRITE_RE.test(s))).toEqual([]);
    const lockStatements = lk[0] || [];
    // La sesión del lock se fija una vez por conexión. (general_log registra el SET que incluye
    // autocommit con una hora posterior: su posición en el log no es la de ejecución; el orden
    // sesión → escrituras lo prueba la unitaria y su efecto, el caso del worker que retiene el lock.)
    if (lockConn) expect(lockStatements.filter((s) => LOCK_SESSION.includes(s)).sort()).toEqual([...LOCK_SESSION].sort());
    if (lockConn) expect(LOCK_IDENTITY_RES.map((re) => lockStatements.filter((st) => re.test(st)).length)).toEqual([1, 1]);
    const rest = lockStatements.filter((s) => !LOCK_SESSION.includes(s) && !isIdentitySql(s));
    expect(rest.filter((s) => !isLockSql(s))).toEqual([]);
    expect(statements.filter((s) => /audit_events|CREATE\s|ALTER\s|DROP\s/i.test(s))).toEqual([]);
    return rest;
  };
  /**
   * Redis del PILOTO a través de un proxy que sólo cuenta conexiones. (El contador del servidor,
   * total_connections_received, también cuenta las ajenas: p. ej. el healthcheck `redis-cli ping` del
   * contenedor de CI cada 10 s.)
   */
  const countingRedis = async () => {
    const p = await proxyFor(redisPort());
    return { env: { REDIS_URL: `redis://127.0.0.1:${p.port}` }, connections: () => p.state.connections };
  };
  const expectNoSecretsOrPeople = (json) => {
    // El corte es un parámetro del operador y la huella es de CONJUNTO: se quitan antes de buscar
    // horas individuales o identificadores.
    const text = JSON.stringify(json, (k, v) => (['hasta', 'huella', 'clave_id', 'corrida_id'].includes(k) ? '…' : v));
    for (const uid of USER_IDS) expect(text).not.toContain(uid);
    expect(text).not.toContain(ip);
    if (server) expect(text).not.toContain(String(server.port));
    expect(text).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(text).not.toMatch(/ECONN|TIMEOUT_|Error:|stack/);
    expect(text).not.toContain(cfg.password);
  };
  const delEvents = () => keyEvents.filter((e) => e.ev === 'del');
  const lockRows = async () => Number((await conn.query('SELECT COUNT(*) AS n FROM device_locks WHERE device_id = ?', [deviceId]))[0][0].n);

  beforeAll(async () => {
    if (!REDIS_URL) throw new Error('IT_REDIS_URL es obligatorio para esta suite (Redis aislado de pruebas)');
    conn = await makeConn();
    // Las filas de device_locks que siembra el arnés se escriben y comparan en la zona de la app, igual
    // que el helper habitual (Sequelize); la base de CI está en UTC.
    await conn.query("SET time_zone = '-03:00'");
    admin = await mysql.createConnection({ ...cfg, user: ADMIN.user, password: ADMIN.password });
    harnessThreads = new Set([
      Number((await conn.query('SELECT CONNECTION_ID() AS id'))[0][0].id),
      Number((await admin.query('SELECT CONNECTION_ID() AS id'))[0][0].id),
    ]);
    const { createClient } = require('redis');
    redis = createClient({ url: REDIS_URL });
    await redis.connect();
    await redis.configSet('notify-keyspace-events', 'KA');
    sub = redis.duplicate();
    await sub.connect();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zk-pilot-it-'));

    const used = new Set((await conn.query("SELECT ip_address FROM devices WHERE ip_address LIKE '127.%'"))[0].map((r) => r.ip_address));
    ip = [...Array(200).keys()].map((i) => `127.0.0.${i + 1}`).find((x) => !used.has(x));
    deviceId = (await conn.query(
      "INSERT INTO devices (name, ip_address, port, connection_mode, timeout_ms) VALUES (?, ?, 4370, 'tcp', 60000)",
      [`${uniq} piloto sintético`, ip],
    ))[0].insertId;
    // Clave literal del helper habitual del worker (deviceLock.js): el piloto debe usar exactamente esta.
    lockKey = `zk:lock:dev:${deviceId}`;
    await sub.pSubscribe(`__keyspace@*__:${lockKey}`, (ev) => {
      keyEvents.push({ ev, open: server ? server.openCount() : 0, t: Date.now() });
    });
  });

  beforeEach(async () => {
    await redis.del(lockKey);
    await conn.query('DELETE FROM device_locks WHERE device_id = ?', [deviceId]).catch(() => {});
    // La notificación del DEL de limpieza llega por otra conexión: se deja
    // pasar antes de vaciar la lista, para que no se cuente en el caso siguiente.
    await sleep(200);
    keyEvents.length = 0;
  });

  afterEach(async () => {
    // Ningún proceso de lectura del piloto debe quedar vivo después de cada caso.
    for (let i = 0; i < 50 && liveReadChildren().length; i += 1) await sleep(100);
    expect(liveReadChildren()).toEqual([]);
  });

  afterAll(async () => {
    if (server) await server.close();
    if (sub) await sub.quit().catch(() => {});
    if (redis) { await redis.del(lockKey).catch(() => {}); await redis.quit().catch(() => {}); }
    if (conn) {
      await conn.query('DELETE FROM device_locks WHERE device_id = ?', [deviceId]).catch(() => {});
      await conn.query("DELETE FROM audit_events WHERE action = 'device_lock.acquire' AND entity_id = ?", [String(deviceId)]).catch(() => {});
      await conn.query('DELETE FROM devices WHERE id = ?', [deviceId]).catch(() => {});
      await conn.end();
    }
    if (admin) await admin.end();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Controles negativos ───────────────────────────────────────

  test('control: el helper habitual, aun con Redis, intenta escribir en audit_events (el detector lo ve)', async () => {
    const code = `
      const lock = require('./src/services/deviceLock');
      (async () => {
        const h = await lock.acquire(${deviceId}, { origin: 'it-control' });
        process.stdout.write('backend=' + (h && h.backend) + '\\n');
        await lock.release(h);
        await new Promise((r) => setTimeout(r, 800));
        await require('./src/config/database').sequelize.close();
        process.exit(0);
      })().catch((e) => { process.stdout.write('error\\n'); process.exit(1); });`;
    const { out, statements } = await auditSql(() => new Promise((resolve) => {
      const p = spawn(process.execPath, ['-e', code], { cwd: API_ROOT, env: pilotEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      p.stdout.on('data', (d) => { stdout += d; });
      p.on('exit', (c) => resolve({ c, stdout }));
    }));
    expect(out).toEqual({ c: 0, stdout: 'backend=redis\n' });
    expect(statements.some((s) => /^INSERT INTO audit_events/i.test(s))).toBe(true);
  });

  test('control: el camino habitual con Promise.race devuelve el timeout y deja la conexión abierta', async () => {
    await useServer({ records: RECORDS, scenarios: ['hang'] });
    const code = `
      const r = require('./src/services/zktecoReader');
      const device = { id: ${deviceId}, ip_address: '${ip}', port: ${server.port}, connection_mode: 'tcp', timeout_ms: 60000 };
      r.readAttendancesStable(device, { readTimeoutMs: 1500, attempts: 1 })
        .then(() => process.stdout.write('RESOLVED\\n'), () => process.stdout.write('RETURNED\\n'));
      setInterval(() => {}, 1000);`;
    const p = spawn(process.execPath, ['-e', code], { cwd: API_ROOT, env: pilotEnv({ REDIS_URL: 'disabled://' }), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    p.stdout.on('data', (d) => { stdout += d; });
    const gone = new Promise((r) => p.on('exit', r));
    let openAfterReturn;
    try {
      for (let i = 0; i < 100 && !/^(RETURNED|RESOLVED)$/m.test(stdout); i += 1) await sleep(100);
      await sleep(500);
      openAfterReturn = server.openCount();
    } finally {
      p.kill('SIGKILL');
      await gone;
    }
    // El lector devolvió el timeout, pero la lectura "vencida" seguía conectada al reloj.
    expect(stdout).toMatch(/^RETURNED$/m);
    expect(openAfterReturn).toBe(1);
    expect(await server.waitAllClosed(5000)).toBe(true);
  });

  // ─── Lectura correcta ──────────────────────────────────────────

  test('lectura completa: agregado exacto, sólo comandos de lectura, escrituras sólo de la fila propia del lock', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    const audit = await auditSql(() => runPilot({ args: limits({ attempts: 3 }) }));
    const { out: r, connects } = audit;
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      formato: 'sishoras.zk-raw-state-pilot/2',
      resultado: 'ok',
      codigo_salida: 0,
      senal: null,
      reloj: { id: deviceId, modo_conexion: 'tcp' },
      limites: {
        intentos_max: 3, timeout_intento_s: 20, duracion_max_s: 60, espera_entre_intentos_s: 0, renovacion_s: 1, ttl_lock_s: 27,
        ttl_provisional_s: 30, operacion_max_s: 5, cierre_max_s: 17,
      },
      corte: null,
      exclusion: {
        backend: 'redis+mysql', clave: lockKey,
        mysql: { tabla: 'device_locks', origen: 'piloto_estados', estado: 'tomado' },
        auditoria_mysql: false,
      },
      liberacion: { redis: 'liberado', mysql: 'liberado' },
      cierre_clientes: { redis: 'normal', mysql: 'normal', mysql_lock: 'normal' },
      intentos_ejecutados: 1,
      herramienta: { node_zklib: '1.3.0' },
    });
    expect(r.json.herramienta.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.json.intentos).toEqual([expect.objectContaining({
      intento: 1, estado: 'completa', codigo: null, registros: 31, validos: 29, basura: 2,
      captura: EXPECTED_TCP40.captura, bytes_estimados: EXPECTED_TCP40.bytes_estimados, cierre: 'proceso_terminado',
    })]);
    expect(r.json.lectura).toEqual({ intento: 1, ...EXPECTED_TCP40 });
    expect(r.json.advertencia).toMatch(/no interpreta/i);
    expectNoSecretsOrPeople(r.json);

    expect(server.connections).toHaveLength(1);
    expect(server.commands().every((c) => READ_COMMANDS.has(c))).toBe(true);
    expect(server.connections[0].commands).toEqual(['CMD_CONNECT', 'CMD_FREE_DATA', 'CMD_DATA_WRRQ', 'CMD_FREE_DATA', 'CMD_EXIT']);
    expect(server.openCount()).toBe(0);
    expect(delEvents()).toEqual([expect.objectContaining({ open: 0 })]);
    expect(await redis.exists(lockKey)).toBe(0);
    expect(await lockRows()).toBe(0);

    // Dos conexiones: la de lectura (READ ONLY) y la del lock (sólo su fila de device_locks).
    expect(connects).toBe(2);
    const lockSql = expectPilotSql(audit, { lockConn: true });
    const kinds = lockSql.map((s) => lockSqlRes().findIndex((re) => re.test(s)));
    expect(kinds[0]).toBe(0);              // limpieza de la fila VENCIDA de este reloj (protocolo habitual)
    expect(kinds[1]).toBe(1);              // INSERT de la fila propia
    expect(kinds.slice(2, -1).every((k) => k === 2)).toBe(true);   // renovaciones por token
    expect(kinds[kinds.length - 1]).toBe(3);   // liberación por token
    // La fila nace con el TTL PROVISIONAL (30 s) y la renovación la lleva al completo (27 s = 20 + 1 + 5 + 1).
    expect(lockSql[1]).toMatch(/INTERVAL 30 SECOND\)\)$/);
    expect(lockSql.slice(2, -1).every((st) => /INTERVAL 27 SECOND\)/.test(st))).toBe(true);
    // La lectura completa se acepta recién con una verificación de la exclusión POSTERIOR al fin del hijo.
    expect(kinds.slice(2, -1).length).toBeGreaterThanOrEqual(2);
  });

  test('lectura truncada y después completa: intentos reales, cada uno cerrado antes del siguiente', async () => {
    const many = manyRecords(2000);
    await useServer({ records: many, scenarios: ['truncate', 'ok'] });
    const audit = await auditSql(() => runPilot({ args: limits({ attempts: 3 }) }));
    const { out: r } = audit;
    expect(r.code).toBe(0);
    expect(r.json.resultado).toBe('ok');
    expect(r.json.intentos_ejecutados).toBe(2);
    expect(r.json.intentos.map((a) => [a.intento, a.estado, a.registros])).toEqual([[1, 'truncada', 1636], [2, 'completa', 2000]]);
    expect(r.json.lectura).toMatchObject({ intento: 2, registros: 2000, captura: { ok: 2000, no_disponible: 0, longitud_inesperada: 0, otro: 0 } });
    expect(server.connections).toHaveLength(2);
    // La 2.ª conexión se abrió recién después de cerrarse la 1.ª.
    expect(server.connections[1].openedAt).toBeGreaterThanOrEqual(server.connections[0].closedAt);
    expect(server.openCount()).toBe(0);
    expect(delEvents()).toEqual([expect.objectContaining({ open: 0 })]);
    expectPilotSql(audit, { lockConn: true });
    expect(await lockRows()).toBe(0);
  });

  // ─── Abortar antes de conectar ─────────────────────────────────

  test('captura tardía (node-zklib cargado antes): aborta antes de conectar al reloj', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    const audit = await auditSql(() => runPilot({ args: limits({ attempts: 2 }), preload: EARLY }));
    const { out: r } = audit;
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ resultado: 'captura_no_garantizada', intentos_ejecutados: 1, lectura: null });
    expect(r.json.intentos).toEqual([expect.objectContaining({ intento: 1, estado: 'captura_no_garantizada' })]);
    expect(server.connections).toHaveLength(0);
    expect(await redis.exists(lockKey)).toBe(0);
    expect(await lockRows()).toBe(0);
    expectPilotSql(audit, { lockConn: true });
  });

  test.each([['1e2'], ['01'], ['-1'], ['1.5'], ['1abc'], ['0'], ['9007199254740993'], [' 7'], ['0x10']])(
    'ID %p: código 2 sin abrir MySQL, Redis ni el reloj', async (raw) => {
      await useServer({ records: RECORDS, scenarios: ['ok'] });
      const rc = await countingRedis();
      const { out: r, statements, connects } = await auditSql(() => runPilot({ args: limits(), id: raw, env: rc.env }));
      expect(r.code).toBe(2);
      expect(r.json).toMatchObject({ resultado: 'id_invalido', reloj: { id: null }, intentos_ejecutados: 0 });
      expect([statements, connects]).toEqual([[], 0]);
      expect(rc.connections()).toBe(0);
      expect(server.connections).toHaveLength(0);
    },
  );

  test('reloj inexistente: código 8 sin tocar Redis ni relojes', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    const rc = await countingRedis();
    const audit = await auditSql(() => runPilot({ args: limits(), id: String(deviceId + 100000), env: rc.env }));
    const { out: r, statements } = audit;
    expect(r.code).toBe(8);
    expect(r.json.resultado).toBe('reloj_inexistente');
    expect(rc.connections()).toBe(0);
    expect(server.connections).toHaveLength(0);
    expectReadOnly(statements);
    expectPilotSql(audit, { lockConn: false });
  });

  test('lock Redis ocupado por otro: código 4, el lock ajeno queda intacto', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    await redis.set(lockKey, 'worker-token', { PX: 60000 });
    const audit = await auditSql(() => runPilot({ args: limits() }));
    const { out: r, statements } = audit;
    expect(r.code).toBe(4);
    expect(r.json.resultado).toBe('reloj_ocupado');
    expect(await redis.get(lockKey)).toBe('worker-token');
    expect(await redis.pTTL(lockKey)).toBeGreaterThan(0);
    expect(server.connections).toHaveLength(0);
    // Sin la clave no se abre la conexión del lock: ninguna escritura.
    expectReadOnly(statements);
    expectPilotSql(audit, { lockConn: false });
  });

  test('lock MySQL previo con Redis libre: código 4, se suelta el Redis propio y la fila ajena queda intacta', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    await conn.query(
      "INSERT INTO device_locks (device_id, token, owner, origin, acquired_at, expires_at) VALUES (?, 'mysql-token', 'otro', 'automatic', NOW(), DATE_ADD(NOW(), INTERVAL 10 MINUTE))",
      [deviceId],
    );
    const audit = await auditSql(() => runPilot({ args: limits() }));
    const { out: r } = audit;
    expect(r.code).toBe(4);
    expect(r.json).toMatchObject({
      resultado: 'lock_mysql_vigente',
      exclusion: { mysql: { estado: 'ocupado' } },
      liberacion: { redis: 'liberado', mysql: 'no_tomado' },
    });
    expect(await redis.exists(lockKey)).toBe(0);
    const [[row]] = await conn.query('SELECT token FROM device_locks WHERE device_id = ?', [deviceId]);
    expect(row.token).toBe('mysql-token');
    expect(server.connections).toHaveLength(0);
    // Sólo la limpieza de vencidos (no toca la fila vigente) y el INSERT rechazado por duplicado.
    const lockSql = expectPilotSql(audit, { lockConn: true });
    expect(lockSql.map((s) => lockSqlRes().findIndex((re) => re.test(s)))).toEqual([0, 1]);
  });

  test('Redis caído: código 5, sin fila MySQL ni DDL, sin conectar al reloj', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    const audit = await auditSql(() => runPilot({ args: limits(), env: { REDIS_URL: 'redis://127.0.0.1:1' } }));
    const { out: r, statements } = audit;
    expect(r.code).toBe(5);
    expect(r.json.resultado).toBe('redis_no_disponible');
    expect(server.connections).toHaveLength(0);
    // Sin Redis el piloto no lee: no toma la fila (no es un fallback) ni abre la conexión del lock.
    expectReadOnly(statements);
    expectPilotSql(audit, { lockConn: false });
    expect(statements.some((s) => /device_locks/i.test(s) && !/^SELECT/i.test(s))).toBe(false);
  });

  // ─── Cierre real: lectura colgada, límite, lock perdido, señales ─

  test('lectura colgada: cada intento se mata y se espera su fin; sin conexiones al liberar', async () => {
    await useServer({ records: RECORDS, scenarios: ['hang'] });
    const audit = await auditSql(() => runPilot({ args: limits({ attempts: 2, timeout: 2, max: 30 }) }));
    const { out: r } = audit;
    expect(r.code).toBe(6);
    expect(r.json.resultado).toBe('sin_lectura_completa');
    expect(r.json.intentos.map((a) => [a.estado, a.codigo, a.cierre])).toEqual([
      ['timeout', 'tiempo_agotado', 'proceso_terminado'], ['timeout', 'tiempo_agotado', 'proceso_terminado'],
    ]);
    expect(r.ms).toBeLessThan(20000);
    expect(server.connections).toHaveLength(2);
    expect(server.connections[1].openedAt).toBeGreaterThanOrEqual(server.connections[0].closedAt);
    expect(server.openCount()).toBe(0);
    expect(delEvents()).toEqual([expect.objectContaining({ open: 0 })]);
    expectPilotSql(audit, { lockConn: true });
    expect(await lockRows()).toBe(0);
  });

  test('límite total: no empieza un intento que no cabe en la duración restante', async () => {
    await useServer({ records: RECORDS, scenarios: ['hang'] });
    const audit = await auditSql(() => runPilot({ args: limits({ attempts: 3, timeout: 2, max: 3 }) }));
    const { out: r } = audit;
    expect(r.code).toBe(6);
    expect(r.json).toMatchObject({ resultado: 'limite_total', intentos_ejecutados: 1 });
    expect(server.connections).toHaveLength(1);
    expect(server.openCount()).toBe(0);
    expect(delEvents()).toEqual([expect.objectContaining({ open: 0 })]);
    expectPilotSql(audit, { lockConn: true });
    expect(await lockRows()).toBe(0);
  });

  test('pérdida del lock durante la lectura: se mata la lectura, no se borra el lock ajeno, código 7', async () => {
    await useServer({ records: RECORDS, scenarios: ['hang'] });
    const audit = await auditSql(() => runPilot({
      args: limits({ timeout: 30, max: 60, renew: 1 }),
      during: async () => {
        await server.waitForConnections(1);
        await redis.set(lockKey, 'otro-dueno', { XX: true, KEEPTTL: true });
      },
    }));
    const { out: r } = audit;
    expect(r.code).toBe(7);
    expect(r.json).toMatchObject({ resultado: 'lock_perdido', liberacion: { redis: 'perdido', mysql: 'liberado' } });
    expect(r.json.intentos).toEqual([expect.objectContaining({ estado: 'cancelado', codigo: 'lock_perdido', cierre: 'proceso_terminado' })]);
    expect(r.ms).toBeLessThan(15000);
    expect(await redis.get(lockKey)).toBe('otro-dueno');
    expect(await server.waitAllClosed(2000)).toBe(true);
    expectPilotSql(audit, { lockConn: true });
    expect(await lockRows()).toBe(0);
  });

  test.each([['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]])(
    'señal %s: cierra la lectura, libera el lock y escribe el JSON (código %d)', async (sig, exitCode) => {
      await useServer({ records: RECORDS, scenarios: ['hang'] });
      const audit = await auditSql(() => runPilot({
        args: limits({ timeout: 30, max: 60 }),
        during: async (child) => { await server.waitForConnections(1); await sleep(300); child.kill(sig); },
      }));
      const { out: r } = audit;
      expect([r.code, r.signal]).toEqual([exitCode, null]);
      expect(r.json).toMatchObject({ resultado: 'interrumpido', senal: sig, codigo_salida: exitCode, liberacion: { redis: 'liberado', mysql: 'liberado' } });
      expect(r.json.intentos).toEqual([expect.objectContaining({ estado: 'cancelado', codigo: 'interrumpido', cierre: 'proceso_terminado' })]);
      expect(server.openCount()).toBe(0);
      expect(delEvents()).toEqual([expect.objectContaining({ open: 0 })]);
      expect(await redis.exists(lockKey)).toBe(0);
      expect(await lockRows()).toBe(0);
      expectPilotSql(audit, { lockConn: true });
    },
  );

  test('SIGKILL del proceso principal: la lectura termina sola y la clave y la fila vencen por TTL', async () => {
    await useServer({ records: RECORDS, scenarios: ['hang'] });
    const audit = await auditSql(() => runPilot({
      args: limits({ timeout: 30, max: 60 }),
      during: async (child) => { await server.waitForConnections(1); await sleep(300); child.kill('SIGKILL'); },
    }));
    const { out: r } = audit;
    expect(r.signal).toBe('SIGKILL');
    expect(r.json).toBeNull();
    expect(await server.waitAllClosed(5000)).toBe(true);
    const ttl = await redis.pTTL(lockKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual((30 + 1 + 5 + 1) * 1000);
    // La fila propia sigue vigente y vence sola, con el mismo TTL (segundos de MySQL).
    const [[row]] = await conn.query(
      'SELECT origin, TIMESTAMPDIFF(SECOND, NOW(), expires_at) AS restante FROM device_locks WHERE device_id = ?', [deviceId],
    );
    expect(row.origin).toBe('piloto_estados');
    expect(row.restante).toBeGreaterThan(0);
    expect(row.restante).toBeLessThanOrEqual(30 + 1 + 5 + 1);
    expectPilotSql(audit, { lockConn: true });
  });

  // ─── Exclusión real con el fallback MySQL del helper habitual ─────

  test('exclusión: con el piloto leyendo, el helper habitual en fallback MySQL NO obtiene el lock', async () => {
    await useServer({ records: RECORDS, scenarios: ['hang'] });
    let habitual = null;
    let openDuring = null;
    const r = await runPilot({
      args: limits({ timeout: 4, max: 20, renew: 1 }),
      killAfterMs: 60000,
      during: async () => {
        await server.waitForConnections(1);
        openDuring = server.openCount();
        // Redis inaccesible SÓLO para el helper habitual ⇒ cae a device_locks.
        habitual = await habitualAcquire({ REDIS_URL: 'disabled://' });
      },
    });
    expect(openDuring).toBe(1);
    // Con el piloto leyendo, el lock habitual debe estar OCUPADO: si no, hay dos lecturas a la vez.
    expect(habitual).toMatchObject({ code: 0, backend: null });
    expect(r.hung).toBe(false);
    expect(r.json).toMatchObject({ resultado: 'sin_lectura_completa', codigo_salida: 6 });
    expect(await server.waitAllClosed(5000)).toBe(true);
    expect(await redis.exists(lockKey)).toBe(0);
    expect(await lockRows()).toBe(0);
  });

  /**
   * El helper HABITUAL toma el lock y lo RETIENE (como un worker leyendo) hasta `release()`. Con
   * REDIS_URL inválida cae al fallback MySQL: Sequelize fija la sesión en la zona de la app (-03:00)
   * y con ella escribe y compara expires_at.
   */
  async function habitualHold(env = {}) {
    const code = `
      const lock = require('./src/services/deviceLock');
      (async () => {
        const h = await lock.acquire(${deviceId}, { origin: 'it-habitual-retiene' });
        process.stdout.write(JSON.stringify({ backend: h ? h.backend : null, token: h ? h.token : null }) + '\\n');
        process.stdin.once('data', async () => {
          if (h) await lock.release(h);
          await require('./src/config/database').sequelize.close();
          process.exit(0);
        });
      })().catch(() => { process.stdout.write(JSON.stringify({ error: true }) + '\\n'); process.exit(1); });`;
    const p = spawn(process.execPath, ['-e', code], { cwd: API_ROOT, env: pilotEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    p.stdout.on('data', (d) => { stdout += d; });
    const gone = new Promise((r) => p.on('exit', r));
    for (let i = 0; i < 100 && !stdout.includes('\n'); i += 1) await sleep(100);
    let info = null;
    try { info = JSON.parse(stdout.trim().split('\n')[0]); } catch { /* sin salida */ }
    return {
      info,
      release: async () => { try { p.stdin.write('x'); } catch { /* terminado */ } await Promise.race([gone, sleep(5000)]); p.kill('SIGKILL'); },
    };
  }

  test('exclusión: el helper habitual en fallback toma y RETIENE el lock; después el piloto NO lee', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    const held = await habitualHold({ REDIS_URL: 'disabled://' });
    try {
      expect(held.info).toMatchObject({ backend: 'mysql' });
      const r = await runPilot({ args: limits(), killAfterMs: 60000 });
      // Con el reloj tomado por el worker, el piloto no debe conectarse.
      expect(server.connections).toHaveLength(0);
      expect(r.code).toBe(4);
      expect(r.json.resultado).toBe('lock_mysql_vigente');
      const [[row]] = await conn.query('SELECT token FROM device_locks WHERE device_id = ?', [deviceId]);
      expect(row.token).toBe(held.info.token);
      expect(await redis.exists(lockKey)).toBe(0);
    } finally {
      await held.release();
    }
  });

  test('exclusión (control): con el piloto leyendo, el helper habitual con Redis tampoco obtiene el lock', async () => {
    await useServer({ records: RECORDS, scenarios: ['hang'] });
    let habitual = null;
    const r = await runPilot({
      args: limits({ timeout: 4, max: 20, renew: 1 }),
      killAfterMs: 60000,
      during: async () => {
        await server.waitForConnections(1);
        habitual = await habitualAcquire();
      },
    });
    expect(habitual).toMatchObject({ code: 0, backend: null });
    expect(r.hung).toBe(false);
    expect(await server.waitAllClosed(5000)).toBe(true);
  });

  // ─── Sesión y privilegios de la conexión del lock ─────────────────

  test('espera de bloqueo en el servidor: la toma se abandona en 2 s, sin fila huérfana ni lectura', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    // Otra transacción retiene la PK del reloj (como un INSERT del fallback todavía sin confirmar).
    const blocker = await makeConn();
    await blocker.query("SET time_zone = '-03:00'");
    await blocker.query('START TRANSACTION');
    await blocker.query(
      "INSERT INTO device_locks (device_id, token, owner, origin, acquired_at, expires_at) VALUES (?, 'bloqueante', 'it', 'automatic', NOW(), DATE_ADD(NOW(), INTERVAL 10 MINUTE))",
      [deviceId],
    );
    let r;
    try {
      r = await runPilot({ args: limits(), killAfterMs: 60000 });
    } finally {
      await blocker.query('ROLLBACK');
      await blocker.end();
    }
    expect(r.hung).toBe(false);
    expect(r.ms).toBeLessThan(15000);
    expect(r.json).toMatchObject({
      resultado: 'exclusion_no_garantizada', codigo_salida: 4,
      exclusion: { mysql: { estado: 'espera_de_bloqueo' } },
      liberacion: { redis: 'liberado', mysql: 'no_tomado' },
    });
    expect(server.connections).toHaveLength(0);
    expect(await lockRows()).toBe(0);
    expect(await redis.exists(lockKey)).toBe(0);
  });

  test.each([
    ['sólo SELECT', 'SELECT', 'sin_acceso', 'no_tomado'],
    ['sin UPDATE', 'SELECT, INSERT, DELETE', 'tomado', 'liberado'],
  ])('usuario %s en device_locks: no lee el reloj y no deja fila', async (_name, grants, estado, liberacionMysql) => {
    const user = `zkp_it_${seq + 1}_${process.pid}`;
    const pass = 'zkp-it-solo-pruebas';
    await admin.query(`CREATE USER '${user}'@'%' IDENTIFIED BY '${pass}'`);
    try {
      await admin.query(`GRANT SELECT ON \`${cfg.database}\`.devices TO '${user}'@'%'`);
      await admin.query(`GRANT ${grants} ON \`${cfg.database}\`.device_locks TO '${user}'@'%'`);
      await useServer({ records: RECORDS, scenarios: ['ok'] });
      const r = await runPilot({ args: limits(), env: { DB_USER: user, DB_PASSWORD: pass }, killAfterMs: 60000 });
      expect(r.hung).toBe(false);
      expect(r.json).toMatchObject({
        resultado: 'exclusion_no_garantizada', codigo_salida: 4,
        exclusion: { mysql: { estado } }, liberacion: { redis: 'liberado', mysql: liberacionMysql },
      });
      expect(server.connections).toHaveLength(0);
      expect(await lockRows()).toBe(0);
      expect(await redis.exists(lockKey)).toBe(0);
    } finally {
      await admin.query(`DROP USER IF EXISTS '${user}'@'%'`);
    }
  });

  // ─── Operaciones pendientes: el límite total se cumple igual ─────

  // Garantía documentada: el piloto termina dentro de --max-duration más una holgura FIJA de cierre.
  const CLOSE_SLACK_S = 17;
  const redisPort = () => Number(new URL(REDIS_URL).port || 6379);
  const proxies = [];
  afterEach(async () => { for (const p of proxies.splice(0)) await p.close(); });
  const proxyFor = async (target, freezeWhen = null, { delayWhen = null, rstWhen = null } = {}) => {
    const p = await startFreezableProxy({ targetHost: '127.0.0.1', targetPort: target, freezeWhen, delayWhen, rstWhen });
    proxies.push(p);
    return p;
  };

  test('Redis sin respuesta mientras el piloto lee: la renovación se acota, se corta la lectura y termina', async () => {
    await useServer({ records: RECORDS, scenarios: ['hang'] });
    const px = await proxyFor(redisPort());
    const r = await runPilot({
      args: limits({ timeout: 20, max: 30, renew: 1 }),
      env: { REDIS_URL: `redis://127.0.0.1:${px.port}` },
      killAfterMs: 45000,
      during: async () => { await server.waitForConnections(1); px.freeze(); },
    });
    expect(r.hung).toBe(false);
    expect(r.ms).toBeLessThan(20000);
    expect(r.json).toMatchObject({ resultado: 'redis_no_disponible', codigo_salida: 5 });
    expect(await server.waitAllClosed(5000)).toBe(true);
    expect(liveReadChildren()).toEqual([]);
    // La liberación en Redis no pudo confirmarse: la clave vence por TTL (nunca queda sin vencimiento).
    const ttl = await redis.pTTL(lockKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual((20 + 1 + 5 + 1) * 1000);
  });

  test('MySQL sin respuesta mientras el piloto lee: la verificación se acota, se corta la lectura y termina', async () => {
    await useServer({ records: RECORDS, scenarios: ['hang'] });
    const px = await proxyFor(cfg.port);
    const r = await runPilot({
      args: limits({ timeout: 20, max: 30, renew: 1 }),
      env: { DB_HOST: '127.0.0.1', DB_PORT: String(px.port) },
      killAfterMs: 45000,
      during: async () => { await server.waitForConnections(1); px.freeze(); },
    });
    expect(r.hung).toBe(false);
    expect(r.ms).toBeLessThan(20000);
    expect(r.json).toMatchObject({ resultado: 'exclusion_no_garantizada', codigo_salida: 4 });
    expect(await server.waitAllClosed(5000)).toBe(true);
    // Redis sano: la clave propia se libera.
    expect(await redis.exists(lockKey)).toBe(0);
  });

  test('MySQL sin respuesta en la consulta inicial: base_no_disponible dentro del tope, sin Redis ni reloj', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    // Redis por un proxy que sólo cuenta: las conexiones del PILOTO, no las de otros clientes del servidor.
    const rpx = await proxyFor(redisPort());
    const px = await proxyFor(cfg.port, MYSQL.queryContains('FROM devices'));
    const r = await runPilot({
      args: limits({ timeout: 20, max: 30 }),
      env: { DB_HOST: '127.0.0.1', DB_PORT: String(px.port), REDIS_URL: `redis://127.0.0.1:${rpx.port}` },
      killAfterMs: 45000,
    });
    expect(px.state.frozen).toBe(true);
    expect(r.hung).toBe(false);
    expect(r.ms).toBeLessThan(20000);
    expect(r.json).toMatchObject({ resultado: 'base_no_disponible', codigo_salida: 8 });
    expect(rpx.state.connections).toBe(0);
    expect(server.connections).toHaveLength(0);
  });

  test('límite total con una consulta MySQL pendiente: limite_total sin esperar a la consulta', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    const px = await proxyFor(cfg.port, MYSQL.queryContains('FROM devices'));
    const r = await runPilot({
      args: limits({ timeout: 1, max: 2 }),
      env: { DB_HOST: '127.0.0.1', DB_PORT: String(px.port) },
      killAfterMs: 45000,
    });
    expect(px.state.frozen).toBe(true);
    expect(r.hung).toBe(false);
    expect(r.ms).toBeLessThan((2 + CLOSE_SLACK_S) * 1000);
    expect(r.json).toMatchObject({ resultado: 'limite_total', codigo_salida: 6 });
    expect(server.connections).toHaveLength(0);
  });

  test('cierre de Redis: nunca QUIT (sólo disconnect, sin ida y vuelta que pueda colgarse), con la lectura completa', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    // Si el piloto mandara QUIT, este proxy lo dejaría sin respuesta.
    const px = await proxyFor(redisPort(), RESP.contains('QUIT'));
    const r = await runPilot({
      args: limits({ timeout: 20, max: 30 }),
      env: { REDIS_URL: `redis://127.0.0.1:${px.port}` },
      killAfterMs: 45000,
    });
    expect(px.state.frozen).toBe(false);
    expect(r.hung).toBe(false);
    expect(r.ms).toBeLessThan(20000);
    expect(r.json).toMatchObject({ resultado: 'ok', codigo_salida: 0, cierre_clientes: { redis: 'normal' } });
    expect(await redis.exists(lockKey)).toBe(0);
    expect(px.openClients()).toBe(0);
  });

  test('liberación de Redis lenta por el mismo cliente: se cancela, se libera por uno nuevo y el EVAL tardío no resucita ni borra nada', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    // El EVAL de liberación (borra la clave) del cliente del lock tarda 4 s en llegar, más que el tope de un
    // paso de cierre (2 s). Sólo el primero: el del cliente nuevo pasa sin demora.
    let delayedOnce = false;
    const px = await proxyFor(redisPort(), null, {
      delayWhen: (chunk) => {
        if (delayedOnce || !RESP.contains("redis.call('del'")(chunk)) return 0;
        delayedOnce = true;
        return 4000;
      },
    });
    const r = await runPilot({
      args: limits({ timeout: 20, max: 30 }),
      env: { REDIS_URL: `redis://127.0.0.1:${px.port}` },
      killAfterMs: 45000,
    });
    expect(r.hung).toBe(false);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      resultado: 'ok', liberacion: { redis: 'liberado', mysql: 'liberado' }, cierre_clientes: { redis: 'forzado' },
    });
    expect(await redis.exists(lockKey)).toBe(0);
    // El EVAL viejo llega al servidor DESPUÉS de que el piloto terminó (su cliente ya no existe: la
    // respuesta no tiene a quién llegar). Mientras tanto otro toma la clave: el EVAL viejo no la toca.
    expect(px.state.flushes).toBe(0);
    await redis.set(lockKey, 'otro-dueño', { PX: 60000 });
    expect(await px.waitDelayFlushed(1)).toBe(true);
    await sleep(300);
    expect(px.state.delivered).toBeGreaterThan(0);
    expect(await redis.get(lockKey)).toBe('otro-dueño');
    expect(px.state.connections).toBe(2);         // la del lock y la nueva para liberar
  });

  // Cancelar el cliente no retira lo que ya está en vuelo: con renovaciones colgadas en conexiones que
  // no responden (pero una NUEVA sí), la clave y la fila se liberan por clientes nuevos, no por TTL.
  test('señal con renovaciones en vuelo sobre conexiones colgadas: gracia corta, clientes nuevos y se libera todo', async () => {
    await useServer({ records: RECORDS, scenarios: ['hang'] });
    const rpx = await proxyFor(redisPort());
    const mpx = await proxyFor(cfg.port);
    let signalAt = null;
    const t0 = Date.now();
    const r = await runPilot({
      args: limits({ timeout: 20, max: 30, renew: 1 }),
      env: { DB_HOST: '127.0.0.1', DB_PORT: String(mpx.port), REDIS_URL: `redis://127.0.0.1:${rpx.port}` },
      killAfterMs: 45000,
      during: async (child) => {
        await server.waitForConnections(1);
        rpx.freezeExisting();
        mpx.freezeExisting();
        // La renovación es cada 1 s y su tope, 5 s: a los 2.5 s hay una en vuelo en las dos conexiones.
        await sleep(2500);
        signalAt = Date.now();
        child.kill('SIGTERM');
      },
    });
    expect(r.hung).toBe(false);
    expect(r.json).toMatchObject({
      resultado: 'interrumpido', codigo_salida: 143, senal: 'SIGTERM',
      liberacion: { redis: 'liberado', mysql: 'liberado' },
      cierre_clientes: { redis: 'forzado', mysql_lock: 'forzado' },
    });
    expect(await redis.exists(lockKey)).toBe(0);
    expect(await lockRows()).toBe(0);
    // Por clientes NUEVOS: Redis (lock + nuevo) y MySQL (lectura + lock + nuevo).
    expect(rpx.state.connections).toBe(2);
    expect(mpx.state.connections).toBe(3);
    // Gracia (400 ms) y clientes nuevos: sin esperar el tope de la renovación colgada (5 s) ni el de un
    // paso de cierre por el mismo cliente (2 s). Correcto ≈ 0.5 s; sin la gracia ≥ CLOSE_OP_MS.
    const closeMs = t0 + r.ms - signalAt;
    process.stdout.write(`señal→salida: ${closeMs} ms\n`);
    expect(STOP_GRACE_MS + 1000).toBeLessThan(CLOSE_OP_MS);
    expect(closeMs).toBeLessThan(STOP_GRACE_MS + 1000);
    expect(await server.waitAllClosed(5000)).toBe(true);
  });

  test('toma de Redis demorada en la red (llega después del tope): CLIENT KILL de la sesión vieja y sin clave huérfana', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    // Sólo la toma lleva NX: llega al servidor 7 s después, detrás de ella el cierre (como TCP).
    const rpx = await proxyFor(redisPort(), null, { delayWhen: (chunk) => (RESP.contains('$2\r\nNX\r\n')(chunk) ? 7000 : 0) });
    const r = await runPilot({
      args: limits({ timeout: 20, max: 30 }),
      env: { REDIS_URL: `redis://127.0.0.1:${rpx.port}` },
      killAfterMs: 45000,
    });
    expect(r.hung).toBe(false);
    // Pasada la demora, la toma vieja ya no puede aplicarse: su conexión se cerró en el servidor.
    expect(await rpx.waitDelayFlushed(1)).toBe(true);
    await sleep(500);
    expect(await redis.exists(lockKey)).toBe(0);
    expect(rpx.state.discarded).toBeGreaterThan(0);
    expect(r.json).toMatchObject({
      resultado: 'redis_no_disponible', codigo_salida: 5,
      liberacion: { redis: 'compensado', mysql: 'no_tomado' },
      limites: { ttl_provisional_s: 30 },
    });
    expect(server.connections).toHaveLength(0);
    expect(await lockRows()).toBe(0);
  });

  test('toma MySQL demorada en la red (llega después del tope): KILL CONNECTION de la sesión vieja y sin fila huérfana', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    const mpx = await proxyFor(cfg.port, null, {
      delayWhen: (chunk) => (MYSQL.queryContains('INSERT INTO device_locks')(chunk) ? 7000 : 0),
    });
    const audit = await auditSql(async () => {
      const out = await runPilot({
        args: limits({ timeout: 20, max: 30 }),
        env: { DB_HOST: '127.0.0.1', DB_PORT: String(mpx.port) },
        killAfterMs: 45000,
      });
      // general_log sigue activo hasta pasada la demora: si el INSERT viejo se ejecutara, quedaría registrado.
      await mpx.waitDelayFlushed(1);
      await sleep(500);
      return out;
    });
    const { out: r, statements } = audit;
    expect(r.hung).toBe(false);
    expect(await lockRows()).toBe(0);
    expect(mpx.state.discarded).toBeGreaterThan(0);
    expect(r.json).toMatchObject({
      resultado: 'exclusion_no_garantizada', codigo_salida: 4,
      exclusion: { mysql: { estado: 'sin_respuesta' } },
      liberacion: { redis: 'liberado', mysql: 'compensado' },
    });
    expect(server.connections).toHaveLength(0);
    expect(await redis.exists(lockKey)).toBe(0);
    // El INSERT viejo nunca se ejecutó; la conexión nueva comprobó que el hilo seguía siendo el nuestro
    // (mismo arranque del servidor y mismo HOST), lo mató, esperó su fin y recién después compensó.
    expect(statements.filter((st) => /^INSERT INTO device_locks/.test(st))).toEqual([]);
    const kills = statements.filter((st) => /^KILL CONNECTION \d+$/.test(st));
    expect(kills).toHaveLength(1);
    const killed = kills[0].split(' ').pop();
    const sessionSql = `SELECT HOST AS host FROM information_schema.PROCESSLIST WHERE ID = ${killed}`;
    const before = statements.slice(0, statements.indexOf(kills[0]));
    const after = statements.slice(statements.indexOf(kills[0]) + 1);
    expect(before.filter((st) => st === sessionSql).length).toBeGreaterThanOrEqual(2);   // identidad al abrir + antes de matar
    expect(after).toContain(sessionSql);                                                  // sondeo hasta que desaparece
    expect(after.some((st) => /^DELETE FROM device_locks WHERE device_id = \d+ AND token = 'pilot:[0-9a-f]{32}'$/.test(st))).toBe(true);
    expect(statements.filter((st) => WRITE_RE.test(st) && !isLockSql(st))).toEqual([]);
  });

  // Un error de RED en MySQL (RST: errno -104) no prueba nada: la sentencia pudo aplicarse.
  const isTokenDelete = (chunk) => chunk.length >= 5 && chunk[4] === 0x03
    // (El texto puede ir precedido por los atributos de consulta de MySQL ≥ 8.0.23: no se ancla al inicio.)
    && /DELETE FROM device_locks WHERE device_id = \d+ AND token/i.test(chunk.subarray(5).toString('utf8'));

  test('toma MySQL aplicada y la conexión reseteada por la red (RST): incierta, se compensa y no queda fila', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    // El proxy entrega el INSERT al servidor y corta al cliente con RST: la respuesta se pierde.
    const mpx = await proxyFor(cfg.port, null, { rstWhen: (chunk) => (MYSQL.queryContains('INSERT INTO device_locks')(chunk) ? 'despues' : null) });
    const audit = await auditSql(async () => {
      const out = await runPilot({
        args: limits({ timeout: 20, max: 30 }),
        env: { DB_HOST: '127.0.0.1', DB_PORT: String(mpx.port) },
        killAfterMs: 45000,
      });
      await sleep(1500);
      return out;
    });
    const { out: r, statements } = audit;
    expect(r.hung).toBe(false);
    expect(mpx.state.resets).toBe(1);
    expect(await lockRows()).toBe(0);
    expect(r.json).toMatchObject({
      resultado: 'exclusion_no_garantizada', codigo_salida: 4,
      liberacion: { redis: 'liberado', mysql: 'compensado' },
      cierre_clientes: { mysql_lock: 'forzado' },
    });
    // El INSERT SÍ se ejecutó (sólo se perdió la respuesta) y la compensación lo borró por token.
    expect(statements.filter((st) => /^INSERT INTO device_locks/.test(st))).toHaveLength(1);
    expect(statements.some((st) => /^DELETE FROM device_locks WHERE device_id = \d+ AND token = 'pilot:[0-9a-f]{32}'$/.test(st))).toBe(true);
    expect(server.connections).toHaveLength(0);
  });

  test('liberación MySQL cortada por la red (RST): se libera por una conexión nueva, no queda la fila hasta el TTL', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    let once = false;
    const mpx = await proxyFor(cfg.port, null, {
      rstWhen: (chunk) => {
        if (once || !isTokenDelete(chunk)) return null;
        once = true;
        return 'antes';
      },
    });
    const r = await runPilot({
      args: limits({ timeout: 20, max: 30 }),
      env: { DB_HOST: '127.0.0.1', DB_PORT: String(mpx.port) },
      killAfterMs: 45000,
    });
    expect(r.hung).toBe(false);
    expect(mpx.state.resets).toBe(1);
    expect(r.json).toMatchObject({
      resultado: 'ok', codigo_salida: 0,
      liberacion: { redis: 'liberado', mysql: 'liberado' },
      cierre_clientes: { mysql_lock: 'forzado' },
    });
    expect(await lockRows()).toBe(0);
    expect(mpx.state.connections).toBe(3);        // lectura, lock y la nueva para liberar
  });

  test('Ctrl+Z (SIGTSTP al grupo) durante la lectura: nada queda suspendido; interrumpe (148), cierra la lectura y libera', async () => {
    await useServer({ records: RECORDS, scenarios: ['hang'] });
    const r = await runPilot({
      args: limits(),
      killAfterMs: 45000,
      // Como la terminal: al grupo entero (el piloto y su proceso de lectura).
      during: async (child) => { await server.waitForConnections(1); process.kill(-child.pid, 'SIGTSTP'); },
    });
    expect(r.hung).toBe(false);
    expect(r.code).toBe(148);
    expect(r.json).toMatchObject({
      resultado: 'interrumpido', senal: 'SIGTSTP', codigo_salida: 148,
      liberacion: { redis: 'liberado', mysql: 'liberado' },
    });
    expect(await server.waitAllClosed(5000)).toBe(true);
    expect(await redis.exists(lockKey)).toBe(0);
    expect(await lockRows()).toBe(0);
  });

  test('clave perdida a mitad de la lectura SIN desconexión (otro dueño): la lectura no vale aunque termine antes de la renovación', async () => {
    // Los datos llegan 2.5 s después del pedido; la renovación es cada 10 s: ningún temporizador cae dentro.
    await useServer({ records: RECORDS, scenarios: ['slow'], slowMs: 2500 });
    const r = await runPilot({
      args: limits({ timeout: 20, max: 40, renew: 10 }),
      killAfterMs: 60000,
      during: async () => {
        for (let i = 0; i < 200 && !(server.connections[0] && server.connections[0].commands.includes('CMD_DATA_WRRQ')); i += 1) await sleep(25);
        // Borrada desde afuera (DEL/FLUSH/failover) y tomada por un helper habitual por Redis.
        await redis.del(lockKey);
        await redis.set(lockKey, 'habitual-it', { PX: 60000 });
      },
    });
    expect(r.hung).toBe(false);
    expect(r.json.intentos).toEqual([expect.objectContaining({ estado: 'completa', cierre: 'proceso_terminado' })]);
    expect(r.json).toMatchObject({
      resultado: 'lock_perdido', codigo_salida: 7, lectura: null,
      liberacion: { redis: 'perdido', mysql: 'liberado' },
    });
    expect(await redis.get(lockKey)).toBe('habitual-it');      // el lock ajeno, intacto
  });

  test('señal DURANTE el cierre de una lectura completa: se registra en senal, pero el resultado sigue siendo ok (0)', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    // La liberación de Redis tarda 1.2 s (menos que el tope de un paso): la señal llega en ese momento.
    let once = false;
    const px = await proxyFor(redisPort(), null, {
      delayWhen: (chunk) => {
        if (once || !RESP.contains("redis.call('del'")(chunk)) return 0;
        once = true;
        return 1200;
      },
    });
    const r = await runPilot({
      args: limits(),
      env: { REDIS_URL: `redis://127.0.0.1:${px.port}` },
      killAfterMs: 45000,
      during: async (child) => {
        for (let i = 0; i < 400 && px.state.delayed === 0; i += 1) await sleep(10);
        await sleep(200);
        child.kill('SIGTERM');
      },
    });
    expect(r.hung).toBe(false);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      resultado: 'ok', codigo_salida: 0, senal: 'SIGTERM',
      liberacion: { redis: 'liberado', mysql: 'liberado' },
    });
    expect(r.json.lectura).not.toBeNull();
  });

  test('la clave del corte nunca llega al entorno ni a los argumentos del proceso de lectura', async () => {
    await useServer({ records: RECORDS, scenarios: ['hang'] });
    let seen = null;
    const r = await runPilot({
      args: [...limits({ timeout: 3, max: 10 }), '--cutoff', CUTOFF],
      env: { PILOT_CORTE_CLAVE: CORTE_KEY },
      killAfterMs: 45000,
      during: async () => {
        await server.waitForConnections(1);
        const [pid] = liveReadChildren();
        seen = {
          env: fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean),
          cmd: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'),
        };
      },
    });
    expect(r.hung).toBe(false);
    expect(seen.env.join('\n')).not.toContain(CORTE_KEY);
    expect(seen.cmd).not.toContain(CORTE_KEY);
    const keys = seen.env.map((kv) => kv.split('=')[0]);
    expect(keys).toContain('TZ');
    for (const k of ['PILOT_CORTE_CLAVE', 'DB_PASSWORD', 'DB_USER', 'REDIS_URL']) expect(keys).not.toContain(k);
    expect(JSON.stringify(r.json) + r.stdout + r.stderr).not.toContain(CORTE_KEY);
  });

  test('cierre de MySQL sin confirmar (COM_QUIT sin respuesta): termina igual, con la lectura completa', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    // La conexión de lectura se cierra apenas se lee el reloj (1.er COM_QUIT); se congela el cierre de
    // la conexión del lock, al final (2.º COM_QUIT), después de liberar la fila.
    let quits = 0;
    const px = await proxyFor(cfg.port, (chunk) => MYSQL.comQuit(chunk) && ++quits === 2);
    const r = await runPilot({
      args: limits({ timeout: 20, max: 30 }),
      env: { DB_HOST: '127.0.0.1', DB_PORT: String(px.port) },
      killAfterMs: 45000,
    });
    expect(px.state.frozen).toBe(true);
    expect(r.hung).toBe(false);
    expect(r.ms).toBeLessThan(20000);
    expect(r.json).toMatchObject({ resultado: 'ok', codigo_salida: 0 });
    expect(await lockRows()).toBe(0);
  });

  // ─── Corte temporal común: el mismo conjunto histórico en dos corridas ─

  test('sin corte (control): con marcas nuevas entre corridas, los agregados difieren', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    const r1 = await runPilot({ args: limits() });
    await useServer({ records: [...RECORDS, ...AFTER_CUTOFF], scenarios: ['ok'] });
    const r2 = await runPilot({ args: limits() });
    expect([r1.code, r2.code]).toEqual([0, 0]);
    expect([r1.json.lectura.registros, r2.json.lectura.registros]).toEqual([31, 37]);
  });

  /** Compara dos salidas con el CLI de comparación (sin conexiones). */
  function compareOutputs(a, b) {
    const fa = path.join(tmpDir, `cmp-${seq}-a.json`);
    const fb = path.join(tmpDir, `cmp-${seq}-b.json`);
    fs.writeFileSync(fa, JSON.stringify(a));
    fs.writeFileSync(fb, JSON.stringify(b));
    const r = require('child_process').spawnSync(process.execPath, [COMPARE, fa, fb], { encoding: 'utf8', timeout: 20000 });
    return { status: r.status, out: JSON.parse(r.stdout) };
  }
  const corteArgs = (cutoff = CUTOFF) => [...limits(), '--cutoff', cutoff];
  const corteEnv = { PILOT_CORTE_CLAVE: CORTE_KEY };

  test('corte común: dos corridas con marcas nuevas entre medio dan el mismo conjunto anterior al corte', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    const r1 = await runPilot({ args: corteArgs(), env: corteEnv });
    await useServer({ records: [...RECORDS, ...AFTER_CUTOFF], scenarios: ['ok'] });
    const r2 = await runPilot({ args: corteArgs(), env: corteEnv });
    expect([r1.code, r2.code]).toEqual([0, 0]);
    expect([r1.json.lectura.registros, r2.json.lectura.registros]).toEqual([31, 37]);
    expect(r1.json.corte).toMatchObject({
      hasta: CUTOFF, canon: 'sishoras.zk-raw-state-pilot.corte/2', decodificacion: { zona: 'UTC' },
      conjunto: { registros: 28, formato: 'tcp40', captura_completa: true, huella_motivo: null },
      fuera: { posteriores: 1, basura: 2 },
    });
    expect(r1.json.corte.conjunto.huella).toBe(expectedCorteHuella(RECORDS, CUTOFF, CORTE_KEY));
    expect(r1.json.corte.conjunto).toEqual(r2.json.corte.conjunto);
    expect(r2.json.corte.fuera.posteriores).toBe(7);
    // `lectura` conserva la forma del agregado completo: el corte va sólo arriba.
    expect(Object.keys(r1.json.lectura)).not.toContain('corte');
    expect(compareOutputs(r1.json, r2.json)).toEqual({ status: 0, out: { resultado: 'igual', motivo: null, delta_registros: 0 } });
    for (const r of [r1, r2]) {
      expectNoSecretsOrPeople(r.json);
      expect(JSON.stringify(r.json) + r.stdout + r.stderr).not.toContain(CORTE_KEY);
    }
  });

  test('corte común: un registro anterior al corte alterado cambia la huella del conjunto', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    const r1 = await runPilot({ args: corteArgs(), env: corteEnv });
    await useServer({ records: withAlteredBeforeCutoff(), scenarios: ['ok'] });
    const r2 = await runPilot({ args: corteArgs(), env: corteEnv });
    expect([r1.code, r2.code]).toEqual([0, 0]);
    expect(r2.json.corte.conjunto.registros).toBe(r1.json.corte.conjunto.registros);
    expect(r2.json.corte.conjunto.huella).not.toBe(r1.json.corte.conjunto.huella);
    expect(r2.json.corte.conjunto.huella).toBe(expectedCorteHuella(withAlteredBeforeCutoff(), CUTOFF, CORTE_KEY));
    expect(compareOutputs(r1.json, r2.json)).toEqual({ status: 1, out: { resultado: 'distinto', motivo: null, delta_registros: 0 } });
  });

  test('corte común: horas inexistentes del cambio de hora de Paraguay salen exactas (el hijo decodifica en UTC)', async () => {
    await useServer({ records: DST_RECORDS, scenarios: ['ok'] });
    const r = await runPilot({ args: corteArgs('2023-10-01'), env: corteEnv });
    expect(r.code).toBe(0);
    expect(r.json.corte.conjunto).toMatchObject({ registros: 15, usuarios: 5, huella_motivo: null });
    // La misma huella que el cálculo a mano en las 3 zonas de CI (con la zona heredada, las 00:30 serían 01:30).
    expect(r.json.corte.conjunto.huella).toBe(expectedCorteHuella(DST_RECORDS, '2023-10-01 23:59:59', CORTE_KEY));
    expect(r.json.lectura.duplicados_usuario_hora).toBe(0);
  });

  test('corte común sin clave: sólo conteos, sin huella (no comparable)', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    const r = await runPilot({ args: corteArgs() });
    expect(r.code).toBe(0);
    expect(r.json.corte.conjunto).toMatchObject({ registros: 28, huella: null, clave_id: null, huella_motivo: 'sin_clave' });
    // (Otra corrida sin clave: la misma salida dos veces sería `misma_corrida`.)
    expect(compareOutputs(r.json, { ...r.json, corrida_id: 'otra-corrida' })).toMatchObject({ status: 3, out: { resultado: 'no_comparable', motivo: 'sin_clave' } });
    expect(compareOutputs(r.json, r.json)).toMatchObject({ status: 3, out: { resultado: 'no_comparable', motivo: 'misma_corrida' } });
  });

  test('corte dentro del margen de 120 min: código 2 sin abrir MySQL, Redis ni el reloj', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    const { pyDateTimeStr } = require('../../src/services/zkRecordShape');
    const { addMinutesWall } = require('../../src/services/zkPilot/corte');
    const rc = await countingRedis();
    const { out: r, statements, connects } = await auditSql(() => runPilot({
      args: corteArgs(addMinutesWall(pyDateTimeStr(new Date()), -30)), env: { ...corteEnv, ...rc.env },
    }));
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ resultado: 'corte_reciente', intentos_ejecutados: 0, corte: { conjunto: null } });
    expect([statements, connects]).toEqual([[], 0]);
    expect(rc.connections()).toBe(0);
    expect(server.connections).toHaveLength(0);
  });

  test('corte en el futuro: código 2 sin abrir MySQL, Redis ni el reloj', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    const rc = await countingRedis();
    const { out: r, statements, connects } = await auditSql(() => runPilot({ args: [...limits(), '--cutoff', '2099-01-01 00:00:00'], env: rc.env }));
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ resultado: 'corte_futuro', intentos_ejecutados: 0 });
    expect([statements, connects]).toEqual([[], 0]);
    expect(rc.connections()).toBe(0);
    expect(server.connections).toHaveLength(0);
  });
});
