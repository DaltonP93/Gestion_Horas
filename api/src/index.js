require('dotenv').config();
// Zona horaria del proceso fija en Paraguay (UTC-3, sin DST desde 2023). Debe
// setearse ANTES de cualquier uso de Date, para que las extracciones por string
// (hhmm, comparaciones, logs) no dependan de la zona del servidor (que en la
// nube suele ser UTC y producía el corrimiento de 3 h).
process.env.TZ = process.env.TZ || 'America/Asuncion';
// Validar la configuración del entorno antes de cualquier otra cosa: si falta
// un secreto crítico en producción, el proceso falla acá con un mensaje claro.
require('./config/env');
const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { sequelize } = require('./config/database');
const { initRedis } = require('./config/redis');
const { initSocket } = require('./socket/socketServer');
const logger = require('./config/logger');

// Rutas
const authRoutes       = require('./routes/auth');
const employeeRoutes   = require('./routes/employees');
const attendanceRoutes = require('./routes/attendance');
const deviceRoutes     = require('./routes/devices');
const scheduleRoutes   = require('./routes/schedules');
const shiftRoutes      = require('./routes/shifts');
const overtimeRoutes   = require('./routes/overtime');
const reportRoutes     = require('./routes/reports');
const legalRoutes      = require('./routes/legal');
const legalDataRoutes  = require('./routes/legalData');
const analyticsProxyRoutes = require('./routes/analytics');
const permissionRoutes = require('./routes/permissions');
const syncRoutes            = require('./routes/sync');
const { router: webhookRoutes } = require('./routes/webhooks');
const integrationRoutes     = require('./routes/integration');
const userRoutes            = require('./routes/users');
const notificationRoutes    = require('./routes/notifications');
const settingsRoutes        = require('./routes/settings');
const hrSourceRoutes        = require('./routes/hrSources');
const processingRoutes      = require('./routes/processing');
const departmentRoutes      = require('./routes/departments');
const approvalRulesRoutes   = require('./routes/approvalRules');
const meRoutes              = require('./routes/me');
const auditRoutes           = require('./routes/audit');
const holidayRoutes         = require('./routes/holidays');
const branchRoutes          = require('./routes/branches');
const justificationsBulk    = require('./routes/justificationsBulk');
const executiveRoutes       = require('./routes/executive');
const selfCheckinRoutes     = require('./routes/selfCheckin');
const payrollRoutes         = require('./routes/payroll');
const supervisorRoutes      = require('./routes/supervisor');
const healthRoutes          = require('./routes/health');
const backupRoutes          = require('./routes/backups');
const milestoneRoutes       = require('./routes/milestones');
const vacationsRoutes       = require('./routes/vacations');
const reportsBuilderRoutes  = require('./routes/reportsBuilder');
const kpiGoalsRoutes        = require('./routes/kpiGoals');
const employeeNotesRoutes   = require('./routes/employeeNotes');
const approvalsSlaRoutes    = require('./routes/approvalsSla');
const gdprRoutes            = require('./routes/gdpr');
const overtimeBankRoutes    = require('./routes/overtimeBank');
const announcementsRoutes   = require('./routes/announcements');
const coursesRoutes         = require('./routes/courses');
const surveysRoutes         = require('./routes/surveys');
const emailTemplatesRoutes  = require('./routes/emailTemplates');
const embedRoutes           = require('./routes/embed');
const trendsRoutes          = require('./routes/trends');
const faceRoutes            = require('./routes/faceRecognition');
const appraisalRoutes       = require('./routes/appraisals');
const onboardingRoutes      = require('./routes/onboarding');
const swaggerUi    = require('swagger-ui-express');
const swaggerSpec  = require('./config/swagger');

const app = express();
const server = http.createServer(app);

// ─── Middleware ─────────────────────────────────────────────────
app.set('trust proxy', 1); // Nginx reverse proxy
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      process.env.FRONTEND_URL,
      ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : []),
      'http://sishoras.saa.com.py',
      'https://sishoras.saa.com.py'
    ].filter(Boolean);
    // Permitir requests sin origin (curl, Postman, SSR)
    if (!origin || allowed.includes(origin)) return callback(null, true);
    callback(new Error(`CORS bloqueado: ${origin}`));
  },
  credentials: true
}));
// Servir uploads locales (logos, favicons, bg)
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// Rate limiting global
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 500,
  message: { error: 'Demasiadas solicitudes, intenta más tarde.' }
}));

// Rate limiting estricto para login (anti fuerza bruta)
// Solo cuenta intentos fallidos, no consultas /me, /refresh, /logout.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de login. Espere 15 minutos.' }
});

// Rate limiting general para el resto de /api/auth/*
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: 'Demasiadas solicitudes de autenticación.' }
});

