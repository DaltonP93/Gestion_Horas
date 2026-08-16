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

const { dryRun, apply } = require('../scripts/historical-attendance-repair');

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

const ARGS = { apply: false, out: null, source: 'device', from: null, to: null, employee: null, limit: null, batchSize: 500, manifest: null };

function manifestCon(filas) {
  const f = path.join(dir, 'manifest.json');
  fs.writeFileSync(f, JSON.stringify({ generado: 'x', filas }));
  return f;
}

const FILA_OK = {
  attendance_log_id: 1, employee_id: 10, employee_code: '3091', device_id: 5,
  source: 'device', old_timestamp: '2024-04-29 02:42:29',
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
    mockQuery.mockResolvedValue([[], { affectedRows: 1 }]);
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
    mockQuery.mockResolvedValue([[], { affectedRows: 1 }]);
    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA_OK]) });

    const [, opts] = mockQuery.mock.calls.find(c => /UPDATE/i.test(String(c[0])));
    const nuevo = opts.replacements[0];
    expect(typeof nuevo).toBe('string');
    expect(nuevo).toBe('2024-04-29 06:42:29');
    expect(nuevo instanceof Date).toBe(false);
  });

  test('★ guard optimista: el UPDATE exige el old_timestamp original', async () => {
    mockQuery.mockResolvedValue([[], { affectedRows: 1 }]);
    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA_OK]) });

    const [sql, opts] = mockQuery.mock.calls.find(c => /UPDATE/i.test(String(c[0])));
    expect(sql).toMatch(/WHERE id = \? AND timestamp = \? AND source = \?/);
    expect(opts.replacements).toEqual([
      '2024-04-29 06:42:29', 1, '2024-04-29 02:42:29', 'device',
    ]);
  });

  test('★ manifest desactualizado: el registro cambió y no se pisa', async () => {
    // affectedRows 0 = el guard no encontró la fila con el old_timestamp
    // esperado, así que alguien la modificó después del dry-run.
    mockQuery.mockResolvedValue([[], { affectedRows: 0 }]);
    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA_OK]) });

    const salida = console.log.mock.calls.flat().join('\n');
    expect(salida).toMatch(/actualizados\s+0/);
    expect(salida).toMatch(/rechazados\s+1/);
  });

  test('★ un error en el lote lo revierte y aborta ruidosamente', async () => {
    const rollback = jest.fn(async () => {});
    mockTransaction.mockResolvedValue({ commit: async () => {}, rollback });
    mockQuery.mockRejectedValue(new Error('deadlock'));

    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA_OK]) });

    expect(rollback).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test('★ idempotencia: reaplicar el mismo manifest no vuelve a escribir', async () => {
    // Tras la primera pasada el timestamp ya es el propuesto, así que el
    // guard (que exige el old_timestamp) no matchea y devuelve 0 filas.
    mockQuery.mockResolvedValue([[], { affectedRows: 0 }]);
    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA_OK]) });

    const salida = console.log.mock.calls.flat().join('\n');
    expect(salida).toMatch(/actualizados\s+0/);
  });

  test('no recalcula resúmenes automáticamente', async () => {
    mockQuery.mockResolvedValue([[], { affectedRows: 1 }]);
    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA_OK]) });

    const sqls = mockQuery.mock.calls.map(c => String(c[0]));
    expect(sqls.some(s => /daily_summary/i.test(s))).toBe(false);
    expect(console.log.mock.calls.flat().join('\n')).toMatch(/NO se recalcularon resúmenes/);
  });
});
