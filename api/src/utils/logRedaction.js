/**
 * logRedaction.js — Evita que un JWT quede en texto plano en los logs de acceso.
 *
 * El JWT viaja como `?access_token=...` en descargas GET (window.open no
 * manda header Authorization; ver middleware/auth.js), y morgan('combined')
 * incluye la URL completa vía el token `:url`. Sin redactar, el token queda
 * en texto plano en cada línea de log.
 *
 * `urlToken(req)` reemplaza al token `:url` por defecto de morgan: mismo
 * valor, con `access_token` tapado en la query string.
 *
 * `redactSensitiveLogLine(line)` es una segunda pasada, sobre la línea ya
 * formateada: defensa en profundidad por si algún día se agrega un token
 * custom que exponga el header Authorization (que 'combined' no incluye hoy).
 */

function urlToken(req) {
  const raw = (req && (req.originalUrl || req.url)) || '';
  return raw.replace(/([?&]access_token=)[^&\s]+/i, '$1[REDACTED]');
}

function redactSensitiveLogLine(line) {
  return String(line || '').replace(
    /((?:authorization|access_token)["'=:\s]+)(?:bearer\s+)?[A-Za-z0-9\-._~+/]+=*/gi,
    '$1[REDACTED]',
  );
}

module.exports = { urlToken, redactSensitiveLogLine };
