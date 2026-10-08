'use strict';

/**
 * zkPilotIsolation.test.js — aislamiento del piloto de estados por reloj.
 *
 *  1. Grafo de módulos: ni el proceso principal ni el proceso de lectura
 *     alcanzan los caminos de importación, staging, recálculo, actualización
 *     de dispositivos, auditoría o el ORM. El proceso de lectura tampoco carga
 *     clientes de MySQL/Redis ni dotenv, e instala la captura ANTES que nada.
 *  2. Los ÚNICOS literales SQL de escritura del piloto son las cuatro
 *     sentencias de su fila de device_locks (lock.js); ninguno de DDL. El
 *     único KILL es el de su propia conexión anterior del lock (por threadId).
 *  3. Lock dual: la MISMA clave compartida que usa el worker en Redis y la fila
 *     propia en device_locks con las sentencias del fallback habitual (sin
 *     auditoría ni DDL); el helper habitual conserva su comportamiento.
 *  4. Operaciones acotadas (bounded.js): tope propio que cancela, corte que
 *     sólo deja de esperar, resultados tardíos descartados.
 */
const fs = require('fs');
const path = require('path');

const API = path.resolve(__dirname, '..');
const rel = (p) => path.relative(API, p).split(path.sep).join('/');
const PARENT_ENTRY = path.join(API, 'scripts', 'zk-raw-state-pilot.js');
const CHILD_ENTRY = path.join(API, 'src', 'services', 'zkPilot', 'readChild.js');
const PILOT_DIR = path.join(API, 'src', 'services', 'zkPilot');

