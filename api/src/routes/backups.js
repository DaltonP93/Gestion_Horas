/**
 * backups.js — endpoints para gestión de backups manuales y descarga.
 */
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { authenticate, authorize } = require('../middleware/auth');
const { BACKUP_DIR, runBackupWithUpload, listBackups, purgeOldBackups } = require('../services/backups');

router.use(authenticate);
router.use(authorize('admin', 'super_admin'));

// GET /api/backups — listado de backups disponibles
router.get('/', async (_req, res) => {
  try {
    const files = await listBackups();
    res.json({ ok: true, backups: files, retention_days: parseInt(process.env.BACKUP_RETENTION_DAYS || '14', 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/backups — generar backup manual (+ upload off-site si está configurado)
router.post('/', async (_req, res) => {
  try {
    const result = await runBackupWithUpload();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/backups/purge — borrar backups viejos según retención
router.post('/purge', async (_req, res) => {
  try {
    const removed = await purgeOldBackups();
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Rutas literales ────────────────────────────────────────────
// Express resuelve por ORDEN de registro: una ruta paramétrica declarada
// antes que una literal se queda con la literal. `GET /:filename` estaba
// registrada acá arriba y capturaba `GET /offsite-config`, que no pasaba el
// regex de nombre y respondía 400 «Nombre inválido»: la pantalla de
// configuración off-site no podía leer su configuración.
//
// Las paramétricas van al final del archivo. No agregar ninguna antes.

// ── Backup off-site config ─────────────────────────────────────
const OFFSITE_KEYS = [
  'backup_upload_provider',
  'backup_s3_endpoint','backup_s3_bucket','backup_s3_access_key',
  'backup_s3_secret_key','backup_s3_region','backup_s3_path_prefix',
  'backup_sftp_host','backup_sftp_port','backup_sftp_user',
  'backup_sftp_password','backup_sftp_key','backup_sftp_remote_dir',
];

router.get('/offsite-config', async (_req, res) => {
  try {
    const { getUploadConfig } = require('../services/backupUpload');
    const cfg = await getUploadConfig();
    // Mask secrets
    if (cfg.s3?.secretKey)   cfg.s3.secretKey   = cfg.s3.secretKey   ? '***' : '';
    if (cfg.sftp?.password)  cfg.sftp.password  = cfg.sftp.password  ? '***' : '';
    res.json({ ok: true, ...cfg });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/offsite-config', async (req, res) => {
  const { sequelize } = require('../config/database');
  const body = req.body || {};
  const map = {
    backup_upload_provider:   body.provider,
    backup_s3_endpoint:       body.s3_endpoint,
    backup_s3_bucket:         body.s3_bucket,
    backup_s3_access_key:     body.s3_access_key,
    backup_s3_region:         body.s3_region,
    backup_s3_path_prefix:    body.s3_prefix,
    backup_sftp_host:         body.sftp_host,
    backup_sftp_port:         body.sftp_port,
    backup_sftp_user:         body.sftp_user,
    backup_sftp_remote_dir:   body.sftp_remote_dir,
  };
  // Only update secrets if not masked
  if (body.s3_secret_key  && body.s3_secret_key  !== '***') map.backup_s3_secret_key  = body.s3_secret_key;
  if (body.sftp_password  && body.sftp_password  !== '***') map.backup_sftp_password   = body.sftp_password;
  if (body.sftp_key)                                          map.backup_sftp_key        = body.sftp_key;

  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined && v !== null) {
      await sequelize.query(
        `INSERT INTO system_settings (key_name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)`,
        { replacements: [k, String(v)] }
      );
    }
  }
  res.json({ ok: true });
});

// POST /api/backups/offsite-test — test upload con el último backup
router.post('/offsite-test', async (_req, res) => {
  try {
    const files = await listBackups();
    if (!files.length) return res.status(400).json({ error: 'No hay backups para probar' });
    const { uploadBackup } = require('../services/backupUpload');
    const f = files[0];
    const fp = require('path').join(BACKUP_DIR, f.filename);
    const result = await uploadBackup(fp, f.filename);
    res.json({ ok: true, result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/backups — generar backup manual (con upload off-site)
// (override para usar runBackupWithUpload)

// ── Rutas paramétricas — SIEMPRE al final ──────────────────────
// Cualquier ruta literal declarada DESPUÉS de éstas sería inalcanzable.

// GET /api/backups/:filename — descargar archivo
router.get('/:filename', async (req, res) => {
  const f = path.basename(req.params.filename); // evita path traversal
  if (!/^asistencia_[\w\-]+\.sql\.gz$/.test(f)) return res.status(400).json({ error: 'Nombre inválido' });
  const fp = path.resolve(BACKUP_DIR, f);
  // Double-check que el archivo resuelto sigue dentro de BACKUP_DIR
  if (!fp.startsWith(path.resolve(BACKUP_DIR) + path.sep)) return res.status(400).json({ error: 'Ruta inválida' });
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Backup no encontrado' });
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${f}"`);
  fs.createReadStream(fp).pipe(res);
});

// DELETE /api/backups/:filename
router.delete('/:filename', async (req, res) => {
  const f = req.params.filename;
  if (!/^asistencia_.*\.sql\.gz$/.test(f)) return res.status(400).json({ error: 'Nombre inválido' });
  const fp = path.join(BACKUP_DIR, f);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Backup no encontrado' });
  try { fs.unlinkSync(fp); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
