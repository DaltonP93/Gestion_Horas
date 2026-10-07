'use strict';

/**
 * fakeZkTcpServer.js — reloj ZKTeco SIMULADO a nivel de red (TCP real).
 *
 * A diferencia de fakeZk.js (que sustituye `readWithBuffer` dentro del
 * proceso), acá el cliente es node-zklib COMPLETO: abre un socket TCP de
 * verdad, envía los comandos del protocolo y recibe las tramas que arma este
 * servidor con `createTCPHeader` de node-zklib. Los registros son los BYTES
 * del formato de 40 bytes (encodeRecord40 de fakeZk.js), así que corren los
 * decodificadores reales sin ninguna sustitución.
 *
 * Sirve para observar desde el lado del reloj lo que una prueba en proceso no
 * puede ver: qué comandos llegan, cuántas conexiones se abren y CUÁNDO se
 * cierran (p. ej. si una conexión sobrevive a la liberación del lock).
 *
 * Escenarios por conexión (`scenarios[i]`, el último se repite):
 *   'ok'        responde todo; el buffer va en una trama CMD_DATA si entra,
 *               o por bloques (CMD_PREPARE_DATA + CMD_DATA_RDY) si no.
 *   'chunked'   fuerza la entrega por bloques.
 *   'truncate'  por bloques; corta el socket tras entregar el primer bloque.
 *   'hang'      contesta CMD_CONNECT y después no responde nada más.
 *   'silent'    acepta la conexión y no contesta nada.
 */
const net = require('net');

const realRequire = (p) => (typeof jest !== 'undefined' && jest.requireActual ? jest.requireActual(p) : require(p));
const { COMMANDS, MAX_CHUNK } = realRequire('node-zklib/constants');
const { createTCPHeader } = realRequire('node-zklib/utils');
const { encodeRecord40 } = require('./fakeZk');

const NAMES = Object.fromEntries(Object.entries(COMMANDS).map(([k, v]) => [v, k]));
const PREFIX = Buffer.from([0x50, 0x50, 0x82, 0x7d]);
const SESSION_ID = 4321;
const FRAME_GAP_MS = 40;

/** Buffer que el reloj entrega para GET_ATTENDANCE_LOGS: uint32 tamaño + registros de 40 bytes. */
function attendanceBuffer(records) {
  const body = Buffer.concat(records.map(encodeRecord40));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length, 0);
  return Buffer.concat([size, body]);
}

async function startFakeZkTcp({ records = [], scenarios = ['ok'], host = '127.0.0.1' } = {}) {
  const payload = attendanceBuffer(records);
  const connections = [];
  const sockets = new Set();
  const closeWaiters = [];

  const server = net.createServer((socket) => {
    const idx = connections.length;
    const scenario = scenarios[Math.min(idx, scenarios.length - 1)];
    const info = { idx, scenario, openedAt: Date.now(), closedAt: null, commands: [] };
    connections.push(info);
    sockets.add(socket);
    let pending = Buffer.alloc(0);
    let chunksSent = 0;
    let chain = Promise.resolve();

    const send = (cmd, data = Buffer.alloc(0)) => {
      if (!socket.destroyed) socket.write(createTCPHeader(cmd, SESSION_ID, 0, data));
    };
    // Las tramas grandes se espacian: node-zklib procesa una trama por evento
    // 'data' en la recepción por bloques.
    const later = (fn) => { chain = chain.then(() => new Promise((r) => setTimeout(() => { fn(); r(); }, FRAME_GAP_MS))); };

    const handle = (cmd, data) => {
      info.commands.push(NAMES[cmd] || String(cmd));
      if (scenario === 'silent') return;
      if (cmd === COMMANDS.CMD_CONNECT) { send(COMMANDS.CMD_ACK_OK); return; }
      if (scenario === 'hang') return;
      switch (cmd) {
        case COMMANDS.CMD_FREE_DATA:
        case COMMANDS.CMD_EXIT:
          send(COMMANDS.CMD_ACK_OK);
          return;
        case COMMANDS.CMD_DATA_WRRQ: {
          const chunked = scenario !== 'ok' || payload.length > 60000;
          if (!chunked) { send(COMMANDS.CMD_DATA, payload); return; }
          const prep = Buffer.alloc(9);
          prep.writeUInt32LE(payload.length, 1);
          send(COMMANDS.CMD_PREPARE_DATA, prep);
          return;
        }
        case COMMANDS.CMD_DATA_RDY: {
          const start = data.readUInt32LE(0);
          const size = data.readUInt32LE(4);
          later(() => {
            if (scenario === 'truncate' && chunksSent >= 1) return;
            send(COMMANDS.CMD_DATA, Buffer.concat([Buffer.alloc(8), payload.subarray(start, start + size)]));
            chunksSent += 1;
            if (scenario === 'truncate') later(() => socket.destroy());
          });
          return;
        }
        default:
          // Comando inesperado: se registra y se responde OK para no ocultarlo
          // detrás de un cuelgue; las pruebas verifican la lista de comandos.
          send(COMMANDS.CMD_ACK_OK);
      }
    };

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8 && pending.compare(PREFIX, 0, 4, 0, 4) === 0) {
        const len = pending.readUInt16LE(4);
        if (pending.length < 8 + len) break;
        const frame = pending.subarray(8, 8 + len);
        pending = pending.subarray(8 + len);
        handle(frame.readUInt16LE(0), frame.subarray(8));
      }
    });
    socket.on('error', () => {});
    socket.on('end', () => socket.end());
    socket.on('close', () => {
      info.closedAt = Date.now();
      sockets.delete(socket);
      for (const w of closeWaiters.splice(0)) w();
    });
  });

  await new Promise((resolve) => server.listen(0, host, resolve));

  return {
    host,
    port: server.address().port,
    connections,
    openCount: () => sockets.size,
    commands: () => connections.flatMap((c) => c.commands),
    /** Espera hasta que haya al menos `n` conexiones abiertas en total. */
    async waitForConnections(n, timeoutMs = 10000) {
      const t0 = Date.now();
      while (connections.length < n) {
        if (Date.now() - t0 > timeoutMs) throw new Error(`el reloj simulado no recibió ${n} conexiones`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    /** Espera hasta que no quede ninguna conexión abierta. */
    async waitAllClosed(timeoutMs = 10000) {
      const t0 = Date.now();
      while (sockets.size > 0) {
        if (Date.now() - t0 > timeoutMs) return false;
        await new Promise((r) => { closeWaiters.push(r); setTimeout(r, 50); });
      }
      return true;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

module.exports = { startFakeZkTcp, attendanceBuffer, SESSION_ID, MAX_CHUNK };
