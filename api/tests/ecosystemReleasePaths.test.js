const path = require('node:path');

const ecosystem = require('../../ecosystem.config');

const RELEASE_ROOT = path.resolve(__dirname, '..', '..');
const APP_NAMES = [
  'sishoras-api',
  'sishoras-sync-worker',
  'sishoras-web',
  'sishoras-bridge',
  'sishoras-analytics',
];

function isInsideRelease(target) {
  const relative = path.relative(RELEASE_ROOT, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

describe('ecosystem PM2 ligado a la release', () => {
  test('declara exactamente los cinco procesos productivos', () => {
    expect(ecosystem.apps.map(app => app.name)).toEqual(APP_NAMES);
  });

  test.each(ecosystem.apps)('$name usa rutas absolutas dentro de la release', app => {
    for (const field of ['cwd', 'script', 'error_file', 'out_file']) {
      expect(path.isAbsolute(app[field])).toBe(true);
      expect(isInsideRelease(app[field])).toBe(true);
    }
  });

  test('Analytics usa intérprete absoluto de su propio venv', () => {
    const analytics = ecosystem.apps.find(app => app.name === 'sishoras-analytics');
    expect(analytics.cwd).toBe(path.join(RELEASE_ROOT, 'analytics'));
    expect(analytics.script).toBe(
      path.join(RELEASE_ROOT, 'analytics', '.venv', 'bin', 'uvicorn'),
    );
    expect(analytics.interpreter).toBe(
      path.join(RELEASE_ROOT, 'analytics', '.venv', 'bin', 'python'),
    );
  });

  test('el ecosystem no materializa secretos en el dump de PM2', () => {
    const analytics = ecosystem.apps.find(app => app.name === 'sishoras-analytics');
    expect(analytics.env).toEqual({ TZ: 'America/Asuncion' });
    expect(JSON.stringify(ecosystem)).not.toMatch(
      /ANALYTICS_API_KEY|JWT_SECRET|DB_PASSWORD/,
    );
  });
});
