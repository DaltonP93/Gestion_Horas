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

const ORIGINAL_WRITE_FLAG = process.env.WORKDAY_CONFIG_WRITE_ENABLED;

beforeEach(() => {
  process.env.WORKDAY_CONFIG_WRITE_ENABLED = 'true';
  sequelize.query.mockReset();
  sequelize.transaction.mockClear();
  mockLoadWorkdayConfig.mockReset();
});

afterAll(() => {
  if (ORIGINAL_WRITE_FLAG === undefined) delete process.env.WORKDAY_CONFIG_WRITE_ENABLED;
  else process.env.WORKDAY_CONFIG_WRITE_ENABLED = ORIGINAL_WRITE_FLAG;
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

describe('kill switch de escritura', () => {
  test('fail-closed: sólo el string exacto true habilita writers', () => {
    for (const value of [undefined, '', 'false', '1', 'TRUE', 'yes']) {
      if (value === undefined) delete process.env.WORKDAY_CONFIG_WRITE_ENABLED;
      else process.env.WORKDAY_CONFIG_WRITE_ENABLED = value;
      expect(svc.isWriteEnabled()).toBe(false);
    }
    process.env.WORKDAY_CONFIG_WRITE_ENABLED = 'true';
    expect(svc.isWriteEnabled()).toBe(true);
  });

  test('createHistory bloquea antes de consultar la BD cuando el flag está OFF', async () => {
    process.env.WORKDAY_CONFIG_WRITE_ENABLED = 'false';
    await expect(svc.createHistory(1, {
      schedule_id: 7,
      valid_from: '2026-09-01',
    }, 99)).rejects.toMatchObject({
      status: 503,
      code: 'WORKDAY_CONFIG_WRITES_DISABLED',
    });
    expect(sequelize.query).not.toHaveBeenCalled();
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  test('updateHistory y closeHistory también fallan cerrados', async () => {
    delete process.env.WORKDAY_CONFIG_WRITE_ENABLED;
    await expect(svc.updateHistory(10, { weekly_target_minutes: 2160 }, 99))
      .rejects.toMatchObject({ status: 503, code: 'WORKDAY_CONFIG_WRITES_DISABLED' });
    await expect(svc.closeHistory(10, '2026-09-30', 99, 'cierre'))
      .rejects.toMatchObject({ status: 503, code: 'WORKDAY_CONFIG_WRITES_DISABLED' });
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});

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

  test.each([
    [2880, 48], [2700, 45], [2520, 42], [2160, 36],
    [1920, 32], [1440, 24], [1200, 20], [2220, 37],
  ])('acepta target semanal %i min (%i h) sin inferir régimen', (minutes) => {
    const s = svc.snapshotFromSchedule(schedule, { weekly_target_minutes: minutes });
    expect(s.weekly_target_minutes).toBe(minutes);
    expect(s.work_regime).toBeNull();
  });

  test.each([
    ['none', 0, 0],
    ['punched', 0, 0],
    ['fixed_unpaid', 45, 240],
  ])('acepta break_mode %s', (mode, minutes, after) => {
    const s = svc.snapshotFromSchedule(schedule, {
      break_mode: mode,
      break_minutes: minutes,
      break_after_minutes: after,
    });
    expect(s.break_mode).toBe(mode);
    expect(s.break_minutes).toBe(minutes);
    expect(s.break_after_minutes).toBe(after);
  });

  test('rechaza work_days parcialmente inválido en vez de descartar tokens', () => {
    expect(() => svc.normalizeWorkDays(['2', 'x', '3'])).toThrow(/exclusivamente valores 1\.\.7/i);
    expect(() => svc.normalizeWorkDays('2,8,3')).toThrow(/exclusivamente valores 1\.\.7/i);
  });

  test('policy config debe ser objeto JSON, no array ni escalar', () => {
    expect(() => svc.buildSnapshot({}, {
      check_in: '08:00',
      check_out: '17:00',
      work_days: [2,3,4,5,6],
      rounding_policy: 'custom',
      rounding_policy_config: '[]',
    })).toThrow(/objeto JSON/i);
    expect(() => svc.buildSnapshot({}, {
      check_in: '08:00',
      check_out: '17:00',
      work_days: [2,3,4,5,6],
      overtime_policy: 'custom',
      overtime_policy_config: '"texto"',
    })).toThrow(/objeto JSON/i);
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


describe('schedule vs profile', () => {
  test('cambiar horario conserva carga/régimen/policies del perfil', () => {
    const nuevoHorario = svc.snapshotFromSchedule({
      ...schedule,
      id: 8,
      name: 'Diurno nuevo',
      check_in: '07:00:00',
      check_out: '15:00:00',
      break_minutes: 0,
    }, {});
    const composed = svc.composeScheduleWithProfile(nuevoHorario, {
      weekly_target_minutes: 2160,
      daily_target_minutes: 360,
      work_regime: 'special',
      night_start: '20:00:00',
      night_end: '06:00:00',
      rounding_policy: 'nearest_5',
      rounding_policy_version: 3,
      rounding_policy_config: { step: 5 },
      overtime_policy: 'rrhh_review',
      overtime_policy_version: 2,
      overtime_policy_config: { approval: true },
    });

    expect(composed.schedule_id).toBe(8);
    expect(composed.check_in).toBe('07:00:00');
    expect(composed.check_out).toBe('15:00:00');
    expect(composed.break_mode).toBe('none');
    expect(composed.weekly_target_minutes).toBe(2160);
    expect(composed.work_regime).toBe('special');
    expect(composed.rounding_policy_version).toBe(3);
    expect(composed.overtime_policy_version).toBe(2);
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

describe('vigencias', () => {
  test('valid_from y valid_to son inclusivos', () => {
    const rows = [
      { valid_from: '2025-01-01', valid_to: '2025-06-30', id: 1 },
      { valid_from: '2025-07-01', valid_to: null, id: 2 },
    ];
    const { vigenteEn } = require('../src/services/workdayConfig');
    expect(vigenteEn(rows, '2025-01-01').id).toBe(1);
    expect(vigenteEn(rows, '2025-06-30').id).toBe(1);
    expect(vigenteEn(rows, '2025-07-01').id).toBe(2);
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

  test('sin configuración ni excepción queda fallback y expected null', async () => {
    wireBaseDb();
    mockLoadWorkdayConfig.mockResolvedValue({
      historyFor: () => [],
      forDate: () => null,
    });
    const r = await svc.getEffectiveConfiguration(1, '2026-08-30');
    expect(r.calculation_mode_candidate).toBe('historical_fallback');
    expect(r.expected_workday).toBeNull();
    expect(r.profile).toBeNull();
  });

  test('Turnera existente sin snapshot queda visible pero INACTIVA para cálculo', async () => {
    wireBaseDb();
    mockLoadWorkdayConfig.mockResolvedValue({
      historyFor: () => [],
      forDate: () => null,
      planningForDate: () => ({
        source: 'shift_assignment',
        shift_schedule_id: 99,
        check_in: '08:00:00',
        check_out: '17:00:00',
        daily_target_minutes: 480,
        weekly_target_minutes: 2880,
        segments: 1,
        kind: 'work',
      }),
    });

    const r = await svc.getEffectiveConfiguration(1, '2026-08-30');
    expect(r.calculation_mode_candidate).toBe('historical_fallback');
    expect(r.expected_workday).toBeNull();
    expect(r.turnera).toMatchObject({
      shift_schedule_id: 99,
      active_for_calculation: false,
      pending_employee_configuration: true,
      shift_weekly_target_minutes: 2880,
    });
  });

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

  test('martes puede ser off por work_days histórico', async () => {
    wireBaseDb();
    const hist = [{
      history_id: 1,
      valid_from: '2026-01-01',
      valid_to: null,
      check_in: '08:00:00',
      check_out: '17:00:00',
      work_days: [2, 4, 5, 6],
      config_incomplete: false,
      source: 'schedule_history',
    }];
    mockLoadWorkdayConfig.mockResolvedValue({
      historyFor: () => hist,
      forDate: () => ({ ...hist[0], source: 'schedule_history' }),
    });
    const r = await svc.getEffectiveConfiguration(1, '2026-09-01'); // martes = 3
    expect(r.expected_workday).toBe(false);
    expect(r.kind).toBe('off');
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

  test('Turnera conserva policies versionadas y target semanal del perfil histórico', async () => {
    wireBaseDb();
    const full = [{
      id: 4,
      employee_id: 1,
      valid_from: '2026-01-01',
      valid_to: null,
      check_in: '08:00:00',
      check_out: '17:00:00',
      work_days: '2,3,4,5,6',
      snapshot_version: 2,
      weekly_target_minutes: 2160,
      work_regime: 'special',
      rounding_policy: 'nearest_5',
      rounding_policy_version: 3,
      rounding_policy_config: JSON.stringify({ step: 5 }),
      overtime_policy: 'rrhh_review',
      overtime_policy_version: 2,
      overtime_policy_config: JSON.stringify({ approval: true }),
    }];

    // getHistory() es la consulta adicional del effective endpoint.
    const oldImpl = sequelize.query.getMockImplementation();
    sequelize.query.mockImplementation(async (sql, opts) => {
      if (/FROM employee_schedule_history h/.test(sql)) return [full];
      return oldImpl(sql, opts);
    });

    mockLoadWorkdayConfig.mockResolvedValue({
      historyFor: () => [],
      forDate: () => ({
        source: 'shift_assignment',
        shift_schedule_id: 11,
        check_in: '18:00:00',
        check_out: '06:00:00',
        daily_target_minutes: 720,
        weekly_target_minutes: 2880,
        break_mode: 'punched',
        break_minutes: 0,
      }),
    });

    const r = await svc.getEffectiveConfiguration(1, '2026-08-30');
    expect(r.profile.weekly_target_minutes).toBe(2160);
    expect(r.profile.daily_target_minutes).toBe(720);
    expect(r.profile.rounding_policy_version).toBe(3);
    expect(r.profile.rounding_policy_config).toEqual({ step: 5 });
    expect(r.profile.overtime_policy_version).toBe(2);
    expect(r.turnera.daily_target_minutes).toBe(720);
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

describe('policy ausente', () => {
  test('no inventa rounding ni overtime', () => {
    const s = svc.snapshotFromSchedule(schedule, { weekly_target_minutes: 2160 });
    expect(s.rounding_policy).toBeNull();
    expect(s.overtime_policy).toBeNull();
  });
});
