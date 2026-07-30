/**
 * paymentTypes.js — ABM de la tabla `payment_types` (catálogo de
 * "tipo de pago" administrable desde la UI).
 *
 * Endpoints:
 *   GET    /api/payment-types                 lista completa (activos + inactivos)
 *   POST   /api/payment-types                 crear
 *   PATCH  /api/payment-types/:id             actualizar name/description/active/sort_order
 *   DELETE /api/payment-types/:id             hard-delete (bloqueado si está en uso)
 *
 * Autorización:
 *   - Lectura: cualquier usuario autenticado (para poblar selectores).
 *   - Escritura: super_admin / admin (o quien tenga permiso configurado
 *     mediante `requirePermission('payment_types', 'manage')` — se declara
 *     como sub-permiso; el catálogo de permisos ya conoce nombres libres).
 *
 * Reglas:
 *   - `code` inmutable después de crear (para no romper referencias en
 *     `employees.pay_type`); si se necesita renombrarlo se hace vía SQL
 *     con `UPDATE employees SET pay_type = ...` en un mantenimiento.
 *   - No se puede eliminar un código en uso: 409. El admin puede
 *     desactivarlo (`active = 0`), lo que lo saca del selector pero deja
 *     intactos los empleados que ya lo tenían.
 *   - Nombres y códigos únicos (constraint DB + validación).
 *   - Auditoría en cada mutación.
 */

const router = require('express').Router();
const Joi = require('joi');
const { authenticate, authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const { sequelize } = require('../config/database');
const paymentTypes = require('../services/paymentTypes');
const audit = require('../services/audit');

router.use(authenticate);

// Solo super_admin/admin/gth/hr pueden administrar el catálogo.
// La UI oculta el botón "+" cuando el rol no está incluido.
const canManage = authorize('super_admin', 'admin', 'gth', 'hr');

const codeRex = /^[a-z][a-z0-9_]{0,39}$/;

const createSchema = Joi.object({
  code:        Joi.string().pattern(codeRex).required(),
  name:        Joi.string().trim().min(1).max(120).required(),
  description: Joi.string().trim().max(500).allow(null, ''),
  active:      Joi.boolean().default(true),
  sort_order:  Joi.number().integer().min(0).default(0),
});

const updateSchema = Joi.object({
  name:        Joi.string().trim().min(1).max(120),
  description: Joi.string().trim().max(500).allow(null, ''),
  active:      Joi.boolean(),
  sort_order:  Joi.number().integer().min(0),
}).min(1);

router.get('/', asyncHandler(async (_req, res) => {
  const rows = await paymentTypes.listAll();
  res.json({ data: rows });
}));

router.post('/', canManage, validate(createSchema), asyncHandler(async (req, res) => {
  const { code, name, description, active, sort_order } = req.body;
  try {
    const [result] = await sequelize.query(
      `INSERT INTO payment_types (code, name, description, active, sort_order, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      { replacements: [
        code, name, description || null, active ? 1 : 0,
        Number(sort_order) || 0, req.user?.id || null,
      ] }
    );
    paymentTypes.invalidateCache();
    audit.log({
      req, user: req.user,
      action: 'payment_type.create',
      entity: 'payment_type', entity_id: result.insertId,
      details: { code, name, active: !!active, sort_order },
    });
    res.status(201).json({ id: result.insertId, code, name, description: description || null, active: !!active, sort_order });
  } catch (err) {
    if (String(err.original?.code || err.parent?.code || '').startsWith('ER_DUP')) {
      return res.status(409).json({ error: 'Código o nombre ya en uso' });
    }
    throw err;
  }
}));

router.patch('/:id', canManage, validate(updateSchema), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const [[prev]] = await sequelize.query(
    'SELECT id, code, name, description, active, sort_order FROM payment_types WHERE id = ?',
    { replacements: [id] }
  );
  if (!prev) return res.status(404).json({ error: 'Tipo de pago no encontrado' });

  const sets = [];
  const vals = [];
  const diff = {};
  for (const [k, v] of Object.entries(req.body)) {
    const newVal = k === 'active' ? (v ? 1 : 0) : v;
    if (String(prev[k]) === String(newVal)) continue;
    sets.push(`${k} = ?`);
    vals.push(newVal);
    diff[k] = { from: prev[k], to: newVal };
  }
  if (!sets.length) return res.json({ ok: true, changed: false });

  try {
    await sequelize.query(
      `UPDATE payment_types SET ${sets.join(', ')} WHERE id = ?`,
      { replacements: [...vals, id] }
    );
  } catch (err) {
    if (String(err.original?.code || err.parent?.code || '').startsWith('ER_DUP')) {
      return res.status(409).json({ error: 'Nombre ya en uso' });
    }
    throw err;
  }
  paymentTypes.invalidateCache();
  audit.log({
    req, user: req.user,
    action: 'payment_type.update',
    entity: 'payment_type', entity_id: id,
    details: { code: prev.code, diff },
  });
  res.json({ ok: true, changed: true });
}));

router.delete('/:id', canManage, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const [[row]] = await sequelize.query(
    'SELECT id, code, name FROM payment_types WHERE id = ?', { replacements: [id] }
  );
  if (!row) return res.status(404).json({ error: 'Tipo de pago no encontrado' });

  const used = await paymentTypes.countUsage(row.code);
  if (used > 0) {
    return res.status(409).json({
      error: `No se puede eliminar: hay ${used} empleado(s) con este tipo de pago. Desactívelo en su lugar.`,
      in_use: used,
    });
  }
  await sequelize.query('DELETE FROM payment_types WHERE id = ?', { replacements: [id] });
  paymentTypes.invalidateCache();
  audit.log({
    req, user: req.user,
    action: 'payment_type.delete',
    entity: 'payment_type', entity_id: id,
    details: { code: row.code, name: row.name },
  });
  res.json({ ok: true });
}));

module.exports = router;
