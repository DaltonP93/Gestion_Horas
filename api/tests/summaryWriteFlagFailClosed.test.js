'use strict';

/**
 * summaryWriteFlagFailClosed.test.js — cierra la simetría de los tres flags
 * gateados del rollout. El kill switch de CONFIG ya tiene su matriz de strings
 * no-"true" (workdayConfigurationService.test.js); aquí se hace lo mismo para:
 *   - WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED  (escritura de daily_summary)
 *   - WORKDAY_ENGINE_STATUS_074_ENABLED           (persistir estados ENUM 074)
 *
 * Invariante fail-closed: SÓLO el string EXACTO "true" habilita; cualquier otra
 * cosa (ausente, vacío, 'false', '1', 'TRUE', 'yes', ' true ') deja el flag OFF.
 * Además, el camino operativo (dispatcher de recalc) consulta el flag para caer
 * a legacy cuando está OFF.
 */

const fs = require('fs');
const path = require('path');

// Mock mínimo de la base: requerir el servicio no debe intentar conectar.
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));

const summary = require('../src/services/workdaySummaryService');

const FLAGS = {
  WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED: summary.isEngineSummaryWriteEnabled,
  WORKDAY_ENGINE_STATUS_074_ENABLED: summary.isStatus074Enabled,
};

const NON_TRUE = [undefined, '', 'false', 'False', 'FALSE', '0', '1', 'TRUE', 'True', 'yes', 'on', ' true ', 'true\n'];

afterEach(() => {
  for (const name of Object.keys(FLAGS)) delete process.env[name];
});

describe('fail-closed: sólo "true" exacto habilita', () => {
  for (const [name, fn] of Object.entries(FLAGS)) {
    describe(name, () => {
      test('con "true" exacto → habilitado', () => {
        process.env[name] = 'true';
        expect(fn()).toBe(true);
      });
      test.each(NON_TRUE)('con %p → deshabilitado (OFF)', (value) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
        expect(fn()).toBe(false);
      });
    });
  }
});

describe('dispatcher operativo consulta el flag (cae a legacy con OFF)', () => {
  const ctrl = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'attendanceController.js'), 'utf8');
  const sched = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'scheduler.js'), 'utf8');

  test('el recalc del controller gatea en isEngineSummaryWriteEnabled()', () => {
    expect(ctrl).toMatch(/isEngineSummaryWriteEnabled\(\)/);
  });
  test('el scheduler gatea el camino de motor en isEngineSummaryWriteEnabled()', () => {
    expect(sched).toMatch(/isEngineSummaryWriteEnabled\(\)/);
  });
});
