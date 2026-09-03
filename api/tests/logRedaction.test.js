/**
 * El JWT no debe quedar en texto plano en los logs: ni el ?access_token= de
 * las descargas GET, ni (defensa en profundidad) un header Authorization.
 */
const { urlToken, redactSensitiveLogLine } = require('../src/utils/logRedaction');

describe('urlToken (token :url de morgan)', () => {
  test('redacta access_token en la query, conserva el resto de la URL', () => {
    const req = { originalUrl: '/api/reports/export?access_token=eyJhbGciOiJIUzI1NiJ9.abc.def&format=pdf' };
    expect(urlToken(req)).toBe('/api/reports/export?access_token=[REDACTED]&format=pdf');
  });

  test('access_token como primer y único parámetro', () => {
    const req = { originalUrl: '/api/legal/marcadas?access_token=eyJhbGciOiJIUzI1NiJ9.abc.def' };
    expect(urlToken(req)).toBe('/api/legal/marcadas?access_token=[REDACTED]');
  });

  test('sin access_token, la URL no cambia', () => {
    const req = { originalUrl: '/api/employees?page=2&limit=20' };
    expect(urlToken(req)).toBe('/api/employees?page=2&limit=20');
  });

  test('sin req.originalUrl, cae a req.url', () => {
    const req = { url: '/health' };
    expect(urlToken(req)).toBe('/health');
  });

  test('request vacío no rompe (devuelve string vacío)', () => {
    expect(urlToken({})).toBe('');
    expect(urlToken(undefined)).toBe('');
  });
});

describe('redactSensitiveLogLine (defensa en profundidad sobre la línea completa)', () => {
  test('tapa un access_token embebido en la línea', () => {
    const line = 'GET /api/x?access_token=eyJhbGciOiJIUzI1NiJ9.abc.def HTTP/1.1" 200';
    expect(redactSensitiveLogLine(line)).toBe('GET /api/x?access_token=[REDACTED] HTTP/1.1" 200');
    expect(redactSensitiveLogLine(line)).not.toMatch(/eyJ/);
  });

  test('tapa un header Authorization: Bearer <token> si apareciera en la línea', () => {
    const line = 'algo Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def resto';
    expect(redactSensitiveLogLine(line)).toBe('algo Authorization: [REDACTED] resto');
  });

  test('una línea de log normal (sin token) queda intacta', () => {
    const line = '::1 - - [11/Apr/2026:08:05:00 +0000] "GET /health HTTP/1.1" 200 15';
    expect(redactSensitiveLogLine(line)).toBe(line);
  });
});
