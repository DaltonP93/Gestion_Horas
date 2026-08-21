/**
 * Cubre el scope de departamento aplicado en generateMarcadasReport (PR 7).
 *
 * No probamos el SQL contra una base real; mockeamos `sequelize.query` para
 * inspeccionar el fragmento inyectado y los params concatenados. Es
 * complementario al test de `applyDepartmentScope` (que ya cubre la unidad
 * `where/params`).
 *
 * FORMA NUEVA DE LA CONSULTA
 *
 * Desde que el reporte pasa por `workdayEngine`, la lectura se hace en DOS
 * consultas en vez de una:
 *
 *   1. el PADRÓN, con los filtros y el scope RBAC — sin fechas;
 *   2. los MARCAJES del lote de empleados, con el rango — sin filtros de RBAC,
 *      que ya quedaron resueltos por la lista de ids del paso 1.
 *
 * El motivo es de memoria: leer todos los marcajes del período de una sola vez
 * es lo que hacía que el RSS creciera con el largo del rango. La propiedad que
 * este archivo protege no cambia —cada valor tiene que llegar a SU columna,
 * porque el enlace es posicional— pero ahora hay que verificarla en las dos.
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));
jest.mock('../src/services/workdayConfig', () => ({
  // Sin configuración cargada: todas las jornadas caen en historical_fallback,
  // que es el estado real mientras las migraciones 072/073 no estén aplicadas.
  loadWorkdayConfig: jest.fn(async () => ({
    forDate: () => null,
    historyFor: () => [],
  })),
}));

const { sequelize } = require('../src/config/database');
const { generateMarcadasReport } = require('../src/services/scheduler');

const EMPLEADO = {
  employee_id: 42, employee_name: 'Ana Páez', code: '3091', department: 'Recepción',
};

/** Consulta del padrón (la primera). */
function padron() {
  const call = sequelize.query.mock.calls[0];
  return { sql: call[0], replacements: call[1].replacements };
}

/** Consulta de marcajes (la segunda, si llegó a correr). */
function marcajes() {
  const call = sequelize.query.mock.calls[1];
  return { sql: call[0], replacements: call[1].replacements };
}

/**
 * Sustituye cada `?` por el valor que le tocaría posicionalmente.
 *
 * Comparar sólo el array de replacements no alcanza: el enlace es posicional,
 * así que un array con los valores correctos pero en otro orden pasa la
 * comparación y produce una consulta equivocada. Esta versión "enlazada" es la
 * que revela a qué columna llega cada valor de verdad.
 */
function bindSql(sql, replacements) {
  let i = 0;
  return sql.replace(/\?/g, () => JSON.stringify(replacements[i++]));
}

