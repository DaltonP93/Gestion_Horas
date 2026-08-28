/**
 * attendanceTime.test.js — La primitiva wall-clock de INSERT.
 *
 * Garantiza el invariante: una marca naive del dispositivo se persiste con sus
 * componentes exactos, sin depender de la zona del proceso; un instante real se
 * convierte intencionalmente a la hora de pared de la institución.
 */

jest.mock('../src/config/database', () => ({ DB_TIMEZONE: '-03:00' }));

const { normalizeAttendanceTimestampForDb } = require('../src/utils/attendanceTime');

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
