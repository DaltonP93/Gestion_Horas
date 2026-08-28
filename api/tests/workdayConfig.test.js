/**
 * workdayConfig.test.js — Precedencia de la configuración de jornada.
 *
 * Lo que este archivo protege, sobre todo, es la regla negativa:
 * `employees.schedule_id` NUNCA entra en la cadena. Esa columna guarda el
 * horario de HOY y no tiene fecha; usarla para el pasado hace que un cambio de
 * turno en 2026 genere atrasos retroactivos en todo 2024.
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const { sequelize } = require('../src/config/database');
const {
  loadWorkdayConfig, vigenteEn, configDesdeTurnera, normalizeConfigRow,
} = require('../src/services/workdayConfig');

/**
 * `loadWorkdayConfig` emite tres consultas en paralelo. Se responde según qué
 * tabla nombra cada SQL, que es más robusto que confiar en el orden de un
 * `Promise.all`.
 */
function mockTablas({ history = [], assignments = [], contracts = [] } = {}) {
  sequelize.query.mockReset();
  sequelize.query.mockImplementation(async (sql) => {
    if (/employee_schedule_history/.test(sql)) return [history];
    if (/shift_assignments/.test(sql)) return [assignments];
    if (/employee_contracts/.test(sql)) return [contracts];
    return [[]];
  });
}

const RANGO = { from: '2024-12-01', to: '2024-12-31' };

describe('precedencia de configuración', () => {
  test('sin nada cargado devuelve null y la jornada cae en fallback', async () => {
    mockTablas({});
    const cfg = await loadWorkdayConfig([1], RANGO);
    expect(cfg.forDate(1, '2024-12-15')).toBeNull();
  });

  test('el historial vigente se usa cuando no hay turnera', async () => {
    mockTablas({
      history: [{
        employee_id: 1, schedule_id: 5,
        valid_from: '2024-01-01', valid_to: null,
        check_in: '07:00:00', check_out: '15:00:00',
        tolerance_in: 10, tolerance_out: 0,
        break_mode: 'fixed_unpaid', break_minutes: 30, break_after_minutes: 0,
        weekly_target_minutes: 2880, daily_target_minutes: null,
      }],
    });
    const cfg = await loadWorkdayConfig([1], RANGO);
    const r = cfg.forDate(1, '2024-12-15');
    expect(r.check_in).toBe('07:00:00');
    expect(r.source).toBe('schedule_history');
    expect(r.weekly_target_minutes).toBe(2880);
  });

  test('la turnera publicada GANA sobre el horario habitual', async () => {
    mockTablas({
      history: [{
        employee_id: 1, schedule_id: 5, valid_from: '2024-01-01', valid_to: null,
        check_in: '07:00:00', check_out: '15:00:00', break_mode: 'none',
      }],
      assignments: [{
        employee_id: 1, work_date: '2024-12-15', segment: 1, kind: 'work',
        start_time: '14:00:00', end_time: '22:00:00',
        break_minutes: 0, shift_schedule_id: 9, weekly_target_minutes: 2520,
      }],
    });
    const cfg = await loadWorkdayConfig([1], RANGO);

    const conTurnera = cfg.forDate(1, '2024-12-15');
    expect(conTurnera.check_in).toBe('14:00:00');
    expect(conTurnera.source).toBe('shift_assignment');
    expect(conTurnera.shift_schedule_id).toBe(9);

    // Un día SIN asignación vuelve al horario habitual.
    const sinTurnera = cfg.forDate(1, '2024-12-16');
    expect(sinTurnera.check_in).toBe('07:00:00');
    expect(sinTurnera.source).toBe('schedule_history');
  });

  test('una turnera en borrador NO se usa', async () => {
    // El SQL filtra `ss.status = 'published'`, así que un borrador nunca llega.
    mockTablas({ assignments: [] });
    const cfg = await loadWorkdayConfig([1], RANGO);
    expect(cfg.forDate(1, '2024-12-15')).toBeNull();

    const sql = sequelize.query.mock.calls.map((c) => c[0]).join('\n');
    expect(sql).toMatch(/ss\.status = 'published'/);
  });

  test('un día off/vacaciones no devuelve horario: marca non_working', async () => {
    // Devolver un horario para un día de vacaciones haría que la persona
    // figure llegando tarde todos los días que no trabajó.
    mockTablas({
      assignments: [{
        employee_id: 1, work_date: '2024-12-15', segment: 1, kind: 'vacation',
        start_time: null, end_time: null, shift_schedule_id: 9,
      }],
    });
    const cfg = await loadWorkdayConfig([1], RANGO);
    const r = cfg.forDate(1, '2024-12-15');
    expect(r.non_working).toBe(true);
    expect(r.kind).toBe('vacation');
    expect(r.check_in).toBeUndefined();
  });

  test('el contrato solo NO habilita el modo configured', async () => {
    // Un contrato dice cuánto hay que trabajar, no a qué hora se entra. Sin
    // hora de entrada no hay atraso que calcular, y devolver una config a
    // medias haría que el motor deje de reportar el fallback.
    mockTablas({
      contracts: [{ contract_id: 7, employee_id: 1, start_date: '2024-01-01', end_date: null }],
    });
    const cfg = await loadWorkdayConfig([1], RANGO);
    expect(cfg.forDate(1, '2024-12-15')).toBeNull();
  });

  test('el contrato vigente se adjunta cuando SÍ hay horario', async () => {
    mockTablas({
      history: [{
        employee_id: 1, valid_from: '2024-01-01', valid_to: null,
        check_in: '08:00:00', check_out: '17:00:00', break_mode: 'none',
      }],
      contracts: [{ contract_id: 7, employee_id: 1, start_date: '2024-01-01', end_date: null }],
    });
    const cfg = await loadWorkdayConfig([1], RANGO);
    expect(cfg.forDate(1, '2024-12-15').contract_id).toBe(7);
  });

  test('no se emite ninguna consulta que lea employees.schedule_id', async () => {
    mockTablas({});
    await loadWorkdayConfig([1, 2, 3], RANGO);
    const sql = sequelize.query.mock.calls.map((c) => c[0]).join('\n');
    expect(sql).not.toMatch(/employees/);
    expect(sql).not.toMatch(/schedule_id\s+FROM\s+employees/);
  });

  test('carga en tres consultas, no una por empleado y día', async () => {
    mockTablas({});
    await loadWorkdayConfig([1, 2, 3, 4, 5], RANGO);
    // 5 empleados x 31 días serían 155 consultas si hubiera N+1.
    expect(sequelize.query).toHaveBeenCalledTimes(3);
  });

  test('sin empleados no consulta nada', async () => {
    mockTablas({});
    const cfg = await loadWorkdayConfig([], RANGO);
    expect(sequelize.query).not.toHaveBeenCalled();
    expect(cfg.forDate(1, '2024-12-15')).toBeNull();
  });
});

