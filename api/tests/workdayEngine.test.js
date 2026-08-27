/**
 * workdayEngine.test.js — Suite del motor único de jornada.
 *
 * Los valores son ABSOLUTOS a propósito: el motor trabaja en hora de pared y
 * no puede depender de la zona del proceso. La suite corre en UTC,
 * America/Asuncion y Asia/Tokyo (ver .github/workflows/ci.yml) y tiene que dar
 * exactamente lo mismo en las tres.
 */

const engine = require('../src/services/workdayEngine');

const {
  buildWorkdays,
  clipToPeriod,
  punchWindow,
  resolveEffectiveConfig,
  normalizePunches,
  breakMinutesFor,
  effectiveType,
  toWall,
  absToDateTime,
  absToHHmm,
  minutesToHM,
  DEFAULTS,
  MODE_HISTORICAL_FALLBACK,
  MODE_CONFIGURED,
  BREAK_NONE,
  BREAK_FIXED_UNPAID,
  BREAK_PUNCHED,
  ANOMALY,
  POLICY_VERSION,
} = engine;

/** Atajo: lista de marcajes sin tipo (el caso del histórico importado). */
const marcas = (...ts) => ts.map((t) => ({ timestamp: t }));

// ═════════════════════════════════════════════════════════════════════
// 1. Casos dorados — los tres que definen "correcto" para este PR
// ═════════════════════════════════════════════════════════════════════

