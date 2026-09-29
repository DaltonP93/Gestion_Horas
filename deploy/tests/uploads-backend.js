'use strict';

/**
 * uploads-backend.js — backend mínimo que sirve /uploads como lo haría cada
 * versión de la API, para probar nginx en aislamiento (sin base real).
 *
 *   node uploads-backend.js <modo> <puerto> <uploadDir> [guardAnterior.js]
 *
 * Modos:
 *   new        guard ACTUAL (api/src/middleware/uploadsGuard.js) con la lista
 *              positiva leída de una base SIMULADA (PUBLIC_SETTINGS_JSON);
 *   prev-pr    guard anterior por prefijos (archivo pasado como 4º argumento,
 *              p. ej. el de ef82b32);
 *   prev-main  sin guard: express.static sirve TODO /uploads (main 7638fa9).
 * Cualquier otra ruta responde 200 "backend:<modo>".
 */

const path = require('path');

const [mode, port, uploadDir, prevGuardPath] = process.argv.slice(2);
const REPO = path.resolve(__dirname, '..', '..');
const express = require(path.join(REPO, 'api', 'node_modules', 'express'));

const app = express();
if (mode === 'new') {
  // Base simulada: sólo responde la consulta de ajustes públicos.
  const settings = JSON.parse(process.env.PUBLIC_SETTINGS_JSON || '{}');
  const dbPath = require.resolve(path.join(REPO, 'api', 'src', 'config', 'database'));
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      sequelize: {
        query: async (_sql, opts = {}) => [(opts.replacements || [])
          .filter((k) => settings[k] != null)
          .map((k) => ({ setting_key: k, setting_value: settings[k] }))],
      },
    },
  };
  const { uploadsGuard, setPublicUploadHeaders } = require(path.join(REPO, 'api', 'src', 'middleware', 'uploadsGuard'));
  app.use('/uploads', uploadsGuard, express.static(uploadDir, { setHeaders: setPublicUploadHeaders }));
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
