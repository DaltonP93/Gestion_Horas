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
        cooldownS: 4, renewS: 5, cutoff: null, out: null, envFile: null,
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
    [['--device-id', '5', '--attempts', '2', '--attempt-timeout', '30', '--max-duration', '30']],  // = timeout: no cabe la preparación
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

  test.each([
    ['2026-10-02', '2026-10-02 23:59:59'],            // día completo (recomendado)
    ['2026-10-02 23:59:59', '2026-10-02 23:59:59'],
    ['2026-10-02T23:59:59', '2026-10-02 23:59:59'],   // con 'T': misma forma canónica
    ['2028-02-29 00:00:00', '2028-02-29 00:00:00'],   // bisiesto real
    ['2028-02-29', '2028-02-29 23:59:59'],
  ])('--cutoff %p → %p (hora de pared canónica)', (raw, canon) => {
    expect(parseArgs(['--device-id', '5', ...LIMITS, '--cutoff', raw]).opts.cutoff).toBe(canon);
  });

  test.each([
    ['2026-02-29 10:00:00'], ['2026-13-01 00:00:00'], ['2026-10-32 00:00:00'], ['2026-10-02 24:00:00'],
    ['2026-10-02 23:60:00'], ['2026-10-02 23:59'], ['2026-02-29'], ['2026-10-2'], [' 2026-10-02 23:59:59'], ['2026-10-02 23:59:59Z'],
    ['2026-10-02 23:59:59-03:00'], ['2009-12-31 23:59:59'], ['2101-01-01 00:00:00'], ['ayer'], [''],
  ])('--cutoff %p → argumentos_invalidos (sin zona, fecha real, años 2010–2100)', (raw) => {
    expect(parseArgs(['--device-id', '5', ...LIMITS, '--cutoff', raw])).toEqual({ ok: false, resultado: 'argumentos_invalidos' });
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

  test('sólo toma DB_*, REDIS_URL y PILOT_CORTE_CLAVE; el resto se ignora y sólo se cuenta', () => {
    const p = write('pilot.env', [
      'DB_HOST=db.invalid', 'DB_PORT=3306', 'DB_NAME=asistencia', 'DB_USER=lector', 'DB_PASSWORD=x',
      'REDIS_URL=redis://redis.invalid:6379', `PILOT_CORTE_CLAVE=${'ab'.repeat(32)}`,
      'JWT_SECRET=nunca', 'ATT_PASSWORD=nunca', 'SMTP_PASS=nunca',
    ].join('\n'), 0o600);
    expect(loadEnvFile(p)).toEqual({
      ok: true,
      env: {
        DB_HOST: 'db.invalid', DB_PORT: '3306', DB_NAME: 'asistencia', DB_USER: 'lector', DB_PASSWORD: 'x',
        REDIS_URL: 'redis://redis.invalid:6379', PILOT_CORTE_CLAVE: 'ab'.repeat(32),
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

  test('`git rev-parse` con tope (un .git colgado no frena el arranque)', () => {
    let seen;
    jest.isolateModules(() => {
      jest.doMock('child_process', () => ({ execFileSync: (cmd, args, o) => { seen = o; throw new Error('timeout'); } }));
      fs.mkdirSync(path.join(dir, '.git'));
      expect(require('../src/services/zkPilot/args').releaseCommit(dir)).toEqual({ commit: null, origen: 'desconocido' });
    });
    jest.dontMock('child_process');
    expect(seen).toMatchObject({ timeout: 2000, killSignal: 'SIGKILL' });
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

  test('clave del corte inválida: configuracion_invalida (código 2) sin conectar', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--device-id', '5', ...LIMITS, '--cutoff', '2026-01-01'], {
      env: { PATH: process.env.PATH, TZ: 'UTC', DB_HOST: '192.0.2.1', DB_PORT: '9', REDIS_URL: 'redis://192.0.2.1:9', PILOT_CORTE_CLAVE: 'corta' },
      encoding: 'utf8', timeout: 20000,
    });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ resultado: 'configuracion_invalida', codigo_salida: 2 });
    expect(r.stdout + r.stderr).not.toContain('corta');
  });

  test('clave del corte VACÍA (línea de la plantilla sin completar) = sin clave: no aborta por configuración', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--device-id', '5', ...LIMITS, '--cutoff', '2099-01-01'], {
      env: { PATH: process.env.PATH, TZ: 'UTC', DB_HOST: '192.0.2.1', DB_PORT: '9', REDIS_URL: 'redis://192.0.2.1:9', PILOT_CORTE_CLAVE: '' },
      encoding: 'utf8', timeout: 20000,
    });
    // Sigue de largo hasta el control del corte (en el futuro): la clave vacía no es configuración inválida.
    expect(JSON.parse(r.stdout)).toMatchObject({ resultado: 'corte_futuro', codigo_salida: 2 });
  });

  test.each([
    ['en el futuro', () => '2099-01-01', 'corte_futuro'],
    ['dentro del margen de 120 min', () => {
      const { pyDateTimeStr } = require('../src/services/zkRecordShape');
      const { addMinutesWall } = require('../src/services/zkPilot/corte');
      return addMinutesWall(pyDateTimeStr(new Date()), -30);
    }, 'corte_reciente'],
  ])('corte %s: código 2 sin conectar a nada', (_name, cutoff, resultado) => {
    const r = run(['--device-id', '5', ...LIMITS, '--cutoff', cutoff()]);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ resultado, codigo_salida: 2, intentos_ejecutados: 0, corte: { conjunto: null } });
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

describe('piloto de estados: comparación del corte (CLI sin conexiones)', () => {
  const COMPARE = path.join(__dirname, '..', 'scripts', 'zk-raw-state-pilot-compare.js');
  // Dos corridas DISTINTAS del mismo reloj (corrida_id); `corrida` permite fabricar la misma dos veces.
  let corridas = 0;
  const base = (over = {}, { corrida = `c${(corridas += 1)}`, reloj = 5 } = {}) => ({
    resultado: 'ok',
    corrida_id: corrida,
    reloj: { id: reloj, modo_conexion: 'tcp' },
    corte: {
      hasta: '2026-10-02 23:59:59', canon: 'sishoras.zk-raw-state-pilot.corte/2', decodificacion: { zona: 'UTC' },
      conjunto: { registros: 28, formato: 'tcp40', huella: 'a'.repeat(64), clave_id: 'c'.repeat(12), huella_motivo: null, ...over },
    },
  });
  const compare = (a, b) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zk-pilot-cmp-'));
    const fa = path.join(dir, 'a.json');
    const fb = path.join(dir, 'b.json');
    fs.writeFileSync(fa, typeof a === 'string' ? a : JSON.stringify(a));
    fs.writeFileSync(fb, typeof b === 'string' ? b : JSON.stringify(b));
    const r = spawnSync(process.execPath, [COMPARE, fa, fb], { encoding: 'utf8', timeout: 20000 });
    fs.rmSync(dir, { recursive: true, force: true });
    return { status: r.status, out: JSON.parse(r.stdout) };
  };

  test('igual (0), distinto (1, con delta) y no comparable (3); entrada inválida (2)', () => {
    expect(compare(base(), base())).toEqual({ status: 0, out: { resultado: 'igual', motivo: null, delta_registros: 0 } });
    expect(compare(base(), base({ huella: 'b'.repeat(64) }))).toEqual({ status: 1, out: { resultado: 'distinto', motivo: null, delta_registros: 0 } });
    expect(compare(base(), base({ registros: 29, huella: 'b'.repeat(64) })).out).toMatchObject({ resultado: 'distinto', delta_registros: 1 });
    expect(compare(base(), 'no es json')).toMatchObject({ status: 2, out: { resultado: 'entrada_invalida' } });
    // JSON válido que no es una salida del piloto (lista, null, número): también entrada inválida.
    for (const raro of ['[]', 'null', '42', '"texto"']) expect(compare(base(), raro)).toMatchObject({ status: 2, out: { resultado: 'entrada_invalida' } });
  });

  test('no comparable: el MISMO archivo dos veces, otro reloj o sin identificador de corrida', () => {
    const una = base();
    expect(compare(una, una)).toEqual({ status: 3, out: { resultado: 'no_comparable', motivo: 'misma_corrida', delta_registros: null } });
    expect(compare(base(), base({}, { reloj: 6 })).out).toMatchObject({ resultado: 'no_comparable', motivo: 'reloj_distinto' });
    const { corrida_id: _sin, ...sinCorrida } = base();
    expect(compare(sinCorrida, base()).out).toMatchObject({ resultado: 'no_comparable', motivo: 'sin_corrida' });
  });

  test.each([
    ['otra clave', { clave_id: 'd'.repeat(12) }, 'clave_distinta'],
    ['otro formato (TCP frente a UDP)', { formato: 'udp16' }, 'formato_distinto'],
    ['sin huella (sin clave)', { huella: null, clave_id: null, huella_motivo: 'sin_clave' }, 'clave_distinta'],
  ])('no comparable: %s', (_name, over, motivo) => {
    expect(compare(base(), base(over))).toEqual({ status: 3, out: { resultado: 'no_comparable', motivo, delta_registros: null } });
  });

  test('no comparable: corrida no ok, otro corte, otra zona o sin bloque de corte', () => {
    const { compararCortes } = require('../src/services/zkPilot/corte');
    expect(compararCortes(base(), { ...base(), resultado: 'limite_total' }).motivo).toBe('resultado_no_ok');
    expect(compararCortes(base(), { ...base(), corte: { ...base().corte, hasta: '2026-10-01 23:59:59' } }).motivo).toBe('corte_distinto');
    expect(compararCortes(base(), { ...base(), corte: { ...base().corte, decodificacion: { zona: 'America/Asuncion' } } }).motivo).toBe('zona_distinta');
    expect(compararCortes(base(), { ...base(), corte: null }).motivo).toBe('sin_corte');
    expect(compararCortes(base(), { ...base(), corte: { ...base().corte, canon: 'sishoras.zk-raw-state-pilot.corte/1' } }).motivo).toBe('canon_distinto');
    const sinClave = (corrida) => base({ huella: null, clave_id: null, huella_motivo: 'sin_clave' }, { corrida });
    expect(compararCortes(sinClave('x1'), sinClave('x2'))).toEqual({ resultado: 'no_comparable', motivo: 'sin_clave', delta_registros: null });
  });
});
