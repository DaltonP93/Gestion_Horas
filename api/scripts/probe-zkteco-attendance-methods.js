#!/usr/bin/env node
/**
 * probe-zkteco-attendance-methods.js — Diagnóstico por COMANDO y por MODO.
 *
 * El GT200/Granding a veces responde connect/getInfo/getUsers pero falla
 * específicamente getAttendances (descarga del buffer de asistencia). Este
 * script prueba cada comando en TCP, UDP y auto, con variantes (delay entre
 * conexión y lectura, leer usuarios antes que asistencia) para encontrar la
 * combinación que sí descarga marcaciones.
 *
 *   node scripts/probe-zkteco-attendance-methods.js --device-id 2 --timeout 600
 *
 * READ-ONLY: no escribe en la BD. Sólo se conecta y mide.
 */
require('dotenv').config();
const { sequelize } = require('../src/config/database');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout (${label}) tras ${Math.round(ms / 1000)}s`)), ms)),
  ]);
}
const errMsg = e => e?.message || e?.err?.message || String(e);

async function openMode(mode, device, timeout) {
  if (mode === 'tcp') {
    const T = require('node-zklib/zklibtcp');
    const c = new T(device.ip_address, device.port, timeout);
    await c.createSocket(); await c.connect(); return c;
  }
  if (mode === 'udp') {
    const U = require('node-zklib/zklibudp');
    const c = new U(device.ip_address, device.port, timeout, 0);
    await c.createSocket(); await c.connect(); return c;
  }
  const Z = require('node-zklib');
  const z = new Z(device.ip_address, device.port, timeout, 0);
  await z.createSocket(); return z;
}

const arrLen = r => (Array.isArray(r) ? r.length : (r && Array.isArray(r.data) ? r.data.length : 0));

// Ejecuta un escenario y devuelve el resultado por comando.
async function runScenario(device, { mode, delayMs = 0, usersFirst = false, timeoutMs }) {
  const res = { mode, delayMs, usersFirst, connect: null, getInfo: null, getUsers: null, getAttendances: null };
  let zk;
  try {
    const t0 = Date.now();
    zk = await withTimeout(openMode(mode, device, Math.min(timeoutMs, 12000)), Math.min(timeoutMs, 15000), 'connect');
    res.connect = { ok: true, ms: Date.now() - t0 };
  } catch (e) { res.connect = { ok: false, error: errMsg(e) }; return res; }

  try { const t0 = Date.now(); const i = await withTimeout(zk.getInfo(), timeoutMs, 'getInfo'); res.getInfo = { ok: true, ms: Date.now() - t0, logs: i?.logCounts ?? i?.logs ?? null }; }
  catch (e) { res.getInfo = { ok: false, error: errMsg(e) }; }

  if (usersFirst) {
    try { const t0 = Date.now(); const u = await withTimeout(zk.getUsers(), timeoutMs, 'getUsers'); res.getUsers = { ok: true, ms: Date.now() - t0, count: arrLen(u) }; }
    catch (e) { res.getUsers = { ok: false, error: errMsg(e) }; }
  }

  if (delayMs) await sleep(delayMs);

  try { const t0 = Date.now(); const a = await withTimeout(zk.getAttendances(), timeoutMs, 'getAttendances'); res.getAttendances = { ok: true, ms: Date.now() - t0, count: arrLen(a) }; }
  catch (e) { res.getAttendances = { ok: false, error: errMsg(e) }; }

  try { await zk.disconnect(); } catch {}
  return res;
}

(async () => {
  const deviceId = parseInt(arg('device-id', ''), 10);
  const timeoutMs = (parseInt(arg('timeout', '120'), 10) || 120) * 1000;
  if (isNaN(deviceId)) { console.error('Uso: node scripts/probe-zkteco-attendance-methods.js --device-id N [--timeout SEG]'); process.exit(1); }

  const [[device]] = await sequelize.query('SELECT * FROM devices WHERE id=?', { replacements: [deviceId] });
  if (!device) { console.error(`No existe el reloj id=${deviceId}`); process.exit(1); }

  console.log(`Prueba por comando/modo — [#${device.id}] ${device.name} (${device.ip_address}:${device.port})`);
  console.log(`connection_mode en BD: ${device.connection_mode || 'auto'} · timeout por comando: ${timeoutMs / 1000}s\n`);

  const scenarios = [
    { mode: 'tcp' },
    { mode: 'udp' },
    { mode: 'auto' },
    { mode: 'tcp', delayMs: 1500 },
    { mode: 'udp', delayMs: 1500 },
    { mode: 'udp', usersFirst: true },
    { mode: 'tcp', usersFirst: true },
  ];

  const fmt = s => s ? (s.ok ? `OK${s.ms != null ? ` ${(s.ms / 1000).toFixed(1)}s` : ''}${s.count != null ? ` (${s.count})` : ''}` : `FALLA: ${s.error}`) : '—';
  let attWorks = null;
  for (const sc of scenarios) {
    const tag = `${sc.mode.toUpperCase()}${sc.delayMs ? ` +delay${sc.delayMs}ms` : ''}${sc.usersFirst ? ' +usersFirst' : ''}`;
    process.stdout.write(`── ${tag} …\n`);
    const r = await runScenario(device, { ...sc, timeoutMs });
    console.log(`   connect:        ${fmt(r.connect)}`);
    console.log(`   getInfo:        ${fmt(r.getInfo)}`);
    if (sc.usersFirst) console.log(`   getUsers:       ${fmt(r.getUsers)}`);
    console.log(`   getAttendances: ${fmt(r.getAttendances)}`);
    console.log('');
    if (r.getAttendances?.ok && attWorks === null) attWorks = tag;
  }

  console.log('─'.repeat(64));
  if (attWorks) {
    console.log(`✅ getAttendances FUNCIONA con: ${attWorks}`);
    const mode = attWorks.split(' ')[0].toLowerCase();
    console.log(`   → Configurá el reloj en connection_mode='${mode}' (Config → Relojes) y reintentá:`);
    console.log(`     node scripts/read-zkteco-now.js --device-id ${deviceId} --mode ${mode} --attempts 3 --timeout 600`);
  } else {
    console.log('❌ Ningún modo logró descargar marcaciones (getAttendances).');
    console.log('   connect/getInfo pueden andar pero la descarga del buffer de asistencia falla en este GT200.');
    console.log('   Alternativa recomendada: vía PUSH/ADMS (reapuntar "Ajustes Servidor Cloud" del reloj al bridge de SisHoras).');
  }

  await sequelize.close();
  process.exit(0);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
