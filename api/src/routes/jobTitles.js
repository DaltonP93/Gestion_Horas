/**
 * jobTitles.js — ABM de la tabla `job_titles` (catálogo de cargos
 * administrable desde la UI).
 *
 * Endpoints:
 *   GET    /api/job-titles       lista completa (activos + inactivos)
 *   POST   /api/job-titles       crear
 *   PATCH  /api/job-titles/:id   actualizar name/description/active/sort_order
 *   DELETE /api/job-titles/:id   hard-delete (bloqueado si está en uso)
 *
 * Autorización:
 *   - Lectura: cualquier usuario autenticado (para poblar selectores).
 *   - Escritura: super_admin / admin / gth / hr.
 *
 * Diferencia con /api/payment-types: acá el nombre SÍ se puede renombrar,
 * porque `employees.position` guarda ese mismo texto. Un rename se
 * propaga en la misma transacción a las fichas que tenían el nombre
 * anterior; si no, quedarían apuntando a un cargo inexistente.
 *
 * No se puede eliminar un cargo en uso: 409. Desactivarlo lo saca del
 * selector y deja intactas las fichas que ya lo tenían.
 */

const router = require('express').Router();
const Joi = require('joi');
const { authenticate, authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const { sequelize } = require('../config/database');
const jobTitles = require('../services/jobTitles');
const audit = require('../services/audit');

router.use(authenticate);

const canManage = authorize('super_admin', 'admin', 'gth', 'hr');

const createSchema = Joi.object({
  name:        Joi.string().trim().min(1).max(100).required(),
  description: Joi.string().trim().max(500).allow(null, ''),
  active:      Joi.boolean().default(true),
  sort_order:  Joi.number().integer().min(0).default(0),
});

const updateSchema = Joi.object({
  name:        Joi.string().trim().min(1).max(100),
  description: Joi.string().trim().max(500).allow(null, ''),
  active:      Joi.boolean(),
  sort_order:  Joi.number().integer().min(0),
}).min(1);

router.get('/', asyncHandler(async (_req, res) => {
  const rows = await jobTitles.listAll();
  res.json({ data: rows });
}));

router.post('/', canManage, validate(createSchema), asyncHandler(async (req, res) => {
  const { name, description, active, sort_order } = req.body;
  try {
    const [result] = await sequelize.query(
      `INSERT INTO job_titles (name, description, active, sort_order, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      { replacements: [
        name, description || null, active ? 1 : 0,
        Number(sort_order) || 0, req.user?.id || null,
      ] }
    );
    jobTitles.invalidateCache();
    audit.log({
      req, user: req.user,
      action: 'job_title.create',
      entity: 'job_title', entity_id: result.insertId,
      details: { name, active: !!active, sort_order },
    });
    res.status(201).json({
      id: result.insertId, name, description: description || null,
      active: !!active, sort_order: Number(sort_order) || 0,
    });
  } catch (err) {
    if (String(err.original?.code || err.parent?.code || '').startsWith('ER_DUP')) {
      return res.status(409).json({ error: 'Ya existe un cargo con ese nombre' });
    }
    throw err;
  }
}));

router.patch('/:id', canManage, validate(updateSchema), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const [[prev]] = await sequelize.query(
    'SELECT id, name, description, active, sort_order FROM job_titles WHERE id = ?',
    { replacements: [id] }
  );
  if (!prev) return res.status(404).json({ error: 'Cargo no encontrado' });

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

  // Un rename tiene que arrastrar a las fichas: `employees.position` guarda
  // este mismo texto, así que renombrar sin propagar dejaría a esos
  // empleados con un cargo que ya no está en el catálogo.
  const renamed = Object.prototype.hasOwnProperty.call(diff, 'name');
  const tx = await sequelize.transaction();
  let movedEmployees = 0;
  try {
    await sequelize.query(
      `UPDATE job_titles SET ${sets.join(', ')} WHERE id = ?`,
      { replacements: [...vals, id], transaction: tx }
    );
    if (renamed) {
      const [result] = await sequelize.query(
        'UPDATE employees SET position = ? WHERE position = ?',
        { replacements: [diff.name.to, prev.name], transaction: tx }
      );
      movedEmployees = Number(result?.affectedRows ?? result?.changedRows ?? 0);
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    if (String(err.original?.code || err.parent?.code || '').startsWith('ER_DUP')) {
      return res.status(409).json({ error: 'Ya existe un cargo con ese nombre' });
    }
    throw err;
  }

  jobTitles.invalidateCache();
  audit.log({
    req, user: req.user,
    action: 'job_title.update',
    entity: 'job_title', entity_id: id,
    details: { name: prev.name, diff, employees_updated: movedEmployees },
  });
  res.json({ ok: true, changed: true, employees_updated: movedEmployees });
}));

router.delete('/:id', canManage, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const [[row]] = await sequelize.query(
    'SELECT id, name FROM job_titles WHERE id = ?', { replacements: [id] }
  );
  if (!row) return res.status(404).json({ error: 'Cargo no encontrado' });

  const used = await jobTitles.countUsage(row.name);
  if (used > 0) {
    return res.status(409).json({
      error: `No se puede eliminar: hay ${used} empleado(s) con este cargo. Desactívelo en su lugar.`,
      in_use: used,
    });
  }
  await sequelize.query('DELETE FROM job_titles WHERE id = ?', { replacements: [id] });
  jobTitles.invalidateCache();
  audit.log({
    req, user: req.user,
    action: 'job_title.delete',
    entity: 'job_title', entity_id: id,
    details: { name: row.name },
  });
  res.json({ ok: true });
}));

module.exports = router;