// ─── Rutas ──────────────────────────────────────────────────────
// Aplica loginLimiter SOLO a POST /api/auth/login (anti brute-force),
// y un authLimiter más permisivo a todo lo demás del módulo.
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth',        authLimiter, authRoutes);
app.use('/api/employees',   employeeRoutes);
app.use('/api/attendance',  attendanceRoutes);
app.use('/api/devices',     deviceRoutes);
app.use('/api/schedules',   scheduleRoutes);
app.use('/api/shifts',      shiftRoutes);
app.use('/api/overtime',    overtimeRoutes);
app.use('/api/reports',     reportRoutes);
app.use('/api/legal',       legalRoutes);
app.use('/api/legal-data',  legalDataRoutes);
app.use('/api/analytics',   analyticsProxyRoutes);
app.use('/api/permissions', permissionRoutes);
app.use('/api/sync',        syncRoutes);
app.use('/api/webhooks',       webhookRoutes);
app.use('/api/integration',    integrationRoutes);
app.use('/api/users',          userRoutes);
app.use('/api/notifications',  notificationRoutes);
app.use('/api/settings',       settingsRoutes);
app.use('/api/hr-sources',     hrSourceRoutes);
app.use('/api/processing',     processingRoutes);
app.use('/api/departments',    departmentRoutes);
app.use('/api/approval-rules', approvalRulesRoutes);
app.use('/api/me',             meRoutes);
app.use('/api/audit',          auditRoutes);
app.use('/api/holidays',       holidayRoutes);
app.use('/api/branches',       branchRoutes);
app.use('/api/justifications', justificationsBulk);
app.use('/api/executive',      executiveRoutes);
app.use('/api/self-checkin',   selfCheckinRoutes);
app.use('/api/payroll',        payrollRoutes);
app.use('/api/supervisor',     supervisorRoutes);
app.use('/api/health',         healthRoutes);
app.use('/api/backups',        backupRoutes);
app.use('/api/milestones',     milestoneRoutes);
app.use('/api/vacations',      vacationsRoutes);
app.use('/api/reports-builder', reportsBuilderRoutes);
app.use('/api/kpi-goals',      kpiGoalsRoutes);
app.use('/api/employee-notes', employeeNotesRoutes);
app.use('/api/approvals-sla',  approvalsSlaRoutes);
app.use('/api/gdpr',           gdprRoutes);
app.use('/api/overtime-bank',  overtimeBankRoutes);
app.use('/api/announcements',  announcementsRoutes);
app.use('/api/courses',        coursesRoutes);
app.use('/api/surveys',        surveysRoutes);
app.use('/api/email-templates', emailTemplatesRoutes);
// Endpoint público de embed (sin auth) — debe ir ANTES del router con auth
app.use('/api/embed',          embedRoutes.publicRouter);
app.use('/api/embed-tokens',   embedRoutes);
app.use('/api/trends',         trendsRoutes);
app.use('/api/face',           faceRoutes);
app.use('/api/appraisals',    appraisalRoutes);
app.use('/api/onboarding',   onboardingRoutes);

// Documentación Swagger UI — http://localhost:4000/api/docs
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Sistema de Asistencia — API Docs',
}));
// JSON spec para consumir desde Oracle APEX / Postman
app.get('/api/docs.json', (req, res) => res.json(swaggerSpec));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Manejo de errores ──────────────────────────────────────────
app.use((err, req, res, next) => {
  const status = err.status || 500;
  // Log completo (con stack) solo del lado servidor.
  logger.error(`${status} ${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
  // No filtrar detalles internos (mensajes SQL, columnas) en respuestas 5xx.
  // Los 4xx sí devuelven el mensaje porque son de validación/cliente.
  const body = { error: status < 500 ? (err.message || 'Solicitud inválida') : 'Error interno del servidor' };
  if (err.code) body.code = err.code;
  res.status(status).json(body);
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ─── Inicio ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;

async function start() {
  try {
    // Conectar Redis
    await initRedis();
    logger.info('✅ Redis conectado');

    // Inicializar scheduler de reportes automáticos
    const { loadSchedules, startAtt2000PullCron, startDailyAlertsCron, startCoursesDueCron } = require('./services/scheduler');
    setTimeout(() => loadSchedules().catch(() => {}), 5000);
    startAtt2000PullCron();
    startDailyAlertsCron();
    startCoursesDueCron();

    // Reconciliación nocturna att2000 vs MySQL
    const { startReconciliationCron } = require('./services/reconciliation');
    startReconciliationCron();

    // Schedules de sincronización HR externa
    const { loadHrSchedules } = require('./services/hrSourceSync');
    setTimeout(() => loadHrSchedules().catch(() => {}), 6000);

    // Cron de backups automáticos de MySQL
    const { startBackupCron } = require('./services/backups');
    startBackupCron();

    // Conectar MySQL
    await sequelize.authenticate();
    logger.info('✅ MySQL conectado');

    // Inicializar Socket.io
    initSocket(server);
    logger.info('✅ Socket.io inicializado');

    server.listen(PORT, () => {
      logger.info(`🚀 API corriendo en puerto ${PORT}`);
    });
  } catch (err) {
    logger.error('❌ Error al iniciar:', err);
    process.exit(1);
  }
}

start();

// ─── Red de seguridad de proceso ────────────────────────────────
// Evita que una promesa rechazada o un error no capturado terminen el
// proceso de forma silenciosa: se registran para diagnóstico. Un proceso
// vivo con un error logueado es preferible a una caída sin rastro; PM2
// reiniciará si el estado queda realmente corrupto.
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException:', err.stack || err.message);
});

module.exports = { app, server };
