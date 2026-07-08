/**
 * asyncHandler.js
 * Envuelve un handler async de Express para que cualquier promesa rechazada
 * se propague al middleware central de errores en vez de quedar como
 * `unhandledRejection` (que en Node moderno puede terminar el proceso).
 *
 * Uso:
 *   router.get('/x', asyncHandler(async (req, res) => { ... }));
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** Error HTTP tipado para responder con un status concreto sin filtrar internals. */
class HttpError extends Error {
  constructor(status, message, code = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (code) this.code = code;
  }
}

module.exports = { asyncHandler, HttpError };
