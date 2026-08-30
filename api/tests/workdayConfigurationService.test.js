'use strict';

jest.mock('../src/config/database', () => {
  const query = jest.fn();
  const transaction = jest.fn(async (cb) => cb('TX'));
  return { sequelize: { query, transaction } };
});

jest.mock('../src/utils/mysqlRetry', () => ({
  withDeadlockRetry: jest.fn(async (fn) => ({ result: await fn(1), attempts: 1, retries: 0 })),
}));

const mockLoadWorkdayConfig = jest.fn();
jest.mock('../src/services/workdayConfig', () => ({
  loadWorkdayConfig: (...args) => mockLoadWorkdayConfig(...args),
  vigenteEn: (rows, date) => (rows || []).find((r) =>
    r.valid_from <= date && (!r.valid_to || r.valid_to >= date)) || null,
}));

const { sequelize } = require('../src/config/database');
const svc = require('../src/services/workdayConfigurationService');

beforeEach(() => {
  sequelize.query.mockReset();
  sequelize.transaction.mockClear();
  mockLoadWorkdayConfig.mockReset();
});

const schedule = {
  id: 7,
  name: 'Nocturno',
  check_in: '20:00:00',
  check_out: '06:00:00',
  tolerance_in: 10,
  tolerance_out: 5,
  break_minutes: 30,
  work_days: '2,3,4,5,6',
  active: 1,
};

describe('snapshot puro', () => {
  test('snapshotFromSchedule congela los campos mutables del horario', () => {
    const s = svc.snapshotFromSchedule(schedule, {
      weekly_target_minutes: 2520,
      work_regime: 'night',
      rounding_policy: 'nearest_5',
      rounding_policy_version: 2,
      overtime_policy: 'custom_ot',
      overtime_policy_version: 1,
    });

    expect(s.schedule_id).toBe(7);
    expect(s.schedule_name_snapshot).toBe('Nocturno');
    expect(s.check_in).toBe('20:00:00');
    expect(s.check_out).toBe('06:00:00');
    expect(s.work_days).toEqual([2, 3, 4, 5, 6]);
    expect(s.break_mode).toBe('fixed_unpaid');
    expect(s.break_minutes).toBe(30);
    expect(s.weekly_target_minutes).toBe(2520);
    expect(s.work_regime).toBe('night');
    expect(s.snapshot_source).toBe('schedule_snapshot');
  });

  test('no infiere régimen a partir de 36 horas', () => {
    const s = svc.snapshotFromSchedule(schedule, { weekly_target_minutes: 2160 });
    expect(s.weekly_target_minutes).toBe(2160);
    expect(s.work_regime).toBeNull();
  });

  test('acepta target custom', () => {
    const s = svc.snapshotFromSchedule(schedule, { weekly_target_minutes: 2220 });
    expect(s.weekly_target_minutes).toBe(2220);
  });

  test('rechaza snapshot incompleto', () => {
    expect(() => svc.buildSnapshot({}, {
      check_in: '08:00',
      check_out: '17:00',
      work_days: null,
    })).toThrow(/snapshot requiere/i);
  });

  test('vigencia usa fechas reales', () => {
    expect(svc.validDateISO('2024-02-29')).toBe(true);
    expect(svc.validDateISO('2023-02-29')).toBe(false);
  });
});

