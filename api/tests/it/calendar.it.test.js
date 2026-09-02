'use strict';

/**
 * calendar.it.test.js — INTEGRACIÓN (MySQL real): versionado real de
 * calendarios y estados del esquema de jornada.
 *
 * Nota: el estado 'complete' de jornada requiere el esquema 072/073 completo
 * (que este harness deja baselined, no aplicado), por lo que se prueba en el
 * unit mockeado; acá se cubren 'missing' e 'incomplete' contra la base real.
 */
const { describeIT, makeConn, closeAppDb } = require('./helper');

describeIT('calendario (integración) — versionado y jornada', () => {
  let conn;
  let svc;
  const ids = {};

  beforeAll(async () => {
    conn = await makeConn();
    svc = require('../../src/services/calendarService');
    const uniq = `ITC${Date.now() % 100000}`;
    const [co] = await conn.query('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${uniq}CO`, 'Cal IT']);
    ids.company = co.insertId;
    ids.code = `${uniq}CAL`;
    // Dos versiones del MISMO código (versionado real).
    const [v1] = await conn.query(
      "INSERT INTO labor_calendars (code, name, company_id, work_days, active, valid_from, valid_to) VALUES (?, 'v1', ?, '2,3,4,5,6', 1, '2025-01-01', '2025-12-31')",
      [ids.code, ids.company],
    );
    ids.v1 = v1.insertId;
    const [v2] = await conn.query(
      "INSERT INTO labor_calendars (code, name, company_id, work_days, active, valid_from, valid_to) VALUES (?, 'v2', ?, '2,3,4,5', 1, '2026-01-01', NULL)",
      [ids.code, ids.company],
    );
    ids.v2 = v2.insertId;
  });

  afterAll(async () => {
    if (conn) {
      await conn.query('DELETE FROM labor_calendars WHERE code = ?', [ids.code]);
      await conn.query('DELETE FROM companies WHERE id = ?', [ids.company]);
      await conn.end();
    }
    await closeAppDb();
  });

  test('dos versiones del mismo código coexisten', async () => {
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM labor_calendars WHERE code = ?', [ids.code]);
    expect(Number(n)).toBe(2);
  });

  test('pickCalendarForDate elige la versión por fecha (precedencia determinista)', async () => {
    const a = await svc.pickCalendarForDate({ company_id: ids.company }, '2025-06-01');
    const b = await svc.pickCalendarForDate({ company_id: ids.company }, '2026-06-01');
    expect(a.id).toBe(ids.v1);
    expect(b.id).toBe(ids.v2);
  });

  test('resolveEffectiveByScope usa la versión vigente por fecha', async () => {
    // 2026: v2 (lun-vie). 2026-01-03 sábado → no laborable.
    const r = await svc.resolveEffectiveByScope({ company_id: ids.company }, '2026-01-03', '2026-01-05');
    const byDate = Object.fromEntries(r.days.map((d) => [d.date, d]));
    expect(byDate['2026-01-03'].working).toBe(false); // sábado (v2 lun-vie)
    expect(byDate['2026-01-05'].working).toBe(true);  // lunes
    expect(byDate['2026-01-05'].calendar_id).toBe(ids.v2);
  });

  test('createCalendar rechaza vigencia invertida (valid_to < valid_from)', async () => {
    await expect(
      svc.createCalendar({ code: `${ids.code}X`, name: 'bad', valid_from: '2026-05-01', valid_to: '2026-01-01' }, null),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_VALIDITY' });
  });

  describe('jornada — estados de esquema reales', () => {
    afterEach(async () => {
      await conn.query('DROP TABLE IF EXISTS employee_schedule_history');
    });

    test('missing: sin tabla employee_schedule_history → historical_fallback', async () => {
      await conn.query('DROP TABLE IF EXISTS employee_schedule_history');
      const r = await svc.readWorkdayForDate(1, '2026-01-05');
      expect(r.schema_state).toBe('missing');
      expect(r.workday).toEqual({ source: 'historical_fallback', config: null });
    });

    test('incomplete: tabla sin columnas 073 → respuesta controlada (no error crudo)', async () => {
      await conn.query(
        `CREATE TABLE employee_schedule_history (
           id INT AUTO_INCREMENT PRIMARY KEY, employee_id INT, valid_from DATE, valid_to DATE, check_in TIME
         ) ENGINE=InnoDB`,
      );
      const r = await svc.readWorkdayForDate(1, '2026-01-05');
      expect(r.schema_state).toBe('incomplete');
      expect(r.workday).toBeNull();
    });
  });
});
