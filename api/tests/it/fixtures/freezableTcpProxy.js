'use strict';

/**
 * freezableTcpProxy.js — proxy TCP que puede CONGELARSE (dejar de reenviar sin
 * cerrar), para reproducir operaciones de MySQL o Redis que quedan pendientes:
 * una consulta sin respuesta, un comando sin respuesta o un cierre (QUIT /
 * COM_QUIT) que nunca se confirma. El servidor real sigue sano; lo que se
 * corta es el camino, como en una partición de red.
 *
 *   freezeWhen(chunk) → true congela ANTES de reenviar ese bloque del cliente
 *   (el comando nunca llega al servidor). También se puede congelar a mano.
 *
 * Al congelarse, las conexiones quedan abiertas en ambos extremos y todo lo
 * que llegue después se descarta. `close()` corta todo.
 */
const net = require('net');

async function startFreezableProxy({ targetHost = '127.0.0.1', targetPort, freezeWhen = null } = {}) {
  const pairs = new Set();
  const state = { frozen: false, frozenAt: null, connections: 0, matched: null };
  const waiters = [];

  const freeze = (why = 'manual') => {
    if (state.frozen) return;
    state.frozen = true;
    state.frozenAt = Date.now();
    state.matched = why;
    for (const w of waiters.splice(0)) w();
  };

  const server = net.createServer((client) => {
    state.connections += 1;
    const upstream = net.connect(targetPort, targetHost);
    const pair = { client, upstream };
    pairs.add(pair);
    const drop = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on('data', (chunk) => {
      if (!state.frozen && freezeWhen && freezeWhen(chunk)) freeze('freezeWhen');
      if (!state.frozen) upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      if (!state.frozen) client.write(chunk);
    });
    // Congelado: nada se propaga, tampoco el cierre (el otro extremo sigue esperando).
    client.on('end', () => { if (!state.frozen) upstream.end(); });
    upstream.on('end', () => { if (!state.frozen) client.end(); });
    client.on('close', () => { if (!state.frozen) drop(); });
    upstream.on('close', () => { if (!state.frozen) drop(); });
    client.on('error', () => {});
    upstream.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    state,
    freeze,
    /** Conexiones de clientes todavía abiertas contra el proxy. */
    openClients: () => [...pairs].filter((p) => !p.client.destroyed).length,
    async waitFrozen(timeoutMs = 10000) {
      if (state.frozen) return true;
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), timeoutMs);
        waiters.push(() => { clearTimeout(t); resolve(true); });
      });
    },
    async close() {
      for (const p of pairs) { p.client.destroy(); p.upstream.destroy(); }
      pairs.clear();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Predicados de congelamiento por protocolo. */
const RESP = {
  /** Un comando Redis (RESP) cuyo nombre o argumento contiene `text`. */
  contains: (text) => (chunk) => chunk.toString('latin1').toUpperCase().includes(String(text).toUpperCase()),
};
const MYSQL = {
  /** COM_QUIT: paquete de 1 byte de carga con el código 0x01. */
  comQuit: (chunk) => chunk.length >= 5 && chunk.readUIntLE(0, 3) === 1 && chunk[4] === 0x01,
  /** COM_QUERY (0x03) cuyo texto contiene `text`. */
  queryContains: (text) => (chunk) => chunk.length >= 5 && chunk[4] === 0x03
    && chunk.subarray(5).toString('utf8').toUpperCase().includes(String(text).toUpperCase()),
};

module.exports = { startFreezableProxy, RESP, MYSQL };
