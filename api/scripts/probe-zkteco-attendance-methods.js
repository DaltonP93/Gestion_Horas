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

// Parseo mínimo de una marca cruda (recordTime/attTime + deviceUserId).
function parseRec(l) {
  const raw = l?.recordTime ?? l?.attTime ?? l?.timestamp ?? l?.time;
  const ts = raw instanceof Date ? raw : (raw != null ? new Date(raw) : null);
  const uid = l?.deviceUserId ?? l?.userId ?? l?.uid ?? l?.userSn ?? null;
  return { ts: ts && !isNaN(ts.getTime()) ? ts : null, uid: uid != null ? String(uid) : null };
}
const isoPY = d => { try { return d.toLocaleString('sv-SE', { timeZone: 'America/Asuncion' }); } catch { return d.toISOString(); } };
// Analiza el array de asistencia: primera/última fecha, en-rango, últimas 20.
function analyzeAtt(logs, from, to) {
  const parsed = logs.map(parseRec).filter(x => x.ts).sort((a, b) => a.ts - b.ts);
  let inRange = 0;
  for (const x of parsed) {
    const d = isoPY(x.ts).slice(0, 10);
    if ((!from || d >= from) && (!to || d <= to)) inRange++;
  }
  return {
    withDate: parsed.length,
    first: parsed[0] ? isoPY(parsed[0].ts) : null,
    last: parsed.length ? isoPY(parsed[parsed.length - 1].ts) : null,
    inRange,
    recent: parsed.slice(-20).reverse().map(x => ({ ts: isoPY(x.ts), uid: x.uid })),
  };
}

// Ejecuta un escenario y devuelve el resultado por comando.
async function runScenario(device, { mode, delayMs = 0, usersFirst = false, timeoutMs, from = null, to = null }) {
  const res = { mode, delayMs, usersFirst, from, to, connect: null, getInfo: null, getUsers: null, getAttendances: null };
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

  try {
    const t0 = Date.now();
    const a = await withTimeout(zk.getAttendances(), timeoutMs, 'getAttendances');
    const logs = Array.isArray(a) ? a : (a && Array.isArray(a.data) ? a.data : []);
    res.getAttendances = { ok: true, ms: Date.now() - t0, count: logs.length, truncated: !!(a && a.err), analysis: analyzeAtt(logs, res.from, res.to) };
  } catch (e) { res.getAttendances = { ok: false, error: errMsg(e) }; }

  try { await zk.disconnect(); } catch {}
  return res;
}

(async () => {
  const deviceId = parseInt(arg('device-id', ''), 10);
  const timeoutMs = (parseInt(arg('timeout', '120'), 10) || 120) * 1000;
  const isD = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const from = isD(arg('from', '')) ? arg('from', '') : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Asuncion' }).format(new Date());
  const to = isD(arg('to', '')) ? arg('to', '') : from;
  if (isNaN(deviceId)) { console.error('Uso: node scripts/probe-zkteco-attendance-methods.js --device-id N [--timeout SEG] [--from YYYY-MM-DD --to YYYY-MM-DD]'); process.exit(1); }

  const [[device]] = await sequelize.query('SELECT * FROM devices WHERE id=?', { replacements: [deviceId] });
  if (!device) { console.error(`No existe el reloj id=${deviceId}`); process.exit(1); }

  console.log(`Prueba por comando/modo — [#${device.id}] ${device.name} (${device.ip_address}:${device.port})`);
  console.log(`connection_mode en BD: ${device.connection_mode || 'auto'} · timeout por comando: ${timeoutMs / 1000}s · rango: ${from} → ${to}\n`);

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
  let attWorks = null, anyDownload = null;
  for (const sc of scenarios) {
    const tag = `${sc.mode.toUpperCase()}${sc.delayMs ? ` +delay${sc.delayMs}ms` : ''}${sc.usersFirst ? ' +usersFirst' : ''}`;
    process.stdout.write(`── ${tag} …\n`);
    const r = await runScenario(device, { ...sc, timeoutMs, from, to });
    console.log(`   connect:        ${fmt(r.connect)}`);
    console.log(`   getInfo:        ${fmt(r.getInfo)}`);
    if (sc.usersFirst) console.log(`   getUsers:       ${fmt(r.getUsers)}`);
    const ga = r.getAttendances;
    console.log(`   getAttendances: ${fmt(ga)}${ga?.truncated ? ' ⚠️TRUNCADA' : ''}`);
    if (ga?.ok && ga.analysis) {
      const an = ga.analysis;
      console.log(`       fechas: ${an.first || '—'} → ${an.last || '—'} · enRango(${from}..${to})=${an.inRange} · conFecha=${an.withDate}`);
      if (an.recent.length) {
        console.log(`       últimas ${Math.min(20, an.recent.length)} marcas:`);
        for (const m of an.recent.slice(0, 20)) console.log(`         ${m.ts}  user ${m.uid}`);
      }
    }
    console.log('');
    const ok = r.getAttendances?.ok;
    if (ok && !r.getAttendances.truncated && attWorks === null) attWorks = tag;        // lectura COMPLETA
    if (ok && anyDownload === null) anyDownload = tag;                                  // descargó algo (aunque truncada)
  }

  console.log('─'.repeat(64));
  const chosen = attWorks || anyDownload;
  if (chosen) {
    const mode = chosen.split(' ')[0].toLowerCase();
    if (attWorks) console.log(`✅ getAttendances COMPLETA con: ${attWorks}`);
    else console.log(`⚠️  getAttendances descargó pero TRUNCADA con: ${anyDownload} (el buffer del GT200 llega parcial).`);
    console.log(`   → Dejá el reloj en connection_mode='${mode}' y leé con reintentos + cooldown:`);
    console.log(`     node scripts/read-zkteco-now.js --device-id ${deviceId} --mode ${mode} --attempts 5 --cooldown-seconds 4 --timeout 600`);
  } else {
    console.log('❌ Ningún modo logró descargar marcaciones (getAttendances).');
    console.log('   connect/getInfo pueden andar pero la descarga del buffer de asistencia falla en este GT200.');
    console.log('   Alternativa recomendada: vía PUSH/ADMS (reapuntar "Ajustes Servidor Cloud" del reloj al bridge de SisHoras).');
  }

  await sequelize.close();
  process.exit(0);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
