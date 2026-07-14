/**
 * settings.js
 * Configuración general del sistema (branding, tema, login, UX).
 * Almacenado en notification_settings como key → value.
 */
const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const audit = require('../services/audit');

// ─── Keys permitidas ────────────────────────────────────────────
// Branding base
const BRANDING_KEYS = [
  'system_name', 'system_company',
  'system_logo_url', 'system_favicon_url',
  'system_pwa_icon_url',             // icono PWA personalizado (manifest.webmanifest)
  'system_login_bg',                 // gradient tailwind (fallback)
  'system_login_bg_image',           // URL local /uploads/*.jpg (preferido)
  'system_login_title', 'system_login_subtitle',
];

// Tema / colores (granular)
const THEME_KEYS = [
  'system_primary_color',            // botón primario / acentos
  'system_secondary_color',          // hover / accent
  'system_accent_color',             // highlights
  'system_sidebar_bg',               // fondo sidebar (hex)
  'system_sidebar_text',             // texto sidebar
  'system_sidebar_active',           // activo sidebar
  'system_theme_mode',               // 'light' | 'dark' | 'auto'
  'system_font_family',              // 'Inter' | 'Roboto' | 'Poppins'
  'system_border_radius',            // 'sm' | 'md' | 'lg' | 'xl'
  // ─── Estilo global de interfaz (personalización de UI) ───────
  'system_ui_style',                 // 'liquidglass'|'glassmorphism'|'maximalismo'|'minimalismo'|'spatial'|'claymorphism'|'brutalismo'
  'system_ui_accent',                // hex del acento principal (ej. #22d3ee)
  'system_ui_density',               // 'compact' | 'comfortable' | 'spacious'
  'system_ui_motion',                // '1' | '0' — animaciones/micro-interacciones
];

// Layout / UX login
const LOGIN_KEYS = [
  'system_login_layout',             // 'center' | 'left' | 'right' | 'split'
  'system_login_show_datetime',      // '1' | '0'
  'system_login_show_weather',       // '1' | '0' (placeholder futuro)
  'system_login_glass',              // '1' | '0' — efecto glassmorphism
  'system_login_footer',             // texto pie de página
];

// Firma digital de planillas
const SIGNATURE_KEYS = [
  'system_signature_url',          // /uploads/firma.png
  'system_signer_name',            // Juan Pérez
  'system_signer_position',        // Gerente de RRHH
  'system_signer_doc_id',          // C.I. 1234567
  'system_seal_url',               // /uploads/sello.png (opcional)
];

// Empleados / display
const DISPLAY_KEYS = [
  'employee_display_mode',           // 'full_name' | 'code_name' | 'code_only'
  'system_date_format',              // 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'MM/DD/YYYY'
  'system_time_format',              // '24h' | '12h'
  'system_timezone',                 // 'America/Asuncion' etc
  'system_locale',                   // 'es-PY' | 'es-ES' | 'en-US'
];

// Datos del empleador — para el encabezado de las planillas legales (MTESS/IPS)
const EMPLOYER_KEYS = [
  'employer_razon_social',           // Razón social / nombre de la empresa
  'employer_ruc',                    // RUC
  'employer_ips_patronal',           // N° patronal IPS
  'employer_mtess_registro',         // N° de registro patronal en el MTESS
  'employer_actividad',              // Actividad económica
  'employer_domicilio',              // Domicilio
  'employer_ciudad',                 // Ciudad
  'employer_telefono',               // Teléfono
  'employer_representante',          // Representante legal
  'ips_rate_obrero',                 // % aporte obrero IPS (default 9)
  'ips_rate_patronal',               // % aporte patronal IPS (default 16.5)
  'salario_minimo',                  // salario mínimo legal vigente (referencia)
  'mtess_dias_base_mensual',         // base de días para mensualizados (default 30)
  'mtess_dias_descuento_tipos',      // tipos de ausencia que descuentan días (lista)
  'mtess_prorratear_basico',         // prorratear básico por días informados (1/0)
  'hora_divisor_mensual',            // divisor para el valor hora mensual (default 240)
  'nocturno_desde',                  // inicio franja nocturna HH:MM (default 20:00)
  'nocturno_hasta',                  // fin franja nocturna HH:MM (default 06:00)
  'extra_diurna_mult',               // multiplicador hora extra diurna (default 1.5)
  'extra_nocturna_mult',             // multiplicador hora extra nocturna (default 2)
  'recargo_nocturno_pct',            // % recargo horas ordinarias nocturnas (default 30)
  'plus_nocturno_feriados',          // aplicar recargo nocturno en feriados (1/0, default 1)
  'plus_nocturno_finde',             // aplicar recargo nocturno en fin de semana (1/0, default 1)
  'bonif_familiar_pct',              // % del salario mínimo por hijo (default 5)
  'att_overtime_requires_auth',      // '1' = las horas extra requieren aprobación
  'att_early_mark_alert_min',        // umbral de entrada temprana que alerta (default 30)
  'att_late_mark_alert_min',         // umbral de salida tardía que alerta (default 30)
  'vacation_day_type',               // conteo de vacaciones: 'habiles' | 'corridos'
  'contract_types',                  // tipos de contrato (lista separada por comas)
  'contract_expiry_alert_days',      // anticipación de alerta de vencimiento (default 30)
  'probation_alert_days',            // anticipación de alerta de fin de prueba (default 7)
];

