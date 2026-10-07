'use strict';

// Conservación del estado CRUDO que node-zklib descarta (byte de estado de
// marcación y de verificación), sin convertirlo en tipo. Recorrido real: las
// clases ZKLibTCP/ZKLibUDP de node-zklib con su getAttendances y sus
// decodificadores, con el transporte simulado y los bytes del formato real
// (fixtures/fakeZk.js). CI corre esta suite en UTC, America/Asuncion y Asia/Tokyo.
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));

const path = require('path');
const FIXTURE = path.join(__dirname, 'it', 'fixtures', 'fakeZk');
const RAW_KEYS = ['zkCapture', 'zkRecordFormat', 'zkPunchState', 'zkVerify', 'zkRecordLength'];

// Valores de byte deliberadamente distintos por marca, para detectar desalineos.
const RECORDS = [
  { deviceUserId: '4101', wall: '2026-10-05 08:00:00', punchByte: 1, verifyByte: 1 },
  { deviceUserId: '4101', wall: '2026-10-05 12:00:00', punchByte: 0, verifyByte: 15 },
  { deviceUserId: '4101', wall: '2026-10-05 13:00:00', punchByte: 5, verifyByte: 4 },
  { deviceUserId: '4102', wall: '2026-10-05 09:00:00', punchByte: 2, verifyByte: 1 },
  { deviceUserId: '4101', wall: '2026-10-05 17:00:00', punchByte: 255, verifyByte: 0 },
];
const DEVICE = { id: 1, name: 'reloj de prueba', connection_mode: 'tcp' };

/** Lee con el lector real (readAttendancesStable) por el camino real de node-zklib. */
async function readAll(reader, fixture, transport) {
  const out = await reader.readAttendancesStable(DEVICE, {
    _readOnce: () => fixture.readThroughNodeZklib(RECORDS, transport),
  });
  return out.logs;
}
const rawOf = (rec) => Object.fromEntries(RAW_KEYS.filter((k) => k in rec).map((k) => [k, rec[k]]));

describe('estado crudo de la marcación (captura de bytes descartados por node-zklib)', () => {
  test.each([['tcp40'], ['udp16']])('%s: cada marca conserva SUS bytes de estado y verificación, en orden', async (transport) => {
    let logs;
    let reader;
    await jest.isolateModulesAsync(async () => {
      reader = require('../src/services/zktecoReader');       // primero el lector…
      logs = await readAll(reader, require(FIXTURE), transport); // …después node-zklib (como openZK)
    });
    expect(logs).toHaveLength(RECORDS.length);
    logs.forEach((rec, i) => {
      expect({ user: String(rec.deviceUserId), wall: reader.wallClockOf(rec.recordTime), raw: rawOf(rec) }).toEqual({
        user: RECORDS[i].deviceUserId,
        wall: RECORDS[i].wall,
        raw: { zkCapture: 'ok', zkRecordFormat: transport, zkPunchState: RECORDS[i].punchByte, zkVerify: RECORDS[i].verifyByte },
      });
    });
  });

  test('udp8: se conservan los bytes 7 y 2; la hora sigue desalineada (defecto aparte, sin corregir)', async () => {
    let logs;
    let reader;
    await jest.isolateModulesAsync(async () => {
      reader = require('../src/services/zktecoReader');
      logs = await readAll(reader, require(FIXTURE), 'udp8');
    });
    logs.forEach((rec, i) => {
      expect(rawOf(rec)).toEqual({ zkCapture: 'ok', zkRecordFormat: 'udp8', zkPunchState: RECORDS[i].punchByte, zkVerify: RECORDS[i].verifyByte });
    });
    expect(logs.map((r) => reader.wallClockOf(r.recordTime))).not.toEqual(RECORDS.map((r) => r.wall));
  });

  test('los campos crudos NO son tipo: no están entre los campos que reconoce el resolvedor', async () => {
    let logs;
    let reader;
    await jest.isolateModulesAsync(async () => {
      reader = require('../src/services/zktecoReader');
      logs = await readAll(reader, require(FIXTURE), 'tcp40');
    });
    const { INOUT_FIELDS, explicitTypeFromRawJson } = require('../src/services/punchTypeResolver');
    for (const k of RAW_KEYS) expect(INOUT_FIELDS).not.toContain(k);
    for (const rec of logs) {
      expect(reader.normalizeRecord(rec).inout).toBeUndefined();
      expect(reader.explicitType(reader.normalizeRecord(rec).inout)).toBeNull();
      expect(explicitTypeFromRawJson(JSON.stringify(rec))).toBeNull();
    }
  });

  test('orden de carga: si node-zklib se cargó ANTES que el lector, la captura no ocurre y queda marcada', async () => {
    let logs;
    let reader;
    await jest.isolateModulesAsync(async () => {
      const fixture = require(FIXTURE);
      require(fixture.TCP_PATH);                              // node-zklib primero
      require(fixture.UDP_PATH);
      reader = require('../src/services/zktecoReader');
      logs = await readAll(reader, fixture, 'tcp40');
    });
    for (const rec of logs) {
      // Explícito, sin inventar valores: ni 0 ni ningún otro.
      expect(rawOf(rec)).toEqual({ zkCapture: 'no_disponible' });
    }
    expect(reader.zkRawCaptureStatus()).toMatchObject({ installed: true, loadedBefore: ['zklibtcp', 'zklibudp'] });
  });

  test('lecturas sin decodificador de node-zklib (inyectadas) quedan marcadas como no disponibles', async () => {
    let logs;
    await jest.isolateModulesAsync(async () => {
      const reader = require('../src/services/zktecoReader');
      const out = await reader.readAttendancesStable(DEVICE, {
        _readOnce: () => ({ data: [{ deviceUserId: '4101', recordTime: new Date(2026, 9, 5, 8, 0, 0) }], err: null }),
      });
      logs = out.logs;
    });
    expect(rawOf(logs[0])).toEqual({ zkCapture: 'no_disponible' });
  });

  test('longitud de registro inesperada: se indica la longitud y no se leen bytes', async () => {
    let rec;
    await jest.isolateModulesAsync(async () => {
      require('../src/services/zktecoReader');
      const utils = require('node-zklib/utils');
      const b = Buffer.alloc(12);
      b.writeUInt32LE(1, 0);
      rec = utils.decodeRecordData16(b);
    });
    expect(rawOf(rec)).toEqual({ zkCapture: 'longitud_inesperada', zkRecordLength: 12 });
  });
});
