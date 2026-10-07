// Qué entrega node-zklib (v1.3.0) de un registro de asistencia del reloj.
//
// Disposición de los registros según pyzk (implementación de referencia del
// protocolo, zk/base.py → get_attendance; ver docs/design/horas-marcas-sin-tipo.md):
//   40 bytes (TCP): uid H · user_id 24s · status B (26) · timestamp 4s (27) · punch B (31) · 8s
//   16 bytes (UDP): user_id I · timestamp 4s (4) · status B (8) · punch B (9) · 2s · workcode I
//    8 bytes (UDP): uid H · status B (2) · timestamp 4s (3) · punch B (7)
// `punch` es el estado de marcación (0 entrada, 1 salida, 2/3 descanso, 4/5 extra).
const { decodeRecordData40, decodeRecordData16 } = require('node-zklib/utils');
const { packZkTime } = require('./it/fixtures/fakeZk');

const WALL = '2026-10-05 17:00:00';
const pad = (n) => String(n).padStart(2, '0');
const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

describe('node-zklib: el registro trae el estado de marcación, la librería no lo expone', () => {
  test('TCP 40 bytes: byte 31 (punch) y 26 (status) se descartan; usuario y hora sí', () => {
    const b = Buffer.alloc(40);
    b.writeUInt16LE(7, 0);
    b.write('12345', 2, 24, 'ascii');
    b.writeUInt8(1, 26);                 // status (modo de verificación)
    b.writeUInt32LE(packZkTime(WALL), 27);
    b.writeUInt8(1, 31);                 // punch = 1 (salida)
    const rec = decodeRecordData40(b);
    expect(Object.keys(rec).sort()).toEqual(['deviceUserId', 'recordTime', 'userSn']);
    expect(rec).toMatchObject({ userSn: 7, deviceUserId: '12345' });
    expect(local(rec.recordTime)).toBe(WALL);
    // El dato existe en el buffer recibido aunque la librería no lo devuelva.
    expect(b.readUInt8(31)).toBe(1);
  });

  test('TCP 40 bytes: el id de usuario se corta en 9 caracteres (el campo tiene 24)', () => {
    const b = Buffer.alloc(40);
    b.write('1234567890AB', 2, 24, 'ascii');
    b.writeUInt32LE(packZkTime(WALL), 27);
    expect(decodeRecordData40(b).deviceUserId).toBe('123456789');
  });

  test('UDP 16 bytes: bytes 8 (status) y 9 (punch) se descartan; el id se lee con 2 de 4 bytes', () => {
    const b = Buffer.alloc(16);
    b.writeUInt32LE(70000, 0);           // user_id de 4 bytes
    b.writeUInt32LE(packZkTime(WALL), 4);
    b.writeUInt8(1, 8);
    b.writeUInt8(1, 9);                  // punch = 1 (salida)
    const rec = decodeRecordData16(b);
    expect(Object.keys(rec).sort()).toEqual(['deviceUserId', 'recordTime']);
    expect(local(rec.recordTime)).toBe(WALL);
    expect(rec.deviceUserId).toBe(70000 % 65536);
  });

  test('UDP 8 bytes: node-zklib usa el decodificador de 16 y lee la hora corrida un byte', () => {
    const b = Buffer.alloc(8);
    b.writeUInt16LE(7, 0);
    b.writeUInt8(1, 2);
    b.writeUInt32LE(packZkTime(WALL), 3); // hora en el byte 3 según el formato de 8 bytes
    b.writeUInt8(1, 7);
    const rec = decodeRecordData16(b);    // zklibudp.js usa este decodificador también para 8 bytes
    expect(local(rec.recordTime)).not.toBe(WALL);
  });
});
