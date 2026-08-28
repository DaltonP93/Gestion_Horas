/**
 * attendanceTime.test.js — La primitiva wall-clock de INSERT.
 *
 * Garantiza el invariante: una marca naive del dispositivo se persiste con sus
 * componentes exactos, sin depender de la zona del proceso; un instante real se
 * convierte intencionalmente a la hora de pared de la institución.
 */

jest.mock('../src/config/database', () => ({ DB_TIMEZONE: '-03:00' }));

const {
  normalizeAttendanceTimestampForDb,
  wallClockToInstitutionInstant,
  attendanceDisplayInstant,
} = require('../src/utils/attendanceTime');

describe('normalizeAttendanceTimestampForDb — naive se preserva', () => {
  test('naive con segundos se guarda tal cual', () => {
    expect(normalizeAttendanceTimestampForDb('2026-08-27 18:30:15')).toBe('2026-08-27 18:30:15');
  });

  test('naive sin segundos completa :00, no inventa hora', () => {
    expect(normalizeAttendanceTimestampForDb('2026-08-27 18:30')).toBe('2026-08-27 18:30:00');
  });

  test('separador T también es naive', () => {
    expect(normalizeAttendanceTimestampForDb('2026-08-27T18:30:15')).toBe('2026-08-27 18:30:15');
  });

  test('madrugada 00:05 permanece 00:05 (no baja de día)', () => {
    expect(normalizeAttendanceTimestampForDb('2026-08-27 00:05:00')).toBe('2026-08-27 00:05:00');
  });

  test('los segundos se preservan', () => {
    expect(normalizeAttendanceTimestampForDb('2026-08-27 23:59:59')).toBe('2026-08-27 23:59:59');
  });
});

describe('el naive NO depende de la zona del proceso', () => {
  const original = process.env.TZ;
  afterEach(() => { process.env.TZ = original; });

  for (const tz of ['UTC', 'America/Asuncion', 'Asia/Tokyo']) {
    test(`TZ=${tz} da el mismo wall-clock`, () => {
      process.env.TZ = tz;
      expect(normalizeAttendanceTimestampForDb('2026-01-15 00:05:00')).toBe('2026-01-15 00:05:00');
      expect(normalizeAttendanceTimestampForDb('2026-08-27 18:30:15')).toBe('2026-08-27 18:30:15');
    });
  }
});

describe('instante real se convierte a hora de pared', () => {
  test('ISO con Z se convierte al offset de la institución (-03:00)', () => {
    // 21:30:15Z en UTC-3 es 18:30:15 de pared.
    expect(normalizeAttendanceTimestampForDb('2026-08-27T21:30:15Z')).toBe('2026-08-27 18:30:15');
  });

  test('ISO Z que cruza medianoche baja de día correctamente', () => {
    // 02:05Z en UTC-3 es 23:05 del día ANTERIOR.
    expect(normalizeAttendanceTimestampForDb('2026-08-27T02:05:00Z')).toBe('2026-08-26 23:05:00');
  });

  test('un Date (instante) se trata como instante, no naive', () => {
    const d = new Date('2026-08-27T21:30:15Z');
    expect(normalizeAttendanceTimestampForDb(d)).toBe('2026-08-27 18:30:15');
  });

  test('offset explícito distinto de UTC también se convierte', () => {
    // 18:30:15+00:00 → 15:30:15 en UTC-3.
    expect(normalizeAttendanceTimestampForDb('2026-08-27T18:30:15+00:00')).toBe('2026-08-27 15:30:15');
  });

  test('un instante HISTÓRICO usa la tzdata de la fecha (Paraguay UTC-4 antes de 2024-10-06)', () => {
    // 2024-07-01T12:00:00Z: Asunción estaba en UTC-4 → 08:00, no 09:00.
    expect(normalizeAttendanceTimestampForDb('2024-07-01T12:00:00Z')).toBe('2024-07-01 08:00:00');
  });

  test('un instante posterior al cambio usa UTC-3', () => {
    // 2025-01-15T12:00:00Z: ya en UTC-3 → 09:00.
    expect(normalizeAttendanceTimestampForDb('2025-01-15T12:00:00Z')).toBe('2025-01-15 09:00:00');
  });
});

describe('entradas inválidas se rechazan (no se inventa hora)', () => {
  test('vacío lanza', () => {
    expect(() => normalizeAttendanceTimestampForDb('')).toThrow();
    expect(() => normalizeAttendanceTimestampForDb(null)).toThrow();
  });

  test('un Date inválido lanza', () => {
    expect(() => normalizeAttendanceTimestampForDb(new Date('nope'))).toThrow();
  });
});

