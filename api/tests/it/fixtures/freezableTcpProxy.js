'use strict';

/**
 * freezableTcpProxy.js — proxy TCP que puede CONGELARSE (dejar de reenviar sin
 * cerrar), para reproducir operaciones de MySQL o Redis que quedan pendientes:
 * una consulta sin respuesta, un comando sin respuesta o un cierre (QUIT /
 * COM_QUIT) que nunca se confirma. El servidor real sigue sano; lo que se
 * corta es el camino, como en una partición de red.
 *
 *   freezeWhen(chunk) → true congela ANTES de reenviar ese bloque del cliente
 *   (el comando nunca llega al servidor). También se puede congelar a mano:
 *   `freeze()` congela todo (también las conexiones nuevas) y `freezeExisting()`
 *   sólo las abiertas (una conexión NUEVA funciona: socket medio muerto, NAT).
 *
 *   delayWhen(chunk) → ms > 0 DEMORA ese bloque del cliente y todo lo que la
 *   misma conexión mande después, también su cierre (FIN detrás de los datos,
 *   como TCP): un comando en vuelo que llega al servidor después de que el
 *   cliente lo dio por perdido. Si el servidor cierra antes esa conexión (KILL),
 *   lo demorado ya no llega.
 *
 * Al congelarse, las conexiones quedan abiertas en ambos extremos y todo lo
 * que llegue después se descarta. `close()` corta todo.
 */
const net = require('net');

async function startFreezableProxy({ targetHost = '127.0.0.1', targetPort, freezeWhen = null, delayWhen = null } = {}) {
  const pairs = new Set();
  const state = {
    frozen: false, frozenAt: null, connections: 0, matched: null,
    // Demoras: bloques demorados, entregados (o descartados si el servidor ya cerró esa conexión).
    delayed: 0, delivered: 0, discarded: 0, flushes: 0,
  };
  const waiters = [];
  const flushWaiters = [];

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
    const pair = { client, upstream, frozen: false, delayed: null };
    pairs.add(pair);
    const frozen = () => state.frozen || pair.frozen;
    const drop = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    // Entrega lo demorado en orden; después, la conexión sigue normal (o se cierra si el cliente ya cerró).
    const flush = () => {
      for (const step of pair.delayed.splice(0)) step();
      pair.delayed = null;
      if (client.destroyed) upstream.end();
      state.flushes += 1;
      for (const w of flushWaiters.splice(0)) w();
    };
    const toUpstream = (chunk) => {
      if (upstream.destroyed || upstream.writableEnded) { state.discarded += 1; return; }
      upstream.write(chunk);
      state.delivered += 1;
    };
    client.on('data', (chunk) => {
      if (!frozen() && freezeWhen && freezeWhen(chunk)) freeze('freezeWhen');
      if (frozen()) return;
      if (!pair.delayed && delayWhen) {
        const ms = delayWhen(chunk);
        if (ms > 0) { pair.delayed = []; setTimeout(flush, ms); }
      }
      if (pair.delayed) { state.delayed += 1; pair.delayed.push(() => toUpstream(chunk)); return; }
      upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      if (!frozen() && !client.destroyed) client.write(chunk);
    });
    // Congelado: nada se propaga, tampoco el cierre (el otro extremo sigue esperando).
    // Demorado: el cierre del cliente va DETRÁS de lo demorado (lo entrega flush()).
    client.on('end', () => { if (!frozen() && !pair.delayed) upstream.end(); });
    upstream.on('end', () => { if (!frozen()) client.end(); });
    client.on('close', () => { if (!frozen() && !pair.delayed) drop(); });
    upstream.on('close', () => { if (!frozen() && !pair.delayed) drop(); });
    client.on('error', () => {});
    upstream.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    state,
    freeze,
    /** Congela sólo las conexiones ya abiertas: las nuevas funcionan. */
    freezeExisting() {
      for (const p of pairs) p.frozen = true;
    },
    /** Espera a que lo demorado de `n` conexiones se haya entregado (o descartado). */
    async waitDelayFlushed(n = 1, timeoutMs = 20000) {
      if (state.flushes >= n) return true;
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), timeoutMs);
        const check = () => { if (state.flushes >= n) { clearTimeout(t); resolve(true); } else flushWaiters.push(check); };
        flushWaiters.push(check);
      });
    },
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