describe('createHistory', () => {
  test('crea bajo lock, valida solapamiento y persiste snapshot completo', async () => {
    sequelize.query.mockImplementation(async (sql) => {
      if (/GET_LOCK/.test(sql)) return [[{ ok: 1 }]];
      if (/RELEASE_LOCK/.test(sql)) return [[]];
      if (/SELECT id FROM employees/.test(sql)) return [[{ id: 1 }]];
      if (/FROM employee_schedule_history/.test(sql) && /FOR UPDATE/.test(sql) && /valid_from/.test(sql)) return [[]];
      if (/FROM schedules/.test(sql)) return [[schedule]];
      if (/INSERT INTO employee_schedule_history/.test(sql)) return [{ insertId: 77 }];
      if (/WHERE id = \? LIMIT 1/.test(sql)) return [[{
        id: 77,
        employee_id: 1,
        schedule_id: 7,
        schedule_name_snapshot: 'Nocturno',
        valid_from: '2026-01-01',
        valid_to: null,
        check_in: '20:00:00',
        check_out: '06:00:00',
        tolerance_in: 10,
        tolerance_out: 5,
        break_mode: 'fixed_unpaid',
        break_minutes: 30,
        break_after_minutes: 0,
        weekly_target_minutes: 2160,
        daily_target_minutes: null,
        work_regime: 'night',
        work_days: '2,3,4,5,6',
        snapshot_version: 1,
        snapshot_source: 'schedule_snapshot',
      }]];
      return [[]];
    });

    const row = await svc.createHistory(1, {
      schedule_id: 7,
      valid_from: '2026-01-01',
      weekly_target_minutes: 2160,
      work_regime: 'night',
      reason: 'Cambio contractual',
    }, 99);

    expect(row.id).toBe(77);
    expect(row.work_days).toEqual([2, 3, 4, 5, 6]);

    const sqls = sequelize.query.mock.calls.map((c) => c[0]).join('\n');
    expect(sqls).toMatch(/GET_LOCK/);
    expect(sqls).toMatch(/INSERT INTO employee_schedule_history/);
    expect(sqls).toMatch(/RELEASE_LOCK/);

    const insert = sequelize.query.mock.calls.find((c) => /INSERT INTO employee_schedule_history/.test(c[0]));
    expect(insert[1].replacements).toContain('2,3,4,5,6');
    expect(insert[1].transaction).toBe('TX');
  });

  test('rechaza solapamiento y no inserta', async () => {
    sequelize.query.mockImplementation(async (sql) => {
      if (/GET_LOCK/.test(sql)) return [[{ ok: 1 }]];
      if (/RELEASE_LOCK/.test(sql)) return [[]];
      if (/SELECT id FROM employees/.test(sql)) return [[{ id: 1 }]];
      if (/FROM employee_schedule_history/.test(sql) && /FOR UPDATE/.test(sql) && /valid_from/.test(sql)) {
        return [[{ id: 4, valid_from: '2025-01-01', valid_to: null }]];
      }
      return [[]];
    });

    await expect(svc.createHistory(1, {
      schedule_id: 7,
      valid_from: '2026-01-01',
    }, 99)).rejects.toMatchObject({ status: 409, code: 'WORKDAY_CONFIG_OVERLAP' });

    expect(sequelize.query.mock.calls.some((c) => /INSERT INTO employee_schedule_history/.test(c[0]))).toBe(false);
  });

  test('si GET_LOCK falla nunca ejecuta el writer', async () => {
    sequelize.query.mockImplementation(async (sql) => {
      if (/GET_LOCK/.test(sql)) return [[{ ok: 0 }]];
      return [[]];
    });

    await expect(svc.createHistory(1, {
      schedule_id: 7,
      valid_from: '2026-01-01',
    }, 99)).rejects.toBeTruthy();

    expect(sequelize.query.mock.calls.some((c) => /INSERT INTO employee_schedule_history/.test(c[0]))).toBe(false);
  });
});


