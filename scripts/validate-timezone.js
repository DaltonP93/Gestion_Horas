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
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += '-03:00'; // naive → hora de Paraguay
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-PY', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
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

assert.strictEqual(failed, 0, `${failed} caso(s) de zona horaria fallaron`);
console.log('\n✅ Todas las marcaciones se muestran en hora de Paraguay.');
