/**
 * analytics.js — BFF proxy hacia el servicio Analytics (FastAPI).
 *
 * El navegador NUNCA habla directo con Analytics ni conoce su API key:
 * el core autentica al usuario (JWT + permiso de reportes) y reenvía la
 * petición añadiendo la clave por header X-API-Key desde el entorno del
 * servidor. Así se elimina la clave del bundle del frontend.
 */
const router = require('express').Router();
const axios = require('axios');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');

const ANALYTICS_URL = process.env.ANALYTICS_URL || 'http://localhost:5000';

// Todas las rutas requieren sesión y permiso de ver reportes.
router.use(authenticate, requirePermission('reportes', 'view'));

// Proxy genérico de GET: /api/analytics/<subpath> → ANALYTICS_URL/<subpath>
router.get('/*', asyncHandler(async (req, res) => {
  const subpath = req.params[0] || '';
  const upstream = await axios.get(`${ANALYTICS_URL}/${subpath}`, {
    params: req.query,
    headers: { 'X-API-Key': process.env.ANALYTICS_API_KEY || '' },
    responseType: 'stream',
    timeout: 60000,
    validateStatus: () => true,
  });
  res.status(upstream.status);
  // Propagar cabeceras relevantes (tipo de contenido, descargas Excel)
  for (const h of ['content-type', 'content-disposition', 'content-length']) {
    if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
  }
  upstream.data.pipe(res);
}));

module.exports = router;
