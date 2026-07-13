#!/usr/bin/env node
/**
 * validate-timezone.js — Prueba de zona horaria (Paraguay / America/Asuncion).
 *
 * Valida el requisito: la hora del reloj debe mostrarse igual en pantalla,
 * sin importar la zona del servidor o del navegador.
 *
 *   Reloj / att2000:  06:34 (hora local Paraguay)
 *   MySQL (DATETIME): 06:34 (guardado en hora local, time_zone -03:00)
 *   API (ISO UTC):    09:34Z
 *   Pantalla:         06:34   ← debe coincidir con el reloj
 *
 * Ejecutar:  node scripts/validate-timezone.js
 * Sale con código 1 si alguna aserción falla.
 */
const assert = require('assert');

const TZ = 'America/Asuncion';

// Réplica de la lógica de web/src/lib/datetime.ts (fmtTimePy) en JS puro.
function fmtTimePy(v) {
  if (v == null || v === '') return '—';
  let s = String(v).trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00-03:00';        // solo fecha → medianoche PY
  else if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += '-03:00';          // naive → hora de Paraguay
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-PY', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

// Formatea solo fecha "dd/mm/aaaa" en PY (para validar strings date-only).
function fmtDatePy(v) {
  if (v == null || v === '') return '—';
  let s = String(v).trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00-03:00';
  else if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += '-03:00';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-PY', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

const cases = [
  // [entrada, esperado, descripción]
  ['2026-07-12T09:34:00Z',       '06:34', 'API ISO UTC (marca real 06:34 PY)'],
  ['2026-07-12T09:34:00.000Z',   '06:34', 'ISO UTC con milisegundos'],
  ['2026-07-12 06:34:00',        '06:34', 'DATETIME local sin zona (dateStrings)'],
  ['2026-07-12T06:34:00-03:00',  '06:34', 'ISO con offset PY explícito'],
  ['2026-07-12T03:00:00Z',       '00:00', 'medianoche de Paraguay'],
  ['2026-07-13T02:59:00Z',       '23:59', 'último minuto del día PY (cruce UTC)'],
  [null,                          '—',    'nulo → guion'],
];

let failed = 0;
for (const [input, expected, desc] of cases) {
  const got = fmtTimePy(input);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${desc}: ${JSON.stringify(input)} → ${got} (esperado ${expected})`);
}

// Caso solo-fecha (daily_summary.date): no debe caer en el fallback.
{
  const got = fmtDatePy('2026-07-12');
  const ok = got === '12/07/2026';
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} fecha sola (YYYY-MM-DD): "2026-07-12" → ${got} (esperado 12/07/2026)`);
}

assert.strictEqual(failed, 0, `${failed} caso(s) de zona horaria fallaron`);
console.log('\n✅ Todas las marcaciones se muestran en hora de Paraguay.');
