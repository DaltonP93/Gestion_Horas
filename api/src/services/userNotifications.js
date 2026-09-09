/**
 * userNotifications.js — Helper para emitir notificaciones in-app.
 * Inserta en DB y emite por Socket.io al room del usuario.
 */
const { sequelize } = require('../config/database');
const { insertId } = require('../utils/insertId');
const { getIO } = require('../socket/socketServer');

async function notifyUser(userId, { type = 'info', title, body = null, link = null }) {
  if (!userId || !title) return null;
  try {
    const [result] = await sequelize.query(
      `INSERT INTO user_notifications (user_id, type, title, body, link)
       VALUES (?, ?, ?, ?, ?)`,
      { replacements: [userId, type, title, body, link] }
    );
    const payload = { id: insertId(result), user_id: userId, type, title, body, link, read_at: null, created_at: new Date() };
    try {
      const io = getIO?.();
      if (io) io.to(`user:${userId}`).emit('notification', payload);
    } catch {}
    return payload;
  } catch {
    return null;
  }
}

async function notifyUsers(userIds, data) {
  const list = (userIds || []).filter(Boolean);
  return Promise.all(list.map(id => notifyUser(id, data)));
}

module.exports = { notifyUser, notifyUsers };
