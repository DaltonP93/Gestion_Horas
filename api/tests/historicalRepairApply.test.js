/**
 * historical-attendance-repair — camino de escritura y fallos de la fuente.
 *
 * Lo que se protege acá es lo que puede romper producción: que sin --apply no
 * se escriba nada, que el guard optimista rechace un manifest desactualizado,
 * que el valor se escriba como STRING de pared y no como Date, y que la caída
 * de ATT2000 aborte sin proponer nada.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockQuery = jest.fn();
const mockTransaction = jest.fn();
jest.mock('../src/config/database', () => ({
  sequelize: {
    query: (...a) => mockQuery(...a),
    transaction: (...a) => mockTransaction(...a),
    close: async () => {},
  },
  DB_TIMEZONE: '-03:00',
}));

const mockAtt = jest.fn();
jest.mock('../src/config/att2000', () => ({ queryAtt2000: (...a) => mockAtt(...a) }), { virtual: true });

const { dryRun, apply, cargarEnv } = require('../scripts/historical-attendance-repair');
const repair = require('../src/services/historicalRepair');

let dir;
beforeEach(() => {
  mockQuery.mockReset();
  mockAtt.mockReset();
  mockTransaction.mockReset();
  mockTransaction.mockResolvedValue({ commit: async () => {}, rollback: async () => {} });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-'));
  process.exitCode = 0;
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

/** Revalidación sin colisión + UPDATE que afecta 1 fila. */
function okQuery(affectedRows = 1) {
  attRevalida();
  mockQuery.mockImplementation((sql) =>
    /SELECT id FROM attendance_logs/i.test(String(sql))
      ? Promise.resolve([[]])
      : Promise.resolve([[], { affectedRows }]));
}

const ARGS = { apply: false, out: null, source: 'device', from: null, to: null, employee: null, limit: null, batchSize: 500, manifest: null };

/**
 * Manifest bien formado: versiones vigentes, huella por fila y huella global.
 * `over` permite corromper campos a propósito.
 */
function manifestCon(filas, over = {}) {
  const conDigest = filas.map(f => ({ ...f, digest: repair.rowDigest(f) }));
  const f = path.join(dir, 'manifest.json');
  fs.writeFileSync(f, JSON.stringify({
    manifest_version: repair.MANIFEST_VERSION,
    repair_algorithm_version: repair.REPAIR_ALGORITHM_VERSION,
    generado: 'x',
    aplicable: true,
    parametros: { source: 'device', from: null, to: null, employee: null },
    digest: repair.manifestDigest(conDigest),
    filas: conDigest,
    ...over,
  }));
  return f;
}

/** ATT2000 devuelve el candidato que hace que FILA_OK revalide como MATCH_240. */
function attRevalida() {
  mockAtt.mockResolvedValue([{ USERID: '3091', CHECKTIME: '2024-04-29 06:42:29', CHECKTYPE: 'I' }]);
}

const FILA_OK = {
  attendance_log_id: 1, employee_id: 10, employee_code: '3091', device_id: 5,
  source: 'device', type: 'in', old_timestamp: '2024-04-29 02:42:29',
  proposed_timestamp: '2024-04-29 06:42:29', delta_minutes: 240,
  status: 'MATCH_240', reason: null, date_changes: false,
};