describe('vigenteEn', () => {
  const tramos = [
    { valid_from: '2024-01-01', valid_to: '2025-12-31', check_in: '22:00' },
    { valid_from: '2026-01-01', valid_to: null, check_in: '08:00' },
  ];

  test('cada fecha usa el tramo que le corresponde', () => {
    expect(vigenteEn(tramos, '2024-12-01').check_in).toBe('22:00');
    expect(vigenteEn(tramos, '2026-06-01').check_in).toBe('08:00');
  });

  test('una fecha anterior a todo tramo no tiene configuración', () => {
    // Es el caso que impide inventar el pasado: 2023 no está cubierto.
    expect(vigenteEn(tramos, '2023-06-01')).toBeNull();
  });

  test('valid_from es inclusivo y valid_to también', () => {
    expect(vigenteEn(tramos, '2024-01-01')).not.toBeNull();
    expect(vigenteEn(tramos, '2025-12-31')).not.toBeNull();
    expect(vigenteEn(tramos, '2025-12-32')).toBeNull();
  });

  test('valid_to null significa vigente hacia adelante', () => {
    expect(vigenteEn(tramos, '2099-01-01').check_in).toBe('08:00');
  });
});

describe('configDesdeTurnera', () => {
  test('un solo tramo usa el descanso fijo de la plantilla', () => {
    const cfg = configDesdeTurnera([{
      kind: 'work', start_time: '07:00:00', end_time: '16:00:00',
      break_minutes: 30, shift_schedule_id: 3, weekly_target_minutes: 2880,
    }]);
    expect(cfg.check_in).toBe('07:00:00');
    expect(cfg.check_out).toBe('16:00:00');
    expect(cfg.break_mode).toBe('fixed_unpaid');
    expect(cfg.break_minutes).toBe(30);
  });

  test('dos tramos (turno partido) toman entrada del primero y salida del último', () => {
    const cfg = configDesdeTurnera([
      { kind: 'work', start_time: '07:00:00', end_time: '14:00:00', break_minutes: 30, shift_schedule_id: 3 },
      { kind: 'work', start_time: '17:00:00', end_time: '19:00:00', break_minutes: 30, shift_schedule_id: 3 },
    ]);
    expect(cfg.check_in).toBe('07:00:00');
    expect(cfg.check_out).toBe('19:00:00');
    expect(cfg.segments).toBe(2);
    // El corte ya está en la turnera: el descanso real es el que se fiche
    // entre los tramos. Descontar además el fijo lo cobraría dos veces.
    expect(cfg.break_mode).toBe('punched');
    expect(cfg.break_minutes).toBe(0);
  });

  test('un tramo sin horas no genera horario', () => {
    const cfg = configDesdeTurnera([{ kind: 'work', start_time: null, end_time: null }]);
    expect(cfg.non_working).toBe(true);
  });
});

