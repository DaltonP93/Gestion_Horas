/**
 * workdayEffectiveConfig.js — PRECEDENCIA explícita y auditable de la
 * configuración de jornada efectiva de un empleado en una fecha civil.
 *
 * Orden (mayor a menor prioridad), ÚNICA fuente de verdad de la precedencia:
 *
 *   1. published shift assignment      (turnera publicada, por día)
 *   2. employee historical override    (employee_schedule_history, snapshot)
 *   3. department historical default   (workday_config_defaults scope=department)
 *   4. company/general historical default (scope=company, luego scope=general)
 *   5. employee contract trace         (employee_contracts: identidad/vigencia)
 *   6. historical_fallback             (motor sin config)
 *
 * Las capas 1–2 ya las resuelve `workdayConfig.forDate` (turnera + ESH). Este
 * módulo AÑADE 3–5 e integra todo en un resultado con `layer`/`calculation_mode`
 * y trazabilidad. Es PURO respecto de la BD: opera sobre filas ya cargadas y
 * fechas civiles 'YYYY-MM-DD' (comparación lexicográfica = cronológica), así que
 * su salida NO depende de la timezone del proceso.
 *
 * INVARIANTE: sólo LEE/decide. No escribe, no recalcula daily_summary, no toca
 * att2000 ni inventa configuración a partir de datos ambiguos: sin evidencia
 * completa cae a la capa siguiente y, en última instancia, a historical_fallback.
 */

const LAYER = Object.freeze({
  PUBLISHED_SHIFT_ASSIGNMENT: 'published_shift_assignment',
  EMPLOYEE_HISTORICAL_OVERRIDE: 'employee_historical_override',
  DEPARTMENT_HISTORICAL_DEFAULT: 'department_historical_default',
  COMPANY_HISTORICAL_DEFAULT: 'company_historical_default',
  GENERAL_HISTORICAL_DEFAULT: 'general_historical_default',
  EMPLOYEE_CONTRACT_TRACE: 'employee_contract_trace',
  HISTORICAL_FALLBACK: 'historical_fallback',
});

// Orden canónico de precedencia (mayor → menor). Exportado para /precedence y UI.
const PRECEDENCE = Object.freeze([
  LAYER.PUBLISHED_SHIFT_ASSIGNMENT,
  LAYER.EMPLOYEE_HISTORICAL_OVERRIDE,
  LAYER.DEPARTMENT_HISTORICAL_DEFAULT,
  LAYER.COMPANY_HISTORICAL_DEFAULT,
  LAYER.GENERAL_HISTORICAL_DEFAULT,
  LAYER.EMPLOYEE_CONTRACT_TRACE,
  LAYER.HISTORICAL_FALLBACK,
]);

/** work_days 'a,b,c' (1..7) → array de enteros únicos válidos; [] si vacío. */
function parseWorkDays(value) {
  if (Array.isArray(value)) return value.map(Number).filter(n => n >= 1 && n <= 7);
  if (value == null || value === '') return [];
  return String(value).split(',').map(s => parseInt(s.trim(), 10)).filter(n => n >= 1 && n <= 7);
}

/**
 * Una configuración es COMPLETA (utilizable para modo `configured`) sólo si trae
 * entrada, salida y días laborables. Mismo criterio que employee_schedule_history
 * (config_incomplete). Sin esto, la capa NO habilita configured: se pasa a la
 * siguiente (no se inventa una jornada).
 */
function isCompleteConfig(cfg) {
  return !!(cfg && cfg.check_in && cfg.check_out && parseWorkDays(cfg.work_days).length > 0);
}

/**
 * De una lista de versiones (con `valid_from`/`valid_to` 'YYYY-MM-DD', valid_to
 * NULL = abierta), elige la VIGENTE en `dateISO`: la de `valid_from` más reciente
 * que cubre la fecha. Determinista, sin timezone.
 */
function pickVigente(rows, dateISO) {
  let best = null;
  for (const r of rows || []) {
    if (!r || !r.valid_from) continue;
    if (r.active === 0 || r.active === false) continue;
    if (r.valid_from > dateISO) continue;
    if (r.valid_to && r.valid_to < dateISO) continue;
    if (!best || r.valid_from > best.valid_from) best = r;
  }
  return best;
}

/**
 * Resolución PURA de la precedencia para UNA fecha. No accede a la BD.
 *
 * @param inputs {
 *   employeeLayer: { config, layer } | null,   // capas 1–2 ya resueltas (forDate)
 *   departmentDefault: cfgRow | null,          // capa 3 (vigente)
 *   companyDefault:    cfgRow | null,          // capa 4a (vigente)
 *   generalDefault:    cfgRow | null,          // capa 4b (vigente)
 *   contractTrace:     { contract_id } | null, // capa 5
 * }
 * @returns {
 *   layer, calculation_mode: 'configured'|'non_working'|'historical_fallback',
 *   config, contract_id, precedence_considered:[...]
 * }
 */
function resolveEffective(inputs = {}) {
  const considered = [];
  const el = inputs.employeeLayer || null;

  // Capa 1–2: forDate ya devolvió un cfg (turnera publicada o ESH), o marcó
  // no-laborable (off/vacaciones/permiso), o null.
  if (el && el.config) {
    considered.push(el.layer);
    const nonWorking = !!el.config.non_working;
    return {
      layer: el.layer,
      calculation_mode: nonWorking ? 'non_working' : 'configured',
      config: el.config,
      contract_id: inputs.contractTrace ? inputs.contractTrace.contract_id : (el.config.contract_id ?? null),
      precedence_considered: considered,
    };
  }
  if (el && el.layer) considered.push(el.layer); // se consideró pero no aplicó

  // Capas 3, 4a, 4b: defaults jerárquicos (departamento → empresa → general).
  const layered = [
    [LAYER.DEPARTMENT_HISTORICAL_DEFAULT, inputs.departmentDefault],
    [LAYER.COMPANY_HISTORICAL_DEFAULT, inputs.companyDefault],
    [LAYER.GENERAL_HISTORICAL_DEFAULT, inputs.generalDefault],
  ];
  for (const [layer, cfg] of layered) {
    considered.push(layer);
    if (isCompleteConfig(cfg)) {
      return {
        layer,
        calculation_mode: 'configured',
        config: { ...cfg, source: layer },
        contract_id: inputs.contractTrace ? inputs.contractTrace.contract_id : null,
        precedence_considered: considered,
      };
    }
  }

  // Capa 5: traza de contrato — identidad/vigencia, NO habilita configured (el
  // contrato dice QUIÉN, no CUÁNTO). Aporta contract_id para trazabilidad.
  if (inputs.contractTrace && inputs.contractTrace.contract_id != null) {
    considered.push(LAYER.EMPLOYEE_CONTRACT_TRACE);
    return {
      layer: LAYER.EMPLOYEE_CONTRACT_TRACE,
      calculation_mode: 'historical_fallback',
      config: null,
      contract_id: inputs.contractTrace.contract_id,
      precedence_considered: considered,
    };
  }

  // Capa 6: sin evidencia → historical_fallback.
  considered.push(LAYER.HISTORICAL_FALLBACK);
  return {
    layer: LAYER.HISTORICAL_FALLBACK,
    calculation_mode: 'historical_fallback',
    config: null,
    contract_id: null,
    precedence_considered: considered,
  };
}

module.exports = {
  LAYER,
  PRECEDENCE,
  parseWorkDays,
  isCompleteConfig,
  pickVigente,
  resolveEffective,
};
