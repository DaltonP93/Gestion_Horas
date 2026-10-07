'use strict';

/**
 * fakeZk.js — reloj ZKTeco SIMULADO para pruebas.
 *
 * Reemplaza ÚNICAMENTE el transporte con el reloj: no abre sockets ni toca la
 * red. Cada marcación SINTÉTICA del archivo JSON indicado en FAKE_ZK_RECORDS
 * se EMPAQUETA en los bytes del formato que transmite el reloj y se entrega a
 * las clases REALES de node-zklib (`ZKLibTCP`/`ZKLibUDP`), cuyo `getAttendances`
 * y decodificadores corren sin cambios. Sólo se sustituye `readWithBuffer` (lo
 * que el socket devolvería ya reensamblado: 4 bytes de tamaño + registros).
 *
 * Marcación: { deviceUserId, wall: 'YYYY-MM-DD HH:MM:SS', userSn?, punchByte?,
 * verifyByte?, inOutStatus? }. `punchByte`/`verifyByte` son los BYTES del
 * registro (estado de marcación y modo de verificación); si la fixture no los
 * indica quedan en 0, como en un buffer vacío.
 * `inOutStatus` (opcional) se agrega DESPUÉS de decodificar: node-zklib no lo
 * entrega; lo usan sólo las fixtures que necesitan un tipo explícito.
 *
 * FAKE_ZK_TRANSPORT elige el formato: 'tcp40' (por defecto), 'udp16', 'udp8'.
 *
 * Las clases reales se cargan RECIÉN al leer (como `openZK`, que carga
 * node-zklib al conectar). FAKE_ZK_PRELOAD_ZKLIB=1 las carga en la precarga,
 * ANTES que la aplicación: sirve para probar qué pasa si la captura de bytes
 * llega tarde (orden de carga).
 *
 * Uso:
 *   - en jest:      jest.mock('node-zklib', () => require('./fixtures/fakeZk').FakeZK)
 *   - en el worker: node -r tests/it/fixtures/fakeZkPreload.js src/workers/syncWorker.js
 */
const fs = require('fs');
const Module = require('module');

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const TCP_PATH = require.resolve('node-zklib/zklibtcp');
const UDP_PATH = require.resolve('node-zklib/zklibudp');
// Dentro de jest las IT mockean 'node-zklib/zklibtcp|udp' (resuelto por ruta):
// para usar las clases REALES hay que pedirlas con requireActual.
// eslint-disable-next-line no-undef
const realRequire = (p) => (typeof jest !== 'undefined' && jest.requireActual ? jest.requireActual(p) : require(p));

/** Hora de pared → uint32 de ZKTeco (inversa exacta de parseTimeToDate de node-zklib). */
function packZkTime(wall) {
  const m = WALL_RE.exec(wall);
  if (!m) throw new Error(`hora de pared inválida para el reloj simulado: ${wall}`);
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return ((((((y - 2000) * 12 + (mo - 1)) * 31 + (d - 1)) * 24 + h) * 60 + mi) * 60 + s);
}

// Disposición de los registros según pyzk (zk/base.py → get_attendance).
/** TCP, 40 bytes: uid H · user_id 24s · status B (26) · timestamp (27) · punch B (31) · 8 reservados. */
function encodeRecord40({ deviceUserId, wall, userSn = 1, punchByte = 0, verifyByte = 0 }) {
  const id = String(deviceUserId);
  if (id.length > 9) throw new Error(`deviceUserId de más de 9 caracteres: ${id}`);
  const b = Buffer.alloc(40);
  b.writeUIntLE(userSn, 0, 2);
  b.write(id, 2, 24, 'ascii');
  b.writeUInt8(verifyByte, 26);
  b.writeUInt32LE(packZkTime(wall), 27);
  b.writeUInt8(punchByte, 31);
  return b;
}
/** UDP, 16 bytes: user_id I · timestamp (4) · status B (8) · punch B (9) · 2 reservados · workcode I. */
function encodeRecord16({ deviceUserId, wall, punchByte = 0, verifyByte = 0 }) {
  const id = Number(deviceUserId);
  if (!Number.isInteger(id) || id < 0 || id > 65535) throw new Error(`UDP: deviceUserId debe ser entero ≤ 65535: ${deviceUserId}`);
  const b = Buffer.alloc(16);
  b.writeUInt32LE(id, 0);
  b.writeUInt32LE(packZkTime(wall), 4);
  b.writeUInt8(verifyByte, 8);
  b.writeUInt8(punchByte, 9);
  return b;
}
/** UDP, 8 bytes: uid H · status B (2) · timestamp (3) · punch B (7). */
function encodeRecord8({ deviceUserId, wall, punchByte = 0, verifyByte = 0 }) {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(Number(deviceUserId) & 0xffff, 0);
  b.writeUInt8(verifyByte, 2);
  b.writeUInt32LE(packZkTime(wall), 3);
  b.writeUInt8(punchByte, 7);
  return b;
}
const ENCODERS = { tcp40: encodeRecord40, udp16: encodeRecord16, udp8: encodeRecord8 };

/** Respuesta reensamblada de GET_ATTENDANCE_LOGS: uint32 tamaño + registros. */
function attendancePayload(records, transport) {
  const encode = ENCODERS[transport];
  if (!encode) throw new Error(`FAKE_ZK_TRANSPORT desconocido: ${transport}`);
  const body = Buffer.concat(records.map(encode));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length, 0);
  return Buffer.concat([size, body]);
}

/**
 * Lee con la clase REAL de node-zklib del formato pedido, sustituyendo sólo el
 * transporte. `socket` queda en null: getAttendances no llama a freeData.
 */
async function readThroughNodeZklib(records, transport, ip = '192.0.2.1') {
  const data = attendancePayload(records, transport);
  const Cls = realRequire(transport === 'tcp40' ? TCP_PATH : UDP_PATH);
  const zk = new Cls(ip, 4370, 1000);
  zk.readWithBuffer = async () => (transport === 'udp8' ? { data, mode: 8, err: null } : { data, err: null });
  return zk.getAttendances();
}

function loadRecordFile() {
  const file = process.env.FAKE_ZK_RECORDS;
  if (!file) throw new Error('FAKE_ZK_RECORDS no definido: el reloj simulado no tiene marcaciones');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

class FakeZK {
  constructor(ip, port) { this.ip = ip; this.port = port; }
  async createSocket() {}
  async connect() {}
  async getAttendances() {
    const records = loadRecordFile();
    const res = await readThroughNodeZklib(records, process.env.FAKE_ZK_TRANSPORT || 'tcp40', this.ip);
    res.data.forEach((rec, i) => {
      if (records[i].inOutStatus !== undefined) rec.inOutStatus = records[i].inOutStatus;
    });
    return res;
  }
  async disconnect() {}
}

const ZKLIB_IDS = new Set(['node-zklib', 'node-zklib/zklibtcp', 'node-zklib/zklibudp']);

function install() {
  const original = Module._load;
  Module._load = function fakeZkLoad(request, ...rest) {
    if (ZKLIB_IDS.has(request)) return FakeZK;
    return original.call(this, request, ...rest);
  };
  if (process.env.FAKE_ZK_PRELOAD_ZKLIB === '1') { require(TCP_PATH); require(UDP_PATH); }
}

module.exports = {
  FakeZK, install, packZkTime, encodeRecord40, encodeRecord16, encodeRecord8,
  attendancePayload, readThroughNodeZklib, TCP_PATH, UDP_PATH,
};
