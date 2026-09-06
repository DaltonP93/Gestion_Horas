/**
 * redactUrlLog.test.js — H3 (logs): el logger de acceso NUNCA debe registrar el
 * valor de `access_token` (ni otros secretos) que viaje en el query string.
 *
 * Se testea la función pura de redacción y su uso como token de morgan.
 */
const morgan = require('morgan');
const { redactUrl, SECRET_QUERY_PARAMS } = require('../src/utils/redactUrl');

describe('redactUrl()', () => {
  test('oculta access_token conservando el resto de la URL', () => {
    const out = redactUrl('/api/reports/export?access_token=eyJhbGciOi.JIUzI1.abc123&format=pdf');
    expect(out).toBe('/api/reports/export?access_token=REDACTED&format=pdf');
    expect(out).not.toContain('eyJhbGciOi');
    expect(out).not.toContain('abc123');
  });

  test('oculta access_token cuando es el único parámetro', () => {
    expect(redactUrl('/download?access_token=SUPERSECRETJWT'))
      .toBe('/download?access_token=REDACTED');
  });

  test('oculta el nombre del parámetro sin distinguir mayúsculas', () => {
    expect(redactUrl('/x?ACCESS_TOKEN=zzz')).toBe('/x?ACCESS_TOKEN=REDACTED');
  });

  test('redacta múltiples parámetros sensibles a la vez', () => {
    const out = redactUrl('/x?token=aaa&keep=1&password=bbb&refresh_token=ccc');
    for (const secret of ['aaa', 'bbb', 'ccc']) expect(out).not.toContain(secret);
    expect(out).toContain('keep=1');
  });

  test('no toca URLs sin secretos', () => {
    const url = '/api/employees?page=2&status=active';
    expect(redactUrl(url)).toBe(url);
  });

  test('no confunde access_token con un sufijo de otro parámetro', () => {
    // `token` NO debe redactar el valor de `mytoken` (no está precedido de ? o &)
    const out = redactUrl('/x?mytoken=keepme');
    expect(out).toBe('/x?mytoken=keepme');
  });

  test('tolera entradas no-string', () => {
    expect(redactUrl(undefined)).toBe(undefined);
    expect(redactUrl(null)).toBe(null);
    expect(redactUrl('')).toBe('');
  });

  test('access_token está en la lista de parámetros redactados', () => {
    expect(SECRET_QUERY_PARAMS).toContain('access_token');
  });
});

describe('token de morgan url-redacted', () => {
  test('la línea de acceso generada por morgan no contiene el JWT', (done) => {
    morgan.token('url-redacted', (req) => redactUrl(req.originalUrl || req.url));
    const mw = morgan(':method :url-redacted', {
      immediate: true,
      stream: {
        write: (line) => {
          try {
            expect(line.trim()).toBe('GET /api/reports/export?access_token=REDACTED');
            expect(line).not.toContain('LEAKEDJWT');
            done();
          } catch (e) { done(e); }
        },
      },
    });
    const req = { method: 'GET', originalUrl: '/api/reports/export?access_token=LEAKEDJWT', headers: {} };
    const res = { getHeader: () => undefined, statusCode: 200 };
    mw(req, res, () => {});
  });
});
