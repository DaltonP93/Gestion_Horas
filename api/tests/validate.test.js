/**
 * Tests del middleware de validación Joi.
 */
const Joi = require('joi');
const { validate } = require('../src/middleware/validate');

function mkRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

const schema = Joi.object({
  code: Joi.string().required(),
  age:  Joi.number().integer().min(0),
});

describe('validate()', () => {
  test('entrada válida → next y req.body saneado (stripUnknown)', () => {
    const req = { body: { code: 'A1', age: 30, extra: 'x' } };
    const res = mkRes(); const next = jest.fn();
    validate(schema)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ code: 'A1', age: 30 }); // 'extra' eliminado
    expect(res.status).not.toHaveBeenCalled();
  });

  test('falta campo requerido → 400 con detalle', () => {
    const req = { body: { age: 30 } };
    const res = mkRes(); const next = jest.fn();
    validate(schema)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.error).toBe('Datos inválidos');
    expect(payload.details.some(d => d.field === 'code')).toBe(true);
  });

  test('tipo inválido → 400', () => {
    const req = { body: { code: 'A1', age: 'noNumero' } };
    const res = mkRes(); const next = jest.fn();
    validate(schema)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('convert: string numérico se castea a number', () => {
    const req = { body: { code: 'A1', age: '25' } };
    const res = mkRes(); const next = jest.fn();
    validate(schema)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.body.age).toBe(25);
  });

  test('source alternativo (query)', () => {
    const req = { query: { code: 'Q' } };
    const res = mkRes(); const next = jest.fn();
    validate(Joi.object({ code: Joi.string().required() }), 'query')(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
