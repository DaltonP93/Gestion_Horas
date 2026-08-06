/**
 * Carga de schedules HR frente a la deriva de esquema.
 *
 * Error de producción que lo motiva:
 *     ER_NO_SUCH_TABLE   stage: load_schedules   sqlState: 42S02
 *
 * La regla que se prueba: una tabla ausente es un ESTADO (módulo no
 * instalado), cualquier otro fallo de base es un ERROR. Confundirlos en
 * cualquiera de las dos direcciones es un bug — uno llena los logs de ruido,
 * el otro esconde una caída real detrás de un mensaje tranquilizador.
 */

const mockLogs = { info: [], warn: [], error: [] };
jest.mock('../src/config/logger', () => ({
  info: (msg, meta) => mockLogs.info.push({ msg, meta }),
  warn: (msg, meta) => mockLogs.warn.push({ msg, meta }),
  error: (msg, meta) => mockLogs.error.push({ msg, meta }),
}));

const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({ sequelize: { query: (...a) => mockQuery(...a) } }));

const mockTareas = [];
jest.mock('node-cron', () => ({
  validate: () => true,
  schedule: (expr) => { const t = { expr, stop: jest.fn() }; mockTareas.push(t); return t; },
}));

const { loadHrSchedules } = require('../src/services/hrSourceSync');

/** Error tal como lo entrega Sequelize sobre mysql2. */
function errorTablaAusente({ envuelto = true } = {}) {
  const driver = new Error("Table 'asistencia.external_hr_sources' doesn't exist");
  driver.code = 'ER_NO_SUCH_TABLE';
  driver.errno = 1146;
  driver.sqlState = '42S02';
  driver.sqlMessage = "Table 'asistencia.external_hr_sources' doesn't exist";
  if (!envuelto) return driver;

  const wrapper = new Error(driver.message);
  wrapper.name = 'SequelizeDatabaseError';
  wrapper.parent = driver;
  wrapper.original = driver;
  return wrapper;
}

beforeEach(() => {
  mockLogs.info.length = 0; mockLogs.warn.length = 0; mockLogs.error.length = 0;
  mockTareas.length = 0;
  mockQuery.mockReset();
});

describe('la tabla existe', () => {
  test('con fuentes activas, las programa', async () => {
    mockQuery.mockResolvedValueOnce([[
      { id: 1, name: 'SAP', schedule_cron: '0 4 * * *' },
      { id: 2, name: 'Odoo', schedule_cron: '0 5 * * *' },
    ]]);

    const r = await loadHrSchedules();

    expect(r.state).toBe('loaded');
    expect(r.scheduled).toBe(2);
    expect(mockTareas).toHaveLength(2);
    expect(mockLogs.error).toHaveLength(0);
  });

  test('sin fuentes activas, no es error: es "nada que programar"', async () => {
    mockQuery.mockResolvedValueOnce([[]]);

    const r = await loadHrSchedules();

    expect(r.state).toBe('no_active_sources');
    expect(r.scheduled).toBe(0);
    expect(mockTareas).toHaveLength(0);
    expect(mockLogs.error).toHaveLength(0);
    expect(mockLogs.info.some(l => l.meta?.result === 'skipped')).toBe(true);
  });
});

describe('la tabla NO existe — módulo no instalado', () => {
  test('no se registra como error', async () => {
    mockQuery.mockRejectedValueOnce(errorTablaAusente());

    const r = await loadHrSchedules();

    expect(r.state).toBe('table_missing');
    expect(mockLogs.error).toHaveLength(0);          // ← lo que fallaba en producción
  });

  test('se registra como skipped, con la tabla y una pista accionable', async () => {
    mockQuery.mockRejectedValueOnce(errorTablaAusente());
    await loadHrSchedules();

    const w = mockLogs.warn[0];
    expect(w.meta.result).toBe('skipped');
    expect(w.meta.reason).toBe('table_missing');
    expect(w.meta.missing_table).toBe('external_hr_sources');
    expect(w.meta.hint).toMatch(/migrat/i);
  });

  test('no se programa ningún cron', async () => {
    mockQuery.mockRejectedValueOnce(errorTablaAusente());
    await loadHrSchedules();

    expect(mockTareas).toHaveLength(0);
  });

  test('lo detecta esté el error envuelto por Sequelize o crudo del driver', async () => {
    for (const envuelto of [true, false]) {
      mockQuery.mockReset(); mockLogs.warn.length = 0; mockLogs.error.length = 0;
      mockQuery.mockRejectedValueOnce(errorTablaAusente({ envuelto }));

      expect((await loadHrSchedules()).state).toBe('table_missing');
      expect(mockLogs.error).toHaveLength(0);
    }
  });

  test('el log no filtra el nombre de la base', async () => {
    mockQuery.mockRejectedValueOnce(errorTablaAusente());
    await loadHrSchedules();

    expect(JSON.stringify(mockLogs.warn)).not.toContain('asistencia.');
  });
});

