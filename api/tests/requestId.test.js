/**
 * requestId.test.js — el middleware asigna un correlation id seguro.
 */
const { requestId, SAFE_ID } = require('../src/middleware/requestId');

function mkReqRes(headers = {}) {
  const req = { headers };
  const res = { setHeader: jest.fn() };
  const next = jest.fn();
  return { req, res, next };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('requestId middleware', () => {
  test('usa X-Correlation-Id entrante si tiene formato seguro', () => {
    const { req, res, next } = mkReqRes({ 'x-correlation-id': 'abc-123_XYZ.1' });
    requestId(req, res, next);
    expect(req.correlationId).toBe('abc-123_XYZ.1');
    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-Id', 'abc-123_XYZ.1');
    expect(next).toHaveBeenCalled();
  });

  test('acepta X-Request-Id como alternativa', () => {
    const { req, res, next } = mkReqRes({ 'x-request-id': 'req-42' });
    requestId(req, res, next);
    expect(req.correlationId).toBe('req-42');
  });

  test('genera un UUID cuando no viene header', () => {
    const { req, res, next } = mkReqRes({});
    requestId(req, res, next);
    expect(req.correlationId).toMatch(UUID_RE);
    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-Id', req.correlationId);
  });

  test('ignora un header con formato inseguro y genera uno propio', () => {
    const unsafe = 'tiene espacios y símbolos <script>';
    const { req, res, next } = mkReqRes({ 'x-correlation-id': unsafe });
    requestId(req, res, next);
    expect(req.correlationId).not.toBe(unsafe);
    expect(req.correlationId).toMatch(UUID_RE);
  });

  test('ignora un header demasiado largo (>64)', () => {
    const { req, res, next } = mkReqRes({ 'x-correlation-id': 'a'.repeat(65) });
    requestId(req, res, next);
    expect(req.correlationId).toMatch(UUID_RE);
  });

  test('SAFE_ID valida el contrato de formato', () => {
    expect(SAFE_ID.test('ok-1_2.3')).toBe(true);
    expect(SAFE_ID.test('no espacio')).toBe(false);
    expect(SAFE_ID.test('')).toBe(false);
  });
});
