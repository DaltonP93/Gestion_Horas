/**
 * dailySummaryEngine.test.js — `daily_summary` derivado del motor.
 *
 * Lo que más importa acá es la semántica de `worked_minutes`: la columna viene
 * guardando PERMANENCIA y cambiarla en silencio movería todos los números
 * históricos de RRHH. El modo por defecto tiene que conservarla.
 */

const {
  buildDailySummaryRows, compararFila, statusEmptyDay,
  WORKED_PRESENCE, WORKED_NET,
} = require('../src/services/dailySummaryEngine');

const marcas = (...ts) => ts.map((t) => ({ timestamp: t }));

const DIA_CON_ALMUERZO = marcas(
  '2025-06-10 08:00:00', '2025-06-10 12:00:00',
  '2025-06-10 13:00:00', '2025-06-10 17:00:00',
);

describe('semántica de worked_minutes', () => {
  test('por defecto conserva la permanencia, que es lo que la columna guarda', () => {
    const [fila] = buildDailySummaryRows(DIA_CON_ALMUERZO, { from: '2025-06-10', to: '2025-06-10' });
    // 08:00 → 17:00 = 540, con el almuerzo adentro. Es el valor histórico.
    expect(fila.worked_minutes).toBe(540);
    expect(fila.presence_minutes).toBe(540);
    expect(fila.net_worked_minutes).toBe(480);
  });

  test('el modo neto es opt-in explícito y cambia el significado', () => {
    const [fila] = buildDailySummaryRows(DIA_CON_ALMUERZO, {
      from: '2025-06-10', to: '2025-06-10', workedMinutesMode: WORKED_NET,
    });
    expect(fila.worked_minutes).toBe(480);
    // Las dos siguen disponibles: la comparación no tiene que recalcular.
    expect(fila.presence_minutes).toBe(540);
  });

  test('WORKED_PRESENCE es el valor por defecto documentado', () => {
    expect(WORKED_PRESENCE).toBe('presence');
    const [conDefault] = buildDailySummaryRows(DIA_CON_ALMUERZO, { from: '2025-06-10', to: '2025-06-10' });
    const [explicito] = buildDailySummaryRows(DIA_CON_ALMUERZO, {
      from: '2025-06-10', to: '2025-06-10', workedMinutesMode: WORKED_PRESENCE,
    });
    expect(conDefault.worked_minutes).toBe(explicito.worked_minutes);
  });
});

describe('el resumen usa el mismo motor que Marcadas', () => {
  test('un turno nocturno queda en la fecha de su entrada, no partido en dos', () => {
    // El cálculo anterior leía los marcajes de UNA fecha civil, así que este
    // turno producía dos filas incompletas: una sin salida y otra sin entrada.
    const filas = buildDailySummaryRows(
      marcas('2024-12-01 18:30:00', '2024-12-02 07:04:00'),
      // materializeEmptyDates:false para aislar la jornada; la materialización
      // de los días vacíos tiene su propio test.
      { from: '2024-12-01', to: '2024-12-31', materializeEmptyDates: false },
    );
    expect(filas).toHaveLength(1);
    expect(filas[0].date).toBe('2024-12-01');
    expect(filas[0].worked_minutes).toBe(754);
    expect(filas[0].crosses_midnight).toBe(true);
  });

  test('el nocturno partido da una sola fila', () => {
    const filas = buildDailySummaryRows(
      marcas(
        '2025-01-02 21:32:00', '2025-01-03 00:05:00',
        '2025-01-03 01:02:00', '2025-01-03 05:29:00',
      ),
      { from: '2025-01-01', to: '2025-01-31', materializeEmptyDates: false },
    );
    expect(filas).toHaveLength(1);
    expect(filas[0].date).toBe('2025-01-02');
    expect(filas[0].net_worked_minutes).toBe(420);
  });

  test('cada fila lleva su modo, su versión de política y sus anomalías', () => {
    const [fila] = buildDailySummaryRows(
      [{ timestamp: '2025-06-10 08:00:00', type: 'in' }],
      { from: '2025-06-10', to: '2025-06-10' },
    );
    expect(fila.calculation_mode).toBe('historical_fallback');
    expect(fila.policy_version).toBe(1);
    expect(fila.anomalies).toContain('entrada_sin_salida');
  });
});

