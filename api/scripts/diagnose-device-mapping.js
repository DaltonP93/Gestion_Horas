#!/usr/bin/env node
/**
 * diagnose-device-mapping.js — Cruce deviceUserId (reloj) ↔ empleados ↔ att2000.
 *
 * READ-ONLY. Sirve para entender por qué las marcas caen en "sinEmp": el
 * deviceUserId del reloj puede corresponder a employees.code, a otra columna
 * (employee_number, …) o a att2000.USERINFO.BADGENUMBER / USERID, no siempre a
 * employees.code.
 *
 *   node scripts/diagnose-device-mapping.js --device-id 1
 *   node scripts/diagnose-device-mapping.js --device-id 1 --from 2026-07-16 --to 2026-07-16
 *
 * Flags:
 *   --device-id N   reloj a diagnosticar (requerido).
 *   --from/--to     acota a las marcas de ese rango (hora Paraguay). Sin rango,
 *                   analiza todos los deviceUserId válidos del buffer.
 *   --limit N       cuántos deviceUserId sin empleado detallar (default 50).
 *   --timeout SEG   timeout de lectura (default 180).
 *   --attempts N    lecturas para elegir la de más registros válidos (default 2).
 *
 * Reporta, por deviceUserId sin mapear:
 *   - si existe en employees por alguna columna (y su estado),
 *   - si existe en att2000.USERINFO por USERID o por BADGENUMBER (con el nombre).
 */
require('dotenv').config();
const { sequelize } = require('../src/config/database');
const {
  readAttendancesStable, isJunkRaw, normalizeRecord, buildEmployeeMatcher, pyDateStr,
} = require('../src/services/zktecoReader');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

