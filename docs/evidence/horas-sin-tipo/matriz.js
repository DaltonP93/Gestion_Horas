#!/usr/bin/env node
'use strict';
// Convierte el JSON que escribe api/tests/it/untypedPunchHours.it.test.js
// (UNTYPED_HOURS_EVIDENCE_OUT) en la matriz Markdown de esta carpeta.
// Uso: node docs/evidence/horas-sin-tipo/matriz.js <matriz.json>
const m = require(require('path').resolve(process.argv[2]));
const hhmm = (s) => (s ? s.slice(5, 16).replace('2026-', '') : '—');
const dia = (r) => (r ? r.date.slice(5) : '');
const fila = (r, motor) => (r
  ? `${hhmm(r.first_in)}→${hhmm(r.last_out)} · ${motor ? `perm ${r.presence_minutes} · neto ${r.net_worked_minutes}` : `trab ${r.worked_minutes}`}`
    + ` · tarde ${r.late_minutes} · extra ${r.overtime_minutes} · ${r.status}${motor && r.anomalies.length ? ` · ⚠ ${r.anomalies.join(', ')}` : ''}`
  : '—');
const out = [];
out.push('| Caso | Marcas (tipo · procedencia) | Legacy `daily_summary` (escrito) | Motor, sin horario vigente (`historical_fallback`) | Motor, con horario vigente (`configured`) | Tramos del motor |');
out.push('|---|---|---|---|---|---|');
for (const [k, v] of Object.entries(m)) {
  if (k.startsWith('_')) continue;
  const marks = v.marks.map((x) => `${hhmm(x.wall)} ${x.type} · ${x.provenance}`).join('<br>');
  const legacy = v.legacy.filter((r) => r.first_in || r.last_out || r.worked_minutes)
    .map((r) => `${dia(r)}: ${fila(r, false)}`).join('<br>') || 'todas las fechas `absent`, 0 min';
  const eng = v.engine.map((r) => `${dia(r)}: ${fila(r, true)}`).join('<br>') || '—';
  const cfg = v.engine_configurado.map((r) => `${dia(r)}: ${fila(r, true)}`).join('<br>') || '—';
  const segs = v.segments.map((s) => `${s.tramo.replace(/2026-/g, '')} (${s.minutos}′) **${s.emparejado_por}**`).join('<br>');
  out.push(`| **${k}**<br>${v.descripcion} | ${marks} | ${legacy} | ${eng} | ${cfg} | ${segs} |`);
}
if (m._job) out.push('', `Lectura de la cola: \`${JSON.stringify(m._job)}\`.`);
console.log(out.join('\n'));
