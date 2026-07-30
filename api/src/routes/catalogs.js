/**
 * catalogs.js — Catálogos administrativos consumidos por la UI.
 *
 * PR-A: expuso endpoints mínimos con datos hardcodeados.
 * PR-B: `pay-types` pasa a leer del catálogo administrable
 * `payment_types` (tabla + ABM en /api/payment-types).
 * Se mantiene el mismo shape para no romper consumidores.
 */

const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const paymentTypes = require('../services/paymentTypes');
const { asyncHandler } = require('../utils/asyncHandler');

router.use(authenticate);

// GET /api/catalogs/pay-types
// Listado de tipos de pago activos. Shape estable: { data: [{value,label,active}] }.
router.get('/pay-types', asyncHandler(async (_req, res) => {
  try {
    const rows = await paymentTypes.listAll({ activeOnly: true });
    res.json({
      data: rows.map(r => ({ value: r.code, label: r.name, active: !!Number(r.active) })),
      source: 'payment_types',
    });
  } catch {
    // Degradado: si la tabla aún no existe (migración pendiente) devolvemos
    // el par mínimo original para no romper la UI en primer boot.
    res.json({
      data: [
        { value: 'mensualizado', label: 'Mensualizado', active: true },
        { value: 'jornalero',    label: 'Jornalero',    active: true },
      ],
      source: 'builtin',
    });
  }
}));

module.exports = router;
