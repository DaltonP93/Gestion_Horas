// Hora de pared de una marca del reloj, independiente de la zona del proceso
// (CI corre esta suite en UTC, America/Asuncion y Asia/Tokyo). Usa el
// decodificador REAL de node-zklib sobre un registro de 40 bytes.
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
const { decodeRecordData40 } = require('node-zklib/utils');
const { normalizeRecord, wallClockOf } = require('../src/services/zktecoReader');
const { encodeRecord40 } = require('./it/fixtures/fakeZk');

const decoded = (wall) => decodeRecordData40(encodeRecord40({ deviceUserId: '901', wall }));

describe(`zktecoReader.wallClockOf (TZ del proceso=${process.env.TZ || 'sin definir'})`, () => {
  test.each(['2026-10-05 00:00:00', '2026-10-05 08:12:00', '2026-10-05 23:59:59', '2026-12-31 23:59:59', '2027-01-01 00:00:00'])(
    'la hora decodificada por node-zklib vuelve a ser %s', (wall) => {
      const rec = decoded(wall);
      expect(wallClockOf(rec.recordTime)).toBe(wall);
      expect(normalizeRecord(rec)).toMatchObject({ wall, userId: '901' });
    });

  test('texto sin zona: es hora de pared, se conserva', () => {
    expect(wallClockOf('2026-10-05 08:12:00')).toBe('2026-10-05 08:12:00');
  });

  test('instante explícito (Z u offset, epoch): hora de pared de Paraguay', () => {
    expect(wallClockOf('2026-10-05T11:12:00Z')).toBe('2026-10-05 08:12:00');
    expect(wallClockOf('2026-10-05T08:12:00-03:00')).toBe('2026-10-05 08:12:00');
    expect(wallClockOf(Date.parse('2026-10-05T11:12:00Z'))).toBe('2026-10-05 08:12:00');
    expect(wallClockOf(Date.parse('2026-10-05T11:12:00Z') / 1000)).toBe('2026-10-05 08:12:00');
  });

  test('sin hora interpretable → null', () => {
    expect(wallClockOf(null)).toBeNull();
    expect(wallClockOf('no-es-fecha')).toBeNull();
  });
});
