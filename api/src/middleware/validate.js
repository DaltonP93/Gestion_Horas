/**
 * validate.js — middleware de validación con Joi.
 *
 * Uso:
 *   const Joi = require('joi');
 *   const schema = Joi.object({ ... });
 *   router.post('/x', validate(schema), handler);
 *   router.get('/y', validate(schema, 'query'), handler);
 *
 * Ante entrada inválida responde 400 con el detalle de campos; ante entrada
 * válida sustituye req[source] por el valor saneado (stripUnknown).
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[source], {
      abortEarly: false,
      stripUnknown: true,
      convert: true,
    });
    if (error) {
      return res.status(400).json({
        error: 'Datos inválidos',
        details: error.details.map(d => ({ field: d.path.join('.'), message: d.message })),
      });
    }
    req[source] = value;
    next();
  };
}

module.exports = { validate };
