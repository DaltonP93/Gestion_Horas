#!/usr/bin/env node
/**
 * inspect-zkteco-raw.js — Volcado CRUDO y AUTÓNOMO de un reloj ZKTeco.
 *
 * Imprime EXACTAMENTE lo que devuelve zk.getAttendances(), SIN normalizar y
 * SIN depender del parser de SisHoras. Sirve para ver los nombres de campo
 * reales (recordTime? attTime? deviceUserId? userId?) y los valores crudos de
 * fecha/hora y usuario. Funciona aunque el normalizador esté equivocado.
 *
 *   node scripts/inspect-zkteco-raw.js --device-id 1 --limit 20
 *   node scripts/inspect-zkteco-raw.js --device-id 2 --timeout 600
 *
 * Flags:
 *   --device-id N   reloj a inspeccionar (requerido). Toma IP/puerto/modo de la BD.
 *   --limit N       cuántos registros del final mostrar completos (default 20).
 *   --timeout SEG   timeout de lectura en segundos (default 120).
 *   --mode tcp|udp|auto   fuerza el modo de conexión (default: el de la BD).
 */
require('dotenv').config();
const { sequelize } = require('../src/config/database');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// Conexión ZKTeco autónoma (no usa el servicio, para no arrastrar el parser).
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

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout (${label}) tras ${Math.round(ms / 1000)}s`)), ms)),
  ]);
}

// Serializa mostrando el TIPO real de cada valor (Date/Buffer/number/string).
function replacer(k, v) {
  if (v instanceof Date) return `Date(${isNaN(v.getTime()) ? 'INVALID' : v.toISOString()})`;
  if (typeof v === 'bigint') return `BigInt(${v})`;
  if (v && v.type === 'Buffer' && Array.isArray(v.data)) return `Buffer(${v.data.length}B)`;
  return v;
}
function dump(o) { try { return JSON.stringify(o, replacer); } catch { return String(o); } }

// Describe los campos de un registro: nombre → tipo(valor).
function describe(rec) {
  if (rec == null) return '(null)';
  if (Array.isArray(rec)) return `Array(len=${rec.length}) ${dump(rec.slice(0, 10))}`;
  if (Buffer.isBuffer(rec)) return `Buffer(${rec.length}B) hex=${rec.subarray(0, 40).toString('hex')}`;
  if (typeof rec !== 'object') return `${typeof rec}: ${dump(rec)}`;
  return Object.keys(rec).map(k => {
    const v = rec[k];
    let t = v === null ? 'null' : (v instanceof Date ? 'Date' : (Buffer.isBuffer(v) ? 'Buffer' : typeof v));
    let shown = v instanceof Date ? (isNaN(v.getTime()) ? 'INVALID' : v.toISOString())
      : Buffer.isBuffer(v) ? v.subarray(0, 12).toString('hex')
        : dump(v);
    return `${k}:${t}=${shown}`;
  }).join('  ');
}

// Campos candidatos que buscamos en el resto del sistema.
const TS_FIELDS = ['recordTime', 'attTime', 'timestamp', 'punchTime', 'verifyTime', 'time', 'dateTime', 'logTime', 'attendanceTime', 'checkTime'];
const UID_FIELDS = ['deviceUserId', 'userId', 'uid', 'user_id', 'enrollNumber', 'enrollNo', 'userSn', 'id'];

(async () => {
  const deviceId = parseInt(arg('device-id', ''), 10);
  const limit = parseInt(arg('limit', '20'), 10) || 20;
  const timeoutMs = (parseInt(arg('timeout', '120'), 10) || 120) * 1000;
  const forceMode = arg('mode', null);
  if (isNaN(deviceId)) {
    console.error('Uso: node scripts/inspect-zkteco-raw.js --device-id N [--limit 20] [--timeout SEG] [--mode tcp|udp|auto]');
    process.exit(1);
  }

  const [rows] = await sequelize.query('SELECT * FROM devices WHERE id=?', { replacements: [deviceId] });
  const device = rows[0];
  if (!device) { console.error(`No existe el reloj id=${deviceId}`); process.exit(1); }
  if (forceMode) device.connection_mode = forceMode;

  console.log(`Volcado CRUDO — [#${device.id}] ${device.name} (${device.ip_address}:${device.port} · ${device.connection_mode || 'auto'})`);
  console.log(`Timeout: ${timeoutMs / 1000}s\n`);

  let zk, res;
  const t0 = Date.now();
  try {
    zk = await withTimeout(openZK(device), timeoutMs, 'conexión');
    res = await withTimeout(zk.getAttendances(), timeoutMs, 'getAttendances');
  } catch (err) {
    console.error(`❌ Falló la lectura tras ${((Date.now() - t0) / 1000).toFixed(1)}s: ${err.message}`);
    if (zk) { try { await zk.disconnect(); } catch {} }
    await sequelize.close();
    process.exit(1);
  }
  try { await zk.disconnect(); } catch {}

  console.log(`── Resultado raíz de getAttendances() ──`);
  console.log(`typeof result      : ${typeof res}`);
  console.log(`Array.isArray      : ${Array.isArray(res)}`);
  if (res && typeof res === 'object' && !Array.isArray(res)) {
    console.log(`keys result        : ${Object.keys(res).join(', ')}`);
  }

  // Localizar el array de registros (data / records / logs / attendances / el propio res).
  let logs = null, where = null;
  for (const key of ['data', 'records', 'logs', 'attendances']) {
    if (res && Array.isArray(res[key])) { logs = res[key]; where = `result.${key}`; break; }
  }
  if (!logs && Array.isArray(res)) { logs = res; where = 'result (array)'; }
  if (!logs) {
    console.log(`\n⚠️  No se encontró un array de registros en el resultado.`);
    console.log(`Resultado completo: ${dump(res)}`);
    await sequelize.close();
    process.exit(0);
  }

  console.log(`registros en       : ${where}`);
  console.log(`typeof registros   : ${typeof logs}  ·  length=${logs.length}\n`);

  if (!logs.length) {
    console.log('⚠️  El array de registros está vacío (0 marcas).');
    await sequelize.close();
    process.exit(0);
  }

  // Primer registro completo.
  console.log(`── Primer registro ──`);
  console.log(`JSON : ${dump(logs[0])}`);
  console.log(`campos: ${describe(logs[0])}\n`);

  // Detección de campos candidatos en el primer registro.
  const first = logs[0];
  const foundTs = TS_FIELDS.filter(f => first && first[f] !== undefined);
  const foundUid = UID_FIELDS.filter(f => first && first[f] !== undefined);
  console.log(`campo(s) de fecha detectado(s)  : ${foundTs.length ? foundTs.join(', ') : '(ninguno de la lista conocida)'}`);
  console.log(`campo(s) de usuario detectado(s): ${foundUid.length ? foundUid.join(', ') : '(ninguno de la lista conocida)'}`);
  for (const f of foundTs) console.log(`   ${f} = ${dump(first[f])}`);
  for (const f of foundUid) console.log(`   ${f} = ${dump(first[f])}`);
  console.log('');

  // Últimos N registros completos.
  const tail = logs.slice(-limit);
  console.log(`── Últimos ${tail.length} registros ──`);
  for (const r of tail) console.log(`  ${describe(r)}`);

  console.log('');
  console.log('Interpretación:');
  console.log(' · Si ves recordTime:Date=... y deviceUserId=..., el fix del PR #46 ya');
  console.log('   parsea eso correctamente (el parser viejo buscaba attTime → 0 en rango).');
  console.log(' · Si la fecha (recordTime) muestra un año raro (p.ej. 2019/2055), el reloj');
  console.log('   tiene la FECHA/HORA mal configurada: hay que corregir el reloj.');

  await sequelize.close();
  process.exit(0);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