describe('materialización de fechas sin jornada', () => {
  const LV = { source: 'schedule_history', check_in: '08:00', check_out: '17:00', work_days: [2, 3, 4, 5, 6] };

  // Sin esto, un recálculo borraría las filas que daily_summary guarda, y el
  // dry-run marcaría cada una como diferencia.
  test('emite una fila por cada fecha civil del período', () => {
    const filas = buildDailySummaryRows(
      marcas('2025-06-10 08:00:00', '2025-06-10 17:00:00'),
      { from: '2025-06-09', to: '2025-06-11', resolveConfig: () => LV },
    );
    expect(filas.map((f) => f.date)).toEqual(['2025-06-09', '2025-06-10', '2025-06-11']);
    // 2025-06-10 martes con marcajes; 09 lunes y 11 miércoles son laborables
    // sin marcar → absent, porque la config dice que debían trabajar.
    expect(filas[1].worked_minutes).toBe(540);
    expect(filas[0].status).toBe('absent');
    expect(filas[0].expected_workday).toBe(true);
    expect(filas[2].status).toBe('absent');
  });

  test('SIN configuración, un día vacío es unconfigured, NO absent', () => {
    // 2022-2025 sin horario cargado: no sabemos si debía trabajar.
    const filas = buildDailySummaryRows([], { from: '2024-03-05', to: '2024-03-05' });
    expect(filas[0].status).toBe('unconfigured');
    expect(filas[0].expected_workday).toBeNull();
  });

  test('un domingo libre por configuración (L-V) es non_working, no weekend hardcodeado', () => {
    // 2025-06-15 domingo. El estado sale de work_days, no del día de la semana.
    const filas = buildDailySummaryRows([], { from: '2025-06-15', to: '2025-06-15', resolveConfig: () => LV });
    expect(filas[0].status).toBe('non_working');
    expect(filas[0].expected_workday).toBe(false);
  });

  test('un empleado configurado para trabajar domingo sin marcar es absent', () => {
    const todos = { source: 'schedule_history', check_in: '08:00', check_out: '12:00', work_days: [1, 2, 3, 4, 5, 6, 7] };
    const filas = buildDailySummaryRows([], { from: '2025-06-15', to: '2025-06-15', resolveConfig: () => todos });
    expect(filas[0].status).toBe('absent');
    expect(filas[0].expected_workday).toBe(true);
  });

  test('un martes libre por configuración sin marcar es non_working', () => {
    // work_days sin el martes (3 en DAYOFWEEK). 2025-06-17 es martes.
    const sinMartes = { source: 'schedule_history', check_in: '08:00', check_out: '17:00', work_days: [2, 4, 5, 6, 7] };
    const filas = buildDailySummaryRows([], { from: '2025-06-17', to: '2025-06-17', resolveConfig: () => sinMartes });
    expect(filas[0].status).toBe('non_working');
    expect(filas[0].expected_workday).toBe(false);
  });

  test('el feriado sin marcajes se materializa como holiday', () => {
    const filas = buildDailySummaryRows([], {
      from: '2025-05-01', to: '2025-05-01', holidays: new Set(['2025-05-01']), resolveConfig: () => LV,
    });
    expect(filas[0].status).toBe('holiday');
    // El feriado no borra que era un día laborable.
    expect(filas[0].expected_workday).toBe(true);
  });

  test('materializeEmptyDates:false sólo devuelve las jornadas', () => {
    const filas = buildDailySummaryRows(
      marcas('2025-06-10 08:00:00', '2025-06-10 17:00:00'),
      { from: '2025-06-01', to: '2025-06-30', materializeEmptyDates: false },
    );
    expect(filas).toHaveLength(1);
    expect(filas[0].date).toBe('2025-06-10');
  });

  test('un conflicto de turnera se expone también en un día SIN marcajes', () => {
    // Dos turneras publicadas para la fecha: el resolvedor eligió el `off` de
    // menor id sobre un `work` de mayor id. Sin marcajes el día no pasa por el
    // motor, así que la anomalía tiene que propagarse desde la config o se
    // pierde justo cuando más importa —el descanso puede estar tapando un turno
    // de trabajo que nadie fichó—.
    const enConflicto = {
      non_working: true, kind: 'off', source: 'shift_assignment',
      conflict_shift_schedule_ids: [3, 9],
    };
    const filas = buildDailySummaryRows([], {
      from: '2025-06-17', to: '2025-06-17', resolveConfig: () => enConflicto,
    });
    expect(filas[0].status).toBe('non_working');
    expect(filas[0].expected_workday).toBe(false);
    expect(filas[0].anomalies).toContain('turnera_conflict');
  });

  test('un día vacío sin conflicto no inventa la anomalía', () => {
    const filas = buildDailySummaryRows([], {
      from: '2025-06-17', to: '2025-06-17', resolveConfig: () => LV,
    });
    expect(filas[0].anomalies).toEqual([]);
  });

  test('un día laborable con SÓLO una salida huérfana no es una ausencia limpia', () => {
    // Configurado laborable (L-V), pero el único registro es un OUT sin entrada:
    // el motor no genera jornada. Materializar 'absent' ocultaría el fichaje y
    // una escritura futura produciría una ausencia engañosa. Se incorpora la
    // anomalía, se conserva la hora como evidencia y NO se clasifica absent.
    const filas = buildDailySummaryRows(
      [{ timestamp: '2025-06-10 17:00:00', type: 'out', id: 5 }], // martes laborable
      { from: '2025-06-10', to: '2025-06-10', resolveConfig: () => LV },
    );
    expect(filas).toHaveLength(1);
    expect(filas[0].status).not.toBe('absent');
    expect(filas[0].status).toBe('present');
    expect(filas[0].last_out.slice(11, 16)).toBe('17:00');
    expect(filas[0].anomalies).toContain('salida_sin_entrada');
    // calculation_mode no-null: el dry-run lo compara en vez de ignorarlo como
    // día vacío.
    expect(filas[0].calculation_mode).toBe('historical_fallback');
  });

  test('un fichaje suelto en un FERIADO conserva la marca (no desaparece)', () => {
    // Un OUT huérfano en un feriado: el día sigue siendo 'holiday', pero la hora
    // del fichaje se registra y la anomalía queda a la vista, en vez de perderse.
    const filas = buildDailySummaryRows(
      [{ timestamp: '2025-05-01 17:00:00', type: 'out', id: 7 }],
      { from: '2025-05-01', to: '2025-05-01', holidays: new Set(['2025-05-01']), resolveConfig: () => LV },
    );
    expect(filas).toHaveLength(1);
    expect(filas[0].status).toBe('holiday');            // conserva su clase
    expect(filas[0].last_out.slice(11, 16)).toBe('17:00'); // pero retiene la marca
    expect(filas[0].anomalies).toContain('salida_sin_entrada');
    expect(filas[0].calculation_mode).toBe('historical_fallback');
  });

  test('un fichaje suelto en un día NO laborable por config conserva la marca', () => {
    // Domingo libre (L-V) con un OUT huérfano: sigue 'non_working' pero registra
    // la hora del fichaje.
    const filas = buildDailySummaryRows(
      [{ timestamp: '2025-06-15 09:00:00', type: 'out', id: 8 }], // domingo
      { from: '2025-06-15', to: '2025-06-15', resolveConfig: () => LV },
    );
    expect(filas[0].status).toBe('non_working');
    expect(filas[0].last_out.slice(11, 16)).toBe('09:00');
    expect(filas[0].anomalies).toContain('salida_sin_entrada');
  });
});

