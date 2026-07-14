/**
 * ruleRuntime.js — Consumo en runtime de las reglas del constructor de
 * condiciones. Carga las reglas ACTIVAS de un módulo desde condition_rules y
 * las evalúa contra contextos reales (hechos de cada entidad) usando el motor
 * puro ruleEngine.
 *
 * Devuelve las reglas que disparan junto con su acción, para que un consumidor
 * (endpoint de alertas, cron, etc.) las muestre o actúe.
 */
const { sequelize } = require('../config/database');
const engine = require('./ruleEngine');

function parseJSON(v, def) {
  if (v == null) return def;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return def; }
}

// Reglas activas de un módulo, normalizadas y ordenadas por prioridad.
async function getActiveRules(module) {
  if (!engine.MODULE_KEYS.includes(module)) return [];
  const [rows] = await sequelize.query(
    'SELECT * FROM condition_rules WHERE active = 1 AND module = ? ORDER BY priority, id',
    { replacements: [module] }
  );
  return rows.map(r => ({
    id: r.id, name: r.name, module: r.module,
    match_type: r.match_type,
    conditions: parseJSON(r.conditions, []),
    action_type: r.action_type,
    action_params: parseJSON(r.action_params, {}),
    priority: r.priority,
  }));
}

// Evalúa un set de reglas ya cargadas contra un contexto; devuelve las que
// disparan (con su acción) vía el motor puro.
function evaluate(rules, context) {
  return engine.evaluateRules(rules, context);
}

// Conveniencia: carga las reglas activas del módulo y evalúa un contexto.
async function evaluateModule(module, context) {
  const rules = await getActiveRules(module);
  return evaluate(rules, context);
}

module.exports = { getActiveRules, evaluate, evaluateModule };
