'use strict';

/**
 * zkPilotIsolation.test.js — aislamiento del piloto de estados por reloj.
 *
 *  1. Grafo de módulos: ni el proceso principal ni el proceso de lectura
 *     alcanzan los caminos de importación, staging, recálculo, actualización
 *     de dispositivos, auditoría o el ORM. El proceso de lectura tampoco carga
 *     clientes de MySQL/Redis ni dotenv, e instala la captura ANTES que nada.
 *  2. Ningún literal de SQL de escritura/DDL en el código del piloto.
 *  3. Lock: la MISMA clave compartida que usa el worker; el lock del piloto
 *     sólo usa Redis (sin auditoría, sin fallback MySQL, sin DDL) y el helper
 *     habitual conserva su comportamiento (Redis + auditoría, o fallback MySQL).
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

  test('ningún literal SQL de escritura o DDL en el código del piloto', () => {
    const files = [PARENT_ENTRY, ...fs.readdirSync(PILOT_DIR).map((f) => path.join(PILOT_DIR, f))];
    const WRITE = /(['"`])[^'"`\n]*\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT)\s[^'"`\n]*\1/i;
    for (const f of files) expect([rel(f), WRITE.test(fs.readFileSync(f, 'utf8'))]).toEqual([rel(f), false]);
  });
});

describe('piloto de estados: lock compartido sólo por Redis', () => {
  test('la clave es la misma que usa el helper habitual del worker', () => {
    const { keyFor } = require('../src/services/deviceLockKeys');
    expect(keyFor(7)).toBe('zk:lock:dev:7');
    const src = fs.readFileSync(path.join(API, 'src', 'services', 'deviceLock.js'), 'utf8');
    expect(src).toMatch(/require\('\.\/deviceLockKeys'\)/);
    expect(src).not.toMatch(/zk:lock:dev:/);   // una sola definición de la clave
  });

  test('acquire/renew/release: SET NX PX y Lua por token, sin ningún acceso a MySQL', async () => {
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

  test('ocupado → false; renovación ajena → false; liberar no borra un lock ajeno', async () => {
    const { createPilotLock } = require('../src/services/zkPilot/lock');
    const redis = { set: async () => null, eval: async () => 0 };
    const lock = createPilotLock({ redis, deviceId: 7, ttlMs: 30000 });
    expect(await lock.acquire()).toBe(false);
    expect(await lock.renew()).toBe(false);
    expect(await lock.release()).toBe(false);
  });

  test('Redis caído: el lock del piloto falla cerrado (lanza), sin fallback', async () => {
    const { createPilotLock } = require('../src/services/zkPilot/lock');
    const redis = { set: async () => { throw new Error('Connection is closed'); }, eval: async () => { throw new Error('closed'); } };
    const lock = createPilotLock({ redis, deviceId: 7, ttlMs: 30000 });
    await expect(lock.acquire()).rejects.toThrow();
    await expect(lock.renew()).rejects.toThrow();
  });

  test('chequeo del lock MySQL: sólo SELECT; tabla ausente, sin lock, lock vigente', async () => {
    const { checkMysqlLock } = require('../src/services/zkPilot/lock');
    const mk = (tables, locks) => {
      const sqls = [];
      return {
        sqls,
        query: async (sql, params) => {
          sqls.push([sql.replace(/\s+/g, ' ').trim(), params]);
          if (/information_schema\.TABLES/i.test(sql)) return [[{ n: tables }]];
          return [[{ n: locks }]];
        },
      };
    };
    let c = mk(0, 0);
    expect(await checkMysqlLock(c, 7)).toBe('sin_tabla');
    expect(c.sqls).toHaveLength(1);
    c = mk(1, 0);
    expect(await checkMysqlLock(c, 7)).toBe('sin_lock_vigente');
    c = mk(1, 1);
    expect(await checkMysqlLock(c, 7)).toBe('lock_vigente');
    for (const [sql, params] of c.sqls) {
      expect(sql).toMatch(/^SELECT /);
      if (/device_locks WHERE/.test(sql)) expect(params).toEqual([7]);
    }
    await expect(checkMysqlLock({ query: async () => { throw new Error('denied'); } }, 7)).rejects.toThrow();
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
