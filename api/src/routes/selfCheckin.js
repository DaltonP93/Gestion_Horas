/**
 * selfCheckin.js — Auto-marcación por empleado (QR rotatorio + geolocalización).
 *
 *  POST /api/self-checkin/qr-token      (admin/hr)   → rota token de sede
 *  GET  /api/self-checkin/qr-token/:branchId/current → token vigente
 *  POST /api/self-checkin/mark          (empleado)   → marca con QR y/o geo
 */
const router = require('express').Router();
const crypto = require('crypto');
const { authenticate, authorize } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const logger = require('../config/logger');

router.use(authenticate);

const TOKEN_TTL_MIN = 5;

// Rotar/crear token QR de una sede
router.post('/qr-token', authorize('admin', 'hr', 'gth', 'super_admin'), async (req, res) => {
  try {
    const branchId = +(req.body.branch_id || req.query.branch_id);
    if (!branchId) return res.status(400).json({ error: 'branch_id requerido' });

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MIN * 60 * 1000);

    await sequelize.query(
      'INSERT INTO checkin_qr_tokens (branch_id, token, expires_at) VALUES (?, ?, ?)',
      { replacements: [branchId, token, expiresAt] }
    );
    res.json({ branch_id: branchId, token, expires_at: expiresAt, ttl_min: TOKEN_TTL_MIN });
  } catch (err) {
    logger.error(`self-checkin POST /qr-token: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno' });
  }
});

// Token vigente (para polling)
router.get('/qr-token/:branchId/current', authorize('admin', 'hr', 'gth', 'super_admin'), async (req, res) => {
  try {
    const branchId = +req.params.branchId;
    const [[row]] = await sequelize.query(`
      SELECT token, expires_at FROM checkin_qr_tokens
      WHERE branch_id = ? AND expires_at > NOW()
      ORDER BY id DESC LIMIT 1
    `, { replacements: [branchId] });
    if (!row) return res.json({ token: null });
    res.json({ branch_id: branchId, token: row.token, expires_at: row.expires_at });
  } catch (err) {
    logger.error(`self-checkin GET /qr-token/current: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno' });
  }
});

// Marcación empleado
router.post('/mark', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'No autenticado' });

    const { type, token, lat, lng, selfie } = req.body;
    if (!['in', 'out'].includes(type)) return res.status(400).json({ error: 'type debe ser in|out' });

    // Empleado asociado al usuario
    const [[emp]] = await sequelize.query(`
      SELECT e.id, e.branch_id, e.code
      FROM employees e
      JOIN users u ON u.employee_id = e.id
      WHERE u.id = ? AND e.status = 'active' LIMIT 1
    `, { replacements: [userId] });
    if (!emp) return res.status(403).json({ error: 'Usuario sin empleado vinculado' });

    let source = 'web';
    let validated = false;

    // Validación QR (si se envía)
    if (token) {
      const [[qr]] = await sequelize.query(`
        SELECT branch_id FROM checkin_qr_tokens
        WHERE token = ? AND expires_at > NOW() LIMIT 1
      `, { replacements: [token] });
      if (!qr) return res.status(400).json({ error: 'Token QR inválido o expirado' });
      if (emp.branch_id && qr.branch_id !== emp.branch_id)
        return res.status(403).json({ error: 'QR no corresponde a tu sede' });
      source = 'qr';
      validated = true;
    }

    // Validación geolocalización (si se envía). El modo (off/warn/enforce) es
    // parametrizable; en 'enforce' se rechaza fuera del radio, en 'warn' se
    // registra pero se permite. Se guarda el resultado para auditoría.
    let geoStatus = null, geoDist = null;
    if (lat != null && lng != null) {
      const geofence = require('../services/geofence');
      const gf = await geofence.check(emp.id, lat, lng);
      geoStatus = gf.status; geoDist = gf.distance;
      if (gf.blocked)
        return res.status(403).json({ error: `Fuera del rango permitido (${gf.distance}m > ${gf.fence.radius}m)` });
      if (gf.fence) {
        validated = true;
        if (source === 'web') source = 'geo';
      }
    }

    if (!validated)
      return res.status(400).json({ error: 'Se requiere QR o geolocalización válida' });

    // Guardar selfie si fue enviado (PNG dataURL)
    let selfieUrl = null;
    if (selfie && /^data:image\/(png|jpeg);base64,/.test(selfie)) {
      try {
        const path = require('path');
        const fs = require('fs');
        const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'));
        const SELFIE_DIR = path.join(UPLOAD_DIR, 'selfies');
        if (!fs.existsSync(SELFIE_DIR)) fs.mkdirSync(SELFIE_DIR, { recursive: true });
        const isPng = selfie.startsWith('data:image/png');
        const ext = isPng ? 'png' : 'jpg';
        const base64 = selfie.replace(/^data:image\/(png|jpeg);base64,/, '');
        const buf = Buffer.from(base64, 'base64');
        if (buf.length > 800 * 1024) {
          return res.status(413).json({ error: 'Selfie demasiado grande (>800 KB)' });
        }
        const filename = `selfie_${emp.id}_${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(SELFIE_DIR, filename), buf);
        selfieUrl = `/uploads/selfies/${filename}`;
      } catch (e) {
        // Si falla el guardado, continuamos sin selfie pero registramos el marcaje
        selfieUrl = null;
      }
    }

    const ua = (req.headers['user-agent'] || '').slice(0, 255);
    // Geolocalización canónica en latitude/longitude (mismas columnas que el
    // marcaje móvil), para que reportes y exports lean un único par.
    await sequelize.query(`
      INSERT INTO attendance_logs (employee_id, timestamp, type, source, selfie_url, latitude, longitude, user_agent, raw_data, geofence_status, distance_m)
      VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, { replacements: [
      emp.id, type, source, selfieUrl,
      lat != null ? +lat : null,
      lng != null ? +lng : null,
      ua,
      JSON.stringify({ self_checkin: true, user_id: userId, has_selfie: !!selfieUrl }),
      geoStatus, geoDist,
    ] });

    res.json({ ok: true, source, type, employee_id: emp.id, code: emp.code, selfie_url: selfieUrl });
  } catch (err) {
    logger.error(`self-checkin POST /mark: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/self-checkin/geofence — perímetro y modo para el empleado del
// usuario, para que la app pueda mostrar el estado dentro/fuera antes de marcar.
router.get('/geofence', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'No autenticado' });
    const [[emp]] = await sequelize.query(
      "SELECT e.id FROM employees e JOIN users u ON u.employee_id = e.id WHERE u.id = ? AND e.status = 'active' LIMIT 1",
      { replacements: [userId] }
    );
    if (!emp) return res.status(403).json({ error: 'Usuario sin empleado vinculado' });
    const geofence = require('../services/geofence');
    const { mode, default_radius_m } = await geofence.getConfig();
    const fence = await geofence.getEmployeeFence(emp.id, default_radius_m);
    res.json({ mode, fence });
  } catch (err) {
    logger.error(`self-checkin GET /geofence: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