describe('normalizeConfigRow', () => {
  test('el objetivo semanal ausente queda en null y no se completa con 2880', () => {
    // Suponer 48 h convertiría una omisión de carga en horas extra o déficit
    // inventado.
    const r = normalizeConfigRow({ weekly_target_minutes: null });
    expect(r.weekly_target_minutes).toBeNull();
    expect(r.daily_target_minutes).toBeNull();
  });

  test('el modo de descanso por defecto es punched', () => {
    expect(normalizeConfigRow({}).break_mode).toBe('punched');
  });
});

describe('parseWorkDays — convención DAYOFWEEK del proyecto', () => {
  const { parseWorkDays } = require('../src/services/workdayConfig');

  test('normaliza el CSV a un array ordenado y sin duplicados', () => {
    expect(parseWorkDays('2,3,4,5,6')).toEqual([2, 3, 4, 5, 6]);
    expect(parseWorkDays('7,1,1,2')).toEqual([1, 2, 7]);
  });

  test('null y vacío significan "no sabemos", no "ningún día"', () => {
    // La distinción evita fabricar descansos: sin work_days no se puede afirmar
    // que un día era libre.
    expect(parseWorkDays(null)).toBeNull();
    expect(parseWorkDays('')).toBeNull();
    expect(parseWorkDays('   ')).toBeNull();
  });

  test('descarta tokens fuera de 1..7', () => {
    expect(parseWorkDays('0,8,3')).toEqual([3]);
    expect(parseWorkDays('a,b')).toBeNull();
  });

  test('la convención es 1=Domingo … 7=Sábado (migración 046)', () => {
    // Lunes a viernes = 2,3,4,5,6. Domingo = 1, Sábado = 7.
    const lv = parseWorkDays('2,3,4,5,6');
    expect(lv).not.toContain(1); // no domingo
    expect(lv).not.toContain(7); // no sábado
  });
});

describe('loadScheduleHistory expone work_days', () => {
  test('el horario carga work_days del schedule y lo normaliza', async () => {
    mockTablas({
      history: [{
        employee_id: 1, schedule_id: 5, valid_from: '2024-01-01', valid_to: null,
        check_in: '08:00:00', check_out: '17:00:00', work_days: '2,3,4,5,6',
      }],
    });
    const cfg = await loadWorkdayConfig([1], RANGO);
    const r = cfg.forDate(1, '2024-12-16'); // lunes
    expect(r.work_days).toEqual([2, 3, 4, 5, 6]);
  });

  test('work_days se toma del SNAPSHOT del historial, no del schedules vivo', async () => {
    // Si se leyera siempre del `schedules` vivo, editar un horario reescribiría
    // la expectativa de los tramos históricos. El COALESCE prefiere h.work_days.
    mockTablas({});
    await loadWorkdayConfig([1], RANGO);
    const sql = sequelize.query.mock.calls.map((c) => c[0]).join('\n');
    expect(sql).toMatch(/COALESCE\(h\.work_days,\s*s\.work_days\)/);
  });
});

describe('dos turneras publicadas la misma fecha no se combinan', () => {
  const { configDesdeTurnera } = require('../src/services/workdayConfig');

  test('usa una sola turnera (menor shift_schedule_id) y marca el conflicto', () => {
    // schedule 9 (07-15) y schedule 3 (18-22) el mismo día: combinarlas
    // fabricaría un turno 07:00→22:00 y arruinaría el atraso.
    const cfg = configDesdeTurnera([
      { kind: 'work', start_time: '07:00:00', end_time: '15:00:00', shift_schedule_id: 9, break_minutes: 0 },
      { kind: 'work', start_time: '18:00:00', end_time: '22:00:00', shift_schedule_id: 3, break_minutes: 0 },
    ]);
    expect(cfg.shift_schedule_id).toBe(3);
    expect(cfg.check_in).toBe('18:00:00');
    expect(cfg.check_out).toBe('22:00:00');
    expect(cfg.conflict_shift_schedule_ids).toEqual([3, 9]);
  });

  test('un turno partido de UNA sola turnera no marca conflicto', () => {
    const cfg = configDesdeTurnera([
      { kind: 'work', start_time: '07:00:00', end_time: '14:00:00', shift_schedule_id: 5, break_minutes: 0 },
      { kind: 'work', start_time: '17:00:00', end_time: '19:00:00', shift_schedule_id: 5, break_minutes: 0 },
    ]);
    expect(cfg.check_in).toBe('07:00:00');
    expect(cfg.check_out).toBe('19:00:00');
    expect(cfg.conflict_shift_schedule_ids).toBeNull();
  });

  test('la consulta de turnera ordena por schedule_id para elegir de forma determinista', async () => {
    mockTablas({});
    await loadWorkdayConfig([1], RANGO);
    const sql = sequelize.query.mock.calls.map((c) => c[0]).join('\n');
    expect(sql).toMatch(/ORDER BY a\.employee_id, a\.work_date, a\.schedule_id, a\.segment/);
  });
});

