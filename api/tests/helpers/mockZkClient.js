'use strict';

/**
 * mockZkClient.js — HARNESS OFFLINE de transporte ZKTeco para pruebas.
 *
 * Emula el cliente que devuelve node-zklib (ZKLib/ZKLibTCP/ZKLibUDP) SIN tocar
 * la red ni un dispositivo real. Reproduce el escenario reportado (getInfo()
 * funciona pero getAttendances() falla con TIMEOUT_ON_WRITING_MESSAGE) y otras
 * variantes de transporte: modo TCP/UDP/auto, buffer truncado y timeouts.
 *
 * Se usa como `_readOnce` (seam de prueba de readAttendancesStable /
 * backupDeviceDirect): `_readOnce: () => mock.getAttendances()`.
 */

const TS_FIELD = 'recordTime';

/** Construye un registro crudo como los que decodifica node-zklib. */
function punch(deviceUserId, isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  return { deviceUserId: String(deviceUserId), [TS_FIELD]: d };
}

/**
 * @param {object} cfg
 *  - info: objeto que devuelve getInfo() (default: reloj sano).
 *  - attendances: array de marcas (punch()) que devuelve getAttendances().
 *  - failAttendances: string → getAttendances() lanza Error con ese mensaje
 *    (p.ej. 'TIMEOUT_ON_WRITING_MESSAGE'); getInfo() sigue OK.
 *  - failInfo: string → getInfo() también falla (reloj inalcanzable).
 *  - truncated: true → getAttendances() resuelve { data, err } (buffer parcial).
 *  - mode: 'auto'|'tcp'|'udp' (sólo informativo, para aserciones del test).
 */
function makeMockZk(cfg = {}) {
  const {
    info = { userCounts: 3, logCounts: 100, serialNumber: 'MOCK123' },
    attendances = [],
    failAttendances = null,
    failInfo = null,
    truncated = false,
    mode = 'auto',
  } = cfg;

  const calls = { getInfo: 0, getAttendances: 0, disconnect: 0, createSocket: 0, connect: 0 };

  return {
    mode,
    calls,
    async createSocket() { calls.createSocket++; },
    async connect() { calls.connect++; },
    async getInfo() {
      calls.getInfo++;
      if (failInfo) throw new Error(failInfo);
      return info;
    },
    async getAttendances() {
      calls.getAttendances++;
      if (failAttendances) throw new Error(failAttendances);
      // node-zklib entrega { data, err }: `err` señala buffer incompleto.
      return truncated ? { data: attendances, err: 'TIMEOUT WHEN RECEIVING PACKET' } : { data: attendances };
    },
    async disconnect() { calls.disconnect++; },
  };
}

module.exports = { makeMockZk, punch };
