'use strict';

/**
 * zkClient.js — conexión a un reloj ZKTeco según `connection_mode`.
 *
 * node-zklib se carga recién al conectar, nunca al cargar este módulo: quien
 * use la captura del estado crudo (zkRawCapture) la instala antes. Extraído
 * sin cambios de zktecoReader.js para que el piloto aislado conecte igual que
 * el lector sin cargarlo.
 */

// ─── Conexión ZKTeco (según connection_mode del device) ─────────
async function openZK(device) {
  const timeout = parseInt(device.timeout_ms || 12000);
  const mode = String(device.connection_mode || 'auto').toLowerCase();
  if (mode === 'udp') {
    const ZKLibUDP = require('node-zklib/zklibudp');
    const c = new ZKLibUDP(device.ip_address, device.port, timeout, 0);
    await c.createSocket(); await c.connect(); return c;
  }
  if (mode === 'tcp') {
    const ZKLibTCP = require('node-zklib/zklibtcp');
    const c = new ZKLibTCP(device.ip_address, device.port, timeout);
    await c.createSocket(); await c.connect(); return c;
  }
  const ZKLib = require('node-zklib');
  const zk = new ZKLib(device.ip_address, device.port, timeout, 0);
  await zk.createSocket(); return zk;
}

module.exports = { openZK };
