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
    const n = normalizePunches(marcas(
      '2025-06-10 17:00:00', '2025-06-10 08:00:00', '2025-06-10 12:00:00',
    ), DEFAULTS);
    expect(n.map((p) => p.hhmm)).toEqual(['08:00', '12:00', '17:00']);
  });

  // 13
  test('colapsa el fichaje repetido del reloj dentro de la ventana de dedupe', () => {
    const n = normalizePunches(marcas(
      '2025-06-10 08:00:00', '2025-06-10 08:00:02', '2025-06-10 08:00:40',
    ), DEFAULTS);
    expect(n).toHaveLength(1);
    expect(n[0].hhmm).toBe('08:00');
    expect(n[0].duplicates).toBe(2);
  });

  // 14
  test('la deduplicación rescata el tipo explícito de la ráfaga', () => {
    const n = normalizePunches([
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
    const { workdays, warnings } = buildWorkdays([
      { timestamp: '2025-06-10 08:00:00', type: 'in' },
      { timestamp: '2025-06-10 09:00:00', type: 'in' },
      { timestamp: '2025-06-10 17:00:00', type: 'out' },
    ]);
    // El emparejamiento posicional daba (08:00,09:00)=60 y descartaba 17:00.
    const j = workdays.find((w) => w.segments.some((s) => s.minutes === 480));
    expect(j).toBeDefined();
    expect(warnings.some((w) => w.code === 'salida_faltante')).toBe(true);
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
    const { workdays, warnings } = buildWorkdays([
      { timestamp: '2025-06-10 17:00:00', type: 'out' },
    ]);
    expect(workdays).toEqual([]);
    expect(warnings).toEqual([{ code: 'salida_huerfana', at: '2025-06-10 17:00:00' }]);
  });

  // 21
  test('una entrada sin salida queda como tramo abierto, no como jornada de 0 a 24', () => {
    const { workdays, warnings } = buildWorkdays([
      { timestamp: '2025-06-10 08:00:00', type: 'in' },
    ]);
    expect(workdays).toHaveLength(1);
    expect(workdays[0].open).toBe(true);
    expect(workdays[0].last_out).toBeNull();
    expect(workdays[0].worked_minutes).toBe(0);
    expect(workdays[0].presence_minutes).toBe(0);
    expect(warnings.some((w) => w.code === 'salida_faltante')).toBe(true);
  });

  // 22
  test('un tramo más largo que maxSegmentMinutes no se cuenta como trabajado', () => {
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
    expect(buildWorkdays(punches, { maxGapMinutes: 10 * 60 }).workdays).toHaveLength(1);
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
    expect(workdays[0].expected_minutes).toBeNull();
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
    const w = punchWindow({ from: '2025-12-01', to: '2025-12-31' }, { maxSpanMinutes: 30 * 60 });
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