const SETTING_KEYS = [
  ...BRANDING_KEYS,
  ...THEME_KEYS,
  ...LOGIN_KEYS,
  ...DISPLAY_KEYS,
  ...SIGNATURE_KEYS,
  ...EMPLOYER_KEYS,
];

// ─── Defaults ───────────────────────────────────────────────────
const DEFAULTS = {
  system_name: 'Sistema de Asistencia',
  system_company: '',
  system_logo_url: '',
  system_favicon_url: '',
  system_pwa_icon_url: '',
  system_login_bg: 'from-slate-900 to-blue-900',
  system_login_bg_image: '',
  system_login_title: 'Sistema de Asistencia',
  system_login_subtitle: 'Recursos Humanos',

  system_primary_color: '#2563eb',
  system_secondary_color: '#1e40af',
  system_accent_color: '#8b5cf6',
  system_sidebar_bg: '#0f172a',
  system_sidebar_text: '#94a3b8',
  system_sidebar_active: '#2563eb',
  system_theme_mode: 'light',
  system_font_family: 'Inter',
  system_border_radius: 'lg',

  system_login_layout: 'center',
  system_login_show_datetime: '1',
  system_login_show_weather: '0',
  system_login_glass: '1',
  system_login_footer: '',

  employee_display_mode: 'full_name',
  system_date_format: 'DD/MM/YYYY',
  system_time_format: '24h',
  system_timezone: 'America/Asuncion',
  system_locale: 'es-PY',
};

