/**
 * Cubre el scope de departamento aplicado en generateMarcadasReport (PR 7).
 *
 * No probamos el SQL contra una base real; mockeamos `sequelize.query` para
 * inspeccionar el fragmento inyectado y los params concatenados. Es
 * complementario al test de `applyDepartmentScope` (que ya cubre la unidad
 * `where/params`).
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));

const { sequelize } = require('../src/config/database');
const { generateMarcadasReport } = require('../src/services/scheduler');

function capturedSql() {
  const call = sequelize.query.mock.calls[0];
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
    // Devolvemos "sin logs" para acortar el flujo — sólo nos interesa el SQL.
    sequelize.query.mockResolvedValue([[]]);
  });

  test('sin scope: no inyecta cláusula IN', async () => {
    await generateMarcadasReport({ dateFrom: '2026-07-01', dateTo: '2026-07-31' });
    const { sql, replacements } = capturedSql();
    expect(sql).not.toMatch(/department_id IN/);
    expect(replacements).toEqual(['2026-07-01', '2026-07-31']);
  });

  test('scope unrestricted: sigue siendo no-op', async () => {
    await generateMarcadasReport({
      dateFrom: '2026-07-01', dateTo: '2026-07-31',
      scope: { unrestricted: true },
    });
    const { sql } = capturedSql();
    expect(sql).not.toMatch(/department_id IN/);
  });

  test('scope con ids: inyecta IN y los valores caen en su placeholder', async () => {
    await generateMarcadasReport({
      dateFrom: '2026-07-01', dateTo: '2026-07-31',
      scope: { unrestricted: false, ids: [3, 5] },
    });
    const { sql, replacements } = capturedSql();
    expect(sql).toMatch(/e\.department_id IN \(\?,\?\)/);
    // Los placeholders del filtro van ANTES del rango en el SQL, así que sus
    // valores van antes en el array.
    expect(replacements).toEqual([3, 5, '2026-07-01', '2026-07-31']);

    const bound = bindSql(sql, replacements);
    expect(bound).toMatch(/department_id IN \(3,5\)/);
    expect(bound).toMatch(/BETWEEN "2026-07-01" AND "2026-07-31"/);
  });

  test('deptId manual + scope: cada valor llega a su columna', async () => {
    await generateMarcadasReport({
      dateFrom: '2026-07-01', dateTo: '2026-07-31',
      deptId: 7,
      scope: { unrestricted: false, ids: [3, 4] },
    });
    const { sql, replacements } = capturedSql();
    expect(sql).toMatch(/e\.department_id = \?/);
    expect(sql).toMatch(/e\.department_id IN \(\?,\?\)/);
    expect(replacements).toEqual([7, 3, 4, '2026-07-01', '2026-07-31']);

    const bound = bindSql(sql, replacements);
    expect(bound).toMatch(/department_id = 7/);
    expect(bound).toMatch(/department_id IN \(3,4\)/);
    expect(bound).toMatch(/BETWEEN "2026-07-01" AND "2026-07-31"/);
  });

  test('la regresión: con deptId, el rango de fechas no recibe el id', async () => {
    // El defecto original inicializaba replacements con [from, to] y hacía
    // push de los filtros encima, así que `department_id = ?` recibía la fecha
    // de inicio y el BETWEEN terminaba comparando contra el id. Devolvía cero
    // filas. Sin filtros funcionaba por coincidencia, que es por qué pasó
    // desapercibido —y por qué este test usa deptId.
    await generateMarcadasReport({
      dateFrom: '2026-07-01', dateTo: '2026-07-31', deptId: 7,
    });
    const { sql, replacements } = capturedSql();
    const bound = bindSql(sql, replacements);

    expect(bound).toMatch(/department_id = 7/);
    expect(bound).not.toMatch(/department_id = "2026-07-01"/);
    expect(bound).toMatch(/BETWEEN "2026-07-01" AND "2026-07-31"/);
  });

  test('employeeId + deptId: orden correcto con dos filtros', async () => {
    await generateMarcadasReport({
      dateFrom: '2026-07-01', dateTo: '2026-07-31', employeeId: 42, deptId: 7,
    });
    const { sql, replacements } = capturedSql();
    expect(replacements).toEqual([42, 7, '2026-07-01', '2026-07-31']);

    const bound = bindSql(sql, replacements);
    expect(bound).toMatch(/e\.id = 42/);
    expect(bound).toMatch(/department_id = 7/);
    expect(bound).toMatch(/BETWEEN "2026-07-01" AND "2026-07-31"/);
  });

  test('scope sin ids (rol scoped sin depto vinculado): devuelve vacío sin tocar DB', async () => {
    const out = await generateMarcadasReport({
      dateFrom: '2026-07-01', dateTo: '2026-07-31',
      scope: { unrestricted: false, ids: [] },
    });
    expect(out.data).toEqual([]);
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});
