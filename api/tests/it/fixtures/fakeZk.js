'use strict';

/**
 * fakeZk.js — reloj ZKTeco SIMULADO para pruebas de integración.
 *
 * Reemplaza ÚNICAMENTE la comunicación con el reloj (`node-zklib`): no abre
 * sockets ni toca la red. Cada marcación SINTÉTICA del archivo JSON indicado en
 * FAKE_ZK_RECORDS ([{ deviceUserId, wall: 'YYYY-MM-DD HH:MM:SS', userSn?,
 * inOutStatus? }]) se EMPAQUETA como lo guarda el reloj (registro de 40 bytes
 * con la hora de pared en un uint32, sin zona) y se DECODIFICA con el
 * decodificador REAL de node-zklib (`decodeRecordData40`, camino TCP). Así el
 * `recordTime` que recibe el lector es exactamente el que produciría el
 * reloj en el proceso y la zona en que corre la prueba.
 *
 * `inOutStatus` (opcional) se agrega DESPUÉS de decodificar: el registro de 40
 * bytes no trae el estado entrada/salida; algunos firmwares lo informan aparte.
 *
 * Uso:
 *   - en jest:      jest.mock('node-zklib', () => require('./fixtures/fakeZk').FakeZK)
 *   - en el worker: node -r tests/it/fixtures/fakeZkPreload.js src/workers/syncWorker.js
 */
const fs = require('fs');
const Module = require('module');
const { decodeRecordData40 } = require('node-zklib/utils');

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** Hora de pared → uint32 de ZKTeco (inversa exacta de parseTimeToDate de node-zklib). */
function packZkTime(wall) {
  const m = WALL_RE.exec(wall);
  if (!m) throw new Error(`hora de pared inválida para el reloj simulado: ${wall}`);
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return ((((((y - 2000) * 12 + (mo - 1)) * 31 + (d - 1)) * 24 + h) * 60 + mi) * 60 + s);
}

/** Registro de asistencia de 40 bytes, como lo transmite el reloj por TCP. */
function encodeRecord40({ deviceUserId, wall, userSn = 1 }) {
  const id = String(deviceUserId);
  if (id.length > 9) throw new Error(`deviceUserId de más de 9 caracteres: ${id}`);
  const b = Buffer.alloc(40);
  b.writeUIntLE(userSn, 0, 2);
  b.write(id, 2, 9, 'ascii');
  b.writeUInt32LE(packZkTime(wall), 27);
  return b;
}

function loadRecords() {
  const file = process.env.FAKE_ZK_RECORDS;
  if (!file) throw new Error('FAKE_ZK_RECORDS no definido: el reloj simulado no tiene marcaciones');
  return JSON.parse(fs.readFileSync(file, 'utf8')).map((r) => {
    const rec = decodeRecordData40(encodeRecord40(r));
    if (r.inOutStatus !== undefined) rec.inOutStatus = r.inOutStatus;
    return rec;
  });
}

class FakeZK {
  constructor(ip, port) { this.ip = ip; this.port = port; }
  async createSocket() {}
  async connect() {}
  async getAttendances() { return { data: loadRecords(), err: null }; }
  async disconnect() {}
}

const ZKLIB_IDS = new Set(['node-zklib', 'node-zklib/zklibtcp', 'node-zklib/zklibudp']);

function install() {
  const original = Module._load;
  Module._load = function fakeZkLoad(request, ...rest) {
    if (ZKLIB_IDS.has(request)) return FakeZK;
    return original.call(this, request, ...rest);
  };
}

module.exports = { FakeZK, loadRecords, install, packZkTime, encodeRecord40 };
