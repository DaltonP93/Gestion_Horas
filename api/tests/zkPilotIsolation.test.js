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

  test('el proceso de lectura corre en UTC y no recibe secretos: ni la clave del corte, ni la base, ni Redis', () => {
    const { childEnv } = require('../src/services/zkPilot/runPilot');
    const SECRETS = ['PILOT_CORTE_CLAVE', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'REDIS_URL', 'JWT_SECRET'];
    const saved = Object.fromEntries(['TZ', ...SECRETS].map((k) => [k, process.env[k]]));
    try {
      process.env.TZ = 'America/Asuncion';
      for (const k of SECRETS) process.env[k] = k === 'PILOT_CORTE_CLAVE' ? 'ab'.repeat(32) : `valor-${k}`;
      const env = childEnv();
      expect(env.TZ).toBe('UTC');
      for (const k of SECRETS) expect(Object.keys(env)).not.toContain(k);
      // Lista blanca exacta (la clave viaja SÓLO por el canal IPC).
      expect(Object.keys(env).every((k) => ['TZ', 'PATH', 'LANG', 'LC_ALL', 'NODE_ENV', 'NODE_OPTIONS', 'HOME'].includes(k))).toBe(true);
      expect(JSON.stringify(env)).not.toContain('ab'.repeat(32));
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
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

  /**
   * Literales de cadena de un fuente JS (comillas simples, dobles y plantillas, también de varias
   * líneas; en las plantillas, el texto y, recursivamente, lo que haya dentro de `${…}`) y el código
   * sin comentarios ni cadenas. Las expresiones regulares literales se saltan (pueden tener comillas).
   */
  function tokens(src) {
    const literals = [];
    let code = '';
    let prev = '';
    let i = 0;
    const regexBefore = /[(,=:[!&|?{};+\-*%<>~^]/;
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
      if (c === '/' && (prev === '' || regexBefore.test(prev) || /\breturn\s*$/.test(code))) {
        let j = i + 1;
        let cls = false;
        while (j < src.length && (src[j] !== '/' || cls)) {
          if (src[j] === '\\') j += 1;
          else if (src[j] === '[') cls = true;
          else if (src[j] === ']') cls = false;
          j += 1;
        }
        i = j + 1;
        code += ' /re/ ';
        prev = '/';
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        let j = i + 1;
        let buf = '';
        while (j < src.length && src[j] !== c) {
          if (src[j] === '\\') { buf += src[j + 1]; j += 2; continue; }
          if (c === '`' && src[j] === '$' && src[j + 1] === '{') {
            let depth = 1;
            const from = j + 2;
            j = from;
            buf += ' ';
            while (j < src.length && depth) { if (src[j] === '{') depth += 1; else if (src[j] === '}') depth -= 1; j += 1; }
            // La expresión de adentro es código: sus literales y su código cuentan igual.
            const inner = tokens(src.slice(from, j - 1));
            literals.push(...inner.literals);
            code += ` ${inner.code} `;
            continue;
          }
          buf += src[j];
          j += 1;
        }
        literals.push(buf);
        code += ' "" ';
        prev = '"';
        i = j + 1;
        continue;
      }
      code += c;
      if (!/\s/.test(c)) prev = c;
      i += 1;
    }
    return { literals, code };
  }
  /** Todo lo que carga el piloto: proceso principal, proceso de lectura y CLI de comparación. */
  const PILOT_FILES = () => [...new Set([
    ...graph(PARENT_ENTRY).files, ...graph(CHILD_ENTRY).files, ...graph(path.join(API, 'scripts', 'zk-raw-state-pilot-compare.js')).files,
  ])].sort();
  const scan = (test) => {
    const found = [];
    for (const f of PILOT_FILES()) {
      for (const lit of tokens(fs.readFileSync(path.join(API, f), 'utf8')).literals) if (test(lit)) found.push([f, lit.replace(/\s+/g, ' ').trim()]);
    }
    return found;
  };

  test('el tokenizador ve lo que un regex por línea no veía (comillas mezcladas, plantillas, varias líneas, piezas sueltas)', () => {
    const src = [
      "const a = \"UPDATE devices SET note = 'x' WHERE id = 1\";",
      'const b = `UPDATE devices',
      '  SET last_sync = NOW()`;',
      "const c = ['update', 'devices'].join(' ');",
      'const d = `KILL ${threadId}`;',
      "const e = /['\"`]/.test(x); // 'DROP TABLE en un comentario'",
      "/* 'DELETE FROM x' */ const f = 'ok';",
      "const g = `${'KILL QUERY'} 0`; c.FLUSHALL(); c.sendCommand(cmd);",
    ].join('\n');
    const { literals, code } = tokens(src);
    expect(literals).toEqual([
      "UPDATE devices SET note = 'x' WHERE id = 1", 'UPDATE devices\n  SET last_sync = NOW()', 'update', 'devices', ' ',
      'KILL  ', 'ok', 'KILL QUERY', '  0',
    ]);
    expect(code.match(REDIS_FORBIDDEN_CODE)).toEqual(['FLUSHALL']);
    expect(code.match(SEND_COMMAND_NOT_ARRAY)).toHaveLength(1);
  });

  // Métodos/alias de node-redis que el piloto nunca usa (también en MAYÚSCULAS: CLIENT_KILL, FLUSHALL…),
  // escrituras de Redis fuera del lock, y sendCommand con algo que no sea una lista literal.
  const REDIS_FORBIDDEN_CODE = /\b(client_?kill|flush_?all|flush_?db|config_?set|config_?rewrite|shutdown|slaveof|replicaof)\b/gi;
  const REDIS_WRITE_CODE = /\.\s*(del|unlink|expire|pexpire|expireat|pexpireat|setex|psetex|setnx|getdel|getset|persist|rename|renamenx|incr|incrby|decr|decrby|append|mset|msetnx|hset|hdel|lpush|rpush|sadd|srem|zadd|zrem)\s*\(/gi;
  const SEND_COMMAND_NOT_ARRAY = /sendCommand\(\s*(?!\[)/g;
  const SQL_WRITE = /\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|CREATE\s|ALTER\s|DROP\s|TRUNCATE\s|RENAME\s|GRANT\s|REVOKE\s|LOAD\s+DATA)/i;
  const SQL_WORD = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE)\s*$/i;

  test('los únicos literales SQL de escritura son los del lock propio en device_locks; ningún DDL (todo el grafo del piloto)', () => {
    expect(scan((lit) => SQL_WRITE.test(lit) || SQL_WORD.test(lit))).toEqual([
      ['src/services/zkPilot/lock.js', 'DELETE FROM device_locks WHERE device_id = ? AND expires_at < NOW()'],
      ['src/services/zkPilot/lock.js', 'INSERT INTO device_locks (device_id, token, owner, job_id, origin, acquired_at, expires_at)'],
      ['src/services/zkPilot/lock.js', 'UPDATE device_locks SET expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE device_id = ? AND token = ?'],
      ['src/services/zkPilot/lock.js', 'DELETE FROM device_locks WHERE device_id = ? AND token = ?'],
    ]);
    // Las mismas sentencias que el fallback del helper habitual (deviceLock.js) para limpiar, renovar y liberar.
    const habitual = fs.readFileSync(path.join(API, 'src', 'services', 'deviceLock.js'), 'utf8');
    const { MYSQL_LOCK_SQL } = require('../src/services/zkPilot/lock');
    for (const k of ['purgeExpired', 'renew', 'release']) expect(habitual).toContain(MYSQL_LOCK_SQL[k]);
  });

  test('el único KILL es el de la sesión PROPIA anterior del lock, atado a su identidad; ningún FLUSH ni CONFIG', () => {
    expect(scan((lit) => /\bkill\b/i.test(lit))).toEqual([
      ['src/services/zkPilot/lock.js', 'KILL CONNECTION ?'],
      ['src/services/zkPilot/runPilot.js', 'KILL'],                 // sendCommand(['CLIENT', 'KILL', 'ID', id, 'ADDR', addr])
    ]);
    // Comandos Redis arbitrarios sólo por sendCommand, y sólo estos: identidad de la sesión y el KILL.
    const sent = [];
    for (const f of PILOT_FILES()) {
      const src = fs.readFileSync(path.join(API, f), 'utf8');
      for (const m of src.matchAll(/sendCommand\(\s*\[([^\]]*)\]/g)) sent.push([f, m[1].replace(/\s+/g, ' ').trim()]);
      const { code } = tokens(src);
      expect([f, code.match(REDIS_FORBIDDEN_CODE), code.match(REDIS_WRITE_CODE), code.match(SEND_COMMAND_NOT_ARRAY)]).toEqual([f, null, null, null]);
    }
    expect(sent).toEqual([
      ['src/services/zkPilot/runPilot.js', "'CLIENT', 'INFO'"],
      ['src/services/zkPilot/runPilot.js', "'INFO', 'server'"],
      ['src/services/zkPilot/runPilot.js', "'INFO', 'server'"],
      ['src/services/zkPilot/runPilot.js', "'CLIENT', 'KILL', 'ID', id, 'ADDR', addr"],
    ]);
    const src = fs.readFileSync(path.join(PILOT_DIR, 'runPilot.js'), 'utf8');
    // Redis: sólo en el MISMO servidor (run_id) y con id Y dirección de la sesión vieja.
    expect(src).toContain("if (parseRunId(await run(() => c.sendCommand(['INFO', 'server']))) === runId) {");
    expect(src).toContain("await run(() => c.sendCommand(['CLIENT', 'KILL', 'ID', id, 'ADDR', addr]));");
    // MySQL: sólo con el mismo arranque del servidor y el mismo HOST del hilo.
    expect(src).toContain('if (bootMs === null || Math.abs(bootMs - ident.bootMs) > BOOT_TOLERANCE_MS) return false;');
    expect(src).toContain('if (String(rows[0].host) !== ident.host) return false;');
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

  // Error de red con la forma REAL de mysql2/node-redis: errno entero NEGATIVO (libuv), sin SQLSTATE.
  // No prueba que la sentencia o el comando no se aplicó.
  const netError = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', errno: -104, syscall: 'read', fatal: true });
  // Respuesta de error del servidor MySQL: errno positivo con SQLSTATE.
  const serverError = (errno, sqlState = 'HY000') => Object.assign(new Error(`servidor ${errno}`), { errno, sqlState });
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * insert: 'dup' (otro tiene la fila) | 'red' (la toma falla por red y la conexión queda rota) | 'ok'.
   * redisSet: 'ok' | 'red' (la toma falla por red y el cliente queda roto).
   * kill: 'ok' | 'denegado' (KILL CONNECTION sin permiso: 1095).
   * reinicio: el servidor MySQL o Redis que atiende al cliente NUEVO arrancó después (otro servidor).
   * hostAjeno: el número de conexión vieja lo tiene OTRA conexión (otro HOST).
   * selectMs / evalMs: demora del SELECT del reloj / de la primera renovación en Redis.
   * Las conexiones MySQL y los clientes Redis se numeran por orden; `log` registra todo en orden.
   */
  async function runWith({
    session = { tz: '-03:00', ac: 1, ro: 0, sro: 0 }, insert = 'dup', redisSet = 'ok', kill = 'ok',
    reinicio = null, hostAjeno = false, selectMs = 0, evalMs = 0, opts = {},
  } = {}) {
    const log = [];
    const redisOptions = [];
    const killed = new Set();
    let n = 0;
    let rn = 0;
    let evals = 0;
    let runPilot;
    const t0 = Date.now();
    await jest.isolateModulesAsync(async () => {
      jest.doMock('mysql2/promise', () => ({
        createConnection: async () => {
          n += 1;
          const id = n;
          let broken = false;
          log.push([id, 'connect']);
          // Arranque del servidor: 1 h antes de la prueba; con `reinicio: 'mysql'`, el de la conexión nueva es otro.
          const uptimeS = () => Math.floor((Date.now() - t0) / 1000) + (reinicio === 'mysql' && id >= 3 ? 1 : 3600);
          return {
            threadId: 900 + id,
            connection: { stream: { destroyed: false, destroy() { this.destroyed = true; } }, on() {} },
            async query(sql, params) {
              const text = sql.replace(/\s+/g, ' ').trim();
              log.push(/KILL|PROCESSLIST|^INSERT/.test(text) ? [id, text, params] : [id, text]);
              if (broken) throw netError();
              if (/^SELECT id, ip_address/.test(sql)) {
                if (selectMs) await sleepMs(selectMs);
                return [[{ id: 7, ip_address: '192.0.2.1', port: 4370, connection_mode: 'tcp', timeout_ms: 1000 }]];
              }
              if (/^SELECT @@session/.test(sql)) return [[session]];
              if (/^SHOW GLOBAL STATUS/.test(sql)) return [[{ Variable_name: 'Uptime', Value: String(uptimeS()) }]];
              if (/PROCESSLIST/.test(sql)) {
                const [tid] = params;
                if (killed.has(tid)) return [[]];
                return [[{ host: hostAjeno && id >= 3 ? '10.9.9.9:5555' : `127.0.0.1:4${tid}` }]];
              }
              if (/^INSERT/.test(sql) && insert === 'dup') throw serverError(1062, '23000');
              if (/^INSERT/.test(sql) && insert === 'red') { broken = true; throw netError(); }
              if (/^KILL/.test(sql)) {
                if (kill === 'denegado') throw serverError(1095);
                killed.add(params[0]);
              }
              if (/^DELETE FROM device_locks WHERE device_id = \? AND token/.test(sql)) return [{ affectedRows: insert === 'ok' ? 1 : 0 }];
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
          const runId = reinicio === 'redis' && rn >= 2 ? 'b'.repeat(40) : 'a'.repeat(40);
          return {
            options,
            isOpen: true,
            on() {},
            connect: () => cmd('connect'),
            async set(key, token, o) {
              log.push([id, `SET NX PX ${o.PX}`]);
              if (broken || redisSet === 'red') { broken = true; throw netError(); }
              return 'OK';
            },
            async eval() {
              evals += 1;
              if (evals === 1 && evalMs) await sleepMs(evalMs);
              // Con la toma perdida en la red, la clave nunca llegó: liberar no encuentra nada.
              return cmd('EVAL', redisSet === 'red' ? 0 : 1);
            },
            sendCommand: (args) => {
              const name = args.join(' ');
              if (name === 'CLIENT INFO') return cmd(name, `id=${rn === 1 ? 101 : 202} addr=127.0.0.1:5555 laddr=127.0.0.1:6379 fd=8 name=\n`);
              if (name === 'INFO server') return cmd(name, `# Server\r\nredis_version:7.2.4\r\nrun_id:${runId}\r\n`);
              return cmd(name, 1);
            },
            quit: () => cmd('QUIT'),
            async disconnect() { log.push([id, 'disconnect']); },
          };
        },
      }));
      ({ runPilot } = require('../src/services/zkPilot/runPilot'));
    });
    const { json } = await runPilot({ ...OPTS, ...opts }, { env: {}, rootDir: REPO });
    return { json, log, redisOptions };
  }

  test('lectura READ ONLY cerrada antes de abrir la del lock; la sesión del lock se fija y verifica ANTES de escribir', async () => {
    const { json, log } = await runWith();
    expect(json).toMatchObject({ resultado: 'lock_mysql_vigente', exclusion: { mysql: { estado: 'ocupado' } } });
    const { LOCK_SESSION_SQL, MYSQL_LOCK_SQL, MYSQL_KILL_SQL, PROVISIONAL_TTL_S } = require('../src/services/zkPilot/lock');
    expect(log).toEqual([
      [1, 'connect'],
      [1, 'SET SESSION TRANSACTION READ ONLY'],
      [1, 'SELECT id, ip_address, port, connection_mode, timeout_ms FROM devices WHERE id = ? LIMIT 1'],
      [1, 'end'],
      ['r1', 'connect'],
      ['r1', 'CLIENT INFO'],                  // identidad de la sesión Redis: id y dirección…
      ['r1', 'INFO server'],                  // …y run_id del servidor
      ['r1', 'SET NX PX 30000'],              // TTL provisional: el completo llega con la verificación previa al intento
      [2, 'connect'],
      [2, LOCK_SESSION_SQL.set],
      [2, LOCK_SESSION_SQL.check],
      [2, MYSQL_KILL_SQL.session, [902]],     // identidad de la sesión del lock: HOST…
      [2, MYSQL_KILL_SQL.uptime],             // …y arranque del servidor
      [2, MYSQL_LOCK_SQL.purgeExpired],
      // La fila también nace con el TTL provisional (30 s), no con el completo.
      [2, MYSQL_LOCK_SQL.insert.replace(/\s+/g, ' ').trim(), [7, expect.stringMatching(/^pilot:[0-9a-f]{32}$/), expect.any(String), 'piloto_estados', PROVISIONAL_TTL_S]],
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

  test('toma MySQL incierta (error de RED real: errno -104) con la conexión rota: se MATA la sesión vieja y recién después se compensa', async () => {
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
      MYSQL_KILL_SQL.uptime,                        // mismo servidor (mismo arranque)…
      [MYSQL_KILL_SQL.session, [902]],              // …y el hilo 902 sigue siendo el nuestro (mismo HOST)
      [MYSQL_KILL_SQL.kill, [902]],
      [MYSQL_KILL_SQL.session, [902]],              // hasta que el hilo desaparece
      MYSQL_LOCK_SQL.release,
    ]);
  });

  test('toma MySQL incierta sin poder matar la sesión vieja (sin permiso) y nada que borrar: incierto, nunca no_tomado', async () => {
    const { json } = await runWith({ insert: 'red', kill: 'denegado' });
    expect(json.liberacion).toEqual({ redis: 'liberado', mysql: 'incierto' });
    expect(json.limites.ttl_provisional_s).toBe(30);
  });

  test.each([
    ['el servidor que atiende la conexión nueva es OTRO (reinicio o cambio detrás de la misma dirección)', { reinicio: 'mysql' }],
    ['el número de la sesión vieja lo tiene OTRA conexión (otro HOST)', { hostAjeno: true }],
  ])('toma MySQL incierta y %s: no se mata NADA; incierto', async (_name, over) => {
    const { json, log } = await runWith({ insert: 'red', ...over });
    expect(log.filter(([, s]) => /^KILL/.test(String(s)))).toEqual([]);
    expect(json.liberacion).toEqual({ redis: 'liberado', mysql: 'incierto' });
  });

  test('toma Redis incierta (red) con el cliente roto: CLIENT KILL de la sesión vieja (id Y dirección, mismo run_id) y después EVAL', async () => {
    const { json, log } = await runWith({ redisSet: 'red' });
    expect(json).toMatchObject({ resultado: 'redis_no_disponible', liberacion: { redis: 'compensado', mysql: 'no_tomado' } });
    expect(log.filter(([id]) => id === 'r2').map(([, c]) => c))
      .toEqual(['connect', 'INFO server', 'CLIENT KILL ID 101 ADDR 127.0.0.1:5555', 'EVAL', 'disconnect']);
    // La base sólo se usó para leer el reloj.
    expect(log.filter(([id]) => id === 2)).toEqual([]);
  });

  test('toma Redis incierta y OTRO servidor Redis (run_id distinto): no se mata nada; incierto', async () => {
    const { json, log } = await runWith({ redisSet: 'red', reinicio: 'redis' });
    expect(log.filter(([, c]) => /KILL/.test(String(c)))).toEqual([]);
    expect(json.liberacion).toEqual({ redis: 'incierto', mysql: 'no_tomado' });
  });

  test('ya no cabe un intento después de leer el reloj: limite_total SIN tomar ningún lock', async () => {
    const { json, log } = await runWith({ selectMs: 1100, opts: { attemptTimeoutS: 1, maxDurationS: 2 } });
    expect(json).toMatchObject({ resultado: 'limite_total', intentos_ejecutados: 0, liberacion: { redis: 'no_tomado', mysql: 'no_tomado' } });
    expect(log.filter(([id]) => String(id).startsWith('r') || id === 2)).toEqual([]);
  });

  test('renovación previa al intento que tarda más de 4 s: no se lanza la lectura (exclusion_no_garantizada)', async () => {
    const { json } = await runWith({ insert: 'ok', evalMs: 4200 });
    expect(json).toMatchObject({ resultado: 'exclusion_no_garantizada', intentos_ejecutados: 0, intentos: [] });
    expect(json.liberacion).toEqual({ redis: 'liberado', mysql: 'liberado' });
  });

  test('renovación previa lenta (pero válida) que se come el tiempo: el intento que ya no cabe no se lanza', async () => {
    const { json } = await runWith({ insert: 'ok', evalMs: 3500, opts: { attemptTimeoutS: 5, maxDurationS: 7 } });
    expect(json).toMatchObject({ resultado: 'limite_total', intentos_ejecutados: 0, intentos: [] });
    expect(json.liberacion).toEqual({ redis: 'liberado', mysql: 'liberado' });
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
