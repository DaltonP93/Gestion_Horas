'use strict';

/**
 * memorySettingsDb.js — base simulada en memoria para las rutas de ajustes
 * (notification_settings), la identidad vigente (users) y la auditoría.
 * La usan el test HTTP de recursos de marca y el backend de la prueba aislada
 * de nginx (deploy/tests). Datos sintéticos; nunca una base real.
 */

function createMemorySettingsDb({ users = {}, settings = {} } = {}) {
  const state = {
    users: { ...users },
    settings: new Map(Object.entries(settings)),
    failOn: null, // RegExp: la próxima consulta que coincida lanza
    audits: [],
  };
  async function query(sql, opts = {}) {
    const rp = opts.replacements || [];
    if (state.failOn && state.failOn.test(sql)) { state.failOn = null; throw new Error('ER_LOCK_WAIT_TIMEOUT'); }
    if (/FROM users WHERE id = \? LIMIT 1/.test(sql)) {
      const u = state.users[rp[0]];
      return [u ? [{ username: `u${u.id}`, ...u }] : []];
    }
    if (/FROM user_permissions/.test(sql)) return [[]];
    if (/SELECT setting_key, setting_value FROM notification_settings\s+WHERE setting_key IN/i.test(sql)) {
      return [rp.filter((k) => state.settings.has(k)).map((k) => ({ setting_key: k, setting_value: state.settings.get(k) }))];
    }
    if (/SELECT setting_value FROM notification_settings WHERE setting_key = \? LIMIT 1/.test(sql)) {
      return [state.settings.has(rp[0]) ? [{ setting_value: state.settings.get(rp[0]) }] : []];
    }
    if (/INSERT INTO notification_settings/.test(sql)) {
      state.settings.set(rp[0], rp[1]);
      return [{ affectedRows: 1 }];
    }
    if (/DELETE FROM notification_settings WHERE setting_key IN/.test(sql)) {
      for (const k of rp) state.settings.delete(k);
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO audit_events/.test(sql)) { state.audits.push(rp); return [{ insertId: state.audits.length }]; }
    return [[]];
  }
  return { state, sequelize: { query, transaction: async () => ({ commit: async () => {}, rollback: async () => {} }) } };
}

module.exports = { createMemorySettingsDb };