(async () => {
  const deviceId = parseInt(arg('device-id', ''), 10);
  const from = arg('from', null);
  const to = arg('to', null);
  const limit = parseInt(arg('limit', '50'), 10) || 50;
  const readTimeoutMs = (parseInt(arg('timeout', '180'), 10) || 180) * 1000;
  const attempts = Math.max(1, parseInt(arg('attempts', '2'), 10) || 2);
  if (isNaN(deviceId)) {
    console.error('Uso: node scripts/diagnose-device-mapping.js --device-id N [--from YYYY-MM-DD --to YYYY-MM-DD] [--limit 50]');
    process.exit(1);
  }
  if ((from && !isDate(from)) || (to && !isDate(to))) {
    console.error('--from/--to deben ser YYYY-MM-DD');
    process.exit(1);
  }

  const [rows] = await sequelize.query('SELECT * FROM devices WHERE id=?', { replacements: [deviceId] });
  const device = rows[0];
  if (!device) { console.error(`No existe el reloj id=${deviceId}`); process.exit(1); }

  console.log(`Diagnóstico de mapeo — [#${device.id}] ${device.name} (${device.ip_address})`);
  console.log(`Rango: ${from || '(todo)'} … ${to || '(todo)'}\n`);

  // 1) Leer y normalizar (sin basura).
  const stable = await readAttendancesStable(device, { readTimeoutMs, attempts });
  const clean = stable.logs.filter(l => !isJunkRaw(l)).map(normalizeRecord).filter(n => n.ts && n.userId);
  if (stable.unstable) console.log(`⚠️  Lectura inestable entre intentos (válidos: ${stable.valids.join(', ')}). Se usó la mejor.\n`);

  // 2) deviceUserId distintos (en rango si se pidió).
  const counts = new Map();
  for (const n of clean) {
    const day = pyDateStr(n.ts);
    if ((from && day < from) || (to && day > to)) continue;
    counts.set(n.userId, (counts.get(n.userId) || 0) + 1);
  }
  const ids = [...counts.keys()];
  console.log(`deviceUserId distintos${from || to ? ' en rango' : ''}: ${ids.length} (marcas: ${[...counts.values()].reduce((a, b) => a + b, 0)})`);

  // 3) Matcher de empleados (todas las columnas disponibles, cualquier estado).
  const matcher = await buildEmployeeMatcher();
  console.log(`Columnas de employees usadas para mapear: ${matcher.columns.join(', ')}`);
  const mapped = ids.filter(id => matcher.active.has(id));
  const unmapped = ids.filter(id => !matcher.active.has(id));
  console.log(`Mapeados a empleado ACTIVO: ${mapped.length}  ·  Sin mapear: ${unmapped.length}\n`);

  // 4) Cruce con att2000.USERINFO (best-effort).
  let userinfo = new Map();  // key: BADGENUMBER string / USERID string → { name, userid, badge }
  const detailIds = unmapped.slice(0, limit);
  if (detailIds.length) {
    try {
      const { queryAtt2000, getTableColumns, pickCol } = require('../src/config/att2000');
      const cols = await getTableColumns('USERINFO');
      const selName = pickCol(cols, 'Name', { alias: 'NAME' }).includes('NULL')
        ? pickCol(cols, 'NAME', { alias: 'NAME' })
        : pickCol(cols, 'Name', { alias: 'NAME' });
      const params = {};
      detailIds.forEach((id, i) => { params[`p${i}`] = id; });
      const inList = detailIds.map((_, i) => `@p${i}`).join(',');
      const sqlText = `SELECT USERID, BADGENUMBER, ${selName}
                       FROM USERINFO
                       WHERE CAST(BADGENUMBER AS NVARCHAR(50)) IN (${inList})
                          OR CAST(USERID AS NVARCHAR(50)) IN (${inList})`;
      const recs = await queryAtt2000(sqlText, params);
      for (const r of recs) {
        const badge = r.BADGENUMBER != null ? String(r.BADGENUMBER).trim() : null;
        const uid = r.USERID != null ? String(r.USERID).trim() : null;
        const val = { name: r.NAME || null, userid: uid, badge };
        if (badge) userinfo.set(badge, val);
        if (uid) userinfo.set(uid, val);
      }
      console.log(`att2000.USERINFO: ${recs.length} coincidencias para los ${detailIds.length} sin mapear.\n`);
    } catch (e) {
      console.log(`att2000.USERINFO no disponible (${e.message}). Se omite ese cruce.\n`);
    }
  }

  // 5) Detalle por deviceUserId sin mapear.
  console.log(`── deviceUserId SIN empleado activo (top ${detailIds.length}) ──`);
  console.log(`   deviceUserId | marcas | employees | att2000.USERINFO`);
  for (const id of detailIds) {
    const alt = matcher.any.get(id);
    const empTxt = alt ? `emp#${alt.id} via '${alt.via}' (${alt.status})` : 'no existe';
    const ui = userinfo.get(id);
    const uiTxt = ui ? `USERID=${ui.userid} BADGE=${ui.badge}${ui.name ? ` "${String(ui.name).trim()}"` : ''}` : 'no existe';
    console.log(`   ${String(id).padEnd(12)} | ${String(counts.get(id)).padStart(6)} | ${empTxt.padEnd(34)} | ${uiTxt}`);
  }

  // 6) Conclusión orientativa.
  console.log('');
  const viaOther = detailIds.filter(id => matcher.any.get(id)).length;
  const viaAtt = detailIds.filter(id => userinfo.get(id)).length;
  console.log('Interpretación:');
  if (viaOther > 0)
    console.log(` · ${viaOther}/${detailIds.length} existen en employees por otra columna/estado → revisar mapeo o reactivar empleados.`);
  if (viaAtt > 0)
    console.log(` · ${viaAtt}/${detailIds.length} existen en att2000.USERINFO → el deviceUserId es el BADGENUMBER/USERID; conviene guardar ese valor en employees.code (o crear tabla de mapeo).`);
  if (!viaOther && !viaAtt && detailIds.length)
    console.log(' · No se encontró correspondencia: esos usuarios del reloj no están cargados como empleados. Hay que darlos de alta o mapearlos.');

  await sequelize.close();
  process.exit(0);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
