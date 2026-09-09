/**
 * passwordResetController.js
 * Flujo "¿olvidaste tu contraseña?"
 *   1. POST /forgot  { email } — genera token 1h, envía mail con link.
 *   2. POST /reset   { token, newPassword } — verifica y actualiza.
 *
 * No revela si el email existe o no (anti-enumeration).
 */
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { sequelize } = require('../config/database');
const audit = require('../services/audit');
const logger = require('../config/logger');
const { isDefaultAdminPassword } = require('../config/securityPreflight');
const SALT_ROUNDS = 12;

// Intento de enviar mail. Si no hay SMTP configurado, loggea el link.
async function sendResetEmail({ to, fullName, link }) {
  try {
    const nodemailer = require('nodemailer');
    const host = process.env.SMTP_HOST;
    if (!host) {
      logger.warn(`SMTP no configurado. Link de reset (${to}): ${link}`);
      return false;
    }
    const transport = nodemailer.createTransport({
      host,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    await transport.sendMail({
      from: process.env.SMTP_FROM || 'no-reply@sishoras.local',
      to,
      subject: 'Restablecer contraseña — SisHoras',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1f2937">
          <h2 style="color:#2563eb">Restablecer contraseña</h2>
          <p>Hola ${fullName || ''},</p>
          <p>Recibimos una solicitud para restablecer tu contraseña. Si fuiste vos, hacé click en el siguiente enlace:</p>
          <p style="margin:24px 0">
            <a href="${link}" style="background:#2563eb;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">
              Restablecer contraseña
            </a>
          </p>
          <p style="color:#64748b;font-size:13px">Este enlace caduca en 1 hora. Si no fuiste vos, ignorá este mensaje.</p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />
          <p style="color:#94a3b8;font-size:12px">SisHoras — Gestión de Asistencia</p>
        </div>
      `,
    });
    return true;
  } catch (err) {
    logger.error(`sendResetEmail error: ${err.message}`);
    return false;
  }
}

// POST /api/auth/password/forgot  { email }
async function forgotPassword(req, res) {
  const { email } = req.body || {};
  // Respuesta siempre OK para no revelar si el email existe
  const okResponse = { message: 'Si el email existe, recibirás un enlace en los próximos minutos.' };
  if (!email || !/\S+@\S+\.\S+/.test(email)) return res.json(okResponse);

  try {
    const [[user]] = await sequelize.query(
      'SELECT id, email, full_name FROM users WHERE email = ? AND active = 1 LIMIT 1',
      { replacements: [email] }
    );
    if (!user) {
      audit.log({ req, user: null, action: 'password_forgot', details: { email, found: false } });
      return res.json(okResponse);
    }

    const token = crypto.randomBytes(32).toString('hex');
    const hash  = crypto.createHash('sha256').update(token).digest('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1h

    await sequelize.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, ip)
       VALUES (?, ?, ?, ?)`,
      { replacements: [user.id, hash, expires,
          (req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || null)
      ]}
    );

    const baseUrl = process.env.FRONTEND_URL || 'http://sishoras.saa.com.py';
    const link = `${baseUrl}/reset-password?token=${token}`;

    await sendResetEmail({ to: user.email, fullName: user.full_name, link });
    audit.log({ req, user, action: 'password_forgot', details: { found: true } });
    res.json(okResponse);
  } catch (err) {
    logger.error('forgotPassword error:', err);
    res.json(okResponse);
  }
}

// POST /api/auth/password/reset  { token, newPassword }
async function resetPassword(req, res) {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) return res.status(400).json({ error: 'token y newPassword requeridos' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Mínimo 8 caracteres' });
  if (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return res.status(400).json({ error: 'Debe contener letras y números' });
  }
  // H1: impedir reintroducir una credencial por defecto conocida vía reset.
  if (isDefaultAdminPassword(newPassword)) {
    return res.status(400).json({ error: 'La contraseña coincide con una contraseña por defecto no permitida; elegí otra.' });
  }

  try {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const [[row]] = await sequelize.query(
      `SELECT id, user_id FROM password_reset_tokens
        WHERE token_hash = ? AND expires_at > NOW() AND used_at IS NULL
        LIMIT 1`,
      { replacements: [hash] }
    );
    if (!row) return res.status(400).json({ error: 'Token inválido o expirado' });

    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await sequelize.query(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      { replacements: [newHash, row.user_id] }
    );
    await sequelize.query(
      'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?',
      { replacements: [row.id] }
    );
    // Revocar refresh tokens existentes
    await sequelize.query('DELETE FROM refresh_tokens WHERE user_id = ?', { replacements: [row.user_id] });

    audit.log({ req, user: { id: row.user_id }, action: 'password_reset' });
    res.json({ message: 'Contraseña actualizada. Ya podés iniciar sesión.' });
  } catch (err) {
    logger.error('resetPassword error:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

module.exports = { forgotPassword, resetPassword };
