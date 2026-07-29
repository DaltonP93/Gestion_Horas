/**
 * Integración LEGADA att2000: kill switch del pull automático + estado.
 */
const OLD_ENV = { ...process.env };

// Mocks para poder requerir el scheduler sin DB/SQL Server reales.
const mockSchedule = jest.fn(() => ({ stop: jest.fn() }));
jest.mock('node-cron', () => ({ schedule: (...a) => mockSchedule(...a) }));
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/config/logger', () => ({ info() {}, warn() {}, error() {} }));
jest.mock('../src/services/emailService', () => ({ sendMail: jest.fn(), buildReportEmailHtml: jest.fn() }));
jest.mock('../src/config/zkAdapter', () => ({ syncAttendance: jest.fn() }));

const legacy = require('../src/services/att2000Legacy');
const scheduler = require('../src/services/scheduler');

afterEach(() => { process.env = { ...OLD_ENV }; legacy._reset(); mockSchedule.mockClear(); });

describe('autoPullEnabled (kill switch)', () => {
  test('por defecto (sin variable) → false', () => {
    delete process.env.ATT2000_AUTO_PULL_ENABLED;
    expect(legacy.autoPullEnabled()).toBe(false);
  });
  test("'false' → false; 'true' → true (case-insensitive)", () => {
    process.env.ATT2000_AUTO_PULL_ENABLED = 'false'; expect(legacy.autoPullEnabled()).toBe(false);
    process.env.ATT2000_AUTO_PULL_ENABLED = 'TRUE';  expect(legacy.autoPullEnabled()).toBe(true);
  });
});

describe('startAtt2000PullCron respeta el kill switch', () => {
  test('kill switch FALSE → NO registra el cron aunque haya expresión', () => {
    process.env.ATT2000_AUTO_PULL_ENABLED = 'false';
    process.env.ATT2000_PULL_CRON = '*/10 * * * *';
    scheduler.startAtt2000PullCron();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  test('kill switch TRUE + expresión → registra el cron', () => {
    process.env.ATT2000_AUTO_PULL_ENABLED = 'true';
    process.env.ATT2000_PULL_CRON = '*/10 * * * *';
    scheduler.startAtt2000PullCron();
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockSchedule.mock.calls[0][0]).toBe('*/10 * * * *');
  });

  test('kill switch TRUE pero SIN expresión → no registra (nada que programar)', () => {
    process.env.ATT2000_AUTO_PULL_ENABLED = 'true';
    delete process.env.ATT2000_PULL_CRON;
    scheduler.startAtt2000PullCron();
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe('estado para Salud del sistema', () => {
  test('available refleja ATT2000_HOST', () => {
    process.env.ATT2000_HOST = 'sqlserver.interno';
    expect(legacy.available()).toBe(true);
    delete process.env.ATT2000_HOST;
    expect(legacy.available()).toBe(false);
  });

  test('recordRun/getStatus expone contadores y fuente, sin secretos', () => {
    process.env.ATT2000_AUTO_PULL_ENABLED = 'false';
    legacy.recordRun({ source: 'manual', ok: true, imported: 60, duplicate: 171, unmapped: 5 });
    const s = legacy.getStatus();
    expect(s.auto_pull_enabled).toBe(false);
    expect(s.last_run).toMatchObject({ source: 'manual', ok: true, imported: 60, duplicate: 171, unmapped: 5 });
    expect(typeof s.last_run.at).toBe('string');
    // El estado NO debe contener credenciales.
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/password|user|host|secret/i);
  });

  test('getStatus sin corridas → last_run null', () => {
    expect(legacy.getStatus().last_run).toBeNull();
  });
});
