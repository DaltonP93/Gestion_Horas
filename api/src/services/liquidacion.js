/**
 * liquidacion.js — Motor de liquidación (montos para la planilla MTESS).
 *
 * Funciones puras y testeables. A partir del resumen mensual de un empleado
 * (días informados, horas extra por día con su hora de salida) calcula los
 * montos: salario básico, horas extra diurnas (50%) y nocturnas (100%),
 * bonificación familiar, antigüedad y aporte obrero IPS.
 *
 * Reglas Paraguay (configurables vía settings):
 *  - Valor hora mensualizado = salario / (30 días × 8 h) = salario / 240.
 *  - Hora extra diurna: valor hora × 1,5 (50%).
 *  - Hora extra nocturna: valor hora × 2 (100%).
 *  - Franja nocturna: 20:00–06:00.
 *  - Bonificación familiar: 5% del salario mínimo por hijo.
 *  - Antigüedad: `antiguedadPctPorAno` × años de antigüedad, sobre el básico.
 *    Desde PR-B los AÑOS se DERIVAN de `hire_date` a la fecha de referencia
 *    (fin del período). La columna legada `antiguedad_rate` se usa sólo
 *    como fallback si el empleado no tiene fecha de ingreso.
 *    Por defecto 1%/año — cada instalación ajusta según su CCT.
 *  - Aporte obrero IPS: 9% sobre el imponible (básico + extras + antigüedad).
 *    La bonificación familiar NO es imponible.
 */

const { computeAntiguedad } = require('./antiguedad');

const DEFAULT_RATES = {
  divisorMensual: 240,      // salario mensual / (30 × 8)
  horasJornal: 8,           // horas de un jornal
  nocturnoDesde: 20 * 60,   // 20:00 en minutos
  nocturnoHasta: 6 * 60,    // 06:00 en minutos
  extraDiurnaMult: 1.5,     // 50%
  extraNocturnaMult: 2.0,   // 100%
  recargoNocturnoPct: 30,   // % de recargo sobre horas ordinarias nocturnas
  plusNocturnoFeriados: true, // aplicar recargo nocturno también en feriados
  plusNocturnoFinde: true,    // aplicar recargo nocturno también en fin de semana
  bonifFamiliarPct: 5,      // % del salario mínimo por hijo
  antiguedadPctPorAno: 1,   // % del básico por año de antigüedad (CCT-dependiente)
  salarioMinimo: 0,         // referencia (settings salario_minimo)
  obreroPct: 9,             // % aporte obrero IPS
  baseMensual: 30,          // base de días para prorrateo
  prorratearBasico: true,   // prorratear el básico por días informados
};

function round(n) { return Math.round(Number(n) || 0); }
function overlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// Minutos de la ventana [winStart, winEnd] (en minutos absolutos, puede cruzar
// medianoche) que caen dentro de la franja nocturna diaria [nf, nt].
// La franja "envuelve" medianoche si nf > nt (ej. 20:00→06:00).
function nightOverlapMinutes(winStart, winEnd, nf, nt) {
  let total = 0;
  for (const base of [-1440, 0, 1440]) {
    if (nf < nt) {
      total += overlap(winStart, winEnd, base + nf, base + nt);
    } else {
      total += overlap(winStart, winEnd, base + nf, base + 1440);
      total += overlap(winStart, winEnd, base + 0, base + nt);
    }
  }
  return total;
}

// Divide los minutos de horas extra del mes en diurnas/nocturnas usando la
// hora de salida de cada día (la ventana de extra es [salida − extra, salida]).
// days: array de { otMin, outMinutes } (outMinutes = minutos desde medianoche
// de la última salida; puede ser null si no hay dato → se cuenta como diurna).
function splitOvertime(days, rates) {
  let noct = 0, total = 0;
  for (const d of days) {
    const ot = Number(d.otMin) || 0;
    if (ot <= 0) continue;
    total += ot;
    if (d.outMinutes == null) continue; // sin hora de salida → diurna
    const end = d.outMinutes;
    const start = end - ot;
    noct += nightOverlapMinutes(start, end, rates.nocturnoDesde, rates.nocturnoHasta);
  }
  const nocturnaMin = Math.min(noct, total);
  return { diurnaMin: total - nocturnaMin, nocturnaMin };
}

// ¿Se excluye el recargo nocturno de este día por ser feriado o fin de semana
// y estar desactivado el toggle correspondiente? (plus nocturno parametrizable)
function nightPlusExcluded(d, rates) {
  if (d.isHoliday && rates.plusNocturnoFeriados === false) return true;
  if (d.isWeekend && rates.plusNocturnoFinde === false) return true;
  return false;
}