// ─── GET /api/settings ──────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT setting_key, setting_value FROM notification_settings
       WHERE setting_key IN (${SETTING_KEYS.map(() => '?').join(',')})`,
      { replacements: SETTING_KEYS }
    );
    const settings = { ...DEFAULTS };
    for (const row of rows) settings[row.setting_key] = row.setting_value;
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/settings ──────────────────────────────────────────
router.put('/', authenticate, authorize('admin', 'gth', 'gestor'), requirePermission('configuracion', 'update'), async (req, res) => {
  try {
    const updates = req.body || {};
    let count = 0;
    for (const [key, value] of Object.entries(updates)) {
      if (!SETTING_KEYS.includes(key)) continue;
      await sequelize.query(
        `INSERT INTO notification_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        { replacements: [key, value == null ? '' : String(value)] }
      );
      count++;
    }
    audit.log({ req, user: req.user, action: 'settings_update', entity: 'settings',
      details: { keys: Object.keys(updates).filter(k => SETTING_KEYS.includes(k)) } });
    res.json({ ok: true, count, message: `${count} configuración(es) guardada(s)` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/settings/reset ───────────────────────────────────
router.post('/reset', authenticate, authorize('admin', 'gth'), requirePermission('configuracion', 'update'), async (req, res) => {
  try {
    await sequelize.query(
      `DELETE FROM notification_settings WHERE setting_key IN (${SETTING_KEYS.map(() => '?').join(',')})`,
      { replacements: SETTING_KEYS }
    );
    res.json({ ok: true, message: 'Apariencia restaurada a valores por defecto' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Uploads locales (logo, favicon, bg) ────────────────────────
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'));
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = crypto.randomBytes(6).toString('hex');
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

const ALLOWED_MIME = [
  'image/png', 'image/jpeg', 'image/jpg',
  'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon',
  'image/gif',
];

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

// POST /api/settings/signature-canvas — guarda PNG dataURL como /uploads/firma_*.png
router.post('/signature-canvas',
  authenticate, authorize('admin', 'gth'),
  requirePermission('configuracion', 'update'),
  async (req, res) => {
    try {
      const { dataUrl, kind = 'signature' } = req.body || {};
      if (!dataUrl || !/^data:image\/png;base64,/.test(dataUrl)) {
        return res.status(400).json({ error: 'dataUrl PNG requerido' });
      }
      if (kind !== 'signature' && kind !== 'seal') {
        return res.status(400).json({ error: 'kind inválido (signature|seal)' });
      }
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.length > 1024 * 1024) {
        return res.status(413).json({ error: 'Imagen demasiado grande (>1 MB)' });
      }
      const filename = `${kind}_${Date.now()}.png`;
      const fs = require('fs');
      const fp = path.join(UPLOAD_DIR, filename);
      fs.writeFileSync(fp, buffer);
      const publicUrl = `/uploads/${filename}`;
      const key = kind === 'signature' ? 'system_signature_url' : 'system_seal_url';
      await sequelize.query(
        `INSERT INTO notification_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        { replacements: [key, publicUrl] }
      );
      res.json({ ok: true, url: publicUrl, key });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Magic bytes → tipo real de imagen (independiente del MIME del header)
const IMAGE_SIGNATURES = [
  { mime: 'image/png',  bytes: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/gif',  bytes: [0x47, 0x49, 0x46] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
  { mime: 'image/x-icon', bytes: [0x00, 0x00, 0x01, 0x00] },
];
function checkMagicBytes(filePath) {
  const buf = Buffer.alloc(8);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buf, 0, 8, 0);
  fs.closeSync(fd);
  // SVG — texto, verificar que empiece con < sin ejecutables
  const head = buf.toString('utf8', 0, 5);
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!DO')) return true;
  return IMAGE_SIGNATURES.some(sig => sig.bytes.every((b, i) => buf[i] === b));
}

// POST /api/settings/upload?kind=logo|favicon|login_bg
router.post('/upload', authenticate, authorize('admin', 'gth'), requirePermission('configuracion', 'update'), (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido (campo "file")' });
    // Validar magic bytes del archivo guardado (independiente del MIME declarado)
    try {
      if (!checkMagicBytes(req.file.path)) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'El contenido del archivo no corresponde a una imagen válida' });
      }
    } catch {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: 'No se pudo verificar el archivo' });
    }

    const publicUrl = `/uploads/${req.file.filename}`;
    const kind = (req.query.kind || '').toString();
    const kindToKey = {
      logo:       'system_logo_url',
      favicon:    'system_favicon_url',
      login_bg:   'system_login_bg_image',
      signature:  'system_signature_url',
      seal:       'system_seal_url',
      pwa_icon:   'system_pwa_icon_url',
    };
    const key = kindToKey[kind];

    const done = () => res.json({
      ok: true,
      url: publicUrl,
      filename: req.file.filename,
      size: req.file.size,
      mime: req.file.mimetype,
      key,
    });

    if (key) {
      sequelize.query(
        `INSERT INTO notification_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        { replacements: [key, publicUrl] }
      ).then(done).catch(e => res.status(500).json({ error: e.message }));
    } else {
      done();
    }
  });
});

// ─── Webhooks Slack / Teams ──────────────────────────────────────
const WEBHOOK_KEYS = ['slack_webhook_url', 'teams_webhook_url', 'webhook_notify_absences', 'webhook_notify_late', 'webhook_notify_device_down', 'webhook_notify_backup'];

router.get('/webhooks',
  authorize('admin', 'super_admin'),
  async (_req, res) => {
    const [rows] = await sequelize.query(
      `SELECT key_name AS k, value AS v FROM system_settings WHERE key_name IN (${WEBHOOK_KEYS.map(() => '?').join(',')})`,
      { replacements: WEBHOOK_KEYS }
    );
    const map = {};
    for (const r of rows) map[r.k] = r.v;
    res.json(map);
  }
);

router.put('/webhooks',
  authorize('admin', 'super_admin'),
  async (req, res) => {
    const body = req.body || {};
    for (const k of WEBHOOK_KEYS) {
      if (k in body) {
        await sequelize.query(
          `INSERT INTO system_settings (key_name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)`,
          { replacements: [k, body[k] || ''] }
        );
      }
    }
    res.json({ ok: true });
  }
);

// Test endpoint — envía mensaje de prueba a los canales configurados
router.post('/webhooks/test',
  authorize('admin', 'super_admin'),
  async (req, res) => {
    try {
      const { notify } = require('../services/notificationWebhooks');
      await notify({
        title: '🧪 Test SisHoras',
        text: `Notificación de prueba desde *SisHoras* — ${new Date().toLocaleString('es-PY')}`,
        color: '#2563eb',
      });
      res.json({ ok: true, message: 'Mensaje enviado a los canales configurados' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

module.exports = router;
