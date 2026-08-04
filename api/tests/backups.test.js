/**
 * Robustez del backup automático.
 *
 * El fallo de producción era `ERR_STREAM_WRITE_AFTER_END` → uncaughtException:
 * el código anterior llamaba a out.end() al ver el 'exit' de gzip, cuando el
 * stdout de gzip todavía tenía datos en vuelo. Estos tests fijan las garantías
 * que lo hacen imposible: una sola finalización, temporal + rename atómico, y
 * que ningún fallo escape del cron.
 */
const fs   = require('fs');
const fsp  = require('fs/promises');
const os   = require('os');
const path = require('path');
const zlib = require('zlib');
const { Writable, Transform } = require('stream');

jest.mock('../src/config/logger', () => ({ info() {}, warn() {}, error() {} }));

let DIR;
const BIN = {};

/** Escribe un mysqldump falso ejecutable. */
function writeBin(name, body) {
  const p = path.join(DIR, name);
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return p;
}

function load(extraEnv = {}) {
  jest.resetModules();
  Object.assign(process.env, {
    BACKUP_DIR: DIR,
    MYSQLDUMP_BIN: BIN.ok,
    BACKUP_TIMEOUT_MS: '30000',
    BACKUP_KILL_GRACE_MS: '200',
    BACKUP_DISABLED: '0',
    ...extraEnv,
  });
  return require('../src/services/backups');
}

const listTemps = () => fs.readdirSync(DIR).filter(f => /\.part$/.test(f));
const listBackupFiles = () => fs.readdirSync(DIR).filter(f => /^asistencia_.*\.sql\.gz$/.test(f));

beforeAll(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sishoras-backup-'));
  BIN.ok = writeBin('dump-ok.js', `
    for (let i = 0; i < 500; i++) process.stdout.write('-- INSERT INTO empleados VALUES (' + i + ');\\n');
  `);
  BIN.fail = writeBin('dump-fail.js', `
    process.stderr.write('mysqldump: Got error: 1045: "Access denied for user \\'sishoras\\'@\\'10.20.30.40\\'" when trying to connect\\n');
    process.exit(2);
  `);
  BIN.empty = writeBin('dump-empty.js', `process.exit(0);`);
  BIN.hang = writeBin('dump-hang.js', `
    process.stdout.write('-- parcial\\n');
    setInterval(() => {}, 1000);
  `);
  BIN.selfKill = writeBin('dump-signal.js', `
    process.stdout.write('-- parcial\\n');
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 30);
    setInterval(() => {}, 1000);
  `);
  // Atrapa SIGTERM y sigue vivo: obliga a que la escalada llegue a SIGKILL.
  BIN.stubborn = writeBin('dump-stubborn.js', `
    process.on('SIGTERM', () => {});
    process.stdout.write('-- parcial\\n');
    setInterval(() => {}, 1000);
  `);
  BIN.noisy = writeBin('dump-noisy.js', `
    for (let i = 0; i < 5000; i++) process.stderr.write('mysqldump: aviso ruidoso numero ' + i + '\\n');
    process.stdout.write('-- ok\\n');
  `);
  BIN.missing = path.join(DIR, 'no-existe-mysqldump');
});

afterAll(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* noop */ } });

beforeEach(() => {
  for (const f of fs.readdirSync(DIR)) {
    if (/^asistencia_|\.part$/.test(f)) fs.rmSync(path.join(DIR, f), { force: true });
  }
});

