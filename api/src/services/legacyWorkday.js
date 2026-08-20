/**
 * legacyWorkday.js — El armado ANTERIOR de jornada, conservado tal cual.
 *
 * NO ES CÓDIGO VIVO. Ningún reporte lo usa. Existe para una sola cosa: que
 * `scripts/workday-engine-audit.js` pueda correr el algoritmo viejo y el nuevo
 * sobre los MISMOS marcajes reales y decir cuánto cambia y dónde.
 *
 * Sin esto, la única forma de contestar "¿qué números se mueven?" sería hacer
 * checkout de un commit anterior y comparar salidas a mano — que es
 * exactamente el trabajo que nadie hace antes de aprobar un cambio así.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * FIDELIDAD, INCLUIDOS LOS DEFECTOS
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Es una transcripción del código que estaba en `scheduler.js`, defectos
 * incluidos y a propósito. Si se "arreglara" algo acá, la auditoría dejaría de
 * medir contra lo que producción realmente hizo y pasaría a medir contra una
 * versión idealizada que nunca corrió. Se conservan:
 *
 *   - `toDate()`, que fija -03:00 sobre el DATETIME guardado;
 *   - el formateo con `Intl` y `America/Asuncion`, que aplica la tzdata
 *     histórica y corre una hora el invierno anterior al 2024-10-06;
 *   - el corte fijo a las 05:00 para asignar la "fecha laboral";
 *   - el emparejamiento por posición (par = entrada, impar = salida), que
 *     ignora `attendance_logs.type`;
 *   - la deduplicación por minuto.
 *
 * NO AGREGAR FUNCIONALIDAD ACÁ. Cuando el motor esté validado y el legacy ya
 * no haga falta como referencia, este archivo se borra entero.
 */

'use strict';

const TZ_PY = 'America/Asuncion';
const _dtfHour = new Intl.DateTimeFormat('es-PY', { timeZone: TZ_PY, hour: 'numeric', hour12: false });
const _dtfDate = new Intl.DateTimeFormat('es-PY', { timeZone: TZ_PY, year: 'numeric', month: '2-digit', day: '2-digit' });
const _dtfTime = new Intl.DateTimeFormat('es-PY', { timeZone: TZ_PY, hour: '2-digit', minute: '2-digit', hour12: false });

/** Marcas antes de esta hora se asignaban al turno del día anterior. */
const SHIFT_CUTOFF_HOUR = 5;

function pyHour(d) { return parseInt(_dtfHour.format(d), 10); }

function pyDateStr(d) {
  const parts = _dtfDate.formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function toDate(v) {
  if (v instanceof Date) return v;
  const s = String(v);
  if (!s.includes('T') && !s.endsWith('Z') && !s.includes('+')) {
    return new Date(s.replace(' ', 'T') + '-03:00');
  }
  return new Date(s);
}

function fmtTime(dt) {
  if (!dt) return '';
  return _dtfTime.format(toDate(dt));
}

/**
 * Filas del reporte legacy para un empleado.
 *
 * @returns {Array<{work_date, pairs, minutes}>} `work_date` es la "fecha
 *          laboral" que calculaba el legacy, con todo lo que eso arrastra.
 *
 * El filtro por período replica el `DATE(al.timestamp) BETWEEN ? AND ?` de la
 * consulta anterior: el legacy recortaba por la fecha de la MARCA, no por la
 * de la jornada, y por eso partía los turnos de los bordes.
 */
function buildLegacyRows(logs, { from, to } = {}) {
  const days = {};

  for (const log of logs || []) {
    const ts = toDate(log.timestamp);
    if (Number.isNaN(ts.getTime())) continue;

    // Recorte por fecha de marca, tal como lo hacía la consulta.
    const fechaMarca = pyDateStr(ts);
    if (from && fechaMarca < from) continue;
    if (to && fechaMarca > to) continue;

    const workDate = new Date(ts);
    if (pyHour(ts) < SHIFT_CUTOFF_HOUR) {
      workDate.setUTCDate(workDate.getUTCDate() - 1);
    }
    const date = pyDateStr(workDate);
    (days[date] = days[date] || []).push(ts);
  }

  const rows = [];
  for (const [dateStr, marks] of Object.entries(days).sort()) {
    marks.sort((a, b) => a - b);

    const deduped = [];
    for (const m of marks) {
      const last = deduped[deduped.length - 1];
      if (!last || Math.abs(m - last) > 60 * 1000) deduped.push(m);
    }

    const pairs = [];
    let minutes = 0;
    for (let i = 0; i < deduped.length; i += 2) {
      const entrada = deduped[i];
      const salida = deduped[i + 1];
      pairs.push({
        entrada: entrada ? fmtTime(entrada) : '',
        salida: salida ? fmtTime(salida) : '',
      });
      if (entrada && salida && salida > entrada) {
        minutes += Math.round((salida - entrada) / 60000);
      }
    }

    rows.push({ work_date: dateStr, pairs, minutes });
  }

  return rows;
}

module.exports = {
  buildLegacyRows,
  SHIFT_CUTOFF_HOUR,
};
