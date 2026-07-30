/**
 * catalogs.js — Catálogos administrativos consumidos por la UI.
 *
 * PR-A: expone endpoints mínimos para que la ficha del empleado y otros
 * formularios dejen de hardcodear listas. Los valores por defecto se
 * mantienen aquí y coinciden con `employeeFieldValidation.PAYTYPES` para
 * conservar la fuente única de verdad de qué acepta el backend.
 *
 * PR-B: agregará ABM real (tabla + settings) y este endpoint pasará a leer
 * de DB, manteniendo el mismo shape para no romper la UI.
 */

const router = require('express').Router();
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// GET /api/catalogs/pay-types
// Listado de tipos de pago aceptados. Shape estable: { data: [{value,label,active}] }.
router.get('/pay-types', (_req, res) => {
  res.json({
    data: [
      { value: 'mensualizado', label: 'Mensualizado', active: true },
      { value: 'jornalero',    label: 'Jornalero',    active: true },
    ],
    source: 'builtin',
  });
});

module.exports = router;