describe('agregación de dos jornadas en la misma fecha civil', () => {
  test('si la última jornada quedó ABIERTA, la permanencia no se borra', () => {
    // Sesión de mañana cerrada (06:00→10:00) y una entrada de tarde sin salida
    // (16:00, entrada_sin_salida). Son dos jornadas del mismo día. La última
    // por hora de entrada está abierta: tomar su last_out (null) colapsaría la
    // permanencia a 0. Debe conservarse la salida real de la sesión cerrada.
    const filas = buildDailySummaryRows(
      marcas('2025-06-10 06:00:00', '2025-06-10 10:00:00', '2025-06-10 16:00:00'),
      { from: '2025-06-10', to: '2025-06-10', materializeEmptyDates: false },
    );
    expect(filas).toHaveLength(1);
    expect(filas[0].date).toBe('2025-06-10');
    expect(filas[0].first_in.slice(11, 16)).toBe('06:00');
    expect(filas[0].last_out.slice(11, 16)).toBe('10:00');
    expect(filas[0].presence_minutes).toBe(240);
    expect(filas[0].workday_count).toBe(2);
    expect(filas[0].anomalies).toContain('multiple_workdays_same_date');
    expect(filas[0].anomalies).toContain('entrada_sin_salida');
  });

  test('dos jornadas cerradas: last_out es la salida más tardía', () => {
    const filas = buildDailySummaryRows(
      marcas(
        '2025-06-10 06:00:00', '2025-06-10 10:00:00',
        '2025-06-10 16:00:00', '2025-06-10 20:00:00',
      ),
      { from: '2025-06-10', to: '2025-06-10', materializeEmptyDates: false },
    );
    expect(filas[0].first_in.slice(11, 16)).toBe('06:00');
    expect(filas[0].last_out.slice(11, 16)).toBe('20:00');
    expect(filas[0].presence_minutes).toBe(840); // 06:00 → 20:00
  });

  test('si la PRIMERA jornada quedó abierta, su entrada no infla el span', () => {
    // Un IN huérfano a las 06:00 (entrada sin salida) seguido de un turno real
    // 18:00-22:00. La entrada abierta no aporta tiempo, así que la permanencia
    // son 4 h (18:00→22:00), no 16 (06:00→22:00). first_in ancla en la jornada
    // cerrada para que first_in/last_out/presence queden coherentes.
    const filas = buildDailySummaryRows(
      [
        { timestamp: '2025-06-10 06:00:00', type: 'in' },
        { timestamp: '2025-06-10 18:00:00', type: 'in' },
        { timestamp: '2025-06-10 22:00:00', type: 'out' },
      ],
      { from: '2025-06-10', to: '2025-06-10', materializeEmptyDates: false },
    );
    expect(filas).toHaveLength(1);
    expect(filas[0].first_in.slice(11, 16)).toBe('18:00');
    expect(filas[0].last_out.slice(11, 16)).toBe('22:00');
    expect(filas[0].presence_minutes).toBe(240); // NO 960
    // El 06:00 seguido del 18:00 (dos entradas) es entradas_consecutivas; la
    // agregación de las dos jornadas del día se marca aparte.
    expect(filas[0].anomalies).toContain('entradas_consecutivas');
    expect(filas[0].anomalies).toContain('multiple_workdays_same_date');
  });
});