describe('turnera — objetivo diario y conflicto con no laborables', () => {
  const { configDesdeTurnera } = require('../src/services/workdayConfig');

  test('el objetivo diario de un turno partido es la SUMA de los tramos, no el span', () => {
    // 07:00-14:00 (7h) + 17:00-19:00 (2h) = 9h = 540, no 720 (07:00→19:00).
    const cfg = configDesdeTurnera([
      { kind: 'work', start_time: '07:00:00', end_time: '14:00:00', shift_schedule_id: 5 },
      { kind: 'work', start_time: '17:00:00', end_time: '19:00:00', shift_schedule_id: 5 },
    ]);
    expect(cfg.daily_target_minutes).toBe(540);
  });

  test('el objetivo diario resuelve el cruce de medianoche', () => {
    const cfg = configDesdeTurnera([
      { kind: 'work', start_time: '22:00:00', end_time: '06:00:00', shift_schedule_id: 5 },
    ]);
    expect(cfg.daily_target_minutes).toBe(480);
  });

  test('un off de menor id gana sobre un work de mayor id, y marca conflicto', () => {
    // El criterio "gana el menor id" se aplica sobre TODAS las asignaciones,
    // no sólo las de trabajo: si no, el work de id mayor ganaría sin conflicto.
    const cfg = configDesdeTurnera([
      { kind: 'off', start_time: null, end_time: null, shift_schedule_id: 3 },
      { kind: 'work', start_time: '08:00:00', end_time: '17:00:00', shift_schedule_id: 9 },
    ]);
    expect(cfg.non_working).toBe(true);
    expect(cfg.shift_schedule_id).toBe(3);
    expect(cfg.conflict_shift_schedule_ids).toEqual([3, 9]);
  });

  test('el objetivo diario usa los minutos NETOS persistidos, no el span con break', () => {
    // 08:00-17:00 son 9 h de span, pero la turnera guardó `minutes` = 480 (con
    // 60' de pausa ya descontados). El objetivo tiene que ser 480, no 540: si
    // usara el span, el break contaría como trabajado y el motor mediría un
    // déficit de una hora todos los días.
    const cfg = configDesdeTurnera([
      { kind: 'work', start_time: '08:00:00', end_time: '17:00:00', shift_schedule_id: 5, minutes: 480 },
    ]);
    expect(cfg.daily_target_minutes).toBe(480);
  });

  test('sin minutes cargado (asignación vieja) cae al span de reloj', () => {
    // Compatibilidad: las asignaciones anteriores a la columna `minutes` no lo
    // traen; el objetivo se deriva del span, que es el mejor dato disponible.
    const cfg = configDesdeTurnera([
      { kind: 'work', start_time: '08:00:00', end_time: '17:00:00', shift_schedule_id: 5 },
    ]);
    expect(cfg.daily_target_minutes).toBe(540);
  });

  test('un minutes de 0 en un tramo de trabajo cae al span (asignación degenerada)', () => {
    const cfg = configDesdeTurnera([
      { kind: 'work', start_time: '08:00:00', end_time: '17:00:00', shift_schedule_id: 5, minutes: 0 },
    ]);
    expect(cfg.daily_target_minutes).toBe(540);
  });

  test('turno partido: el objetivo es la SUMA de los minutos netos de cada tramo', () => {
    const cfg = configDesdeTurnera([
      { kind: 'work', start_time: '07:00:00', end_time: '14:00:00', shift_schedule_id: 5, minutes: 390 },
      { kind: 'work', start_time: '17:00:00', end_time: '19:00:00', shift_schedule_id: 5, minutes: 120 },
    ]);
    expect(cfg.daily_target_minutes).toBe(510);
  });

  test('la consulta de asignaciones trae la columna minutes', async () => {
    mockTablas({});
    await loadWorkdayConfig([1], RANGO);
    const sql = sequelize.query.mock.calls.map((c) => c[0]).join('\n');
    expect(sql).toMatch(/a\.minutes/);
  });
});
