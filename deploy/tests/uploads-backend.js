'use strict';

/**
 * uploads-backend.js — backend mínimo que sirve /uploads como lo haría cada
 * versión de la API, para probar nginx en aislamiento (sin base real).
 *
 *   node uploads-backend.js <modo> <puerto> <uploadDir> [guardAnterior.js]
 *
 * Modos:
 *   new        código ACTUAL: uploadsGuard + router REAL de ajustes
 *              (/api/settings: upload, PUT, reset, brand/:kind) con JWT e
 *              identidad reales y base SIMULADA en memoria. Semilla opcional
 *              de ajustes en SEED_SETTINGS_JSON (p. ej. un logo heredado).
 *   prev-pr    guard anterior por prefijos (archivo pasado como 4º argumento,
 *              p. ej. el de ef82b32);
 *   prev-main  sin guard: express.static sirve TODO /uploads (main 7638fa9).
 * Cualquier otra ruta responde 200 "backend:<modo>".
 */

const path = require('path');

const [mode, port, uploadDir, prevGuardPath] = process.argv.slice(2);
const REPO = path.resolve(__dirname, '..', '..');
const API = path.join(REPO, 'api');
const express = require(path.join(API, 'node_modules', 'express'));

const app = express();
if (mode === 'new') {
  process.env.UPLOAD_DIR = uploadDir;
  const { createMemorySettingsDb } = require(path.join(API, 'tests', 'helpers', 'memorySettingsDb'));
  const db = createMemorySettingsDb({
    users: { 1: { id: 1, role: 'admin', active: 1, employee_id: null } },
    settings: JSON.parse(process.env.SEED_SETTINGS_JSON || '{}'),
  });
  const dbPath = require.resolve(path.join(API, 'src', 'config', 'database'));
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { sequelize: db.sequelize } };
  const { uploadsGuard, setPublicUploadHeaders } = require(path.join(API, 'src', 'middleware', 'uploadsGuard'));
  app.use(express.json());
  app.use('/uploads', uploadsGuard, express.static(uploadDir, { setHeaders: setPublicUploadHeaders }));
  app.use('/api/settings', require(path.join(API, 'src', 'routes', 'settings')));
} else if (mode === 'prev-pr') {
  const { uploadsGuard } = require(path.resolve(prevGuardPath));
  app.use('/uploads', uploadsGuard, express.static(uploadDir));
} else if (mode === 'prev-main') {
  app.use('/uploads', express.static(uploadDir));
} else {
  throw new Error(`modo desconocido: ${mode}`);
}
app.use((_req, res) => res.status(200).type('text/plain').send(`backend:${mode}`));
app.listen(Number(port), '127.0.0.1', () => process.stdout.write(`ready ${mode} ${port}\n`));