describe('estado del día', () => {
  test('un día esperado sin jornada es ausencia', () => {
    expect(statusEmptyDay({ expected: true, kind: 'work' }, false)).toBe('absent');
  });

  test('un día no esperado sin jornada es non_working, no absent', () => {
    expect(statusEmptyDay({ expected: false, kind: 'rest_day' }, false)).toBe('non_working');
  });

  test('sin expectativa (null) es unconfigured, nunca absent', () => {
    expect(statusEmptyDay({ expected: null, kind: null }, false)).toBe('unconfigured');
  });

  test('el feriado gana a la ausencia, para no fabricar ausencias masivas', () => {
    expect(statusEmptyDay({ expected: true, kind: 'work' }, true)).toBe('holiday');
  });

  test('vacaciones/permiso ganan al feriado', () => {
    expect(statusEmptyDay({ expected: false, kind: 'vacation' }, true)).toBe('permission');
    expect(statusEmptyDay({ expected: false, kind: 'permiso' }, false)).toBe('permission');
  });

  test('trabajar un feriado cuenta como trabajado, no como feriado', () => {
    // Se conserva el criterio previo: el feriado trabajado se refleja en las
    // horas extra, no en el estado.
    const filas = buildDailySummaryRows(
      marcas('2025-05-01 08:00:00', '2025-05-01 17:00:00'),
      { from: '2025-05-01', to: '2025-05-01', holidays: new Set(['2025-05-01']) },
    );
    expect(filas[0].status).toBe('present');
  });

  test('un día de vacaciones de turnera no se marca como ausencia', () => {
    const filas = buildDailySummaryRows(
      marcas('2025-06-10 08:00:00', '2025-06-10 09:00:00'),
      {
        from: '2025-06-10', to: '2025-06-10',
        resolveConfig: () => ({ non_working: true, kind: 'vacation', source: 'shift_assignment' }),
      },
    );
    expect(filas[0].status).toBe('permission');
  });

  test('el atraso marca el estado como late', () => {
    const filas = buildDailySummaryRows(
      marcas('2026-02-02 07:25:00', '2026-02-02 15:00:00'),
      {
        from: '2026-02-02', to: '2026-02-02',
        config: { check_in: '07:00', check_out: '15:00', tolerance_in: 10 },
      },
    );
    expect(filas[0].late_minutes).toBe(15);
    expect(filas[0].status).toBe('late');
  });
});

