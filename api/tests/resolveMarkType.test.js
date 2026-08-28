/**
 * resolveMarkType.test.js — Inferencia de in/out por CONTEXTO de jornada.
 *
 * La regla vieja contaba marcas por DATE(timestamp) y alternaba por paridad, lo
 * que se reinicia a medianoche y rompe los turnos nocturnos. Acá se verifica que
 * la resolución mira la SECUENCIA real, sin reset diario, y que NO inventa in/out
 * sin evidencia: cuando el contexto no alcanza o es ambiguo devuelve 'unknown'.
 */

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() }, DB_TIMEZONE: '-03:00' }));
jest.mock('../src/config/logger', () => ({ info() {}, warn() {}, error() {} }));
jest.mock('../src/socket/socketServer', () => ({ getIO: () => ({ to: () => ({ emit() {} }), emit() {} }), emitAttendance() {} }));

const { sequelize } = require('../src/config/database');
const { resolveMarkType } = require('../src/controllers/attendanceController');

/** Marcas previas que devolverá la lectura de la ventana. */
function conPrevias(rows) {
  sequelize.query.mockReset();
  sequelize.query.mockImplementation(async (sql) => {
    if (/FROM attendance_logs/i.test(sql)) return [rows];
    return [[]];
  });
}

describe('resolveMarkType — sin reset por día civil', () => {
  test('21:00 IN y una marca a las 00:30 del día siguiente → SALIDA (sesión abierta)', async () => {
    conPrevias([{ timestamp: '2025-06-10 21:00:00', type: 'in' }]);
    expect(await resolveMarkType(1, '2025-06-11 00:30:00')).toBe('out');
  });

  test('la paridad NO se reinicia a medianoche: un OUT de madrugada no se infiere IN', async () => {
    // Previas del turno nocturno; la marca de madrugada cierra, no abre.
    conPrevias([{ timestamp: '2025-06-10 21:32:00', type: 'in' }]);
    expect(await resolveMarkType(1, '2025-06-11 05:29:00')).toBe('out');
  });

  test('IN + IN duplicado: la siguiente marca es SALIDA, no se invierte la secuencia', async () => {
    conPrevias([
      { timestamp: '2025-06-10 08:00:00', type: 'in' },
      { timestamp: '2025-06-10 08:00:30', type: 'in' },
    ]);
    expect(await resolveMarkType(1, '2025-06-10 17:00:00')).toBe('out');
  });

  test('sin marcas previas → UNKNOWN (no se inventa una entrada sin evidencia)', async () => {
    conPrevias([]);
    expect(await resolveMarkType(1, '2025-06-10 08:00:00')).toBe('unknown');
  });

  test('historial previo SÓLO unknown → UNKNOWN (no hay estado de sesión)', async () => {
    conPrevias([
      { timestamp: '2025-06-10 08:00:00', type: 'unknown' },
      { timestamp: '2025-06-10 12:00:00', type: 'unknown' },
    ]);
    expect(await resolveMarkType(1, '2025-06-10 17:00:00')).toBe('unknown');
  });

  test('última explícita SALIDA, nueva claramente posterior → ENTRADA', async () => {
    conPrevias([
      { timestamp: '2025-06-10 08:00:00', type: 'in' },
      { timestamp: '2025-06-10 12:00:00', type: 'out' },
    ]);
    expect(await resolveMarkType(1, '2025-06-10 13:00:00')).toBe('in');
  });

  test('secuencia ambigua: una entrada vieja cuya sesión ya cerró por el hueco → UNKNOWN', async () => {
    // IN de hace 30 h: esa jornada ya cerró. No se puede afirmar si esta marca es
    // la salida tardía que faltó o una entrada nueva → ambiguo → unknown.
    conPrevias([{ timestamp: '2025-06-09 06:00:00', type: 'in' }]);
    expect(await resolveMarkType(1, '2025-06-10 12:00:00')).toBe('unknown');
  });

  test('duplicado UNKNOWN inmediatamente después de un IN → conserva in (no crea OUT falso)', async () => {
    conPrevias([{ timestamp: '2025-06-10 08:00:00', type: 'in' }]);
    expect(await resolveMarkType(1, '2025-06-10 08:00:20')).toBe('in');
  });

  test('ráfaga del reloj: una marca unknown dentro de la ventana de dedupe conserva el tipo', async () => {
    // 08:00:00 in + 08:00:30 (unknown): la segunda es una repetición del reloj y
    // conserva 'in'. Si se alternara a 'out', el dedupe nuevo (que no colapsa
    // tipos opuestos) dejaría un tramo de 30 s y rompería la jornada.
    conPrevias([{ timestamp: '2025-06-10 08:00:00', type: 'in' }]);
    expect(await resolveMarkType(1, '2025-06-10 08:00:30')).toBe('in');
  });

  test('tras la ráfaga, la salida real de la tarde se infiere SALIDA', async () => {
    conPrevias([
      { timestamp: '2025-06-10 08:00:00', type: 'in' },
      { timestamp: '2025-06-10 08:00:30', type: 'in' }, // duplicado ya guardado como in
    ]);
    expect(await resolveMarkType(1, '2025-06-10 17:00:00')).toBe('out');
  });
});
