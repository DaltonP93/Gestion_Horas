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
 *     (también las que fallarían), así se verifica cero intentos de
 *     INSERT/UPDATE/DELETE/DDL, incluida auditoría asíncrona.
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
const { RECORDS, USER_IDS, EXPECTED_TCP40, manyRecords } = require('./fixtures/pilotRecords');

jest.setTimeout(300000);

const API_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(API_ROOT, 'scripts', 'zk-raw-state-pilot.js');
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

/** Procesos de lectura del piloto vivos (por su línea de comando). */
function liveReadChildren() {
  const out = [];
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (cmd.includes(CHILD_MARK)) out.push(Number(pid));
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

  /** Corre el piloto como proceso real; `during(child)` actúa mientras corre. */
  async function runPilot({ args, env = {}, preload = null, during = null, id = String(deviceId) }) {
    seq += 1;
    const outFile = path.join(tmpDir, `out-${seq}.json`);
    const argv = [...(preload ? ['-r', preload] : []), SCRIPT, '--device-id', id, ...args, '--out', outFile];
    const t0 = Date.now();
    const child = spawn(process.execPath, argv, { cwd: API_ROOT, env: pilotEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    if (during) await during(child);
    const { code, signal } = await exited;
    const json = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
    return { code, signal, json, stdout, stderr, ms: Date.now() - t0, pid: child.pid };
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
    const others = rows.filter((r) => !harnessThreads.has(Number(r.thread_id)));
    return {
      out,
      statements: others.filter((r) => ['Query', 'Prepare', 'Execute'].includes(r.command_type)).map((r) => String(r.arg).replace(/\s+/g, ' ').trim()),
      connects: others.filter((r) => r.command_type === 'Connect').length,
    };
  }

  const expectReadOnly = (statements) => {
    expect(statements.filter((s) => WRITE_RE.test(s))).toEqual([]);
    expect(statements.filter((s) => !ALLOWED_RE.test(s))).toEqual([]);
  };
  const redisConnections = async () => Number(/total_connections_received:(\d+)/.exec(await redis.info('stats'))[1]);
  const expectNoSecretsOrPeople = (json) => {
    const text = JSON.stringify(json);
    for (const uid of USER_IDS) expect(text).not.toContain(uid);
    expect(text).not.toContain(ip);
    if (server) expect(text).not.toContain(String(server.port));
    expect(text).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(text).not.toMatch(/ECONN|TIMEOUT_|Error:|stack/);
    expect(text).not.toContain(cfg.password);
  };
  const delEvents = () => keyEvents.filter((e) => e.ev === 'del');

  beforeAll(async () => {
    if (!REDIS_URL) throw new Error('IT_REDIS_URL es obligatorio para esta suite (Redis aislado de pruebas)');
    conn = await makeConn();
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

  test('lectura completa: agregado exacto, sólo comandos de lectura, cero escrituras y sin conexiones al liberar', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    const { out: r, statements, connects } = await auditSql(() => runPilot({ args: limits({ attempts: 3 }) }));
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      formato: 'sishoras.zk-raw-state-pilot/1',
      resultado: 'ok',
      codigo_salida: 0,
      senal: null,
      reloj: { id: deviceId, modo_conexion: 'tcp' },
      limites: { intentos_max: 3, timeout_intento_s: 20, duracion_max_s: 60, espera_entre_intentos_s: 0, renovacion_s: 1, ttl_lock_s: 27 },
      exclusion: {
        backend: 'redis', clave: lockKey, mysql_device_locks: 'sin_lock_vigente',
        auditoria_mysql: false, fallback_mysql: false,
      },
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

    expectReadOnly(statements);
    expect(connects).toBe(1);
    expect(statements[0]).toBe('SET SESSION TRANSACTION READ ONLY');
  });

  test('lectura truncada y después completa: intentos reales, cada uno cerrado antes del siguiente', async () => {
    const many = manyRecords(2000);
    await useServer({ records: many, scenarios: ['truncate', 'ok'] });
    const { out: r, statements } = await auditSql(() => runPilot({ args: limits({ attempts: 3 }) }));
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
    expectReadOnly(statements);
  });

  // ─── Abortar antes de conectar ─────────────────────────────────

  test('captura tardía (node-zklib cargado antes): aborta antes de conectar al reloj', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    const { out: r, statements } = await auditSql(() => runPilot({ args: limits({ attempts: 2 }), preload: EARLY }));
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ resultado: 'captura_no_garantizada', intentos_ejecutados: 1, lectura: null });
    expect(r.json.intentos).toEqual([expect.objectContaining({ intento: 1, estado: 'captura_no_garantizada' })]);
    expect(server.connections).toHaveLength(0);
    expect(await redis.exists(lockKey)).toBe(0);
    expectReadOnly(statements);
  });

  test.each([['1e2'], ['01'], ['-1'], ['1.5'], ['1abc'], ['0'], ['9007199254740993'], [' 7'], ['0x10']])(
    'ID %p: código 2 sin abrir MySQL, Redis ni el reloj', async (raw) => {
      await useServer({ records: RECORDS, scenarios: ['ok'] });
      const before = await redisConnections();
      const { out: r, statements, connects } = await auditSql(() => runPilot({ args: limits(), id: raw }));
      expect(r.code).toBe(2);
      expect(r.json).toMatchObject({ resultado: 'id_invalido', reloj: { id: null }, intentos_ejecutados: 0 });
      expect([statements, connects]).toEqual([[], 0]);
      expect(await redisConnections()).toBe(before);
      expect(server.connections).toHaveLength(0);
    },
  );

  test('reloj inexistente: código 8 sin tocar Redis ni relojes', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    const before = await redisConnections();
    const { out: r, statements } = await auditSql(() => runPilot({ args: limits(), id: String(deviceId + 100000) }));
    expect(r.code).toBe(8);
    expect(r.json.resultado).toBe('reloj_inexistente');
    expect(await redisConnections()).toBe(before);
    expect(server.connections).toHaveLength(0);
    expectReadOnly(statements);
  });

  test('lock Redis ocupado por otro: código 4, el lock ajeno queda intacto', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    await redis.set(lockKey, 'worker-token', { PX: 60000 });
    const { out: r, statements } = await auditSql(() => runPilot({ args: limits() }));
    expect(r.code).toBe(4);
    expect(r.json.resultado).toBe('reloj_ocupado');
    expect(await redis.get(lockKey)).toBe('worker-token');
    expect(await redis.pTTL(lockKey)).toBeGreaterThan(0);
    expect(server.connections).toHaveLength(0);
    expectReadOnly(statements);
  });

  test('lock MySQL previo con Redis libre: código 4, se suelta el Redis propio y no se toca la fila', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    await conn.query(
      "INSERT INTO device_locks (device_id, token, owner, origin, acquired_at, expires_at) VALUES (?, 'mysql-token', 'otro', 'automatic', NOW(), DATE_ADD(NOW(), INTERVAL 10 MINUTE))",
      [deviceId],
    );
    const { out: r, statements } = await auditSql(() => runPilot({ args: limits() }));
    expect(r.code).toBe(4);
    expect(r.json.resultado).toBe('lock_mysql_vigente');
    expect(await redis.exists(lockKey)).toBe(0);
    const [[row]] = await conn.query('SELECT token FROM device_locks WHERE device_id = ?', [deviceId]);
    expect(row.token).toBe('mysql-token');
    expect(server.connections).toHaveLength(0);
    expectReadOnly(statements);
  });

  test('Redis caído: código 5, sin fallback MySQL ni DDL, sin conectar al reloj', async () => {
    await useServer({ records: RECORDS, scenarios: ['ok'] });
    const { out: r, statements } = await auditSql(() => runPilot({ args: limits(), env: { REDIS_URL: 'redis://127.0.0.1:1' } }));
    expect(r.code).toBe(5);
    expect(r.json.resultado).toBe('redis_no_disponible');
    expect(server.connections).toHaveLength(0);
    expectReadOnly(statements);
    expect(statements.some((s) => /device_locks/i.test(s) && !/^SELECT/i.test(s))).toBe(false);
  });

  // ─── Cierre real: lectura colgada, límite, lock perdido, señales ─

  test('lectura colgada: cada intento se mata y se espera su fin; sin conexiones al liberar', async () => {
    await useServer({ records: RECORDS, scenarios: ['hang'] });
    const { out: r, statements } = await auditSql(() => runPilot({ args: limits({ attempts: 2, timeout: 2, max: 30 }) }));
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
    expectReadOnly(statements);
  });

  test('límite total: no empieza un intento que no cabe en la duración restante', async () => {
    await useServer({ records: RECORDS, scenarios: ['hang'] });
    const { out: r, statements } = await auditSql(() => runPilot({ args: limits({ attempts: 3, timeout: 2, max: 3 }) }));
    expect(r.code).toBe(6);
    expect(r.json).toMatchObject({ resultado: 'limite_total', intentos_ejecutados: 1 });
    expect(server.connections).toHaveLength(1);
    expect(server.openCount()).toBe(0);
    expect(delEvents()).toEqual([expect.objectContaining({ open: 0 })]);
    expectReadOnly(statements);
  });

  test('pérdida del lock durante la lectura: se mata la lectura, no se borra el lock ajeno, código 7', async () => {
    await useServer({ records: RECORDS, scenarios: ['hang'] });
    const { out: r, statements } = await auditSql(() => runPilot({
      args: limits({ timeout: 30, max: 60, renew: 1 }),
      during: async () => {
        await server.waitForConnections(1);
        await redis.set(lockKey, 'otro-dueno', { XX: true, KEEPTTL: true });
      },
    }));
    expect(r.code).toBe(7);
    expect(r.json.resultado).toBe('lock_perdido');
    expect(r.json.intentos).toEqual([expect.objectContaining({ estado: 'cancelado', codigo: 'lock_perdido', cierre: 'proceso_terminado' })]);
    expect(r.ms).toBeLessThan(15000);
    expect(await redis.get(lockKey)).toBe('otro-dueno');
    expect(await server.waitAllClosed(2000)).toBe(true);
    expectReadOnly(statements);
  });

  test.each([['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]])(
    'señal %s: cierra la lectura, libera el lock y escribe el JSON (código %d)', async (sig, exitCode) => {
      await useServer({ records: RECORDS, scenarios: ['hang'] });
      const { out: r, statements } = await auditSql(() => runPilot({
        args: limits({ timeout: 30, max: 60 }),
        during: async (child) => { await server.waitForConnections(1); await sleep(300); child.kill(sig); },
      }));
      expect([r.code, r.signal]).toEqual([exitCode, null]);
      expect(r.json).toMatchObject({ resultado: 'interrumpido', senal: sig, codigo_salida: exitCode });
      expect(r.json.intentos).toEqual([expect.objectContaining({ estado: 'cancelado', codigo: 'interrumpido', cierre: 'proceso_terminado' })]);
      expect(server.openCount()).toBe(0);
      expect(delEvents()).toEqual([expect.objectContaining({ open: 0 })]);
      expect(await redis.exists(lockKey)).toBe(0);
      expectReadOnly(statements);
    },
  );

  test('SIGKILL del proceso principal: la lectura termina sola y el lock vence por TTL', async () => {
    await useServer({ records: RECORDS, scenarios: ['hang'] });
    const { out: r, statements } = await auditSql(() => runPilot({
      args: limits({ timeout: 30, max: 60 }),
      during: async (child) => { await server.waitForConnections(1); await sleep(300); child.kill('SIGKILL'); },
    }));
    expect(r.signal).toBe('SIGKILL');
    expect(r.json).toBeNull();
    expect(await server.waitAllClosed(5000)).toBe(true);
    const ttl = await redis.pTTL(lockKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual((30 + 1 + 5 + 1) * 1000);
    expectReadOnly(statements);
  });
});
