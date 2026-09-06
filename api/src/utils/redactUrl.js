/**
 * redactUrl.js — Oculta secretos que viajen en el query string antes de que la
 * URL llegue al logger de acceso (morgan).
 *
 * El middleware de auth acepta `?access_token=<jwt>` por query para descargas
 * vía window.open (PDFs, exports), donde no se pueden enviar headers. Ese token
 * NUNCA debe quedar registrado en texto plano en los logs de acceso: quien lea
 * el log tendría un JWT válido reutilizable. Esta función reemplaza el valor por
 * `REDACTED` conservando el resto de la URL para diagnóstico.
 */

// Nombres de parámetros de query cuyo VALOR es un secreto y debe redactarse.
const SECRET_QUERY_PARAMS = [
  'access_token',
  'refresh_token',
  'refreshToken',
  'token',
  'api_key',
  'apikey',
  'password',
];

/**
 * Devuelve la URL con los valores de parámetros sensibles reemplazados por
 * `REDACTED`. No modifica nada más (path, otros params, fragmento).
 * @param {string} url  típicamente `req.originalUrl`
 * @returns {string}
 */
function redactUrl(url) {
  if (typeof url !== 'string' || url === '') return url;
  let out = url;
  for (const param of SECRET_QUERY_PARAMS) {
    // `?param=valor` o `&param=valor` → `?param=REDACTED`. El nombre se compara
    // sin distinguir mayúsculas; el valor es cualquier cosa hasta &, # o espacio.
    const re = new RegExp(`([?&]${param}=)[^&#\\s]*`, 'gi');
    out = out.replace(re, '$1REDACTED');
  }
  return out;
}

module.exports = { redactUrl, SECRET_QUERY_PARAMS };