// ── 1 · camino feliz ────────────────────────────────────────────
describe('backup exitoso', () => {
  test('produce un .sql.gz válido, con tamaño > 0 y sin temporales', async () => {
    const svc = load();
    const res = await svc.runBackup();

    expect(res.filename).toMatch(/^asistencia_\d{8}_\d{6}\.sql\.gz$/);
    expect(res.size).toBeGreaterThan(0);
    expect(res.duration_ms).toBeGreaterThanOrEqual(0);
    expect(fs.existsSync(res.path)).toBe(true);
    expect(listTemps()).toEqual([]);

    const plano = zlib.gunzipSync(fs.readFileSync(res.path)).toString();
    expect(plano).toContain('INSERT INTO empleados VALUES (499)');
    expect(plano.split('\n').filter(Boolean)).toHaveLength(500);
  });

  test('el archivo sólo aparece con su nombre final al terminar (rename atómico)', async () => {
    const svc = load();
    const nombres = [];
    const hooks = {
      createWriteStream: (p, o) => {
        nombres.push(path.basename(p));
        return fs.createWriteStream(p, o);
      },
    };
    svc.__setTestHooks(hooks);
    const res = await svc.runBackup();
    svc.__setTestHooks(null);

    // Se escribió a un temporal oculto, nunca directo al nombre publicado.
    expect(nombres).toHaveLength(1);
    expect(nombres[0]).toMatch(/^\.asistencia_.*\.part$/);
    expect(nombres[0]).not.toBe(res.filename);
    expect(listBackupFiles()).toEqual([res.filename]);
  });

  test('nunca se escribe después del end del stream (regresión ERR_STREAM_WRITE_AFTER_END)', async () => {
    const svc = load();
    const log = { ended: false, violations: 0, ends: 0 };
    svc.__setTestHooks({
      createWriteStream: (p, o) => {
        const real = fs.createWriteStream(p, o);
        return new Writable({
          write(chunk, enc, cb) {
            if (log.ended) log.violations++;   // esto era el crash en producción
            real.write(chunk, enc, cb);
          },
          final(cb) { log.ended = true; log.ends++; real.end(cb); },
          destroy(err, cb) { real.destroy(); cb(err); },
        });
      },
    });
    const res = await svc.runBackup();
    svc.__setTestHooks(null);

    expect(log.violations).toBe(0);
    expect(log.ends).toBe(1);          // una sola finalización del stream
    expect(res.size).toBeGreaterThan(0);
  });
});