describe('dry-run', () => {
  test('★ no ejecuta ningún UPDATE', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 1, employee_id: 10, employee_code: '3091', device_id: 5, source: 'device', timestamp: '2024-04-29 02:42:29', type: 'in' }]])
      .mockResolvedValueOnce([[]]);
    mockAtt.mockResolvedValue([{ USERID: '3091', CHECKTIME: '2024-04-29 06:42:29', CHECKTYPE: 'I' }]);

    await dryRun({ ...ARGS, out: dir });

    const sqls = mockQuery.mock.calls.map(c => String(c[0]));
    expect(sqls.some(s => /UPDATE/i.test(s))).toBe(false);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test('escribe manifest, CSV y lista de recálculo', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 1, employee_id: 10, employee_code: '3091', device_id: 5, source: 'device', timestamp: '2024-04-29 22:30:00', type: 'in' }]])
      .mockResolvedValueOnce([[]]);
    mockAtt.mockResolvedValue([{ USERID: '3091', CHECKTIME: '2024-04-30 02:30:00', CHECKTYPE: 'I' }]);

    await dryRun({ ...ARGS, out: dir });

    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    expect(m.filas[0].status).toBe('MATCH_240');
    expect(m.filas[0].date_changes).toBe(true);

    expect(fs.readFileSync(path.join(dir, 'manifest.csv'), 'utf8')).toMatch(/attendance_log_id;/);

    // Cruza de día → hay que recalcular el día viejo y el nuevo.
    const recalc = JSON.parse(fs.readFileSync(path.join(dir, 'recalcular.json'), 'utf8'));
    expect(recalc).toEqual([
      { employee_id: 10, date: '2024-04-29' },
      { employee_id: 10, date: '2024-04-30' },
    ]);
  });

  test('★ ATT2000 inaccesible: aborta sin generar manifest', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 1, employee_id: 10, employee_code: '3091', device_id: 5, source: 'device', timestamp: '2024-04-29 02:42:29', type: 'in' }]])
      .mockResolvedValueOnce([[]]);
    mockAtt.mockRejectedValue(new Error('ECONNREFUSED'));

    await dryRun({ ...ARGS, out: dir });

    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});