describe('generateMarcadasReport — scope de departamento', () => {
  beforeEach(() => {
    sequelize.query.mockReset();
    // Un empleado en el padrón y ningún marcaje: alcanza para que las dos
    // consultas se emitan y podamos inspeccionarlas.
    sequelize.query
      .mockResolvedValueOnce([[EMPLEADO]])
      .mockResolvedValue([[]]);
  });

  test('sin scope: no inyecta cláusula IN', async () => {
    await generateMarcadasReport({ dateFrom: '2026-07-01', dateTo: '2026-07-31' });
    const { sql, replacements } = padron();
    expect(sql).not.toMatch(/department_id IN/);
    expect(replacements).toEqual([]);
  });

  test('scope unrestricted: sigue siendo no-op', async () => {
    await generateMarcadasReport({
      dateFrom: '2026-07-01', dateTo: '2026-07-31',
      scope: { unrestricted: true },
    });
    expect(padron().sql).not.toMatch(/department_id IN/);
  });

  test('scope con ids: inyecta IN y los valores caen en su placeholder', async () => {
    await generateMarcadasReport({
      dateFrom: '2026-07-01', dateTo: '2026-07-31',
      scope: { unrestricted: false, ids: [3, 5] },
    });
    const { sql, replacements } = padron();
    expect(sql).toMatch(/e\.department_id IN \(\?,\?\)/);
    expect(replacements).toEqual([3, 5]);
    expect(bindSql(sql, replacements)).toMatch(/department_id IN \(3,5\)/);
  });

  test('deptId manual + scope: cada valor llega a su columna', async () => {
    await generateMarcadasReport({
      dateFrom: '2026-07-01', dateTo: '2026-07-31',
      deptId: 7,
      scope: { unrestricted: false, ids: [3, 4] },
    });
    const { sql, replacements } = padron();
    expect(sql).toMatch(/e\.department_id = \?/);
    expect(sql).toMatch(/e\.department_id IN \(\?,\?\)/);
    expect(replacements).toEqual([7, 3, 4]);

    const bound = bindSql(sql, replacements);
    expect(bound).toMatch(/department_id = 7/);
    expect(bound).toMatch(/department_id IN \(3,4\)/);
  });

  test('la regresión: el rango de fechas no puede recibir un id', async () => {
    // El defecto original inicializaba replacements con [from, to] y hacía
    // push de los filtros encima, así que `department_id = ?` recibía la fecha
    // de inicio y el rango terminaba comparando contra el id. Devolvía cero
    // filas. Sin filtros funcionaba por coincidencia, que es por qué pasó
    // desapercibido —y por qué este test usa deptId.
    //
    // Ahora las dos familias de valores viajan en consultas distintas, que es
    // una defensa más fuerte que el orden: el padrón no tiene placeholders de
    // fecha y los marcajes no tienen placeholders de departamento.
    await generateMarcadasReport({
      dateFrom: '2026-07-01', dateTo: '2026-07-31', deptId: 7,
    });

    const p = padron();
    expect(bindSql(p.sql, p.replacements)).toMatch(/department_id = 7/);
    expect(p.replacements).not.toContain('2026-07-01');

    const m = marcajes();
    expect(m.sql).not.toMatch(/department_id/);
    // La ventana se extiende un día a cada lado para no truncar la jornada de
    // los bordes. El límite superior es exclusivo y por eso llega al 02/08: el
    // 01/08 00:00 apenas cubriría el último día del período, sin dejar margen
    // para la jornada que entra el 31/07 a la noche y cierra a la mañana
    // siguiente.
    expect(m.replacements).toEqual([42, '2026-06-30 00:00:00', '2026-08-02 00:00:00']);
  });

  test('employeeId + deptId: orden correcto con dos filtros', async () => {
    await generateMarcadasReport({
      dateFrom: '2026-07-01', dateTo: '2026-07-31', employeeId: 42, deptId: 7,
    });
    const { sql, replacements } = padron();
    expect(replacements).toEqual([42, 7]);

    const bound = bindSql(sql, replacements);
    expect(bound).toMatch(/e\.id = 42/);
    expect(bound).toMatch(/department_id = 7/);
  });

  test('la consulta de marcajes es sargable: rango sobre la columna, sin DATE()', async () => {
    // `DATE(al.timestamp) BETWEEN ? AND ?` obliga a evaluar la función sobre
    // cada fila y no puede usar idx_emp_ts.
    await generateMarcadasReport({ dateFrom: '2026-07-01', dateTo: '2026-07-31' });
    const { sql } = marcajes();
    expect(sql).toMatch(/al\.timestamp >= \? AND al\.timestamp < \?/);
    expect(sql).not.toMatch(/DATE\(al\.timestamp\) BETWEEN/);
  });

  test('scope sin ids (rol scoped sin depto vinculado): devuelve vacío sin tocar DB', async () => {
    const out = await generateMarcadasReport({
      dateFrom: '2026-07-01', dateTo: '2026-07-31',
      scope: { unrestricted: false, ids: [] },
    });
    expect(out.data).toEqual([]);
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('padrón vacío: no emite la consulta de marcajes', async () => {
    sequelize.query.mockReset();
    sequelize.query.mockResolvedValue([[]]);
    const out = await generateMarcadasReport({ dateFrom: '2026-07-01', dateTo: '2026-07-31' });
    expect(out.data).toEqual([]);
    expect(sequelize.query).toHaveBeenCalledTimes(1);
  });
});