// ── 2 · mysqldump falla ─────────────────────────────────────────
describe('mysqldump falla', () => {
  test('rechaza con BACKUP_DUMP_FAILED, exit_code y stage', async () => {
    const svc = load({ MYSQLDUMP_BIN: BIN.fail });
    const err = await svc.runBackup().catch(e => e);

    expect(err.code).toBe(svc.BACKUP_ERROR_CODES.DUMP_FAILED);
    expect(err.exit_code).toBe(2);
    expect(err.stage).toBe('dump');
    expect(err.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test('no publica archivo y borra el temporal', async () => {
    const svc = load({ MYSQLDUMP_BIN: BIN.fail });
    await expect(svc.runBackup()).rejects.toThrow();

    expect(listBackupFiles()).toEqual([]);
    expect(listTemps()).toEqual([]);
  });

  test('el binario inexistente da BACKUP_SPAWN_FAILED, no un crash', async () => {
    const svc = load({ MYSQLDUMP_BIN: BIN.missing });
    const err = await svc.runBackup().catch(e => e);

    expect(err.code).toBe(svc.BACKUP_ERROR_CODES.SPAWN_FAILED);
    expect(err.stage).toBe('spawn');
    expect(listTemps()).toEqual([]);
  });

  test('mysqldump terminado por señal se distingue del exit code', async () => {
    const svc = load({ MYSQLDUMP_BIN: BIN.selfKill });
    const err = await svc.runBackup().catch(e => e);

    expect(err.code).toBe(svc.BACKUP_ERROR_CODES.DUMP_SIGNALED);
    expect(err.signal).toBe('SIGTERM');
  });
});

// ── 3 · fallos de compresión y escritura ────────────────────────
describe('fallos del pipeline', () => {
  test('gzip que falla da BACKUP_COMPRESS_FAILED y limpia', async () => {
    const svc = load();
    svc.__setTestHooks({
      createGzip: () => new Transform({
        transform(_c, _e, cb) { cb(Object.assign(new Error('zlib: datos corruptos'), { code: 'Z_DATA_ERROR' })); },
      }),
    });
    const err = await svc.runBackup().catch(e => e);
    svc.__setTestHooks(null);

    expect(err.code).toBe(svc.BACKUP_ERROR_CODES.COMPRESS_FAILED);
    expect(err.stage).toBe('compress');
    expect(listBackupFiles()).toEqual([]);
  });

  test('disco lleno da BACKUP_DISK_FULL (no un 500 opaco)', async () => {
    const svc = load();
    svc.__setTestHooks({
      createWriteStream: () => new Writable({
        write(_c, _e, cb) { cb(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })); },
      }),
    });
    const err = await svc.runBackup().catch(e => e);
    svc.__setTestHooks(null);

    expect(err.code).toBe(svc.BACKUP_ERROR_CODES.DISK_FULL);
    expect(err.stage).toBe('write');
  });

  test('permiso denegado da BACKUP_WRITE_DENIED', async () => {
    const svc = load();
    svc.__setTestHooks({
      createWriteStream: () => new Writable({
        write(_c, _e, cb) { cb(Object.assign(new Error('permission denied'), { code: 'EACCES' })); },
      }),
    });
    const err = await svc.runBackup().catch(e => e);
    svc.__setTestHooks(null);

    expect(err.code).toBe(svc.BACKUP_ERROR_CODES.WRITE_DENIED);
  });

  test('error seguido de close y callback doble: una sola finalización y una sola limpieza', async () => {
    const svc = load();
    const unlink = jest.spyOn(fsp, 'unlink');
    unlink.mockClear();

    svc.__setTestHooks({
      createWriteStream: () => new Writable({
        write(_c, _e, cb) {
          const err = Object.assign(new Error('falla dura'), { code: 'EIO' });
          cb(err);
          cb(err);                                    // callback doble
          setImmediate(() => {
            this.emit('error', err);                  // error tardío...
            this.emit('close');                       // ...seguido de close
          });
        },
      }),
    });

    const err = await svc.runBackup().catch(e => e);
    // Se le da tiempo a los eventos tardíos para intentar romper algo.
    await new Promise(r => setTimeout(r, 50));
    svc.__setTestHooks(null);

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(svc.BACKUP_ERROR_CODES.WRITE_FAILED);
    const delTemp = unlink.mock.calls.filter(c => /\.part$/.test(String(c[0])));
    expect(delTemp).toHaveLength(1);                  // limpieza idempotente
    unlink.mockRestore();
  });
});

// ── 4 · timeout y cancelación ───────────────────────────────────
describe('timeout y cancelación', () => {
  test('un mysqldump colgado se corta con BACKUP_TIMEOUT y se mata el proceso', async () => {
    const svc = load({ MYSQLDUMP_BIN: BIN.hang, BACKUP_TIMEOUT_MS: '250' });
    const t0 = Date.now();
    const err = await svc.runBackup().catch(e => e);

    expect(err.code).toBe(svc.BACKUP_ERROR_CODES.TIMEOUT);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(listBackupFiles()).toEqual([]);
    expect(listTemps()).toEqual([]);
  }, 10000);

  test('un mysqldump que atrapa SIGTERM igual se corta: escala a SIGKILL', async () => {
    // child.killed se pone en true al ENVIAR el SIGTERM; si el guard mirara
    // esa bandera, el SIGKILL nunca saldría y esto quedaría colgado.
    const svc = load({ MYSQLDUMP_BIN: BIN.stubborn, BACKUP_TIMEOUT_MS: '250', BACKUP_KILL_GRACE_MS: '200' });
    const t0 = Date.now();
    const err = await svc.runBackup().catch(e => e);

    expect(err.code).toBe(svc.BACKUP_ERROR_CODES.TIMEOUT);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(listTemps()).toEqual([]);
  }, 10000);

  test('cancelar durante el apagado da BACKUP_CANCELLED', async () => {
    const svc = load({ MYSQLDUMP_BIN: BIN.hang });
    const p = svc.runBackup();
    await new Promise(r => setTimeout(r, 100));

    expect(svc.cancelActiveBackup('shutdown')).toBe(true);
    const err = await p.catch(e => e);

    expect(err.code).toBe(svc.BACKUP_ERROR_CODES.CANCELLED);
    expect(listTemps()).toEqual([]);
  }, 10000);

  test('AbortSignal previo cancela sin dejar residuos', async () => {
    const svc = load({ MYSQLDUMP_BIN: BIN.hang });
    const ac = new AbortController();
    ac.abort();
    const err = await svc.runBackup({ signal: ac.signal }).catch(e => e);

    expect(err.code).toBe(svc.BACKUP_ERROR_CODES.CANCELLED);
    expect(listTemps()).toEqual([]);
  }, 10000);

  test('no corre dos backups a la vez', async () => {
    const svc = load({ MYSQLDUMP_BIN: BIN.hang, BACKUP_TIMEOUT_MS: '400' });
    const p1 = svc.runBackup();
    const err = await svc.runBackup().catch(e => e);

    expect(err.code).toBe(svc.BACKUP_ERROR_CODES.ALREADY_RUNNING);
    await p1.catch(() => {});
  }, 10000);
});

// ── 5 · verificación del resultado ──────────────────────────────
describe('verificación del archivo', () => {
  test('un mysqldump que no emite nada da BACKUP_EMPTY_OUTPUT aunque el .gz pese', async () => {
    const svc = load({ MYSQLDUMP_BIN: BIN.empty });
    const err = await svc.runBackup().catch(e => e);

    // gzip de 0 bytes igual escribe ~20 bytes de cabecera: sin contar los
    // bytes crudos, esto pasaría por un backup válido.
    expect(err.code).toBe(svc.BACKUP_ERROR_CODES.EMPTY_OUTPUT);
    expect(err.stage).toBe('verify');
    expect(listBackupFiles()).toEqual([]);
    expect(listTemps()).toEqual([]);
  });

  test('archivo de tamaño 0 da BACKUP_EMPTY_OUTPUT', async () => {
    const svc = load();
    svc.__setTestHooks({
      createWriteStream: (p) => {
        fs.writeFileSync(p, '');                       // queda en 0 bytes
        return new Writable({ write(_c, _e, cb) { cb(); } });
      },
    });
    const err = await svc.runBackup().catch(e => e);
    svc.__setTestHooks(null);

    expect(err.code).toBe(svc.BACKUP_ERROR_CODES.EMPTY_OUTPUT);
    expect(err.stage).toBe('verify');
    expect(listBackupFiles()).toEqual([]);
  });

  test('si el archivo no existe al final da BACKUP_MISSING_OUTPUT', async () => {
    const svc = load();
    svc.__setTestHooks({
      createWriteStream: () => new Writable({ write(_c, _e, cb) { cb(); } }),
    });
    const err = await svc.runBackup().catch(e => e);
    svc.__setTestHooks(null);

    expect(err.code).toBe(svc.BACKUP_ERROR_CODES.MISSING_OUTPUT);
    expect(err.stage).toBe('verify');
  });
});

// ── 6 · higiene de logs y temporales ────────────────────────────
describe('sanitización', () => {
  test('no filtra usuario, host ni IP del error de mysqldump', () => {
    const svc = load();
    const limpio = svc.sanitizeStderr(
      `mysqldump: Got error: 1045: "Access denied for user 'sishoras'@'10.20.30.40'" when trying to connect`
    );

    expect(limpio).not.toContain('sishoras');
    expect(limpio).not.toContain('10.20.30.40');
    expect(limpio).toBe("mysqldump: Got error: 1045: '***'");   // queda el código
  });

  test('descarta contenido SQL y contraseñas', () => {
    const svc = load();
    const limpio = svc.sanitizeStderr([
      "INSERT INTO empleados VALUES (1,'Juan Pérez','1234567');",
      'mysqldump: error con password=SuperSecreta123',
    ].join('\n'));

    expect(limpio).not.toContain('Juan Pérez');
    expect(limpio).not.toContain('INSERT INTO');
    expect(limpio).not.toContain('SuperSecreta123');
    expect(limpio).toContain('password=***');
  });

  test('no filtra hostnames internos fuera del formato usuario@host', () => {
    const svc = load();
    const limpio = svc.sanitizeStderr(
      `mysqldump: Got error: 2005: Unknown MySQL server host 'db-prod.interna.sishoras' (-2) when trying to connect`
    );

    expect(limpio).not.toContain('db-prod.interna.sishoras');
    expect(limpio).toContain('2005');                  // el código sobrevive
    expect(limpio).toContain('Unknown MySQL server host');
    expect(limpio.endsWith("'***'")).toBe(true);
  });

  test('no filtra el SQL de un error de ejecución', () => {
    const svc = load();
    const limpio = svc.sanitizeStderr(
      "mysqldump: Couldn't execute 'SHOW FIELDS FROM `empleados` WHERE documento=\"1234567\"': Table doesn't exist (1146)"
    );

    expect(limpio).not.toContain('SHOW FIELDS');
    expect(limpio).not.toContain('empleados');
    expect(limpio).not.toContain('1234567');
    expect(limpio).toContain("Couldn't execute");      // el apóstrofo no corta acá
  });

  test('comillas anidadas no dejan fragmentos (MySQL bug #70907)', () => {
    const svc = load();
    // Emparejar comillas cerraba en la interna y dejaba escapar el
    // identificador de la tabla.
    const limpio = svc.sanitizeStderr(
      "mysqldump: Couldn't execute 'show table status like 'uc\\_secreta%'': error"
    );

    expect(limpio).not.toContain('uc\\_secreta');
    expect(limpio).not.toContain('show table status');
    expect(limpio).toBe("mysqldump: Couldn't execute '***'");
  });

  test('una comilla en la primera línea no tapa el diagnóstico de la segunda', () => {
    const svc = load();
    const limpio = svc.sanitizeStderr([
      "mysqldump: Got error: 2005: Unknown host 'db.interna'",
      'mysqldump: Aborting dump on error 1',
    ].join('\n'));

    expect(limpio).not.toContain('db.interna');
    expect(limpio).toContain('2005');
    expect(limpio).toContain('Aborting dump on error 1');
  });

  test('sanitizePath deja sólo el nombre del archivo', () => {
    const svc = load();
    expect(svc.sanitizePath('/srv/sishoras/backups/asistencia_1.sql.gz')).toBe('asistencia_1.sql.gz');
    expect(svc.sanitizePath('')).toBe('');
  });

  test('un stderr enorme no crece sin límite', async () => {
    const svc = load({ MYSQLDUMP_BIN: BIN.noisy });
    const res = await svc.runBackup();

    expect(res.stderr_bytes).toBeGreaterThan(64 * 1024);  // el proceso escribió mucho…
    expect(res.size).toBeGreaterThan(0);                  // …y el backup igual salió bien
  }, 15000);

  test('purgeStaleTemps borra temporales huérfanos y respeta los backups', async () => {
    const svc = load();
    const viejo = path.join(DIR, '.asistencia_20200101_000000.sql.gz.1.aaaa.part');
    const nuevo = path.join(DIR, '.asistencia_20990101_000000.sql.gz.2.bbbb.part');
    const real  = path.join(DIR, 'asistencia_20990101_000000.sql.gz');
    fs.writeFileSync(viejo, 'x'); fs.writeFileSync(nuevo, 'x'); fs.writeFileSync(real, 'x');
    fs.utimesSync(viejo, new Date(Date.now() - 48 * 3600e3), new Date(Date.now() - 48 * 3600e3));

    const removed = await svc.purgeStaleTemps();

    expect(removed).toBe(1);
    expect(fs.existsSync(viejo)).toBe(false);
    expect(fs.existsSync(nuevo)).toBe(true);
    expect(fs.existsSync(real)).toBe(true);
  });
});

// ── 7 · el fallo no puede tumbar la API ─────────────────────────
describe('aislamiento del proceso', () => {
  test('runScheduledBackup no rechaza y devuelve el error_code', async () => {
    const svc = load({ MYSQLDUMP_BIN: BIN.fail });
    const r = await svc.runScheduledBackup();

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(svc.BACKUP_ERROR_CODES.DUMP_FAILED);
  });

  test('un backup fallido no emite uncaughtException ni unhandledRejection', async () => {
    const svc = load({ MYSQLDUMP_BIN: BIN.fail });
    const caught = [];
    const onUncaught = (e) => caught.push(['uncaught', e]);
    const onUnhandled = (e) => caught.push(['unhandled', e]);
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);

    try {
      await svc.runScheduledBackup();
      // el pipeline roto de un dump fallido debe cerrar en silencio
      svc.__setTestHooks({
        createWriteStream: () => new Writable({
          write(_c, _e, cb) { cb(Object.assign(new Error('EIO'), { code: 'EIO' })); },
        }),
      });
      await svc.runScheduledBackup();
      svc.__setTestHooks(null);
      await new Promise(r => setTimeout(r, 150));
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUnhandled);
    }

    expect(caught).toEqual([]);
  }, 15000);

  test('el cron sigue programado después de un fallo', async () => {
    const svc = load({ MYSQLDUMP_BIN: BIN.fail, BACKUP_CRON: '0 2 * * *' });
    svc.startBackupCron();
    const r = await svc.runScheduledBackup();

    expect(r.ok).toBe(false);
    expect(() => svc.stopBackupCron()).not.toThrow();
  });
});
