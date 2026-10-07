'use strict';

/**
 * zkPilotArgs.test.js — entrada del piloto de estados por reloj: ID canónico,
 * límites explícitos, archivo de configuración mínimo e identificación de la
 * release (`.release-commit`, sin depender de `.git`).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'zk-raw-state-pilot.js');
const LIMITS = ['--attempts', '2', '--attempt-timeout', '30', '--max-duration', '90'];

describe('piloto de estados: argumentos', () => {
  const { parseArgs } = require('../src/services/zkPilot/args');

  test('argumentos válidos: límites explícitos y valores por defecto declarados', () => {
    expect(parseArgs(['--device-id', '12', ...LIMITS])).toEqual({
      ok: true,
      opts: {
        deviceId: 12, attempts: 2, attemptTimeoutS: 30, maxDurationS: 90,
        cooldownS: 4, renewS: 5, out: null, envFile: null,
      },
    });
    expect(parseArgs(['--device-id', '3', ...LIMITS, '--cooldown', '0', '--renew-seconds', '2',
      '--out', '/tmp/x.json', '--env-file', '/tmp/p.env']).opts)
      .toMatchObject({ cooldownS: 0, renewS: 2, out: '/tmp/x.json', envFile: '/tmp/p.env' });
  });

  test.each([['1e2'], ['01'], ['-1'], ['1.5'], ['1abc'], ['0'], ['9007199254740993'], [' 7'], ['0x10'], ['+3'], ['']])(
    'ID %p → id_invalido', (raw) => {
      expect(parseArgs(['--device-id', raw, ...LIMITS])).toEqual({ ok: false, resultado: 'id_invalido' });
    },
  );

  test.each([
    [['--device-id', '5']],                                                  // faltan límites
    [['--device-id', '5', '--attempts', '2', '--attempt-timeout', '30']],    // falta duración total
    [['--device-id', '5', '--attempts', '0', '--attempt-timeout', '30', '--max-duration', '90']],
    [['--device-id', '5', '--attempts', '6', '--attempt-timeout', '30', '--max-duration', '900']],
    [['--device-id', '5', '--attempts', '2', '--attempt-timeout', '901', '--max-duration', '3600']],
    [['--device-id', '5', '--attempts', '2', '--attempt-timeout', '30', '--max-duration', '3601']],
    [['--device-id', '5', '--attempts', '2', '--attempt-timeout', '30', '--max-duration', '29']],  // < timeout
    [['--device-id', '5', ...LIMITS, '--cooldown', '61']],
    [['--device-id', '5', ...LIMITS, '--cooldown', '-1']],
    [['--device-id', '5', ...LIMITS, '--renew-seconds', '0']],
    [['--device-id', '5', ...LIMITS, '--renew-seconds', '31']],
    [['--device-id', '5', ...LIMITS, '--attempts', '2']],                     // repetido
    [['--device-id', '5', ...LIMITS, '--verbose']],                           // desconocido
    [['--device-id', '5', ...LIMITS, 'extra']],                               // posicional
    [['--device-id', '5', ...LIMITS, '--out']],                               // sin valor
    [['--attempts', '2', '--attempt-timeout', '30', '--max-duration', '90']], // sin reloj
  ])('argumentos inválidos %p → argumentos_invalidos', (argv) => {
    expect(parseArgs(argv)).toEqual({ ok: false, resultado: 'argumentos_invalidos' });
  });
});

describe('piloto de estados: configuración mínima', () => {
  const { loadEnvFile } = require('../src/services/zkPilot/args');
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zk-pilot-env-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name, text, mode) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text, { mode });
    fs.chmodSync(p, mode);
    return p;
  };

  test('sólo toma DB_* y REDIS_URL; el resto se ignora y sólo se cuenta', () => {
    const p = write('pilot.env', [
      'DB_HOST=db.invalid', 'DB_PORT=3306', 'DB_NAME=asistencia', 'DB_USER=lector', 'DB_PASSWORD=x',
      'REDIS_URL=redis://redis.invalid:6379', 'JWT_SECRET=nunca', 'ATT_PASSWORD=nunca', 'SMTP_PASS=nunca',
    ].join('\n'), 0o600);
    expect(loadEnvFile(p)).toEqual({
      ok: true,
      env: {
        DB_HOST: 'db.invalid', DB_PORT: '3306', DB_NAME: 'asistencia', DB_USER: 'lector', DB_PASSWORD: 'x',
        REDIS_URL: 'redis://redis.invalid:6379',
      },
      ignoradas: 3,
    });
  });

  test('rechaza un archivo legible por grupo u otros, un enlace o un archivo inexistente', () => {
    const open = write('open.env', 'DB_HOST=x\n', 0o644);
    expect(loadEnvFile(open)).toEqual({ ok: false, motivo: 'permisos' });
    const real = write('real.env', 'DB_HOST=x\n', 0o600);
    const link = path.join(dir, 'link.env');
    fs.symlinkSync(real, link);
    expect(loadEnvFile(link)).toEqual({ ok: false, motivo: 'no_es_archivo' });
    expect(loadEnvFile(path.join(dir, 'nope.env'))).toEqual({ ok: false, motivo: 'no_existe' });
  });
});

describe('piloto de estados: identificación de la release', () => {
  const { releaseCommit } = require('../src/services/zkPilot/args');
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zk-pilot-rel-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const SHA = '0123456789abcdef0123456789abcdef01234567';

  test('`.release-commit` válido (release extraída con git archive, sin .git)', () => {
    fs.writeFileSync(path.join(dir, '.release-commit'), `${SHA}\n`);
    expect(releaseCommit(dir)).toEqual({ commit: SHA, origen: 'release-commit' });
  });

  test('`.release-commit` inválido no se reemplaza por otra fuente', () => {
    fs.writeFileSync(path.join(dir, '.release-commit'), 'main\n');
    expect(releaseCommit(dir)).toEqual({ commit: null, origen: 'release-commit-invalido' });
  });

  test('sin `.release-commit` ni `.git` → desconocido', () => {
    expect(releaseCommit(dir)).toEqual({ commit: null, origen: 'desconocido' });
  });

  test('checkout con `.git` y sin `.release-commit` → git', () => {
    const root = path.resolve(__dirname, '..', '..');
    const r = releaseCommit(root);
    if (fs.existsSync(path.join(root, '.release-commit'))) {
      expect(r.origen).toBe('release-commit');
    } else {
      expect(r.origen).toBe('git');
      expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe('piloto de estados: CLI sin conexiones ante entrada inválida', () => {
  const run = (argv) => spawnSync(process.execPath, [SCRIPT, ...argv], {
    // Destinos inexistentes: si el script intentara conectarse, fallaría con
    // otro resultado; la entrada inválida debe cortar antes.
    env: { PATH: process.env.PATH, TZ: process.env.TZ || 'UTC', DB_HOST: '192.0.2.1', DB_PORT: '9', REDIS_URL: 'redis://192.0.2.1:9' },
    encoding: 'utf8',
    timeout: 20000,
  });

  test.each([['1e2'], ['01'], ['-1'], ['0']])('ID %p: código 2 y JSON id_invalido', (raw) => {
    const r = run(['--device-id', raw, ...LIMITS]);
    expect(r.status).toBe(2);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ resultado: 'id_invalido', codigo_salida: 2, intentos_ejecutados: 0, reloj: { id: null } });
    expect(r.stdout + r.stderr).not.toContain('192.0.2.1');
  });

  test('archivo de salida existente: no se sobrescribe y no se conecta', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zk-pilot-out-'));
    const out = path.join(dir, 'ya-existe.json');
    fs.writeFileSync(out, 'previo');
    const r = run(['--device-id', '5', ...LIMITS, '--out', out]);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ resultado: 'salida_existente', codigo_salida: 2 });
    expect(fs.readFileSync(out, 'utf8')).toBe('previo');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
