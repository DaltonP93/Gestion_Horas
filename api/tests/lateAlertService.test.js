/**
 * lateAlertService.test.js — La alerta de atraso sale del MOTOR.
 *
 * Verifica que:
 *   - con configuración efectiva y llegada tarde → alerta con los minutos del motor;
 *   - sin configuración (historical_fallback) → NO se inventa tardanza;
 *   - con conflicto de turnera → NO se alerta.
 */

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() }, DB_TIMEZONE: '-03:00' }));
jest.mock('../src/services/recalcLock', () => ({
  withDayRecalcLock: jest.fn(async (_d, fn) => fn('TX')),
  dayBounds: (d) => ({ start: d, next: d }),
}));

const { sequelize } = require('../src/config/database');
const mockLoadWorkdayConfig = jest.fn();
jest.mock('../src/services/workdayConfig', () => ({ loadWorkdayConfig: (...a) => mockLoadWorkdayConfig(...a) }));

const lateAlert = require('../src/services/lateAlertService');

function conMarcajes(rows) {
  sequelize.query.mockReset();
  sequelize.query.mockImplementation(async (sql) => {
    if (/FROM attendance_logs/i.test(sql)) return [rows];
    if (/FROM holidays/i.test(sql)) return [[]];
    return [[]];
  });
}
function conConfig(cfg) {
  mockLoadWorkdayConfig.mockReset();
  mockLoadWorkdayConfig.mockResolvedValue({ forDate: () => cfg, historyFor: () => [] });
}

const emp = { first_name: 'Ana', last_name: 'Páez' };
function ioSpy() {
  const emit = jest.fn();
  const io = { to: () => io, emit };
  return { io, emit };
}

describe('checkAndAlertLate', () => {
  test('con config efectiva y llegada tarde emite alerta con los minutos del motor', async () => {
    conMarcajes([
      { id: 1, timestamp: '2025-06-10 08:20:00', type: 'in' },
      { id: 2, timestamp: '2025-06-10 17:00:00', type: 'out' },
    ]);
    conConfig({ source: 'schedule_history', check_in: '08:00', check_out: '17:00', tolerance_in: 5, work_days: [2, 3, 4, 5, 6] });
    const { io, emit } = ioSpy();
    await lateAlert.checkAndAlertLate(emp, 1, '2025-06-10 08:20:00', io);
    expect(emit).toHaveBeenCalledWith('alert:late', expect.objectContaining({ employeeId: 1, lateMinutes: 15 }));
  });

  test('SIN configuración efectiva no inventa tardanza (no alerta)', async () => {
    conMarcajes([{ id: 1, timestamp: '2025-06-10 09:30:00', type: 'in' }]);
    conConfig(null); // historical_fallback
    const { io, emit } = ioSpy();
    await lateAlert.checkAndAlertLate(emp, 1, '2025-06-10 09:30:00', io);
    expect(emit).not.toHaveBeenCalled();
  });

  test('con conflicto de turnera NO se alerta', async () => {
    conMarcajes([{ id: 1, timestamp: '2025-06-10 09:30:00', type: 'in' }]);
    conConfig({
      source: 'shift_assignment', check_in: '08:00', check_out: '17:00',
      tolerance_in: 0, conflict_shift_schedule_ids: [3, 9],
    });
    const { io, emit } = ioSpy();
    await lateAlert.checkAndAlertLate(emp, 1, '2025-06-10 09:30:00', io);
    expect(emit).not.toHaveBeenCalled();
  });

  test('dentro de la tolerancia no alerta', async () => {
    conMarcajes([{ id: 1, timestamp: '2025-06-10 08:03:00', type: 'in' }]);
    conConfig({ source: 'schedule_history', check_in: '08:00', check_out: '17:00', tolerance_in: 5, work_days: [2, 3, 4, 5, 6] });
    const { io, emit } = ioSpy();
    await lateAlert.checkAndAlertLate(emp, 1, '2025-06-10 08:03:00', io);
    expect(emit).not.toHaveBeenCalled();
  });
});
