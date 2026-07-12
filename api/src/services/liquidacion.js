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
 *  - Antigüedad: % (según CCT) sobre el básico.
 *  - Aporte obrero IPS: 9% sobre el imponible (básico + extras + antigüedad).
 *    La bonificación familiar NO es imponible.
 */

const DEFAULT_RATES = {
  divisorMensual: 240,      // salario mensual / (30 × 8)
  horasJornal: 8,           // horas de un jornal
  nocturnoDesde: 20 * 60,   // 20:00 en minutos
  nocturnoHasta: 6 * 60,    // 06:00 en minutos
  extraDiurnaMult: 1.5,     // 50%
  extraNocturnaMult: 2.0,   // 100%
  bonifFamiliarPct: 5,      // % del salario mínimo por hijo
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

/**
 * Calcula la liquidación de un empleado en el período.
 * @param emp  { pay_type, salary_base, children_count, antiguedad_rate, days:[{otMin,outMinutes}] }
 * @param dias días informados (de computeDiasTrabajados)
 * @param rates configuración (mezcla con DEFAULT_RATES)
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

  const bonifFamiliar = round((Number(emp.children_count) || 0) * (Number(r.salarioMinimo) || 0) * (r.bonifFamiliarPct / 100));
  const antiguedad = round(basico * (Number(emp.antiguedad_rate) || 0) / 100);

  const imponible = basico + montoExtraDiurna + montoExtraNocturna + antiguedad;
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
    bonif_familiar: bonifFamiliar,
    antiguedad,
    aporte_obrero: aporteObrero,
    total_bruto: totalBruto,
    total_neto: totalNeto,
  };
}

module.exports = { DEFAULT_RATES, nightOverlapMinutes, splitOvertime, computeLiquidacion, round };
