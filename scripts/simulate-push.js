#!/usr/bin/env node
/**
 * simulate-push.js
 * Simula un reloj ZKTeco enviando marcajes al Bridge vía PUSH ADMS.
 *
 * Uso:
 *   node scripts/simulate-push.js [host:port] [SN] [userId] [count]
 *
 * Defaults:
 *   host:port = localhost:8080
 *   SN        = SIMTEST01
 *   userId    = 1
 *   count     = 1
 *
 * Ejemplos:
 *   node scripts/simulate-push.js                      # 1 marcaje a localhost
 *   node scripts/simulate-push.js bridge.example.internal:8080     # contra prod
 *   node scripts/simulate-push.js localhost:8080 FAKE 99 5   # 5 marcajes user 99
 */

const http = require('http');

const [, , hostArg = 'localhost:8080', sn = 'SIMTEST01', userId = '1', countArg = '1'] = process.argv;
const [host, port] = hostArg.split(':');
const count = parseInt(countArg);

function req(method, path, body = '', contentType = 'text/plain') {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host, port: parseInt(port || '8080'), method, path,
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
    if (body) r.write(body);
    r.end();
  });
}

function fmtTs(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

(async () => {
  console.log(`🔌 Simulando reloj SN=${sn} contra ${host}:${port}`);

  // 1) GET cdata — handshake de registro
  const reg = await req('GET', `/iclock/cdata?SN=${sn}&options=all`);
  console.log(`   Registro: HTTP ${reg.status}`);
  if (reg.status !== 200) {
    console.error('❌ El Bridge no respondió al handshake');
    process.exit(1);
  }

  // 2) POST cdata — enviar marcajes
  const now = new Date();
  const lines = [];
  for (let i = 0; i < count; i++) {
    const ts = new Date(now.getTime() - i * 60000); // 1 min de separación
    const status = i % 2;   // alternar in/out
    lines.push(`${userId}\t${fmtTs(ts)}\t${status}\t1\t0`);
  }
  const body = lines.join('\n');
  console.log(`   Enviando ${count} marcaje(s)...`);
  const send = await req('POST', `/iclock/cdata?SN=${sn}&table=ATTLOG`, body, 'text/plain');
  console.log(`   POST: HTTP ${send.status} — respuesta: "${send.body}"`);

  // 3) Consultar estado
  try {
    const st = await req('GET', `/push-state`);
    const state = JSON.parse(st.body);
    console.log(`\n📊 Estado del Bridge:`);
    console.log(JSON.stringify(state[sn], null, 2));
  } catch (e) {
    console.warn(`⚠ No se pudo leer /push-state: ${e.message}`);
  }

  console.log(`\n✅ Simulación completa. Verificar:`);
  console.log(`   - pm2 logs sishoras-bridge → "PUSH de SN=${sn}"`);
  console.log(`   - pm2 logs sishoras-api    → "Marcaje: ..." o "código desconocido: ${userId}"`);
  console.log(`   - MySQL: SELECT * FROM attendance_logs WHERE raw_data LIKE '%${sn}%' LIMIT 5;`);
})().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