const REQUIRE_RE = /require\(\s*(['"])([^'"]+)\1\s*\)/g;

/** Grafo estático de require() a partir de un archivo: { files:Set<rel>, packages:Set<name> }. */
function graph(entry) {
  const files = new Set();
  const packages = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    const key = rel(file);
    if (files.has(key)) continue;
    files.add(key);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(REQUIRE_RE)) {
      const spec = m[2];
      if (spec.startsWith('.')) {
        stack.push(require.resolve(path.resolve(path.dirname(file), spec)));
      } else {
        packages.add(spec);
      }
    }
  }
  return { files, packages };
}

const FORBIDDEN_FILES = [
  'src/services/zktecoReader.js',      // importación, staging, recálculo, devices.last_sync
  'src/services/deviceLock.js',        // auditoría MySQL + fallback MySQL con DDL
  'src/services/audit.js',
  'src/config/database.js',            // ORM de la app
  'src/services/netMetrics.js',
  'src/services/punchTypeResolver.js',
  'src/workers/syncWorker.js',
  'src/services/syncJobs.js',
];

describe('piloto de estados: grafo de módulos', () => {
  test('proceso principal: sin caminos de importación, auditoría ni ORM', () => {
    const g = graph(PARENT_ENTRY);
    for (const f of FORBIDDEN_FILES) expect([...g.files]).not.toContain(f);
    expect([...g.packages]).not.toContain('sequelize');
    expect([...g.packages]).not.toContain('node-zklib');          // el principal nunca habla con el reloj
    expect([...g.files].some((f) => f.startsWith('src/services/zkPilot/'))).toBe(true);
  });

  test('proceso principal y CLI de comparación: sin logger ni captura (nada con efectos al cargar)', () => {
    const g = graph(PARENT_ENTRY);
    for (const f of ['src/config/logger.js', 'src/services/zkRawCapture.js', 'src/services/zkPilot/aggregate.js']) {
      expect([...g.files]).not.toContain(f);
    }
    const c = graph(path.join(API, 'scripts', 'zk-raw-state-pilot-compare.js'));
    expect([...c.files].sort()).toEqual(['scripts/zk-raw-state-pilot-compare.js', 'src/services/zkPilot/corte.js']);
  });

  test('el proceso de lectura corre en UTC: nunca hereda la zona del principal', () => {
    const { childEnv } = require('../src/services/zkPilot/runPilot');
    const prev = process.env.TZ;
    try {
      process.env.TZ = 'America/Asuncion';
      expect(childEnv().TZ).toBe('UTC');
      process.env.DB_PASSWORD_PRUEBA = 'nunca';
      expect(Object.keys(childEnv())).not.toContain('DB_PASSWORD_PRUEBA');
    } finally {
      if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
      delete process.env.DB_PASSWORD_PRUEBA;
    }
  });

  test('proceso de lectura: sin base, Redis ni configuración; la captura se instala primero', () => {
    const g = graph(CHILD_ENTRY);
    for (const f of FORBIDDEN_FILES) expect([...g.files]).not.toContain(f);
    for (const p of ['sequelize', 'mysql2', 'mysql2/promise', 'redis', 'dotenv']) expect([...g.packages]).not.toContain(p);
    expect([...g.files]).toContain('src/services/zkRawCapture.js');
    const src = fs.readFileSync(CHILD_ENTRY, 'utf8');
    const first = src.match(REQUIRE_RE)[0];
    expect(first).toMatch(/zkRawCapture/);
    // node-zklib sólo se carga dentro de openZK (al conectar), nunca al cargar el módulo.
    expect(src).not.toMatch(/require\(\s*['"]node-zklib/);
  });

  test('los únicos literales SQL de escritura son los del lock propio en device_locks; ningún DDL', () => {
    const files = [PARENT_ENTRY, ...fs.readdirSync(PILOT_DIR).map((f) => path.join(PILOT_DIR, f))];
    const WRITE = /(['"`])([^'"`\n]*\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT)\s[^'"`\n]*)\1/gi;
    const found = [];
    for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(WRITE)) found.push([rel(f), m[2]]);
    expect(found).toEqual([
      ['src/services/zkPilot/lock.js', 'DELETE FROM device_locks WHERE device_id = ? AND expires_at < NOW()'],
      ['src/services/zkPilot/lock.js', 'INSERT INTO device_locks (device_id, token, owner, job_id, origin, acquired_at, expires_at) '],
      ['src/services/zkPilot/lock.js', 'UPDATE device_locks SET expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE device_id = ? AND token = ?'],
      ['src/services/zkPilot/lock.js', 'DELETE FROM device_locks WHERE device_id = ? AND token = ?'],
    ]);
    // Las mismas sentencias que el fallback del helper habitual (deviceLock.js) para limpiar, renovar y liberar.
    const habitual = fs.readFileSync(path.join(API, 'src', 'services', 'deviceLock.js'), 'utf8');
    const { MYSQL_LOCK_SQL } = require('../src/services/zkPilot/lock');
    for (const k of ['purgeExpired', 'renew', 'release']) expect(habitual).toContain(MYSQL_LOCK_SQL[k]);
  });

  test('el único KILL es el de la sesión PROPIA anterior del lock (MySQL por threadId, Redis por CLIENT ID)', () => {
    const files = [PARENT_ENTRY, ...fs.readdirSync(PILOT_DIR).map((f) => path.join(PILOT_DIR, f))];
    const found = [];
    for (const f of files) {
      // Literales de código (comillas simples o dobles), en mayúsculas como se envían; no los comentarios.
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/(['"])([^'"\n]*\bKILL\b[^'"\n]*)\1/g)) found.push([rel(f), m[2]]);
    }
    expect(found).toEqual([
      ['src/services/zkPilot/lock.js', 'KILL CONNECTION ?'],
      ['src/services/zkPilot/runPilot.js', 'KILL'],                 // sendCommand(['CLIENT', 'KILL', 'ID', <CLIENT ID propio>])
    ]);
    const src = fs.readFileSync(path.join(PILOT_DIR, 'runPilot.js'), 'utf8');
    expect(src).toContain("['CLIENT', 'KILL', 'ID', String(sessionIds.redis)]");
    expect(src).toContain('MYSQL_KILL_SQL.kill, [threadId]');
    expect(src).toMatch(/killMysqlSession\(c, run, sessionIds\.lockConn\)/);
  });
});

describe('piloto de estados: lock dual (clave Redis compartida + fila propia en device_locks)', () => {
  test('la clave es la misma que usa el helper habitual del worker', () => {
    const { keyFor } = require('../src/services/deviceLockKeys');
    expect(keyFor(7)).toBe('zk:lock:dev:7');
    const src = fs.readFileSync(path.join(API, 'src', 'services', 'deviceLock.js'), 'utf8');
    expect(src).toMatch(/require\('\.\/deviceLockKeys'\)/);
    expect(src).not.toMatch(/zk:lock:dev:/);   // una sola definición de la clave
  });

  test('Redis: SET NX PX y Lua por token', async () => {
    const { createPilotLock } = require('../src/services/zkPilot/lock');
    const { keyFor, RENEW_LUA, RELEASE_LUA } = require('../src/services/deviceLockKeys');
    const calls = [];
    const redis = {
      set: async (...a) => { calls.push(['set', ...a]); return 'OK'; },
      eval: async (script, o) => { calls.push(['eval', script, o]); return 1; },
    };
    const lock = createPilotLock({ redis, deviceId: 7, ttlMs: 30000 });
    expect(lock.key).toBe(keyFor(7));
    expect(await lock.acquire()).toBe(true);
    expect(await lock.renew()).toBe(true);
    expect(await lock.release()).toBe(true);
    expect(calls).toEqual([
      ['set', keyFor(7), lock.token, { NX: true, PX: 30000 }],
      ['eval', RENEW_LUA, { keys: [keyFor(7)], arguments: [lock.token, '30000'] }],
      ['eval', RELEASE_LUA, { keys: [keyFor(7)], arguments: [lock.token] }],
    ]);
    expect(lock.token).toMatch(/^pilot:[0-9a-f]{32}$/);
  });

  test('Redis: ocupado → false; renovación ajena → false; liberar no borra un lock ajeno; caído → lanza', async () => {
    const { createPilotLock } = require('../src/services/zkPilot/lock');
    let lock = createPilotLock({ redis: { set: async () => null, eval: async () => 0 }, deviceId: 7, ttlMs: 30000 });
    expect(await lock.acquire()).toBe(false);
    expect(await lock.renew()).toBe(false);
    expect(await lock.release()).toBe(false);
    lock = createPilotLock({
      redis: { set: async () => { throw new Error('Connection is closed'); }, eval: async () => { throw new Error('closed'); } },
      deviceId: 7, ttlMs: 30000,
    });
    await expect(lock.acquire()).rejects.toThrow();
    await expect(lock.renew()).rejects.toThrow();
  });

  const fakeConn = (handler) => {
    const sqls = [];
    return {
      sqls,
      query: async (sql, params) => { sqls.push([sql, params]); return handler(sql, params); },
    };
  };

  test('MySQL: limpia sólo la fila VENCIDA de su reloj, inserta la propia, renueva y libera por token', async () => {
    const { createMysqlLock, MYSQL_LOCK_SQL } = require('../src/services/zkPilot/lock');
    const c = fakeConn(() => [{ affectedRows: 1 }]);
    const lock = createMysqlLock({ conn: c, deviceId: 7, ttlS: 27, token: 'pilot:abc', owner: 'piloto:host:1' });
    expect(await lock.acquire()).toBe('tomado');
    expect(await lock.renew()).toBe(true);
    expect(await lock.release()).toBe(true);
    expect(c.sqls).toEqual([
      [MYSQL_LOCK_SQL.purgeExpired, [7]],
      [MYSQL_LOCK_SQL.insert, [7, 'pilot:abc', 'piloto:host:1', 'piloto_estados', 27]],
      [MYSQL_LOCK_SQL.renew, [27, 7, 'pilot:abc']],
      [MYSQL_LOCK_SQL.release, [7, 'pilot:abc']],
    ]);
  });

  test('MySQL: fila vigente de otro → ocupado; fila ajena o vencida al renovar/liberar → false; otros errores lanzan', async () => {
    const { createMysqlLock, mysqlLockError } = require('../src/services/zkPilot/lock');
    const err = (code) => Object.assign(new Error(code), { code });
    let lock = createMysqlLock({
      conn: fakeConn((sql) => { if (/^INSERT/.test(sql)) throw Object.assign(err('ER_DUP_ENTRY'), { errno: 1062 }); return [{ affectedRows: 0 }]; }),
      deviceId: 7, ttlS: 27, token: 'pilot:abc', owner: 'x',
    });
    expect(await lock.acquire()).toBe('ocupado');
    expect(await lock.renew()).toBe(false);
    expect(await lock.release()).toBe(false);
    for (const [code, errno, kind] of [['ER_NO_SUCH_TABLE', 1146, 'sin_acceso'], ['ER_TABLEACCESS_DENIED_ERROR', 1142, 'sin_acceso'], ['ECONNRESET', undefined, 'error']]) {
      const e = Object.assign(err(code), { errno });
      lock = createMysqlLock({ conn: fakeConn(() => { throw e; }), deviceId: 7, ttlS: 27, token: 't', owner: 'x' });
      await expect(lock.acquire()).rejects.toThrow(code);
      expect(mysqlLockError(e)).toBe(kind);
    }
    // Si se dejó de esperar entre la limpieza y el INSERT, el INSERT no se envía.
    const c = fakeConn(() => [{ affectedRows: 0 }]);
    lock = createMysqlLock({ conn: c, deviceId: 7, ttlS: 27, token: 't', owner: 'x' });
    await expect(lock.acquire(() => true)).rejects.toMatchObject({ code: 'PILOT_STOPPED' });
    expect(c.sqls.map(([s]) => s.split(' ')[0])).toEqual(['DELETE']);
    expect(createMysqlLock({ conn: fakeConn(() => [{}]), deviceId: 7, ttlS: 1, token: 't', owner: 'o'.repeat(80) }).token).toBe('t');
  });
});

describe('piloto de estados: sesión de la conexión del lock', () => {
  test('la zona de sesión es la MISMA que usa la app (Sequelize) para device_locks', () => {
    const { DB_TIMEZONE, LOCK_SESSION_SQL } = require('../src/services/zkPilot/lock');
    let appTz;
    jest.isolateModules(() => {
      jest.doMock('../src/config/logger', () => ({ debug() {}, info() {}, warn() {}, error() {} }));
      appTz = require('../src/config/database').DB_TIMEZONE;
    });
    expect(DB_TIMEZONE).toBe(appTz);
    expect(LOCK_SESSION_SQL.set).toMatch(/^SET SESSION time_zone = \?, SESSION autocommit = 1, SESSION innodb_lock_wait_timeout = 2, SESSION lock_wait_timeout = 2$/);
  });

  test('sesión válida sólo con la zona de la app, autocommit y base escribible', () => {
    const { lockSessionOk } = require('../src/services/zkPilot/lock');
    const ok = { tz: '-03:00', ac: 1, ro: 0, sro: 0 };
    expect(lockSessionOk(ok)).toBe(true);
    for (const bad of [{ tz: 'SYSTEM' }, { tz: '+00:00' }, { ac: 0 }, { ro: 1 }, { sro: 1 }]) {
      expect(lockSessionOk({ ...ok, ...bad })).toBe(false);
    }
    expect(lockSessionOk(undefined)).toBe(false);
  });

  test('renovación: filas encontradas por `info` (independiente de FOUND_ROWS), con affectedRows de respaldo', () => {
    const { rowsMatched } = require('../src/services/zkPilot/lock');
    expect(rowsMatched({ info: 'Rows matched: 1  Changed: 0  Warnings: 0', affectedRows: 0 })).toBe(1);
    expect(rowsMatched({ info: 'Rows matched: 0  Changed: 0  Warnings: 0', affectedRows: 0 })).toBe(0);
    expect(rowsMatched({ affectedRows: 1 })).toBe(1);
  });

  test('cancelar destruye el SOCKET con un error fatal (no el cierre a medias de destroy())', () => {
    const { hardCancelMysql } = require('../src/services/zkPilot/lock');
    const stream = { destroyed: false, destroy: jest.fn(function destroy() { this.destroyed = true; }) };
    hardCancelMysql({ connection: { stream } });
    expect(stream.destroy).toHaveBeenCalledWith(expect.objectContaining({ code: 'PILOT_CANCELLED', fatal: true }));
    hardCancelMysql({ connection: { stream } });               // idempotente
    expect(stream.destroy).toHaveBeenCalledTimes(1);
    expect(() => hardCancelMysql(null)).not.toThrow();
  });

  test('errores: sólo 1062 es ocupado; sin tabla y sin permiso no se distinguen', () => {
    const { mysqlLockError } = require('../src/services/zkPilot/lock');
    expect(mysqlLockError({ errno: 1062 })).toBe('ocupado');
    for (const errno of [1142, 1044, 1146]) expect(mysqlLockError({ errno })).toBe('sin_acceso');
    for (const errno of [1205, 1213]) expect(mysqlLockError({ errno })).toBe('espera_de_bloqueo');
    expect(mysqlLockError({ code: 'ER_DUP_ENTRY' })).toBe('error');   // sin errno no se presume nada
    expect(mysqlLockError(new Error('x'))).toBe('error');
  });
});

describe('piloto de estados: orden de las conexiones MySQL (dobles de mysql2 y redis)', () => {
  const REPO = path.resolve(API, '..');
  const OPTS = { deviceId: 7, attempts: 1, attemptTimeoutS: 5, maxDurationS: 10, cooldownS: 0, renewS: 1, cutoff: null };
  // Los clientes se cargan al llamarlos (fuera de isolateModules): sin esto, el doble quedaría en el
  // registro global para las pruebas siguientes.
  afterEach(() => {
    jest.dontMock('mysql2/promise');
    jest.dontMock('redis');
    jest.resetModules();
  });

  // Error de red (sin respuesta del servidor): no prueba que la sentencia o el comando no se aplicó.
  const netError = () => Object.assign(new Error('socket cerrado'), { code: 'ECONNRESET' });

  /**
   * insert: 'dup' (otro tiene la fila) | 'red' (la toma falla por red y la conexión queda rota).
   * redisSet: 'ok' | 'red' (la toma falla por red y el cliente queda roto).
   * kill: 'ok' | 'denegado' (KILL CONNECTION sin permiso: 1095).
   * Las conexiones MySQL y los clientes Redis se numeran por orden; `log` registra todo en orden.
   */
  async function runWith({ session = { tz: '-03:00', ac: 1, ro: 0, sro: 0 }, insert = 'dup', redisSet = 'ok', kill = 'ok' } = {}) {
    const log = [];
    const redisOptions = [];
    let n = 0;
    let rn = 0;
    let runPilot;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('mysql2/promise', () => ({
        createConnection: async () => {
          n += 1;
          const id = n;
          let broken = false;
          log.push([id, 'connect']);
          return {
            threadId: 900 + id,
            connection: { stream: { destroyed: false, destroy() { this.destroyed = true; } }, on() {} },
            async query(sql, params) {
              const text = sql.replace(/\s+/g, ' ').trim();
              log.push(/KILL|PROCESSLIST/.test(text) ? [id, text, params] : [id, text]);
              if (broken) throw netError();
              if (/^SELECT id, ip_address/.test(sql)) return [[{ id: 7, ip_address: '192.0.2.1', port: 4370, connection_mode: 'tcp', timeout_ms: 1000 }]];
              if (/^SELECT @@session/.test(sql)) return [[session]];
              if (/^INSERT/.test(sql) && insert === 'dup') throw Object.assign(new Error('dup'), { errno: 1062 });
              if (/^INSERT/.test(sql) && insert === 'red') { broken = true; throw netError(); }
              if (/^KILL/.test(sql) && kill === 'denegado') throw Object.assign(new Error('no es tuya'), { errno: 1095 });
              if (/PROCESSLIST/.test(sql)) return [[{ n: 0 }]];
              if (/^DELETE FROM device_locks WHERE device_id = \? AND token/.test(sql)) return [{ affectedRows: 0 }];
              return [{ affectedRows: 1, info: 'Rows matched: 1' }];
            },
            async end() { log.push([id, 'end']); },
          };
        },
      }));
      jest.doMock('redis', () => ({
        createClient: (options) => {
          rn += 1;
          redisOptions.push(options);
          const id = `r${rn}`;
          let broken = false;
          const cmd = async (name, value) => { log.push([id, name]); if (broken) throw netError(); return value; };
          return {
            options,
            isOpen: true,
            on() {},
            connect: () => cmd('connect'),
            clientId: () => cmd('CLIENT ID', 101),
            async set(key, token, o) {
              log.push([id, `SET NX PX ${o.PX}`]);
              if (broken || redisSet === 'red') { broken = true; throw netError(); }
              return 'OK';
            },
            eval: () => cmd('EVAL', 1),
            sendCommand: (args) => cmd(args.join(' '), 1),
            quit: () => cmd('QUIT'),
            async disconnect() { log.push([id, 'disconnect']); },
          };
        },
      }));
      ({ runPilot } = require('../src/services/zkPilot/runPilot'));
    });
    const { json } = await runPilot(OPTS, { env: {}, rootDir: REPO });
    return { json, log, redisOptions };
  }

  test('lectura READ ONLY cerrada antes de abrir la del lock; la sesión del lock se fija y verifica ANTES de escribir', async () => {
    const { json, log } = await runWith();
    expect(json).toMatchObject({ resultado: 'lock_mysql_vigente', exclusion: { mysql: { estado: 'ocupado' } } });
    const { LOCK_SESSION_SQL, MYSQL_LOCK_SQL } = require('../src/services/zkPilot/lock');
    expect(log).toEqual([
      [1, 'connect'],
      [1, 'SET SESSION TRANSACTION READ ONLY'],
      [1, 'SELECT id, ip_address, port, connection_mode, timeout_ms FROM devices WHERE id = ? LIMIT 1'],
      [1, 'end'],
      ['r1', 'connect'],
      ['r1', 'CLIENT ID'],
      ['r1', 'SET NX PX 30000'],              // TTL provisional: el completo llega con la verificación previa al intento
      [2, 'connect'],
      [2, LOCK_SESSION_SQL.set],
      [2, LOCK_SESSION_SQL.check],
      [2, MYSQL_LOCK_SQL.purgeExpired],
      [2, MYSQL_LOCK_SQL.insert.replace(/\s+/g, ' ').trim()],
      ['r1', 'EVAL'],
      // Los cierres corren en paralelo: Redis con disconnect() (nunca QUIT) y MySQL con end().
      expect.anything(),
      expect.anything(),
    ]);
    expect(log.slice(-2)).toEqual(expect.arrayContaining([[2, 'end'], ['r1', 'disconnect']]));
  });

  test('cliente Redis: sin reconexión, sin cola offline y sin CLIENT SETINFO al conectar', async () => {
    const { log, redisOptions } = await runWith({ redisSet: 'red' });
    expect(redisOptions).toHaveLength(2);                    // el del lock y el nuevo para compensar
    for (const o of redisOptions) {
      expect(o).toMatchObject({ disableOfflineQueue: true, disableClientInfo: true, socket: { reconnectStrategy: false } });
      expect(o.socket.connectTimeout).toBeGreaterThan(0);
    }
    expect(log.filter(([, c]) => c === 'QUIT')).toEqual([]);
  });

  test('toma MySQL incierta (red) con la conexión rota: se MATA la sesión vieja y recién después se compensa por token', async () => {
    const { json, log } = await runWith({ insert: 'red' });
    const { MYSQL_KILL_SQL, MYSQL_LOCK_SQL } = require('../src/services/zkPilot/lock');
    expect(json).toMatchObject({
      resultado: 'exclusion_no_garantizada', exclusion: { mysql: { estado: 'error' } },
      liberacion: { redis: 'liberado', mysql: 'compensado' },
    });
    const fresh = log.filter(([id]) => id === 3).map(([, s, p]) => (p ? [s, p] : s));
    expect(fresh).toEqual([
      'connect',
      expect.stringMatching(/^SET SESSION time_zone/),
      [MYSQL_KILL_SQL.kill, [902]],                 // el hilo de la conexión del lock (threadId 902)
      [MYSQL_KILL_SQL.alive, [902]],
      MYSQL_LOCK_SQL.release,
    ]);
  });

  test('toma MySQL incierta sin poder matar la sesión vieja (sin permiso) y nada que borrar: incierto, nunca no_tomado', async () => {
    const { json } = await runWith({ insert: 'red', kill: 'denegado' });
    expect(json.liberacion).toEqual({ redis: 'liberado', mysql: 'incierto' });
    expect(json.limites.ttl_provisional_s).toBe(30);
  });

  test('toma Redis incierta (red) con el cliente roto: CLIENT KILL de la sesión vieja por un cliente nuevo y después EVAL', async () => {
    const { json, log } = await runWith({ redisSet: 'red' });
    expect(json).toMatchObject({ resultado: 'redis_no_disponible', liberacion: { redis: 'compensado', mysql: 'no_tomado' } });
    expect(log.filter(([id]) => id === 'r2').map(([, c]) => c)).toEqual(['connect', 'CLIENT KILL ID 101', 'EVAL', 'disconnect']);
    // La base sólo se usó para leer el reloj.
    expect(log.filter(([id]) => id === 2)).toEqual([]);
  });

  test.each([
    [{ tz: 'SYSTEM', ac: 1, ro: 0, sro: 0 }], [{ tz: '+00:00', ac: 1, ro: 0, sro: 0 }],
    [{ tz: '-03:00', ac: 0, ro: 0, sro: 0 }], [{ tz: '-03:00', ac: 1, ro: 1, sro: 0 }], [{ tz: '-03:00', ac: 1, ro: 0, sro: 1 }],
  ])('sesión del lock inválida %p: exclusion_no_garantizada sin ninguna escritura', async (session) => {
    const { json, log } = await runWith({ session });
    expect(json).toMatchObject({ resultado: 'exclusion_no_garantizada', codigo_salida: 4, exclusion: { mysql: { estado: 'sesion_invalida' } } });
    expect(log.filter(([, s]) => /^(DELETE|INSERT|UPDATE)/.test(s))).toEqual([]);
    expect(json.intentos_ejecutados).toBe(0);
  });
});

describe('piloto de estados: operaciones acotadas (bounded.js)', () => {
  const { bounded, createStop, BoundedError } = require('../src/services/zkPilot/bounded');
  const never = () => new Promise(() => {});

  test('sin respuesta: vence su tope, CANCELA el cliente y rechaza', async () => {
    const cancel = jest.fn();
    const t0 = Date.now();
    await expect(bounded('redis', never, { capMs: 50, cancel })).rejects.toMatchObject({ motivo: 'timeout', kind: 'redis' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('corte (límite total, señal, lock perdido): deja de esperar SIN cancelar el cliente', async () => {
    const cancel = jest.fn();
    const stop = createStop();
    const p = bounded('mysql', never, { capMs: 60000, cancel, stop });
    stop.fire();
    await expect(p).rejects.toMatchObject({ motivo: 'detenido', kind: 'mysql' });
    expect(cancel).not.toHaveBeenCalled();
    // Ya cortado: una operación nueva no se LANZA (una toma no puede salir después de abortar).
    const fn = jest.fn(never);
    await expect(bounded('mysql', fn, { capMs: 60000, cancel, stop })).rejects.toBeInstanceOf(BoundedError);
    expect(fn).not.toHaveBeenCalled();
  });

  test('resultado a tiempo; error envuelto con su causa; resultado tardío descartado sin rechazo suelto', async () => {
    await expect(bounded('mysql', async () => 42, { capMs: 1000 })).resolves.toBe(42);
    const cause = new Error('denied');
    await expect(bounded('mysql', async () => { throw cause; }, { capMs: 1000 })).rejects.toMatchObject({ motivo: 'error', cause });
    await expect(bounded('mysql', () => { throw cause; }, { capMs: 1000 })).rejects.toMatchObject({ motivo: 'error', cause });
    let late;
    const slow = new Promise((_, rej) => { late = rej; });
    await expect(bounded('redis', () => slow, { capMs: 20 })).rejects.toMatchObject({ motivo: 'timeout' });
    late(new Error('tarde'));            // sin unhandledRejection: el rechazo tardío ya tiene manejador
    await new Promise((r) => setImmediate(r));
  });
});

describe('helper habitual del worker: comportamiento conservado', () => {
  test('con Redis: misma clave y SIGUE auditando (camino del worker sin cambios)', async () => {
    let deviceLock;
    let audit;
    let setKey;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('redis', () => ({
        createClient: () => ({
          on() {}, connect: async () => {},
          set: async (k) => { setKey = k; return 'OK'; },
        }),
      }));
      jest.doMock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
      jest.doMock('../src/config/logger', () => ({ info() {}, warn() {}, error() {} }));
      jest.doMock('../src/services/audit', () => ({ log: jest.fn() }));
      deviceLock = require('../src/services/deviceLock');
      audit = require('../src/services/audit');
    });
    const h = await deviceLock.acquire(7, { origin: 'automatic' });
    expect(h.backend).toBe('redis');
    expect(setKey).toBe(require('../src/services/deviceLockKeys').keyFor(7));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'device_lock.acquire', entity_id: 7 }));
  });
});