// Minutos ORDINARIOS (no extra) trabajados dentro de la franja nocturna.
// Toma la ventana trabajada del día [entrada, salida] (ajustando si cruza
// medianoche), calcula su solapamiento nocturno y le resta la porción
// nocturna que ya es hora extra. Los días excluidos por los toggles de plus
// nocturno (feriados / fin de semana) no computan recargo.
function nightOrdinaryMinutes(days, rates, overtimeNocturnaMin) {
  let workedNight = 0;
  for (const d of days) {
    if (d.inMinutes == null || d.outMinutes == null) continue;
    if (nightPlusExcluded(d, rates)) continue;
    let end = d.outMinutes;
    if (end < d.inMinutes) end += 1440; // cruza medianoche
    workedNight += nightOverlapMinutes(d.inMinutes, end, rates.nocturnoDesde, rates.nocturnoHasta);
  }
  return Math.max(0, workedNight - (overtimeNocturnaMin || 0));
}

/**
 * Calcula la liquidación de un empleado en el período.
 * @param emp  { pay_type, salary_base, children_count, hire_date,
 *               antiguedad_rate (legacy fallback),
 *               days:[{otMin,outMinutes}] }
 * @param dias días informados (de computeDiasTrabajados)
 * @param rates configuración (mezcla con DEFAULT_RATES).
 *              Puede incluir `refDate` (YYYY-MM-DD) para calcular la
 *              antigüedad al cierre del período; default = hoy.
 */
function computeLiquidacion(emp, dias, rates = {}) {
  const r = { ...DEFAULT_RATES, ...rates };
  const salary = Number(emp.salary_base) || 0;
  const jornalero = emp.pay_type === 'jornalero';

  const valorHora = jornalero
    ? (r.horasJornal ? salary / r.horasJornal : 0)
    : (r.divisorMensual ? salary / r.divisorMensual : 0);

  const basico = jornalero
    ? round(salary * dias)
    : (r.prorratearBasico && r.baseMensual ? round(salary * dias / r.baseMensual) : round(salary));

  const { diurnaMin, nocturnaMin } = splitOvertime(emp.days || [], r);
  const montoExtraDiurna   = round(valorHora * (diurnaMin / 60) * r.extraDiurnaMult);
  const montoExtraNocturna = round(valorHora * (nocturnaMin / 60) * r.extraNocturnaMult);

  // Recargo nocturno sobre las horas ordinarias trabajadas de noche.
  const nocturnoOrdMin = nightOrdinaryMinutes(emp.days || [], r, nocturnaMin);
  const recargoNocturno = round(valorHora * (nocturnoOrdMin / 60) * (r.recargoNocturnoPct / 100));

  const bonifFamiliar = round((Number(emp.children_count) || 0) * (Number(r.salarioMinimo) || 0) * (r.bonifFamiliarPct / 100));
  // Antigüedad: preferimos derivarla de hire_date (fuente única desde PR-B).
  // Fallback al valor legado `antiguedad_rate` si no hay fecha o el cálculo
  // no fue posible, para no romper empleados históricos hasta que RRHH cargue
  // la fecha de ingreso. La política CCT se aplica vía `antiguedadPctPorAno`.
  let antiguedadAnios = 0;
  if (emp.hire_date) {
    const a = computeAntiguedad(emp.hire_date, r.refDate);
    if (a) antiguedadAnios = a.years;
  }
  if (!antiguedadAnios && emp.antiguedad_rate != null) {
    antiguedadAnios = Number(emp.antiguedad_rate) || 0;
  }
  const antiguedad = round(basico * antiguedadAnios * (Number(r.antiguedadPctPorAno) || 0) / 100);

  const imponible = basico + montoExtraDiurna + montoExtraNocturna + recargoNocturno + antiguedad;
  const aporteObrero = round(imponible * (r.obreroPct / 100));

  const totalBruto = imponible + bonifFamiliar;
  const totalNeto = totalBruto - aporteObrero;

  return {
    valor_hora: round(valorHora),
    dias,
    basico,
    ot_diurna_horas: +(diurnaMin / 60).toFixed(2),
    ot_nocturna_horas: +(nocturnaMin / 60).toFixed(2),
    monto_extra_diurna: montoExtraDiurna,
    monto_extra_nocturna: montoExtraNocturna,
    recargo_nocturno: recargoNocturno,
    bonif_familiar: bonifFamiliar,
    antiguedad,
    aporte_obrero: aporteObrero,
    total_bruto: totalBruto,
    total_neto: totalNeto,
  };
}

module.exports = { DEFAULT_RATES, nightOverlapMinutes, splitOvertime, nightOrdinaryMinutes, computeLiquidacion, round };
