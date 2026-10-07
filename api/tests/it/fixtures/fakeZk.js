'use strict';

/**
 * fakeZk.js — reloj ZKTeco SIMULADO para pruebas de integración.
 *
 * Reemplaza ÚNICAMENTE la comunicación con el reloj (`node-zklib`): no abre
 * sockets ni toca la red. Devuelve las marcaciones SINTÉTICAS del archivo JSON
 * indicado en FAKE_ZK_RECORDS ([{ deviceUserId, recordTime: ISO-8601 }]), con
 * `recordTime` como Date, igual que node-zklib. Todo lo demás (API, cola en
 * MySQL, worker, lector, staging e importación) es código real.
 *
 * Uso:
 *   - en jest:      jest.mock('node-zklib', () => require('./fixtures/fakeZk').FakeZK)
 *   - en el worker: node -r tests/it/fixtures/fakeZkPreload.js src/workers/syncWorker.js
 */
const fs = require('fs');
const Module = require('module');

function loadRecords() {
  const file = process.env.FAKE_ZK_RECORDS;
  if (!file) throw new Error('FAKE_ZK_RECORDS no definido: el reloj simulado no tiene marcaciones');
  return JSON.parse(fs.readFileSync(file, 'utf8'))
    .map((r) => ({ deviceUserId: String(r.deviceUserId), recordTime: new Date(r.recordTime) }));
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

module.exports = { FakeZK, loadRecords, install };