describe('updateHistory — snapshot no mutable', () => {
  test('editar el perfil NO relee schedules ni cambia el horario congelado', async () => {
    const existing = {
      id: 10,
      employee_id: 1,
      schedule_id: 7,
      schedule_name_snapshot: 'Nocturno viejo',
      valid_from: '2024-01-01',
      valid_to: null,
      check_in: '20:00:00',
      check_out: '06:00:00',
      tolerance_in: 10,
      tolerance_out: 5,
      break_mode: 'fixed_unpaid',
      break_minutes: 30,
      break_after_minutes: 0,
      weekly_target_minutes: 2520,
      daily_target_minutes: 420,
      work_regime: 'night',
      work_days: '2,3,4,5,6',
      snapshot_version: 1,
      snapshot_source: 'schedule_snapshot',
    };
    let readCount = 0;
    sequelize.query.mockImplementation(async (sql) => {
      if (/SELECT id, employee_id FROM employee_schedule_history/.test(sql)) return [[{ id: 10, employee_id: 1 }]];
      if (/GET_LOCK/.test(sql)) return [[{ ok: 1 }]];
      if (/RELEASE_LOCK/.test(sql)) return [[]];
      if (/WHERE id = \? LIMIT 1 FOR UPDATE/.test(sql)) return [[existing]];
      if (/FROM employee_schedule_history/.test(sql) && /valid_from/.test(sql) && /FOR UPDATE/.test(sql)) return [[]];
      if (/UPDATE employee_schedule_history SET/.test(sql)) return [{ affectedRows: 1 }];
      if (/WHERE id = \? LIMIT 1/.test(sql)) {
        readCount += 1;
        return [[{ ...existing, weekly_target_minutes: 2160, snapshot_version: 2, snapshot_source: 'correction' }]];
      }
      return [[]];
    });

    const result = await svc.updateHistory(10, {
      weekly_target_minutes: 2160,
      reason: 'Cambio de carga',
    }, 99);

    expect(result.after.check_in).toBe('20:00:00');
    expect(result.after.weekly_target_minutes).toBe(2160);
    expect(result.after.snapshot_version).toBe(2);
    expect(readCount).toBe(1);

    const sqls = sequelize.query.mock.calls.map((x) => x[0]).join('\n');
    expect(sqls).not.toMatch(/FROM schedules/);
  });
});

describe('effective configuration', () => {
  function wireBaseDb({ permission = null, holiday = null } = {}) {
    sequelize.query.mockImplementation(async (sql) => {
      if (/SELECT id FROM employees/.test(sql)) return [[{ id: 1 }]];
      if (/FROM permissions/.test(sql)) return [[permission].filter(Boolean)];
      if (/FROM holidays/.test(sql)) return [[holiday].filter(Boolean)];
      return [[]];
    });
  }

  test('domingo puede ser día laboral por configuración', async () => {
    wireBaseDb();
    const hist = [{
      history_id: 1,
      valid_from: '2026-01-01',
      valid_to: null,
      check_in: '08:00:00',
      check_out: '17:00:00',
      work_days: [1],
      weekly_target_minutes: 2160,
      work_regime: 'custom',
      config_incomplete: false,
      source: 'schedule_history',
    }];
    mockLoadWorkdayConfig.mockResolvedValue({
      historyFor: () => hist,
      forDate: () => ({ ...hist[0], source: 'schedule_history' }),
    });

    const r = await svc.getEffectiveConfiguration(1, '2026-08-30'); // domingo
    expect(r.expected_workday).toBe(true);
    expect(r.kind).toBe('work');
    expect(r.profile.weekly_target_minutes).toBe(2160);
  });

  test('vacación aprobada vuelve el día no laborable sin inventar ausencia', async () => {
    wireBaseDb({
      permission: {
        id: 9,
        type: 'vacation',
        status: 'approved',
        approval_state: 'approved',
        date_from: '2026-08-30',
        date_to: '2026-09-05',
      },
    });
    mockLoadWorkdayConfig.mockResolvedValue({
      historyFor: () => [],
      forDate: () => null,
    });

    const r = await svc.getEffectiveConfiguration(1, '2026-08-30');
    expect(r.expected_workday).toBe(false);
    expect(r.kind).toBe('vacation');
    expect(r.calculation_mode_candidate).toBe('historical_fallback');
  });

  test('dos turneras incompatibles exponen conflicto y no declaran jornada esperada', async () => {
    wireBaseDb();
    mockLoadWorkdayConfig.mockResolvedValue({
      historyFor: () => [],
      forDate: () => ({
        source: 'shift_assignment',
        check_in: '08:00:00',
        check_out: '17:00:00',
        conflict_shift_schedule_ids: [3, 9],
      }),
    });

    const r = await svc.getEffectiveConfiguration(1, '2026-08-30');
    expect(r.configuration_conflict).toBe(true);
    expect(r.expected_workday).toBeNull();
    expect(r.calculation_mode_candidate).toBe('historical_fallback');
  });
});
