/**
 * monthlyWorkedFromEngine.test.js
 *
 * FASE 0 — "consistencia de totales": el REPORTE MENSUAL calcula el trabajado
 * con el MISMO motor que Marcadas, de forma SÓLO LECTURA, para que los turnos
 * nocturnos que cruzan medianoche queden bien y el total del mes coincida con
 * Marcadas.
 *
 * Se prueban dos cosas:
 *   1. el helper `monthlyWorkedByEmployee` (el cálculo por el motor);
 *   2. que `GET /api/reports/monthly` lo USA — el total NO sale ya de
 *      `SUM(daily_summary.worked_minutes)`, así que un nocturno partido por el
 *      motor legacy en daily_summary igual se reporta como UN jornal.
 *
 * La base está mockeada. Sin configuración cargada, todas las jornadas caen en
 * `historical_fallback` (el estado real de producción), donde el motor no
 * descuenta el descanso de nuevo y `worked_minutes === segment_minutes`: por eso
 * el total del mensual y el "Total Permanencia" de Marcadas son el mismo número.
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));
jest.mock('../src/services/workdayConfig', () => ({
  loadWorkdayConfig: jest.fn(async () => ({ forDate: () => null, historyFor: () => [] })),
}));
jest.mock('../src/config/logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 1, role: 'admin' }; next(); },
  authorize: () => (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/departmentScope', () => ({
  getVisibleDepartmentIds: async () => ({ unrestricted: true }),
  applyDepartmentScope: (where, params) => ({ where, params }),
  canSeeEmployee: async () => true,
}));

const express = require('express');
const http = require('http');
const { sequelize } = require('../src/config/database');
const { monthlyWorkedByEmployee } = require('../src/services/monthlyWorkedFromEngine');
const { generateMarcadasReport } = require('../src/services/scheduler');
const reportsRouter = require('../src/routes/reports');

// Nocturno que cruza medianoche: entra Mié 15/01 21:00, descanso 00:00–00:30,
// sale Jue 16/01 06:00. Tramos: 21:00→00:00 = 180 min, 00:30→06:00 = 330 min.
// Trabajado = 510 min (8:30), atribuido íntegro al 15 (miércoles).
const NOCTURNO = [
  { id: 1, employee_id: 7, timestamp: '2025-01-15 21:00:00', type: 'in' },
  { id: 2, employee_id: 7, timestamp: '2025-01-16 00:00:00', type: 'out' },
  { id: 3, employee_id: 7, timestamp: '2025-01-16 00:30:00', type: 'in' },
  { id: 4, employee_id: 7, timestamp: '2025-01-16 06:00:00', type: 'out' },
];

describe('monthlyWorkedByEmployee — trabajado del mes por el motor', () => {
  beforeEach(() => sequelize.query.mockReset());

  test('nocturno cruzando medianoche = UN jornal del miércoles, no dos días', async () => {
    sequelize.query.mockResolvedValueOnce([NOCTURNO]);

    const map = await monthlyWorkedByEmployee([7], { from: '2025-01-01', to: '2025-01-31' });
    const agg = map.get(7);

    expect(agg.workedMinutes).toBe(510); // 8:30, no 3:00 + 5:30 en días distintos
    // Todo el jornal se fecha en el día de la PRIMERA entrada (15), nada el 16.
    expect(agg.byDate.get('2025-01-15')).toBe(510);
    expect(agg.byDate.has('2025-01-16')).toBe(false);
  });

  test('coincide con el total que reporta Marcadas para el mismo período', async () => {
    // Marcadas: primero el padrón, después los marcajes.
    sequelize.query
      .mockResolvedValueOnce([[{ employee_id: 7, employee_name: 'Ada Nocturna', code: '007', department: 'Vigilancia' }]])
      .mockResolvedValueOnce([NOCTURNO]);
    const marc = await generateMarcadasReport({ dateFrom: '2025-01-01', dateTo: '2025-01-31' });

    sequelize.query.mockReset();
    sequelize.query.mockResolvedValueOnce([NOCTURNO]);
    const map = await monthlyWorkedByEmployee([7], { from: '2025-01-01', to: '2025-01-31' });

    // En historical_fallback el trabajado del mensual == "Total Permanencia" de
    // Marcadas (segment_minutes). Cierran exactamente.
    expect(marc.data[0].total_minutes).toBe(510);
    expect(map.get(7).workedMinutes).toBe(marc.data[0].total_minutes);
  });

  test('no cambia para un mes de jornadas diurnas simples', async () => {
    // Tres días 08:00–17:00 (9 h), sin pausa marcada: presence == segment ==
    // worked == 540 min cada uno. El motor no altera el caso común.
    const diurnas = [];
    let id = 1;
    for (const d of ['06', '07', '08']) {
      diurnas.push({ id: id++, employee_id: 7, timestamp: `2025-01-${d} 08:00:00`, type: 'in' });
      diurnas.push({ id: id++, employee_id: 7, timestamp: `2025-01-${d} 17:00:00`, type: 'out' });
    }
    sequelize.query.mockResolvedValueOnce([diurnas]);

    const map = await monthlyWorkedByEmployee([7], { from: '2025-01-01', to: '2025-01-31' });
    expect(map.get(7).workedMinutes).toBe(540 * 3);
    expect(map.get(7).byDate.get('2025-01-06')).toBe(540);
    expect(map.get(7).byDate.get('2025-01-07')).toBe(540);
    expect(map.get(7).byDate.get('2025-01-08')).toBe(540);
  });

  test('un empleado sin marcajes queda en 0, no lanza', async () => {
    sequelize.query.mockResolvedValueOnce([[]]);
    const map = await monthlyWorkedByEmployee([7], { from: '2025-01-01', to: '2025-01-31' });
    expect(map.get(7).workedMinutes).toBe(0);
  });

  test('un lote que supera el tope de marcajes lanza un error tipado 413', async () => {
    sequelize.query.mockResolvedValueOnce([new Array(400001).fill(0)]);
    await expect(
      monthlyWorkedByEmployee([7], { from: '2025-01-01', to: '2025-12-31' }),
    ).rejects.toMatchObject({ status: 413, code: 'MONTHLY_TOO_MANY_PUNCHES' });
  });
});

describe('GET /api/reports/monthly usa el motor para el trabajado', () => {
  let server, base;
  beforeAll((done) => {
    const app = express();
    app.use('/api/reports', reportsRouter);
    server = http.createServer(app).listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });
  afterAll((done) => { server.close(done); });
  beforeEach(() => sequelize.query.mockReset());

  function getJson(path) {
    return new Promise((resolve, reject) => {
      http.get(base + path, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }).on('error', reject);
    });
  }

  test('el nocturno partido en daily_summary igual se reporta como UN jornal (510)', async () => {
    // 1ª consulta: agregado por empleado desde daily_summary (SIN worked, que
    //    ahora lo pone el motor). El conteo de estado sigue siendo legacy.
    // 2ª consulta: marcajes que lee el motor.
    sequelize.query
      .mockResolvedValueOnce([[{
        id: 7, code: '007', employee_name: 'Ada Nocturna', department: 'Vigilancia',
        days_present: 1, days_late: 0, days_absent: 0,
        total_late_minutes: 0, total_overtime_minutes: 0,
      }]])
      .mockResolvedValueOnce([NOCTURNO]);

    const { status, body } = await getJson('/api/reports/monthly?year=2025&month=1');
    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    // 510 min = 8:30, el jornal completo — NO la mitad partida por fecha civil.
    expect(body.data[0].total_worked_minutes).toBe(510);
  });
});