describe('--to inclusivo', () => {
  function logsDe(rows) {
    mockQuery.mockImplementation((sql) => {
      if (/DATE_FORMAT\(al\.timestamp/i.test(String(sql))) return Promise.resolve([rows]);
      return Promise.resolve([[]]);
    });
  }

  test('★ el rango es semiabierto: incluye el día completo de --to', async () => {
    logsDe([]);
    mockAtt.mockResolvedValue([]);
    await dryRun({ ...ARGS, out: dir, from: '2024-04-01', to: '2024-04-30' });

    const [, opts] = mockQuery.mock.calls.find(c => /DATE_FORMAT\(al\.timestamp/i.test(String(c[0])));
    // El defecto anterior era `< '2024-04-30 23:59:59'`, que excluía justo ese
    // segundo. El límite correcto es el día siguiente a medianoche.
    expect(opts.replacements).toContain('2024-04-01 00:00:00');
    expect(opts.replacements).toContain('2024-05-01 00:00:00');
    expect(opts.replacements).not.toContain('2024-04-30 23:59:59');
  });

  test('★ una marca exactamente a 23:59:59 del último día entra', async () => {
    const enElBorde = {
      id: 1, employee_id: 10, employee_code: '3091', device_id: 5,
      source: 'device', timestamp: '2024-04-30 23:59:59', type: 'in',
    };
    logsDe([enElBorde]);
    mockAtt.mockResolvedValue([{ USERID: '3091', CHECKTIME: '2024-05-01 03:59:59', CHECKTYPE: 'I' }]);

    await dryRun({ ...ARGS, out: dir, from: '2024-04-01', to: '2024-04-30' });

    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    expect(m.filas).toHaveLength(1);
    expect(m.filas[0].status).toBe('MATCH_240');
    // La corrección la mueve al mes siguiente.
    expect(m.filas[0].proposed_timestamp).toBe('2024-05-01 03:59:59');
    expect(m.filas[0].date_changes).toBe(true);
  });

  test('cruce de año en el límite', async () => {
    logsDe([]);
    mockAtt.mockResolvedValue([]);
    await dryRun({ ...ARGS, out: dir, from: '2024-12-01', to: '2024-12-31' });

    const [, opts] = mockQuery.mock.calls.find(c => /DATE_FORMAT\(al\.timestamp/i.test(String(c[0])));
    expect(opts.replacements).toContain('2025-01-01 00:00:00');
  });

  test('un --to inválido aborta en vez de generar un rango silencioso', async () => {
    logsDe([]);
    await dryRun({ ...ARGS, out: dir, to: 'ayer' });
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
  });

  test('★ una fecha inexistente aborta en vez de correr el rango', async () => {
    for (const fecha of ['2025-02-29', '2024-13-01', '2024-04-31']) {
      process.exitCode = 0;
      logsDe([]);
      await dryRun({ ...ARGS, out: dir, to: fecha });
      expect(process.exitCode).toBe(1);
    }
  });

  test('--from inexistente también aborta', async () => {
    logsDe([]);
    await dryRun({ ...ARGS, out: dir, from: '2025-02-29', to: '2025-03-31' });
    expect(process.exitCode).toBe(1);
  });

  test('un rango invertido aborta', async () => {
    logsDe([]);
    await dryRun({ ...ARGS, out: dir, from: '2025-03-01', to: '2025-01-01' });
    expect(process.exitCode).toBe(1);
  });
});

describe('carga de entorno', () => {
  test('--no-env usa el shell y no toca process.env', () => {
    expect(cargarEnv(['--no-env']).modo).toBe('shell');
  });

  test('un --env inexistente cae al shell y lo reporta', () => {
    const r2 = cargarEnv(['--env', path.join(dir, 'no-existe.env')]);
    expect(r2.modo).toBe('shell');
    expect(r2.faltante).toBe(true);
  });

  test('★ un .env presente pisa el valor del shell (override)', () => {
    // Es el caso verificado en producción: DB_PASSWORD del shell no coincide
    // con el de api/.env, y sin override la conexión falla.
    const envFile = path.join(dir, 'test.env');
    fs.writeFileSync(envFile, 'REPAIR_TEST_VAR=delArchivo\n');
    process.env.REPAIR_TEST_VAR = 'delShell';

    const r2 = cargarEnv(['--env', envFile]);

    expect(r2.modo).toBe('archivo');
    expect(process.env.REPAIR_TEST_VAR).toBe('delArchivo');
    delete process.env.REPAIR_TEST_VAR;
  });

  test('la salida no imprime valores de variables sensibles', async () => {
    process.env.DB_PASSWORD = 'secreto-no-imprimible';
    process.env.ATT_PASSWORD = 'otro-secreto';
    mockQuery.mockResolvedValue([[]]);
    await dryRun({ ...ARGS, out: dir });

    const salida = console.log.mock.calls.flat().join('\n');
    expect(salida).not.toContain('secreto-no-imprimible');
    expect(salida).not.toContain('otro-secreto');
    expect(salida).toMatch(/DB_PASSWORD/);    // sí se informa que están definidas
    expect(salida).toMatch(/ATT_PASSWORD/);
    delete process.env.DB_PASSWORD;
    delete process.env.ATT_PASSWORD;
  });

  test('★ informa las variables que el conector LEE de verdad (ATT_*, no ATT2000_*)', async () => {
    process.env.ATT_HOST = 'h';
    process.env.ATT_DATABASE = 'att2000';
    mockQuery.mockResolvedValue([[]]);
    await dryRun({ ...ARGS, out: dir });

    const salida = console.log.mock.calls.flat().join('\n');
    expect(salida).toMatch(/ATT_HOST/);
    expect(salida).toMatch(/ATT_DATABASE/);
    delete process.env.ATT_HOST; delete process.env.ATT_DATABASE;
  });

  test('★ avisa si están las ATT2000_* que documenta CLAUDE.md pero no las ATT_* que se leen', async () => {
    // Trampa real: quien sigue la documentación configura variables que el
    // conector nunca mira, y antes el diagnóstico decía "(ninguna)".
    process.env.ATT2000_HOST = 'h';
    process.env.ATT2000_USER = 'u';
    mockQuery.mockResolvedValue([[]]);
    await dryRun({ ...ARGS, out: dir });

    const salida = console.log.mock.calls.flat().join('\n');
    expect(salida).toMatch(/el conector lee ATT_\*/);
    delete process.env.ATT2000_HOST; delete process.env.ATT2000_USER;
  });
});

describe('apply', () => {
  test('★ sin --manifest no hace nada y falla ruidosamente', async () => {
    await apply({ ...ARGS, apply: true, manifest: null });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test('manifest inexistente o ilegible se rechaza', async () => {
    await apply({ ...ARGS, apply: true, manifest: path.join(dir, 'no-existe.json') });
    expect(process.exitCode).toBe(1);

    const roto = path.join(dir, 'roto.json');
    fs.writeFileSync(roto, '{ esto no es json');
    process.exitCode = 0;
    await apply({ ...ARGS, apply: true, manifest: roto });
    expect(process.exitCode).toBe(1);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test('★ un manifest sin el arreglo `filas` se rechaza', async () => {
    const f = path.join(dir, 'sin-filas.json');
    fs.writeFileSync(f, JSON.stringify({ generado: 'x', resumen: {} }));
    await apply({ ...ARGS, apply: true, manifest: f });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test('★ sólo escribe las filas aplicables', async () => {
    okQuery();
    const f = manifestCon([
      FILA_OK,
      { ...FILA_OK, attendance_log_id: 2, status: 'NO_MATCH', proposed_timestamp: null },
      { ...FILA_OK, attendance_log_id: 3, status: 'AMBIGUOUS', proposed_timestamp: null },
      { ...FILA_OK, attendance_log_id: 4, status: 'COLLISION' },
      { ...FILA_OK, attendance_log_id: 5, status: 'ALREADY_CORRECT', delta_minutes: 0 },
    ]);

    await apply({ ...ARGS, apply: true, manifest: f });

    const updates = mockQuery.mock.calls.filter(c => /UPDATE/i.test(String(c[0])));
    expect(updates).toHaveLength(1);
    expect(updates[0][1].replacements[1]).toBe(1);   // sólo el id 1
  });

  test('★ el valor se escribe como STRING de pared, no como Date', async () => {
    // Pasar un Date haría que el driver lo convierta otra vez y reintroduzca
    // exactamente el defecto que se está reparando.
    okQuery();
    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA_OK]) });

    const [, opts] = mockQuery.mock.calls.find(c => /UPDATE/i.test(String(c[0])));
    const nuevo = opts.replacements[0];
    expect(typeof nuevo).toBe('string');
    expect(nuevo).toBe('2024-04-29 06:42:29');
    expect(nuevo instanceof Date).toBe(false);
  });

  test('★ el guard compara TODOS los campos que decidieron la propuesta', async () => {
    // No alcanza con id/timestamp/source: si alguien reasignó el empleado, la
    // hora propuesta salió del USERID anterior; si cambió el dispositivo, la
    // verificación del UNIQUE ya no vale; si cambió el tipo, tampoco.
    okQuery();
    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA_OK]) });

    const [sql, opts] = mockQuery.mock.calls.find(c => /UPDATE/i.test(String(c[0])));
    for (const campo of ['id = ?', 'timestamp = ?', 'source = ?', 'employee_id = ?',
                         'IFNULL(device_id, 0) = ?', 'type = ?']) {
      expect(sql).toContain(campo);
    }
    expect(opts.replacements).toEqual([
      '2024-04-29 06:42:29', 1, '2024-04-29 02:42:29', 'device', 10, 5, 'in',
    ]);
  });

  test('device_id nulo se compara como 0, igual que en el UNIQUE', async () => {
    okQuery();
    await apply({ ...ARGS, apply: true, manifest: manifestCon([{ ...FILA_OK, device_id: null }]) });
    const [, opts] = mockQuery.mock.calls.find(c => /UPDATE/i.test(String(c[0])));
    expect(opts.replacements[5]).toBe(0);
  });

  test('★ colisión sobrevenida: se revalida el UNIQUE dentro de la transacción', async () => {
    // Entre el dry-run y el apply otra ingesta insertó esa hora. Sin revalidar,
    // el UPDATE chocaría con el índice y voltearía el lote entero.
    attRevalida();
    mockQuery.mockImplementation((sql) =>
      /SELECT id FROM attendance_logs/i.test(String(sql))
        ? Promise.resolve([[{ id: 99 }]])
        : Promise.resolve([[], { affectedRows: 1 }]));

    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA_OK]) });

    expect(mockQuery.mock.calls.filter(c => /UPDATE/i.test(String(c[0])))).toHaveLength(0);
    expect(console.log.mock.calls.flat().join('\n')).toMatch(/rechazados\s+1/);
  });

  test('★ un duplicado en carrera se aísla por fila, no tumba el lote', async () => {
    const rollback = jest.fn(async () => {});
    mockTransaction.mockResolvedValue({ commit: async () => {}, rollback });
    attRevalida();
    mockQuery.mockImplementation((sql) =>
      /SELECT id FROM attendance_logs/i.test(String(sql))
        ? Promise.resolve([[]])
        : Promise.reject(new Error("Duplicate entry for key 'uk_emp_ts_dev'")));

    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA_OK]) });

    expect(rollback).not.toHaveBeenCalled();
    expect(console.log.mock.calls.flat().join('\n')).toMatch(/rechazados\s+1/);
  });

  test('★ manifest desactualizado: el registro cambió y no se pisa', async () => {
    // affectedRows 0 = el guard no encontró la fila con el old_timestamp
    // esperado, así que alguien la modificó después del dry-run.
    okQuery(0);
    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA_OK]) });

    const salida = console.log.mock.calls.flat().join('\n');
    expect(salida).toMatch(/actualizados\s+0/);
    expect(salida).toMatch(/rechazados\s+1/);
  });

  test('★ un error en el lote lo revierte y aborta ruidosamente', async () => {
    const rollback = jest.fn(async () => {});
    mockTransaction.mockResolvedValue({ commit: async () => {}, rollback });
    attRevalida();
    mockQuery.mockRejectedValue(new Error('deadlock'));

    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA_OK]) });

    expect(rollback).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test('★ idempotencia: reaplicar el mismo manifest no vuelve a escribir', async () => {
    // Tras la primera pasada el timestamp ya es el propuesto, así que el
    // guard (que exige el old_timestamp) no matchea y devuelve 0 filas.
    okQuery(0);
    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA_OK]) });

    const salida = console.log.mock.calls.flat().join('\n');
    expect(salida).toMatch(/actualizados\s+0/);
  });

  // ── Protecciones agregadas tras la auditoría operacional ──

  test('★ un manifest con OTRA versión de algoritmo se rechaza', async () => {
    // La regla de clasificación cambió durante el desarrollo: un manifest
    // viejo propondría correcciones que el criterio vigente rechazaría.
    okQuery();
    const f = manifestCon([FILA_OK], { repair_algorithm_version: 1 });
    await apply({ ...ARGS, apply: true, manifest: f });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test('un manifest sin versión tampoco se aplica', async () => {
    okQuery();
    const f = manifestCon([FILA_OK], { repair_algorithm_version: undefined });
    await apply({ ...ARGS, apply: true, manifest: f });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test('★ un manifest diagnóstico no se puede aplicar', async () => {
    okQuery();
    const f = manifestCon([FILA_OK], { aplicable: false });
    await apply({ ...ARGS, apply: true, manifest: f });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test('★ un manifest de otro source no se puede aplicar', async () => {
    okQuery();
    const f = manifestCon([FILA_OK], {
      parametros: { source: 'zkteco_direct', from: null, to: null, employee: null },
    });
    await apply({ ...ARGS, apply: true, manifest: f });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test('★ una fila de otro source se rechaza aunque el manifest sea de device', async () => {
    okQuery();
    const f = manifestCon([{ ...FILA_OK, source: 'zkteco_direct' }]);
    await apply({ ...ARGS, apply: true, manifest: f });

    expect(mockQuery.mock.calls.filter(c => /UPDATE/i.test(String(c[0])))).toHaveLength(0);
  });

  test('★ EDICIÓN MANUAL: promover AMBIGUOUS a MATCH_240 no alcanza para escribir', async () => {
    // El escenario que motivó esta auditoría. Se toma una fila legítimamente
    // ambigua y se la reescribe a mano como MATCH_240 con una hora propuesta.
    okQuery();
    const ambigua = {
      ...FILA_OK, attendance_log_id: 7, status: 'AMBIGUOUS',
      proposed_timestamp: null, delta_minutes: null,
    };
    const promovida = { ...ambigua, status: 'MATCH_240', proposed_timestamp: '2024-04-29 06:42:29', delta_minutes: 240 };

    // (a) Sin recalcular la huella: la del archivo ya no corresponde.
    const conHuellaVieja = path.join(dir, 'editado.json');
    fs.writeFileSync(conHuellaVieja, JSON.stringify({
      manifest_version: repair.MANIFEST_VERSION,
      repair_algorithm_version: repair.REPAIR_ALGORITHM_VERSION,
      aplicable: true,
      parametros: { source: 'device' },
      filas: [{ ...promovida, digest: repair.rowDigest(ambigua) }],
    }));
    await apply({ ...ARGS, apply: true, manifest: conHuellaVieja });
    expect(mockQuery.mock.calls.filter(c => /UPDATE/i.test(String(c[0])))).toHaveLength(0);

    // (b) Recalculando la huella —quien conoce el algoritmo puede—: igual se
    // rechaza, porque el apply REVALIDA contra ATT2000 y ahí la fila sigue
    // siendo ambigua.
    mockQuery.mockClear();
    mockAtt.mockResolvedValue([
      { USERID: '3091', CHECKTIME: '2024-04-29 05:42:29', CHECKTYPE: 'I' },
      { USERID: '3091', CHECKTIME: '2024-04-29 06:42:29', CHECKTYPE: 'O' },
    ]);
    await apply({ ...ARGS, apply: true, manifest: manifestCon([promovida]) });

    expect(mockQuery.mock.calls.filter(c => /UPDATE/i.test(String(c[0])))).toHaveLength(0);
    expect(console.log.mock.calls.flat().join('\n')).toMatch(/revalidación distinta/);
  });

  test('★ la revalidación rechaza si ATT2000 ya no respalda la propuesta', async () => {
    okQuery();
    mockAtt.mockResolvedValue([]);   // el marcaje desapareció de la fuente
    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA_OK]) });

    expect(mockQuery.mock.calls.filter(c => /UPDATE/i.test(String(c[0])))).toHaveLength(0);
    expect(console.log.mock.calls.flat().join('\n')).toMatch(/NO_MATCH/);
  });

  test('★ ATT2000 caído durante el apply aborta sin escribir', async () => {
    okQuery();
    mockAtt.mockRejectedValue(new Error('ECONNREFUSED'));
    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA_OK]) });

    expect(mockQuery.mock.calls.filter(c => /UPDATE/i.test(String(c[0])))).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  test('★ un manifest SIN huella global se rechaza', async () => {
    // Tratarla como opcional dejaba borrarla para saltear la verificación:
    // con eso se podían pegar filas de otro manifest —con huella individual
    // válida— sin que el cambio de estructura se detectara.
    okQuery();
    const f = manifestCon([FILA_OK], { digest: undefined });
    await apply({ ...ARGS, apply: true, manifest: f });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test('★ una fila duplicada dentro del manifest rompe la huella global', async () => {
    okQuery();
    const base = manifestCon([FILA_OK]);
    const m = JSON.parse(fs.readFileSync(base, 'utf8'));
    m.filas.push({ ...m.filas[0] });          // duplicado exacto, huella válida
    fs.writeFileSync(base, JSON.stringify(m));

    await apply({ ...ARGS, apply: true, manifest: base });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test('la huella global detecta filas agregadas al archivo', async () => {
    okQuery();
    const base = manifestCon([FILA_OK]);
    const m = JSON.parse(fs.readFileSync(base, 'utf8'));
    // Se agrega una fila con huella propia válida, pero la global ya no cierra.
    const extra = { ...FILA_OK, attendance_log_id: 99 };
    m.filas.push({ ...extra, digest: repair.rowDigest(extra) });
    fs.writeFileSync(base, JSON.stringify(m));

    await apply({ ...ARGS, apply: true, manifest: base });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test('no recalcula resúmenes automáticamente', async () => {
    okQuery();
    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA_OK]) });

    const sqls = mockQuery.mock.calls.map(c => String(c[0]));
    expect(sqls.some(s => /daily_summary/i.test(s))).toBe(false);
    expect(console.log.mock.calls.flat().join('\n')).toMatch(/NO se recalcularon resúmenes/);
  });
});