describe('casos dorados', () => {
  // 1
  test('turno nocturno 18:30 → 07:04 del día siguiente da 12:34 en la jornada del 01/12', () => {
    const { workdays } = buildWorkdays(marcas('2024-12-01 18:30:00', '2024-12-02 07:04:00'));

    expect(workdays).toHaveLength(1);
    expect(workdays[0].work_date).toBe('2024-12-01');
    expect(workdays[0].worked_minutes).toBe(754);
    expect(minutesToHM(workdays[0].worked_minutes)).toBe('12:34');
    expect(workdays[0].crosses_midnight).toBe(true);
  });

  // 2
  test('nocturno partido 21:32→00:05 y 01:02→05:29 da 2:33 + 4:27 = 7:00 en una sola jornada', () => {
    const { workdays } = buildWorkdays(marcas(
      '2025-03-09 21:32:00',
      '2025-03-10 00:05:00',
      '2025-03-10 01:02:00',
      '2025-03-10 05:29:00',
    ));

    expect(workdays).toHaveLength(1);
    const j = workdays[0];
    expect(j.work_date).toBe('2025-03-09');
    expect(j.segments.map((s) => minutesToHM(s.minutes))).toEqual(['2:33', '4:27']);
    expect(j.worked_minutes).toBe(420);
    expect(minutesToHM(j.worked_minutes)).toBe('7:00');
    expect(j.first_in_hhmm).toBe('21:32');
    expect(j.last_out_hhmm).toBe('05:29');
  });

  // 3
  test('la salida a las 05:29 NO abre jornada propia (el corte fijo de las 05:00 la partía)', () => {
    const { workdays } = buildWorkdays(marcas(
      '2025-03-09 21:32:00',
      '2025-03-10 00:05:00',
      '2025-03-10 01:02:00',
      '2025-03-10 05:29:00',
    ));
    expect(workdays.map((w) => w.work_date)).toEqual(['2025-03-09']);
  });

  // 4
  test('jornada diurna con almuerzo: permanencia 9:00, trabajado 8:00, pausa 60', () => {
    const { workdays } = buildWorkdays(marcas(
      '2025-06-10 08:00:00', '2025-06-10 12:00:00',
      '2025-06-10 13:00:00', '2025-06-10 17:00:00',
    ));

    expect(workdays).toHaveLength(1);
    expect(workdays[0].presence_minutes).toBe(540);
    expect(workdays[0].segment_minutes).toBe(480);
    expect(workdays[0].worked_minutes).toBe(480);
    expect(workdays[0].break_minutes).toBe(60);
    expect(workdays[0].crosses_midnight).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Hora de pared — nada de zonas horarias
// ═════════════════════════════════════════════════════════════════════

describe('hora de pared', () => {
  // 5
  test('una fecha de invierno anterior al 2024-10-06 conserva la hora guardada', () => {
    // El reporte actual imprime 07:00 acá, porque formatea con la tzdata
    // histórica de America/Asuncion (UTC-4 en esa fecha).
    const { workdays } = buildWorkdays(marcas('2024-08-01 08:00:00', '2024-08-01 17:00:00'));
    expect(workdays[0].first_in_hhmm).toBe('08:00');
    expect(workdays[0].last_out_hhmm).toBe('17:00');
    expect(workdays[0].work_date).toBe('2024-08-01');
  });

  // 6
  test('una marca de 00:30 en invierno NO se corre al día anterior', () => {
    // Con la conversión vieja, 2024-06-15 00:30 se imprimía 23:30 del 14/06.
    const { workdays } = buildWorkdays(marcas('2024-06-15 00:30:00', '2024-06-15 04:30:00'));
    expect(workdays[0].work_date).toBe('2024-06-15');
    expect(workdays[0].first_in_hhmm).toBe('00:30');
  });

  // 7
  test('los segundos no se pierden al truncar a minutos', () => {
    const { workdays } = buildWorkdays(marcas('2025-05-02 08:00:59', '2025-05-02 17:00:00'));
    expect(workdays[0].segment_minutes).toBe(539); // no 540
  });

  // 8
  test('toWall es aritmética civil pura: 24 h de diferencia entre días consecutivos', () => {
    const a = toWall('2024-10-05 12:00:00');
    const b = toWall('2024-10-06 12:00:00');
    // El 2024-10-06 es justamente la última transición horaria de Paraguay.
    expect(b.abs - a.abs).toBe(86400);
  });

  // 9
  test('absToDateTime es el inverso exacto de toWall', () => {
    for (const s of ['2024-01-01 00:00:00', '2025-12-31 23:59:59', '2024-02-29 06:42:29']) {
      expect(absToDateTime(toWall(s).abs)).toBe(s);
    }
  });

  // 10
  test('acepta el objeto Date que devuelve el driver, no sólo el string', () => {
    // mysql2 entrega DATETIME como Date interpretado con el offset de la
    // config; el motor tiene que deshacer exactamente esa conversión.
    const { workdays } = buildWorkdays([
      { timestamp: new Date('2025-07-01T08:15:00-03:00') },
      { timestamp: new Date('2025-07-01T16:45:00-03:00') },
    ]);
    expect(workdays[0].first_in_hhmm).toBe('08:15');
    expect(workdays[0].last_out_hhmm).toBe('16:45');
  });

  // 11
  test('absToHHmm normaliza sin depender de la zona del proceso', () => {
    expect(absToHHmm(toWall('2025-01-01 00:00:00').abs)).toBe('00:00');
    expect(absToHHmm(toWall('2025-01-01 23:59:00').abs)).toBe('23:59');
  });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Normalización y deduplicación
// ═════════════════════════════════════════════════════════════════════

describe('normalización de marcajes', () => {
  // 12
  test('ordena marcajes desordenados', () => {
    const { punches: n } = normalizePunches(marcas(
      '2025-06-10 17:00:00', '2025-06-10 08:00:00', '2025-06-10 12:00:00',
    ), DEFAULTS);
    expect(n.map((p) => p.hhmm)).toEqual(['08:00', '12:00', '17:00']);
  });

  // 13
  test('colapsa el fichaje repetido del reloj dentro de la ventana de dedupe', () => {
    const { punches: n } = normalizePunches(marcas(
      '2025-06-10 08:00:00', '2025-06-10 08:00:02', '2025-06-10 08:00:40',
    ), DEFAULTS);
    expect(n).toHaveLength(1);
    expect(n[0].hhmm).toBe('08:00');
    expect(n[0].duplicates).toBe(2);
  });

  // 14
  test('la deduplicación rescata el tipo explícito de la ráfaga', () => {
    const { punches: n } = normalizePunches([
      { timestamp: '2025-06-10 08:00:00', type: 'unknown' },
      { timestamp: '2025-06-10 08:00:02', type: 'in' },
    ], DEFAULTS);
    expect(n).toHaveLength(1);
    expect(n[0].type).toBe('in');
    expect(n[0].hhmm).toBe('08:00');
  });

  // 15
  test('descarta valores ilegibles sin lanzar y sin arrastrar el resto', () => {
    const { workdays } = buildWorkdays([
      { timestamp: null },
      { timestamp: '2025-06-10 08:00:00' },
      { timestamp: 'no-es-una-fecha' },
      { timestamp: '2025-06-10 17:00:00' },
    ]);
    expect(workdays).toHaveLength(1);
    expect(workdays[0].segment_minutes).toBe(540);
  });

  // 16
  test('sin marcajes no devuelve jornadas', () => {
    expect(buildWorkdays([]).workdays).toEqual([]);
    expect(buildWorkdays(null).workdays).toEqual([]);
  });

  // 17
  test('effectiveType mapea break_start/break_end a cierre/apertura', () => {
    expect(effectiveType('in')).toBe('in');
    expect(effectiveType('break_end')).toBe('in');
    expect(effectiveType('out')).toBe('out');
    expect(effectiveType('break_start')).toBe('out');
    expect(effectiveType('unknown')).toBe('unknown');
    expect(effectiveType(null)).toBe('unknown');
  });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Emparejamiento sensible al tipo
// ═════════════════════════════════════════════════════════════════════

describe('emparejamiento', () => {
  // 18
  test('con tipos explícitos, una entrada repetida no corre todos los pares', () => {
    const { workdays, anomalies } = buildWorkdays([
      { timestamp: '2025-06-10 08:00:00', type: 'in' },
      { timestamp: '2025-06-10 09:00:00', type: 'in' },
      { timestamp: '2025-06-10 17:00:00', type: 'out' },
    ]);
    // El emparejamiento posicional daba (08:00,09:00)=60 y descartaba 17:00.
    const j = workdays.find((w) => w.segments.some((s) => s.minutes === 480));
    expect(j).toBeDefined();
    // La anomalía queda en SU jornada, no en la lista global: cada fila del
    // reporte tiene que poder explicarse sola.
    const conAnomalia = workdays.find(
      (w) => w.anomalies.some((a) => a.code === ANOMALY.ENTRADAS_CONSECUTIVAS),
    );
    expect(conAnomalia).toBeDefined();
    expect(anomalies).toEqual([]);
  });

  // 19
  test('sin tipos (histórico importado) cae en alternancia', () => {
    const { workdays } = buildWorkdays(marcas(
      '2025-06-10 08:00:00', '2025-06-10 12:00:00', '2025-06-10 13:00:00',
    ));
    expect(workdays[0].segments[0].minutes).toBe(240);
    expect(workdays[0].segments[1].open).toBe(true);
  });

  // 20
  test('una salida huérfana NO inventa una entrada', () => {
    const { workdays, anomalies } = buildWorkdays([
      { timestamp: '2025-06-10 17:00:00', type: 'out' },
    ]);
    expect(workdays).toEqual([]);
    expect(anomalies).toEqual([
      { code: ANOMALY.SALIDA_SIN_ENTRADA, at: '2025-06-10 17:00:00', log_ids: [] },
    ]);
  });

  // 21
  test('una entrada sin salida queda como tramo abierto, no como jornada de 0 a 24', () => {
    const { workdays, anomalies } = buildWorkdays([
      { timestamp: '2025-06-10 08:00:00', type: 'in' },
    ]);
    expect(workdays).toHaveLength(1);
    expect(workdays[0].open).toBe(true);
    expect(workdays[0].last_out).toBeNull();
    expect(workdays[0].worked_minutes).toBe(0);
    expect(workdays[0].presence_minutes).toBe(0);
    expect(workdays[0].anomalies.map((a) => a.code)).toContain(ANOMALY.ENTRADA_SIN_SALIDA);
    expect(anomalies).toEqual([]);
  });

  // 22
  test('un tramo más largo que historicalMaxSessionSpanMinutes no se cuenta como trabajado', () => {
    const { workdays } = buildWorkdays(marcas('2025-06-10 08:00:00', '2025-06-12 09:00:00'));
    expect(workdays[0].open).toBe(true);
    expect(workdays[0].worked_minutes).toBe(0);
  });

  // 23
  test('typeAware:false fuerza la alternancia aunque haya tipos', () => {
    const { workdays } = buildWorkdays([
      { timestamp: '2025-06-10 08:00:00', type: 'in' },
      { timestamp: '2025-06-10 09:00:00', type: 'in' },
      { timestamp: '2025-06-10 17:00:00', type: 'out' },
    ], { typeAware: false });
    expect(workdays[0].segments[0].minutes).toBe(60);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Agrupación en jornadas
// ═════════════════════════════════════════════════════════════════════

describe('agrupación en jornadas', () => {
  // 24
  test('una pausa mayor a maxGapMinutes abre jornada nueva el mismo día', () => {
    const { workdays } = buildWorkdays(marcas(
      '2025-06-10 06:00:00', '2025-06-10 10:00:00',
      '2025-06-10 18:00:00', '2025-06-10 22:00:00',
    ));
    expect(workdays).toHaveLength(2);
    expect(workdays.every((w) => w.work_date === '2025-06-10')).toBe(true);
  });

  // 25
  test('el umbral de pausa es configurable y cambia la agrupación', () => {
    const punches = marcas(
      '2025-06-10 06:00:00', '2025-06-10 10:00:00',
      '2025-06-10 18:00:00', '2025-06-10 22:00:00',
    );
    expect(buildWorkdays(punches, { historicalMaxIntersegmentGapMinutes: 10 * 60 }).workdays).toHaveLength(1);
  });

  // 26
  test('dos jornadas nocturnas consecutivas no se encadenan entre sí', () => {
    const { workdays } = buildWorkdays(marcas(
      '2025-06-10 22:00:00', '2025-06-11 06:00:00',
      '2025-06-11 22:00:00', '2025-06-12 06:00:00',
    ));
    expect(workdays.map((w) => w.work_date)).toEqual(['2025-06-10', '2025-06-11']);
    expect(workdays.every((w) => w.worked_minutes === 480)).toBe(true);
  });

  // 27
  test('maxSpanMinutes corta una cadena de pausas cortas encadenadas', () => {
    // Tramos de 1 h cada 3 h durante más de 20 h: sin tope se volvería una
    // sola jornada de día y medio.
    const punches = [];
    let abs = toWall('2025-06-10 06:00:00').abs;
    for (let i = 0; i < 9; i++) {
      punches.push({ timestamp: absToDateTime(abs) });
      punches.push({ timestamp: absToDateTime(abs + 3600) });
      abs += 3 * 3600;
    }
    const { workdays } = buildWorkdays(punches);
    expect(workdays.length).toBeGreaterThan(1);
  });

  // 28
  test('la work_date es la de la primera entrada, no la de cada marca', () => {
    const { workdays } = buildWorkdays(marcas('2025-12-31 22:00:00', '2026-01-01 06:00:00'));
    expect(workdays[0].work_date).toBe('2025-12-31');
    expect(workdays[0].last_out).toBe('2026-01-01 06:00:00');
  });
});

// ═════════════════════════════════════════════════════════════════════
// 6. Configuración vigente y modos
// ═════════════════════════════════════════════════════════════════════

describe('modos y configuración vigente', () => {
  const historial = [
    { valid_from: '2026-01-01', valid_to: null, check_in: '07:00', check_out: '15:00', tolerance_in: 10 },
  ];

  // 29
  test('sin configuración vigente la jornada queda en historical_fallback y sin atraso', () => {
    const { workdays } = buildWorkdays(
      marcas('2024-12-01 09:30:00', '2024-12-01 18:00:00'),
      { history: historial },
    );
    expect(workdays[0].mode).toBe(MODE_HISTORICAL_FALLBACK);
    expect(workdays[0].late_minutes).toBeNull();
    expect(workdays[0].scheduled_minutes).toBeNull();
  });

  // 30
  test('el horario de hoy NO se aplica retroactivamente al historial', () => {
    // Con `valid_from = 2026-01-01`, diciembre de 2024 no puede generar
    // atrasos: no había horario configurado contra el cual llegar tarde.
    const hist = resolveEffectiveConfig('2024-12-01', historial);
    expect(hist).toBeNull();
  });

  // 31
  test('con configuración vigente calcula atraso respetando la tolerancia', () => {
    const { workdays } = buildWorkdays(
      marcas('2026-02-02 07:25:00', '2026-02-02 15:00:00'),
      { history: historial },
    );
    expect(workdays[0].mode).toBe(MODE_CONFIGURED);
    expect(workdays[0].late_minutes).toBe(15); // 25 min menos 10 de tolerancia
  });

  // 32
  test('gana el tramo de vigencia más reciente que cubre la fecha', () => {
    const hist = [
      { valid_from: '2025-01-01', valid_to: '2025-12-31', check_in: '08:00' },
      { valid_from: '2026-01-01', valid_to: null, check_in: '07:00' },
    ];
    expect(resolveEffectiveConfig('2025-06-10', hist).check_in).toBe('08:00');
    expect(resolveEffectiveConfig('2026-06-10', hist).check_in).toBe('07:00');
    expect(resolveEffectiveConfig('2024-06-10', hist)).toBeNull();
  });

  // 33
  test('el objetivo semanal no se inventa: sin configuración queda en null', () => {
    const { workdays } = buildWorkdays(marcas('2024-12-01 08:00:00', '2024-12-01 17:00:00'));
    expect(workdays[0].weekly_target_minutes).toBeNull();
  });

  // 34
  test('el objetivo semanal se toma de la configuración, cualquiera sea', () => {
    for (const horas of [48, 45, 42, 36, 32, 24, 20]) {
      const { workdays } = buildWorkdays(
        marcas('2026-03-02 08:00:00', '2026-03-02 17:00:00'),
        { config: { check_in: '08:00', check_out: '17:00', weekly_target_minutes: horas * 60 } },
      );
      expect(workdays[0].weekly_target_minutes).toBe(horas * 60);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// 7. Descansos
// ═════════════════════════════════════════════════════════════════════

describe('descansos', () => {
  // 35
  test('modo none: no descuenta nada', () => {
    const { workdays } = buildWorkdays(
      marcas('2026-03-02 08:00:00', '2026-03-02 17:00:00'),
      { config: { break_mode: BREAK_NONE, break_minutes: 60 } },
    );
    expect(workdays[0].worked_minutes).toBe(540);
    expect(workdays[0].break_minutes).toBe(0);
  });

  // 36
  test('modo fixed_unpaid: descuenta el fijo del tiempo trabajado', () => {
    const { workdays } = buildWorkdays(
      marcas('2026-03-02 08:00:00', '2026-03-02 17:00:00'),
      { config: { break_mode: BREAK_FIXED_UNPAID, break_minutes: 60 } },
    );
    expect(workdays[0].segment_minutes).toBe(540);
    expect(workdays[0].worked_minutes).toBe(480);
    expect(workdays[0].break_minutes).toBe(60);
  });

  // 37
  test('modo fixed_unpaid nunca deja el tiempo trabajado en negativo', () => {
    const { workdays } = buildWorkdays(
      marcas('2026-03-02 08:00:00', '2026-03-02 08:40:00'),
      { config: { break_mode: BREAK_FIXED_UNPAID, break_minutes: 60 } },
    );
    expect(workdays[0].worked_minutes).toBe(0);
    expect(workdays[0].worked_minutes).toBeGreaterThanOrEqual(0);
  });

  // 38
  test('modo fixed_unpaid respeta el umbral break_after_minutes', () => {
    const cfg = { break_mode: BREAK_FIXED_UNPAID, break_minutes: 60, break_after_minutes: 360 };
    const corta = buildWorkdays(marcas('2026-03-02 08:00:00', '2026-03-02 12:00:00'), { config: cfg });
    const larga = buildWorkdays(marcas('2026-03-02 08:00:00', '2026-03-02 17:00:00'), { config: cfg });
    expect(corta.workdays[0].worked_minutes).toBe(240);
    expect(larga.workdays[0].worked_minutes).toBe(480);
  });

  // 39
  test('modo punched: la pausa marcada ya está fuera, no se descuenta dos veces', () => {
    const { workdays } = buildWorkdays(marcas(
      '2026-03-02 08:00:00', '2026-03-02 12:00:00',
      '2026-03-02 13:00:00', '2026-03-02 17:00:00',
    ), { config: { break_mode: BREAK_PUNCHED } });
    expect(workdays[0].segment_minutes).toBe(480);
    expect(workdays[0].worked_minutes).toBe(480); // NO 420
    expect(workdays[0].break_minutes).toBe(60);
  });

  // 40
  test('breakMinutesFor es puro y cubre los tres modos', () => {
    const base = { fixedBreakMinutes: 45, breakAfterMinutes: 0, gapMinutes: 30, segmentMinutes: 480 };
    expect(breakMinutesFor({ ...base, mode: BREAK_NONE })).toBe(0);
    expect(breakMinutesFor({ ...base, mode: BREAK_FIXED_UNPAID })).toBe(45);
    expect(breakMinutesFor({ ...base, mode: BREAK_PUNCHED })).toBe(30);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 8. Bordes del reporte
// ═════════════════════════════════════════════════════════════════════

describe('bordes del período', () => {
  // 41
  test('la jornada del 31/12 que cierra el 01/01 pertenece a diciembre, completa', () => {
    const { workdays } = buildWorkdays(marcas('2025-12-31 22:00:00', '2026-01-01 06:00:00'));
    const dic = clipToPeriod(workdays, { from: '2025-12-01', to: '2025-12-31' });
    expect(dic).toHaveLength(1);
    expect(dic[0].worked_minutes).toBe(480);

    const ene = clipToPeriod(workdays, { from: '2026-01-01', to: '2026-01-31' });
    expect(ene).toEqual([]);
  });

  // 42
  test('clipToPeriod filtra por work_date, no por fecha de marca', () => {
    const { workdays } = buildWorkdays(marcas(
      '2025-11-30 22:00:00', '2025-12-01 06:00:00',
      '2025-12-01 22:00:00', '2025-12-02 06:00:00',
    ));
    const dic = clipToPeriod(workdays, { from: '2025-12-01', to: '2025-12-31' });
    expect(dic.map((w) => w.work_date)).toEqual(['2025-12-01']);
  });

  // 43
  test('punchWindow extiende el rango hacia atrás y hacia adelante', () => {
    const w = punchWindow({ from: '2025-12-01', to: '2025-12-31' });
    expect(w.from).toBe('2025-11-30 00:00:00');
    expect(w.to).toBe('2026-01-02 00:00:00'); // exclusivo
  });

  // 44
  test('punchWindow acompaña un maxSpanMinutes mayor a un día', () => {
    const w = punchWindow({ from: '2025-12-01', to: '2025-12-31' }, { historicalMaxWorkdaySpanMinutes: 30 * 60 });
    expect(w.from).toBe('2025-11-29 00:00:00');
    expect(w.to).toBe('2026-01-03 00:00:00');
  });

  // 45
  test('punchWindow rechaza un rango inválido en vez de devolver fechas absurdas', () => {
    expect(() => punchWindow({ from: '2025-13-45', to: '2025-12-31' })).toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════
// 9. Diferenciación de conceptos
// ═════════════════════════════════════════════════════════════════════

describe('permanencia vs trabajado', () => {
  // 46
  test('los tres totales se informan por separado y no son sinónimos', () => {
    const { workdays } = buildWorkdays(marcas(
      '2026-03-02 08:00:00', '2026-03-02 12:00:00',
      '2026-03-02 13:30:00', '2026-03-02 17:00:00',
    ), { config: { break_mode: BREAK_PUNCHED } });

    const j = workdays[0];
    expect(j.presence_minutes).toBe(540); // 08:00 → 17:00
    expect(j.segment_minutes).toBe(450);  // 240 + 210
    expect(j.worked_minutes).toBe(450);
    expect(j.gap_minutes).toBe(90);
    expect(j.presence_minutes - j.segment_minutes).toBe(j.gap_minutes);
  });

  // 47
  test('minutesToHM nunca devuelve negativos ni horas raras', () => {
    expect(minutesToHM(0)).toBe('0:00');
    expect(minutesToHM(-5)).toBe('0:00');
    expect(minutesToHM(754)).toBe('12:34');
    expect(minutesToHM(1440)).toBe('24:00');
  });
});

// ═════════════════════════════════════════════════════════════════════
// 10. Escala
// ═════════════════════════════════════════════════════════════════════

describe('escala', () => {
  // 48
  test('un año de marcajes no desborda el stack ni degrada a cuadrático', () => {
    const punches = [];
    let abs = toWall('2025-01-01 08:00:00').abs;
    for (let i = 0; i < 365; i++) {
      punches.push({ timestamp: absToDateTime(abs), type: 'in' });
      punches.push({ timestamp: absToDateTime(abs + 9 * 3600), type: 'out' });
      abs += 86400;
    }
    const t0 = Date.now();
    const { workdays } = buildWorkdays(punches);
    expect(workdays).toHaveLength(365);
    expect(workdays.every((w) => w.worked_minutes === 540)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 11. El bug 24:xx — regresión del runtime de producción
// ═════════════════════════════════════════════════════════════════════

describe('nunca se emite 24:xx', () => {
  // 49
  test('reproduce el mecanismo: Intl con hourCycle h24 devuelve 24:05', () => {
    // Esto NO es una hipótesis. Con `hour12: false`, algunas combinaciones de
    // locale e ICU resuelven a hourCycle 'h24' —que es lo que hace el runtime
    // de producción— y entonces la medianoche se numera 24 en vez de 0.
    const h24 = new Intl.DateTimeFormat('es-PY', {
      timeZone: 'America/Asuncion', hour: '2-digit', minute: '2-digit', hourCycle: 'h24',
    });
    expect(h24.format(new Date('2025-01-03T00:05:00-03:00'))).toBe('24:05');
    expect(h24.format(new Date('2025-01-03T00:00:00-03:00'))).toBe('24:00');
    // Y el corte por hora se rompe: pyHour(00:05) da 24, así que `24 < 5` es
    // falso y la marca de la madrugada NO se asigna al día anterior.
    const hora = new Intl.DateTimeFormat('es-PY', {
      timeZone: 'America/Asuncion', hour: 'numeric', hourCycle: 'h24',
    });
    expect(parseInt(hora.format(new Date('2025-01-03T00:05:00-03:00')), 10)).toBe(24);
    expect(parseInt(hora.format(new Date('2025-01-03T01:02:00-03:00')), 10)).toBe(1);
  });

  // 50
  test('el motor es inmune: no usa Intl para las horas', () => {
    const fuente = require('fs').readFileSync(
      require('path').resolve(__dirname, '..', 'src', 'services', 'workdayEngine.js'), 'utf8',
    );
    // La garantía estructural: si nadie llama a Intl, ningún hourCycle puede
    // afectar el resultado. Es más fuerte que probar formatos uno por uno.
    expect(fuente).not.toMatch(/Intl\./);
  });

  // 51
  test.each([
    ['00:00:00', '00:00'],
    ['00:05:00', '00:05'],
    ['00:12:00', '00:12'],
    ['00:58:00', '00:58'],
    ['01:02:00', '01:02'],
    ['23:59:00', '23:59'],
  ])('%s se muestra %s', (hora, esperado) => {
    expect(absToHHmm(toWall(`2025-01-03 ${hora}`).abs)).toBe(esperado);
  });

  // 52
  test('ninguna hora emitida por el motor empieza con 24', () => {
    const { workdays } = buildWorkdays(marcas(
      '2025-01-02 21:32:00', '2025-01-03 00:00:00',
      '2025-01-03 00:05:00', '2025-01-03 05:29:00',
    ));
    const horas = workdays.flatMap((w) => w.segments.flatMap((s) => [s.in_hhmm, s.out_hhmm]));
    expect(horas.length).toBeGreaterThan(0);
    for (const h of horas) expect(h).not.toMatch(/^24/);
  });

  // 53
  test('23:59 → 00:01 cruza el día sin producir 24:xx', () => {
    const { workdays } = buildWorkdays(marcas('2025-01-02 23:59:00', '2025-01-03 00:01:00'));
    expect(workdays[0].segments[0].in_hhmm).toBe('23:59');
    expect(workdays[0].segments[0].out_hhmm).toBe('00:01');
    expect(workdays[0].segment_minutes).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 12. Anomalías — se reportan, no se rellenan
// ═════════════════════════════════════════════════════════════════════

describe('anomalías', () => {
  // 54
  test('IN sin OUT no inventa minutos', () => {
    const { workdays } = buildWorkdays([{ timestamp: '2025-01-02 08:00:00', type: 'in' }]);
    expect(workdays[0].worked_minutes).toBe(0);
    expect(workdays[0].anomalies.map((a) => a.code)).toContain(ANOMALY.ENTRADA_SIN_SALIDA);
  });

  // 55
  test('OUT sin IN se reporta y no genera jornada', () => {
    const { workdays, anomalies } = buildWorkdays([{ timestamp: '2025-01-02 17:00:00', type: 'out' }]);
    expect(workdays).toEqual([]);
    expect(anomalies.map((a) => a.code)).toEqual([ANOMALY.SALIDA_SIN_ENTRADA]);
  });

  // 56
  test('IN, IN consecutivos se reportan como entradas_consecutivas', () => {
    const { workdays } = buildWorkdays([
      { timestamp: '2025-01-02 08:00:00', type: 'in' },
      { timestamp: '2025-01-02 11:00:00', type: 'in' },
      { timestamp: '2025-01-02 17:00:00', type: 'out' },
    ]);
    const codigos = workdays.flatMap((w) => w.anomalies.map((a) => a.code));
    expect(codigos).toContain(ANOMALY.ENTRADAS_CONSECUTIVAS);
  });

  // 57
  test('OUT, OUT consecutivos se reportan como salidas_consecutivas', () => {
    const { workdays, anomalies } = buildWorkdays([
      { timestamp: '2025-01-02 08:00:00', type: 'in' },
      { timestamp: '2025-01-02 12:00:00', type: 'out' },
      { timestamp: '2025-01-02 17:00:00', type: 'out' },
    ]);
    const codigos = [...anomalies, ...workdays.flatMap((w) => w.anomalies)].map((a) => a.code);
    expect(codigos).toContain(ANOMALY.SALIDAS_CONSECUTIVAS);
    // El primer par sí se contabiliza: la anomalía del segundo OUT no
    // invalida tiempo que sí está respaldado por dos marcas.
    expect(workdays[0].segment_minutes).toBe(240);
  });

  // 58
  test('duplicado del mismo tipo se colapsa conservando trazabilidad', () => {
    const { workdays } = buildWorkdays([
      { timestamp: '2025-01-02 08:00:00', type: 'in', id: 101 },
      { timestamp: '2025-01-02 08:00:03', type: 'in', id: 102 },
      { timestamp: '2025-01-02 17:00:00', type: 'out', id: 103 },
    ]);
    expect(workdays[0].segments).toHaveLength(1);
    expect(workdays[0].segments[0].source_logs).toEqual([101, 102, 103]);
    expect(workdays[0].anomalies.map((a) => a.code)).toContain(ANOMALY.MARCAJE_DUPLICADO);
  });

  // 59
  test('IN y OUT en el mismo minuto NO se deduplican entre sí', () => {
    // Colapsarlos destruía el cierre del tramo: el segmento quedaba abierto y
    // la jornada perdía todos sus minutos.
    const { workdays } = buildWorkdays([
      { timestamp: '2025-01-02 08:00:00', type: 'in', id: 1 },
      { timestamp: '2025-01-02 08:00:30', type: 'out', id: 2 },
      { timestamp: '2025-01-02 09:00:00', type: 'in', id: 3 },
      { timestamp: '2025-01-02 17:00:00', type: 'out', id: 4 },
    ]);
    expect(workdays[0].segments).toHaveLength(2);
    expect(workdays[0].segments[0].open).toBe(false);
    expect(workdays[0].segments[1].minutes).toBe(480);
  });

  // 60
  test('cada jornada lleva su modo, su fuente y su versión de política', () => {
    const { workdays } = buildWorkdays(marcas('2025-01-02 08:00:00', '2025-01-02 17:00:00'));
    expect(workdays[0].calculation_mode).toBe(MODE_HISTORICAL_FALLBACK);
    expect(workdays[0].calculation_source).toBe('attendance_logs');
    expect(workdays[0].policy_version).toBe(POLICY_VERSION);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 13. Bordes de mes y de año
// ═════════════════════════════════════════════════════════════════════

describe('cruces de mes y de año', () => {
  // 61
  test('31/01 IN → 01/02 OUT pertenece al 31/01', () => {
    const { workdays } = buildWorkdays(marcas('2025-01-31 20:00:00', '2025-02-01 06:30:00'));
    expect(workdays[0].work_date).toBe('2025-01-31');
    expect(workdays[0].segment_minutes).toBe(630);
    expect(clipToPeriod(workdays, { from: '2025-01-01', to: '2025-01-31' })).toHaveLength(1);
    expect(clipToPeriod(workdays, { from: '2025-02-01', to: '2025-02-28' })).toHaveLength(0);
  });

  // 62
  test('31/12 IN → 01/01 OUT pertenece al 31/12', () => {
    const { workdays } = buildWorkdays(marcas('2025-12-31 22:00:00', '2026-01-01 06:00:00'));
    expect(workdays[0].work_date).toBe('2025-12-31');
    expect(workdays[0].last_out).toBe('2026-01-01 06:00:00');
  });

  // 63
  test('un OUT del primer día cuya jornada empezó antes no se mezcla con el IN siguiente', () => {
    // Sin contexto previo, el OUT de las 06:30 sería huérfano y podría quedar
    // emparejado con el IN de las 08:00, inventando una jornada al revés.
    const { workdays } = buildWorkdays([
      { timestamp: '2025-01-31 20:00:00', type: 'in' },
      { timestamp: '2025-02-01 06:30:00', type: 'out' },
      { timestamp: '2025-02-01 08:00:00', type: 'in' },
      { timestamp: '2025-02-01 17:00:00', type: 'out' },
    ]);
    expect(workdays.map((w) => w.work_date)).toEqual(['2025-01-31', '2025-02-01']);
    expect(workdays[1].segments[0].in_hhmm).toBe('08:00');
    expect(workdays[1].segment_minutes).toBe(540);
  });

  // 64
  test('punchWindow cubre el mes de febrero bisiesto sin fechas absurdas', () => {
    const w = punchWindow({ from: '2024-02-01', to: '2024-02-29' });
    expect(w.from).toBe('2024-01-31 00:00:00');
    expect(w.to).toBe('2024-03-02 00:00:00');
  });
});

// ═════════════════════════════════════════════════════════════════════
// 14. Objetivos semanales y exceso contractual
// ═════════════════════════════════════════════════════════════════════

describe('objetivo contractual', () => {
  // 65
  test.each([48, 45, 42, 36, 32, 24, 20, 37.5])('objetivo semanal de %s h es configurable', (horas) => {
    const { workdays } = buildWorkdays(
      marcas('2026-03-02 08:00:00', '2026-03-02 17:00:00'),
      { config: { check_in: '08:00', check_out: '17:00', weekly_target_minutes: Math.round(horas * 60) } },
    );
    expect(workdays[0].weekly_target_minutes).toBe(Math.round(horas * 60));
  });

  // 66
  test('el exceso sobre el objetivo se mide, sin llamarlo hora extra legal', () => {
    // Objetivo diario 6:00, trabajado 9:00 → 3:00 de exceso. Si ese exceso se
    // liquida como extraordinario o se compensa con descanso es una decisión
    // de convenio que el motor NO toma.
    const { workdays } = buildWorkdays(
      marcas('2026-03-02 08:00:00', '2026-03-02 17:00:00'),
      { config: { check_in: '08:00', check_out: '17:00', daily_target_minutes: 360 } },
    );
    expect(workdays[0].worked_minutes).toBe(540);
    expect(workdays[0].contract_target_minutes).toBe(360);
    expect(workdays[0].contract_excess_minutes).toBe(180);
    expect(workdays[0]).not.toHaveProperty('legal_overtime_minutes');
  });

  // 67
  test('sin objetivo cargado no se inventa exceso', () => {
    const { workdays } = buildWorkdays(marcas('2026-03-02 08:00:00', '2026-03-02 20:00:00'));
    expect(workdays[0].contract_target_minutes).toBeNull();
    expect(workdays[0].contract_excess_minutes).toBeNull();
    expect(workdays[0].weekly_target_minutes).toBeNull();
  });

  // 68
  test('trabajar menos que el objetivo da exceso 0, nunca negativo', () => {
    const { workdays } = buildWorkdays(
      marcas('2026-03-02 08:00:00', '2026-03-02 12:00:00'),
      { config: { check_in: '08:00', check_out: '17:00', daily_target_minutes: 480 } },
    );
    expect(workdays[0].contract_excess_minutes).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 15. Franja nocturna
// ═════════════════════════════════════════════════════════════════════

describe('reparto diurno / nocturno', () => {
  // 69
  test('sin franja configurada no se inventa horario nocturno', () => {
    const { workdays } = buildWorkdays(marcas('2025-01-02 22:00:00', '2025-01-03 06:00:00'));
    expect(workdays[0].night_minutes).toBe(0);
    expect(workdays[0].day_minutes).toBe(480);
  });

  // 70
  test('con franja 20:00→06:00 un turno nocturno completo es todo nocturno', () => {
    const { workdays } = buildWorkdays(
      marcas('2025-01-02 22:00:00', '2025-01-03 06:00:00'),
      { nightStartMinute: 20 * 60, nightEndMinute: 6 * 60 },
    );
    expect(workdays[0].night_minutes).toBe(480);
    expect(workdays[0].day_minutes).toBe(0);
  });

  // 71
  test('un turno que arranca de tarde reparte los minutos entre las dos franjas', () => {
    // 18:00 → 23:00: dos horas diurnas y tres nocturnas con franja 20:00→06:00.
    const { workdays } = buildWorkdays(
      marcas('2025-01-02 18:00:00', '2025-01-02 23:00:00'),
      { nightStartMinute: 20 * 60, nightEndMinute: 6 * 60 },
    );
    expect(workdays[0].night_minutes).toBe(180);
    expect(workdays[0].day_minutes).toBe(120);
  });

  // 72
  test('la franja también admite no cruzar la medianoche', () => {
    const { workdays } = buildWorkdays(
      marcas('2025-01-02 00:00:00', '2025-01-02 08:00:00'),
      { nightStartMinute: 0, nightEndMinute: 6 * 60 },
    );
    expect(workdays[0].night_minutes).toBe(360);
    expect(workdays[0].day_minutes).toBe(120);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 16. Correcciones de la revisión de Codex (PR #147)
// ═════════════════════════════════════════════════════════════════════

describe('franja nocturna desde la configuración resuelta', () => {
  // La config resuelta trae night_start/night_end como TIME; los callers de
  // producción no fijan nightStartMinute/nightEndMinute de nivel superior, así
  // que sin tomar el intervalo de la config un turno 20:00-06:00 daba night 0.
  test('resolveConfig con night_start/night_end reparte los minutos', () => {
    const { workdays } = buildWorkdays(
      [
        { timestamp: '2025-01-02 22:00:00', type: 'in' },
        { timestamp: '2025-01-03 06:00:00', type: 'out' },
      ],
      {
        resolveConfig: () => ({
          check_in: '22:00', check_out: '06:00',
          night_start: '20:00:00', night_end: '06:00:00',
          source: 'schedule_history',
        }),
      },
    );
    expect(workdays[0].night_minutes).toBe(480);
    expect(workdays[0].day_minutes).toBe(0);
  });

  test('un día no laborable no aplica la franja aunque la config la traiga', () => {
    const { workdays } = buildWorkdays(
      marcas('2025-01-02 22:00:00', '2025-01-03 02:00:00'),
      {
        resolveConfig: () => ({
          non_working: true, kind: 'vacation',
          night_start: '20:00:00', night_end: '06:00:00',
        }),
      },
    );
    expect(workdays[0].night_minutes).toBe(0);
  });
});

describe('anomalía de duplicado en el cierre queda en su jornada', () => {
  // Un OUT duplicado posterior al OUT retenido tiene su hora DESPUÉS del cierre
  // de la jornada; un filtro por sólo rango temporal lo dejaba en la lista
  // global, que el reporte descarta, volviéndolo invisible.
  test('17:00:00 out + 17:00:30 out: el duplicado se ve en la jornada', () => {
    const { workdays, anomalies } = buildWorkdays([
      { timestamp: '2025-01-02 08:00:00', type: 'in', id: 1 },
      { timestamp: '2025-01-02 17:00:00', type: 'out', id: 2 },
      { timestamp: '2025-01-02 17:00:30', type: 'out', id: 3 },
    ]);
    expect(workdays).toHaveLength(1);
    expect(workdays[0].anomalies.map((a) => a.code)).toContain(ANOMALY.MARCAJE_DUPLICADO);
    expect(workdays[0].segments[0].source_logs).toEqual([1, 2, 3]);
    // No debe quedar huérfana en la lista global.
    expect(anomalies).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 17. Anomalía de cierre posterior al último out (revisión Codex, b733b82)
// ═════════════════════════════════════════════════════════════════════

describe('anomalía de salida posterior al cierre queda en su jornada', () => {
  // Un OUT de más, fuera de la ventana de dedupe y POSTERIOR al último out:
  // 08:00 in, 17:00 out, 17:05 out. El 17:05 es salidas_consecutivas, no
  // comparte log con ningún tramo y cae después de la última salida; un filtro
  // que corta en last_out lo dejaba en la lista global —que el reporte
  // descarta— y el marcaje repetido quedaba invisible.
  test('17:00 out + 17:05 out: la anomalía se ve en la jornada, no global', () => {
    const { workdays, anomalies } = buildWorkdays([
      { timestamp: '2025-06-10 08:00:00', type: 'in', id: 1 },
      { timestamp: '2025-06-10 17:00:00', type: 'out', id: 2 },
      { timestamp: '2025-06-10 17:05:00', type: 'out', id: 3 },
    ]);
    expect(workdays).toHaveLength(1);
    expect(workdays[0].anomalies.map((a) => a.code)).toContain(ANOMALY.SALIDAS_CONSECUTIVAS);
    expect(anomalies).toEqual([]);
  });

  // La contracara: una salida sin entrada ANTES de la primera jornada queda
  // global, que es lo correcto (su entrada fue antes de la ventana).
  test('una salida huérfana previa a la primera jornada queda global', () => {
    const { workdays, anomalies } = buildWorkdays([
      { timestamp: '2025-06-10 06:00:00', type: 'out', id: 1 },
      { timestamp: '2025-06-10 08:00:00', type: 'in', id: 2 },
      { timestamp: '2025-06-10 17:00:00', type: 'out', id: 3 },
    ]);
    expect(workdays).toHaveLength(1);
    expect(anomalies.map((a) => a.code)).toContain(ANOMALY.SALIDA_SIN_ENTRADA);
  });

  // Un OUT huérfano entre dos jornadas se asigna a la que viene ANTES, no a la
  // siguiente ni a la lista global.
  test('un OUT suelto entre dos jornadas se asigna a la jornada previa', () => {
    const { workdays, anomalies } = buildWorkdays([
      { timestamp: '2025-06-10 08:00:00', type: 'in', id: 1 },
      { timestamp: '2025-06-10 12:00:00', type: 'out', id: 2 },
      { timestamp: '2025-06-10 12:30:00', type: 'out', id: 3 },
      { timestamp: '2025-06-10 18:00:00', type: 'in', id: 4 },
      { timestamp: '2025-06-10 22:00:00', type: 'out', id: 5 },
    ]);
    expect(workdays).toHaveLength(2);
    expect(workdays[0].anomalies.map((a) => a.code)).toContain(ANOMALY.SALIDAS_CONSECUTIVAS);
    expect(workdays[1].anomalies).toEqual([]);
    expect(anomalies).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 18. Conflicto de turneras visible en la jornada (revisión Codex)
// ═════════════════════════════════════════════════════════════════════

describe('conflicto de turneras se expone como anomalía', () => {
  test('dos turneras el mismo día → anomalía turnera_conflict en la jornada', () => {
    const { workdays } = buildWorkdays(
      [
        { timestamp: '2025-06-10 08:00:00', type: 'in' },
        { timestamp: '2025-06-10 17:00:00', type: 'out' },
      ],
      {
        resolveConfig: () => ({
          source: 'shift_assignment', check_in: '08:00', check_out: '17:00',
          conflict_shift_schedule_ids: [3, 9],
        }),
      },
    );
    const a = workdays[0].anomalies.find((x) => x.code === ANOMALY.TURNERA_CONFLICT);
    expect(a).toBeDefined();
    expect(a.shift_schedule_ids).toEqual([3, 9]);
  });

  test('sin conflicto no se agrega la anomalía', () => {
    const { workdays } = buildWorkdays(
      [
        { timestamp: '2025-06-10 08:00:00', type: 'in' },
        { timestamp: '2025-06-10 17:00:00', type: 'out' },
      ],
      { resolveConfig: () => ({ source: 'shift_assignment', check_in: '08:00', check_out: '17:00' }) },
    );
    expect(workdays[0].anomalies.map((x) => x.code)).not.toContain(ANOMALY.TURNERA_CONFLICT);
  });
});
