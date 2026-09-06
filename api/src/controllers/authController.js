const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sequelize } = require('../config/database');
const logger = require('../config/logger');
const audit = require('../services/audit');
const totp = require('../services/totp');

const SALT_ROUNDS = 12;

// Metadata de sesión (IP / dispositivo) para "Seguridad de mi cuenta".
// Nunca registra credenciales; sólo cabeceras de red del request.
function reqIp(req) {
  return String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
      || req?.ip || req?.connection?.remoteAddress || null;
}
function reqUA(req) {
  return req?.headers?.['user-agent']?.slice(0, 255) || null;
}
function sha256(v) { return crypto.createHash('sha256').update(v).digest('hex'); }

function generateTokens(user) {
  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    email: user.email,
    employee_id: user.employee_id ?? null,
  };

  const accessToken = jwt.sign(payload, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { algorithm: 'HS256', expiresIn: '7d' });

  return { accessToken, refreshToken };
}

// POST /api/auth/login
async function login(req, res) {
  const { username, password, otp } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }

  try {
    const [users] = await sequelize.query(
      `SELECT id, username, email, password_hash, full_name, role, active, employee_id,
              twofa_secret, twofa_enabled
         FROM users WHERE (username = ? OR email = ?) LIMIT 1`,
      { replacements: [username, username] }
    );

    const user = users[0];
    if (!user || !user.active) {
      audit.log({ req, user: null, action: 'login_fail', details: { username, reason: 'user_not_found_or_inactive' } });
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      audit.log({ req, user, action: 'login_fail', details: { reason: 'bad_password' } });
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // ─── 2FA TOTP ──────────────────────────────────────────────
    if (user.twofa_enabled && user.twofa_secret) {
      if (!otp) {
        // Password OK, pide el segundo factor
        return res.status(200).json({ twofaRequired: true });
      }
      const ok = totp.verifyCode(user.twofa_secret, otp, { window: 1 });
      if (!ok) {
        audit.log({ req, user, action: 'login_fail', details: { reason: 'bad_otp' } });
        return res.status(401).json({ twofaRequired: true, error: 'Código 2FA inválido' });
      }
    }

    const { accessToken, refreshToken } = generateTokens(user);

    // Guardar refresh token hasheado
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await sequelize.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent, last_used_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      { replacements: [user.id, tokenHash, expiresAt, reqIp(req), reqUA(req)] }
    ).catch(() => sequelize.query(
      // Fallback si la migración 062 aún no corrió (columnas de metadata ausentes).
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
      { replacements: [user.id, tokenHash, expiresAt] }
    ));

    // Actualizar último login
    await sequelize.query('UPDATE users SET last_login = NOW() WHERE id = ?', { replacements: [user.id] });

    logger.info(`Login: ${user.username} (${user.role})`);
    audit.log({ req, user, action: 'login_ok', details: { role: user.role } });

    res.json({
      accessToken,
      refreshToken,
      user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role, email: user.email, employee_id: user.employee_id ?? null }
    });
  } catch (err) {
    logger.error('Error en login:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /api/auth/refresh
async function refresh(req, res) {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token requerido' });

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    const [rows] = await sequelize.query(
      'SELECT id FROM refresh_tokens WHERE token_hash = ? AND expires_at > NOW() AND user_id = ?',
      { replacements: [tokenHash, decoded.id] }
    );

    if (!rows.length) return res.status(401).json({ error: 'Refresh token inválido o expirado' });

    const [users] = await sequelize.query(
      'SELECT id, username, email, full_name, role FROM users WHERE id = ? AND active = 1',
      { replacements: [decoded.id] }
    );

    if (!users.length) return res.status(401).json({ error: 'Usuario no encontrado' });

    const { accessToken, refreshToken: newRefreshToken } = generateTokens(users[0]);

    // Rotar refresh token conservando la metadata de la sesión (misma IP/UA).
    await sequelize.query('DELETE FROM refresh_tokens WHERE token_hash = ?', { replacements: [tokenHash] });
    const newHash = sha256(newRefreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await sequelize.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent, last_used_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      { replacements: [users[0].id, newHash, expiresAt, reqIp(req), reqUA(req)] }
    ).catch(() => sequelize.query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
      { replacements: [users[0].id, newHash, expiresAt] }
    ));

    res.json({ accessToken, refreshToken: newRefreshToken });
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// POST /api/auth/logout
async function logout(req, res) {
  const { refreshToken } = req.body;
  if (refreshToken) {
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await sequelize.query('DELETE FROM refresh_tokens WHERE token_hash = ?', { replacements: [tokenHash] });
  }
  res.json({ message: 'Sesión cerrada' });
}

// POST /api/auth/change-password — cambiar password del usuario actual.
// Body: { currentPassword, newPassword, closeOtherSessions?, refreshToken? }
//  - closeOtherSessions (default true): revoca las demás sesiones. Si se envía
//    el refreshToken actual, ESA sesión se conserva (no cierra la del propio
//    usuario); sin él, revoca todas (fallback seguro).
//  - Nunca se registran contraseñas en logs ni en audit_events: sólo el evento.
async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  const closeOtherSessions = req.body.closeOtherSessions !== false; // default: true
  const currentRefresh = req.body.refreshToken || null;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword y newPassword son requeridos' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }
  // Regla mínima: 1 letra + 1 número
  if (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return res.status(400).json({ error: 'La contraseña debe contener letras y números' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'La nueva contraseña debe ser distinta a la actual' });
  }

  try {
    const [rows] = await sequelize.query(
      'SELECT password_hash FROM users WHERE id = ?',
      { replacements: [req.user.id] }
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) {
      audit.log({ req, user: req.user, action: 'password.change_fail', entity: 'user', entity_id: req.user.id, details: { reason: 'bad_current_password' } });
      return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    }

    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await sequelize.query(
      'UPDATE users SET password_hash = ?, password_changed_at = NOW() WHERE id = ?',
      { replacements: [newHash, req.user.id] }
    ).catch(() => sequelize.query(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      { replacements: [newHash, req.user.id] }
    ));

    // Revocar sesiones. Conservar la actual si el cliente envió su refresh token.
    let closedOthers = 0;
    if (closeOtherSessions) {
      if (currentRefresh) {
        const keepHash = sha256(currentRefresh);
        const [r] = await sequelize.query(
          'DELETE FROM refresh_tokens WHERE user_id = ? AND token_hash <> ?',
          { replacements: [req.user.id, keepHash] }
        );
        closedOthers = r?.affectedRows ?? 0;
      } else {
        const [r] = await sequelize.query('DELETE FROM refresh_tokens WHERE user_id = ?', { replacements: [req.user.id] });
        closedOthers = r?.affectedRows ?? 0;
      }
    }

    logger.info(`Password cambiada: user_id=${req.user.id} (${req.user.username})`);
    audit.log({ req, user: req.user, action: 'password.change', entity: 'user', entity_id: req.user.id, details: { closed_other_sessions: closeOtherSessions ? closedOthers : 0 } });
    res.json({
      message: closeOtherSessions
        ? 'Contraseña actualizada. Se cerraron las otras sesiones.'
        : 'Contraseña actualizada.',
      closed_other_sessions: closeOtherSessions ? closedOthers : 0,
    });
  } catch (err) {
    logger.error('Error cambiando password:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /api/auth/me
async function me(req, res) {
  try {
    const [users] = await sequelize.query(
      'SELECT id, username, email, full_name, role, last_login FROM users WHERE id = ?',
      { replacements: [req.user.id] }
    );
    if (!users.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(users[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
}

module.exports = { login, refresh, logout, me, changePassword };