describe('validación estricta de naive por componentes (no se delega en MySQL)', () => {
  test('29 de febrero en año bisiesto es válido y se preserva', () => {
    expect(normalizeAttendanceTimestampForDb('2024-02-29 00:05:07')).toBe('2024-02-29 00:05:07');
  });

  test('29 de febrero en año NO bisiesto se rechaza', () => {
    expect(() => normalizeAttendanceTimestampForDb('2023-02-29 08:00:00')).toThrow();
  });

  test('día 31 en un mes de 30 se rechaza', () => {
    expect(() => normalizeAttendanceTimestampForDb('2026-04-31 10:00:00')).toThrow();
  });

  test('día 30 de febrero se rechaza', () => {
    expect(() => normalizeAttendanceTimestampForDb('2026-02-30 08:00:00')).toThrow();
  });

  test('mes 13 se rechaza', () => {
    expect(() => normalizeAttendanceTimestampForDb('2026-13-01 08:00:00')).toThrow();
  });

  test('hora 24 se rechaza', () => {
    expect(() => normalizeAttendanceTimestampForDb('2026-01-01 24:15:00')).toThrow();
  });

  test('minuto 60 se rechaza', () => {
    expect(() => normalizeAttendanceTimestampForDb('2026-01-01 08:60:00')).toThrow();
  });

  test('segundo 60 se rechaza', () => {
    expect(() => normalizeAttendanceTimestampForDb('2026-01-01 08:00:60')).toThrow();
  });

  const original = process.env.TZ;
  afterEach(() => { process.env.TZ = original; });
  for (const tz of ['UTC', 'America/Asuncion', 'Asia/Tokyo']) {
    test(`TZ=${tz}: un naive válido produce exactamente el mismo string`, () => {
      process.env.TZ = tz;
      expect(normalizeAttendanceTimestampForDb('2024-02-29 00:05:07')).toBe('2024-02-29 00:05:07');
      expect(normalizeAttendanceTimestampForDb('2026-08-27 18:30:15')).toBe('2026-08-27 18:30:15');
    });
  }
});

describe('wallClockToInstitutionInstant — wall-clock → instante correcto', () => {
  test('18:30 wall-clock de Asunción → ISO del instante (21:30Z, UTC-3)', () => {
    expect(wallClockToInstitutionInstant('2026-08-27 18:30:15').toISOString())
      .toBe('2026-08-27T21:30:15.000Z');
  });

  test('fecha histórica pre-cambio usa la tzdata real (UTC-4 antes de 2024-10-06)', () => {
    // 12:00 wall-clock de Asunción en UTC-4 → 16:00Z.
    expect(wallClockToInstitutionInstant('2024-07-01 12:00:00').toISOString())
      .toBe('2024-07-01T16:00:00.000Z');
  });

  const original = process.env.TZ;
  afterEach(() => { process.env.TZ = original; });
  for (const tz of ['UTC', 'America/Asuncion', 'Asia/Tokyo']) {
    test(`TZ=${tz}: el instante emitido es el mismo (no depende del proceso)`, () => {
      process.env.TZ = tz;
      expect(wallClockToInstitutionInstant('2026-08-27 18:30:15').toISOString())
        .toBe('2026-08-27T21:30:15.000Z');
    });
  }

  test('un naive DB no cambia según la TZ del proceso (round-trip con normalize)', () => {
    // normalize preserva el wall-clock; el instante que representa es estable.
    const wall = normalizeAttendanceTimestampForDb('2026-08-27 18:30:15');
    expect(wallClockToInstitutionInstant(wall).toISOString()).toBe('2026-08-27T21:30:15.000Z');
  });
});

describe('attendanceDisplayInstant — el instante inequívoco se conserva', () => {
  test('un input naive se invierte como hora de Asunción', () => {
    const wall = normalizeAttendanceTimestampForDb('2026-08-27 18:30:15');
    expect(attendanceDisplayInstant('2026-08-27 18:30:15', wall).toISOString())
      .toBe('2026-08-27T21:30:15.000Z');
  });

  test('un ISO con Z en la HORA REPETIDA conserva su instante original (no lo corre)', () => {
    // 2024-03-24T03:30:00Z persiste como wall 2024-03-23 23:30:00 (hora repetida
    // del cambio histórico). Reinvertir el wall elegiría la ocurrencia equivocada;
    // el instante original es inequívoco y se conserva.
    const src = '2024-03-24T03:30:00Z';
    const wall = normalizeAttendanceTimestampForDb(src);
    expect(wall).toBe('2024-03-23 23:30:00');
    expect(attendanceDisplayInstant(src, wall).toISOString()).toBe('2024-03-24T03:30:00.000Z');
  });

  test('un Date se conserva como instante original', () => {
    const d = new Date('2024-03-24T03:30:00Z');
    const wall = normalizeAttendanceTimestampForDb(d);
    expect(attendanceDisplayInstant(d, wall).toISOString()).toBe('2024-03-24T03:30:00.000Z');
  });

  const original = process.env.TZ;
  afterEach(() => { process.env.TZ = original; });
  for (const tz of ['UTC', 'America/Asuncion', 'Asia/Tokyo']) {
    test(`TZ=${tz}: naive e ISO-Z dan el mismo instante en cualquier proceso`, () => {
      process.env.TZ = tz;
      expect(attendanceDisplayInstant('2026-08-27 18:30:15', '2026-08-27 18:30:15').toISOString())
        .toBe('2026-08-27T21:30:15.000Z');
      expect(attendanceDisplayInstant('2026-08-27T21:30:15Z', '2026-08-27 18:30:15').toISOString())
        .toBe('2026-08-27T21:30:15.000Z');
    });
  }
});