describe('overtime_minutes', () => {
  test('el exceso sobre el objetivo NO se vuelca a overtime sin política', () => {
    // Medir exceso es un hecho; liquidarlo como extraordinario es una decisión
    // de convenio. Volcarlo convertiría una medición en una liquidación.
    const filas = buildDailySummaryRows(
      marcas('2026-03-02 08:00:00', '2026-03-02 20:00:00'),
      {
        from: '2026-03-02', to: '2026-03-02',
        config: { check_in: '08:00', check_out: '17:00', daily_target_minutes: 480 },
      },
    );
    expect(filas[0].contract_excess_minutes).toBeGreaterThan(0);
    expect(filas[0].overtime_minutes).toBe(0);
  });
});

describe('comparación contra lo guardado', () => {
  const calculada = {
    worked_minutes: 540, late_minutes: 0, break_minutes: 60,
    status: 'present', first_in: '2025-06-10 08:00:00', last_out: '2025-06-10 17:00:00',
  };

  test('filas idénticas no difieren', () => {
    expect(compararFila({ ...calculada }, calculada)).toEqual({ iguales: true, difieren: [] });
  });

  test('nombra exactamente qué campo difiere', () => {
    const r = compararFila({ ...calculada, worked_minutes: 480 }, calculada);
    expect(r.iguales).toBe(false);
    expect(r.difieren).toEqual(['worked_minutes']);
  });

  test('los segundos no generan ruido en la comparación de horas', () => {
    const guardada = { ...calculada, first_in: '2025-06-10 08:00:59' };
    expect(compararFila(guardada, calculada).iguales).toBe(true);
  });

  test('distingue "no hay fila" de "los minutos no coinciden"', () => {
    expect(compararFila(null, calculada).difieren).toEqual(['sin_fila_guardada']);
    expect(compararFila(calculada, null).difieren).toEqual(['sin_jornada_calculada']);
  });

  test('acumula varias diferencias en vez de reportar sólo la primera', () => {
    const r = compararFila(
      { ...calculada, worked_minutes: 100, status: 'late', last_out: '2025-06-10 16:00:00' },
      calculada,
    );
    expect(r.difieren).toEqual(expect.arrayContaining(['worked_minutes', 'status', 'last_out']));
  });
});
