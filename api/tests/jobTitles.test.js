/**
 * jobTitles.test.js — PR 3 (catálogo de cargos).
 *
 * Contrato del servicio `jobTitles`:
 *  - La búsqueda por nombre es insensible a may/min y a espacios de los
 *    bordes, igual que la UNIQUE de la tabla (utf8mb4_unicode_ci). Si no,
 *    "operario " rebotaría contra el cargo "Operario" ya cargado.
 *  - `canonicalName` devuelve el nombre tal como está en el catálogo, para
 *    que lo que se guarda en `employees.position` no acumule variantes.
 *  - La cache se sirve mientras está fresca y se suelta al invalidarla.
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));

const { sequelize } = require('../src/config/database');
const jobTitles = require('../src/services/jobTitles');

const ROWS = [
  { id: 1, name: 'Operario',   description: null, active: 1, sort_order: 0 },
  { id: 2, name: 'Analista',   description: null, active: 1, sort_order: 0 },
  { id: 3, name: 'Sereno',     description: null, active: 0, sort_order: 0 },
];

beforeEach(() => {
  jest.clearAllMocks();
  jobTitles.invalidateCache();
  sequelize.query.mockResolvedValue([ROWS]);
});

describe('jobTitles.listAll', () => {
  test('activeOnly filtra los desactivados', async () => {
    const all = await jobTitles.listAll();
    expect(all).toHaveLength(3);
    const activos = await jobTitles.listAll({ activeOnly: true });
    expect(activos.map(r => r.name)).toEqual(['Operario', 'Analista']);
  });

  test('la cache evita una segunda consulta', async () => {
    await jobTitles.listAll();
    await jobTitles.listAll();
    expect(sequelize.query).toHaveBeenCalledTimes(1);
  });

  test('invalidateCache fuerza a releer', async () => {
    await jobTitles.listAll();
    jobTitles.invalidateCache();
    await jobTitles.listAll();
    expect(sequelize.query).toHaveBeenCalledTimes(2);
  });
});

describe('jobTitles.findByName', () => {
  test('coincide ignorando may/min y espacios de los bordes', async () => {
    for (const needle of ['Operario', 'operario', 'OPERARIO', '  Operario  ']) {
      const found = await jobTitles.findByName(needle);
      expect(found?.id).toBe(1);
    }
  });

  test('un nombre inexistente devuelve null', async () => {
    expect(await jobTitles.findByName('Astronauta')).toBeNull();
  });

  test('vacío, espacios y no-string devuelven null sin consultar', async () => {
    jobTitles.invalidateCache();
    for (const v of ['', '   ', null, undefined, 42, {}]) {
      expect(await jobTitles.findByName(v)).toBeNull();
    }
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});

describe('jobTitles.isActiveName', () => {
  test('true sólo para cargos activos', async () => {
    expect(await jobTitles.isActiveName('Operario')).toBe(true);
    expect(await jobTitles.isActiveName('Sereno')).toBe(false);
    expect(await jobTitles.isActiveName('Astronauta')).toBe(false);
  });
});

describe('jobTitles.canonicalName', () => {
  test('normaliza la variante tipeada al nombre del catálogo', async () => {
    expect(await jobTitles.canonicalName('  oPeRaRiO ')).toBe('Operario');
  });

  test('null si el cargo no está en el catálogo', async () => {
    expect(await jobTitles.canonicalName('Astronauta')).toBeNull();
  });
});

describe('jobTitles.countUsage', () => {
  test('cuenta empleados por nombre de cargo', async () => {
    sequelize.query.mockResolvedValueOnce([[{ c: '7' }]]);
    expect(await jobTitles.countUsage('Operario')).toBe(7);
  });

  test('sin filas devuelve 0, no NaN', async () => {
    sequelize.query.mockResolvedValueOnce([[]]);
    expect(await jobTitles.countUsage('Operario')).toBe(0);
  });
});
