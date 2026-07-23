const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { login, refresh, logout, me, changePassword } = require('../controllers/authController');
const { setup2fa, verify2fa, disable2fa, status2fa } = require('../controllers/twofaController');
const { forgotPassword, resetPassword }              = require('../controllers/passwordResetController');
const { authenticate } = require('../middleware/auth');

// Rate limiter estricto para /forgot y /reset (anti abuso)
const pwdResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1h
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Esperá 1 hora.' },
});

// Protección contra intentos repetidos al cambiar la contraseña.
const changePwdLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de cambio de contraseña. Esperá unos minutos.' },
});

router.post('/login',           login);
router.post('/refresh',         refresh);
router.post('/logout',          authenticate, logout);
router.get('/me',               authenticate, me);
router.post('/change-password', authenticate, changePwdLimiter, changePassword);

// ─── 2FA TOTP (usuario autenticado) ────────────────────────────
router.get ('/2fa/status',  authenticate, status2fa);
router.post('/2fa/setup',   authenticate, setup2fa);
router.post('/2fa/verify',  authenticate, verify2fa);
router.post('/2fa/disable', authenticate, disable2fa);

// ─── Password recovery ──────────────────────────────────────────
router.post('/password/forgot', pwdResetLimiter, forgotPassword);
router.post('/password/reset',  pwdResetLimiter, resetPassword);

module.exports = router;