describe('un fallo real de base SIGUE siendo un error', () => {
  const reales = [
    ['acceso denegado',   Object.assign(new Error('Access denied'), { code: 'ER_ACCESS_DENIED_ERROR', sqlState: '28000' })],
    ['conexión perdida',  Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' })],
    ['deadlock',          Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK', sqlState: '40001' })],
    ['columna ausente',   Object.assign(new Error("Unknown column 'x'"), { code: 'ER_BAD_FIELD_ERROR', sqlState: '42S22' })],
    ['error sin código',  new Error('algo raro')],
  ];

  test.each(reales)('%s no se disfraza de "módulo no instalado"', async (_n, err) => {
    mockQuery.mockRejectedValueOnce(err);

    const r = await loadHrSchedules();

    expect(r.state).toBe('error');
    expect(mockLogs.error).toHaveLength(1);
    expect(mockLogs.error[0].meta.result).toBe('error');
    expect(mockLogs.warn.some(w => w.meta?.reason === 'table_missing')).toBe(false);
  });
});

describe('nunca tumba el arranque de la API', () => {
  test('no lanza en ningún escenario', async () => {
    const escenarios = [
      () => mockQuery.mockResolvedValueOnce([[]]),
      () => mockQuery.mockResolvedValueOnce([[{ id: 1, name: 'X', schedule_cron: '0 4 * * *' }]]),
      () => mockQuery.mockRejectedValueOnce(errorTablaAusente()),
      () => mockQuery.mockRejectedValueOnce(new Error('boom')),
    ];
    for (const armar of escenarios) {
      mockQuery.mockReset(); armar();
      await expect(loadHrSchedules()).resolves.toBeDefined();
    }
  });

  test('ninguna promesa queda sin manejar', async () => {
    const sinManejar = [];
    const captura = (r) => sinManejar.push(r);
    process.on('unhandledRejection', captura);

    mockQuery.mockRejectedValueOnce(errorTablaAusente());
    await loadHrSchedules();
    mockQuery.mockReset();
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    await loadHrSchedules();

    await new Promise(r => setImmediate(r));
    process.off('unhandledRejection', captura);

    expect(sinManejar).toEqual([]);
  });
});

describe('detección de errores de esquema (schemaState)', () => {
  const { isMissingTableError, missingTableName } = require('../src/utils/schemaState');

  test('reconoce ER_NO_SUCH_TABLE y 42S02 por separado', () => {
    expect(isMissingTableError(Object.assign(new Error('x'), { code: 'ER_NO_SUCH_TABLE' }))).toBe(true);
    expect(isMissingTableError(Object.assign(new Error('x'), { sqlState: '42S02' }))).toBe(true);
  });

  test('lo encuentra a través de parent, original y cause', () => {
    const driver = Object.assign(new Error('x'), { code: 'ER_NO_SUCH_TABLE' });
    for (const clave of ['parent', 'original', 'cause']) {
      expect(isMissingTableError(Object.assign(new Error('wrap'), { [clave]: driver }))).toBe(true);
    }
  });

  test('no confunde otros errores de esquema', () => {
    // 42S22 es "columna desconocida": también es deriva, pero NO es tabla
    // ausente y no debe silenciarse por este camino.
    expect(isMissingTableError(Object.assign(new Error('x'), { sqlState: '42S22' }))).toBe(false);
    expect(isMissingTableError(new Error('sin código'))).toBe(false);
    expect(isMissingTableError(null)).toBe(false);
    expect(isMissingTableError(undefined)).toBe(false);
  });

  test('no entra en bucle con errores encadenados circularmente', () => {
    const a = new Error('a'); const b = new Error('b');
    a.parent = b; b.parent = a;
    expect(() => isMissingTableError(a)).not.toThrow();
    expect(isMissingTableError(a)).toBe(false);
  });

  test('extrae la tabla sin el nombre de la base', () => {
    const err = Object.assign(new Error("Table 'asistencia.external_hr_sources' doesn't exist"),
      { code: 'ER_NO_SUCH_TABLE' });

    expect(missingTableName(err)).toBe('external_hr_sources');
  });

  test('devuelve null si el mensaje no trae la tabla', () => {
    expect(missingTableName(Object.assign(new Error('otra cosa'), { code: 'ER_NO_SUCH_TABLE' }))).toBeNull();
  });
});
