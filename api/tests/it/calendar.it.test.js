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

// DDL de cada columna que lee el camino normal de loadScheduleHistory. Permite
// construir tablas employee_schedule_history con subconjuntos para probar los
// estados de esquema reales (072 base / 073 / 075 phaseC).
const COL_DDL = {
  schedule_id: 'INT', valid_from: 'DATE', valid_to: 'DATE',
  check_in: 'TIME', check_out: 'TIME', tolerance_in: 'INT', tolerance_out: 'INT',
  break_mode: 'VARCHAR(20)', break_minutes: 'INT', break_after_minutes: 'INT',
  weekly_target_minutes: 'INT', daily_target_minutes: 'INT',
  work_regime: 'VARCHAR(20)', overtime_policy: 'VARCHAR(20)', rounding_policy: 'VARCHAR(20)',
  night_start: 'TIME', night_end: 'TIME', work_days: 'VARCHAR(20)',
  schedule_name_snapshot: 'VARCHAR(120)', snapshot_version: 'INT', snapshot_source: 'VARCHAR(40)', change_reason: 'VARCHAR(200)',
  overtime_policy_version: 'INT', overtime_policy_config: 'JSON', rounding_policy_version: 'INT', rounding_policy_config: 'JSON',
};
const ALL_HIST_COLS = Object.keys(COL_DDL);
const PHASEC_075_COLS = ['schedule_name_snapshot', 'snapshot_version', 'snapshot_source', 'change_reason',
  'overtime_policy_version', 'overtime_policy_config', 'rounding_policy_version', 'rounding_policy_config'];
function createHistTableSQL(cols) {
  const defs = ['id INT AUTO_INCREMENT PRIMARY KEY', 'employee_id INT', ...cols.map((c) => `${c} ${COL_DDL[c]}`)];
  return `CREATE TABLE employee_schedule_history (${defs.join(', ')}) ENGINE=InnoDB`;
}

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

  test('createCalendar rechaza fecha civil imposible (2026-02-30) → 400 INVALID_DATE', async () => {
    await expect(
      svc.createCalendar({ code: `${ids.code}D`, name: 'bad', valid_from: '2026-02-30' }, null),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_DATE' });
  });

  test('código por ALCANCE: mismo code+valid_from en OTRA empresa NO colisiona; misma empresa sí', async () => {
    const [coB] = await conn.query('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${ids.code}COB`, 'B']);
    ids.companyB = coB.insertId;
    // Mismo code y valid_from que v2 (company A), pero en company B → permitido.
    await expect(
      conn.query(
        "INSERT INTO labor_calendars (code, name, company_id, active, valid_from) VALUES (?, 'otra empresa', ?, 1, '2026-01-01')",
        [ids.code, ids.companyB],
      ),
    ).resolves.toBeTruthy();
    // Mismo code + valid_from en la MISMA empresa A → colisiona (UNIQUE por alcance).
    await expect(
      conn.query(
        "INSERT INTO labor_calendars (code, name, company_id, active, valid_from) VALUES (?, 'dup', ?, 1, '2026-01-01')",
        [ids.code, ids.company],
      ),
    ).rejects.toThrow(/Duplicate|ER_DUP/i);
    await conn.query('DELETE FROM labor_calendars WHERE company_id = ?', [ids.companyB]);
    await conn.query('DELETE FROM companies WHERE id = ?', [ids.companyB]);
  });

  test('listCalendars aplica ALCANCE: rol con alcance ve global + su empresa, no otra', async () => {
    // Global + otra empresa, temporales.
    const [g] = await conn.query("INSERT INTO labor_calendars (code, name, active, valid_from) VALUES (?, 'global', 1, '2026-01-01')", [`${ids.code}G`]);
    const [coC] = await conn.query('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${ids.code}COC`, 'C']);
    const [oc] = await conn.query("INSERT INTO labor_calendars (code, name, company_id, active, valid_from) VALUES (?, 'ajena', ?, 1, '2026-01-01')", [`${ids.code}O`, coC.insertId]);
    const scope = { unrestricted: false, companyIds: [ids.company], branchIds: [], departmentIds: [] };
    const rows = await svc.listCalendars(scope);
    const seen = new Set(rows.map((r) => r.id));
    expect(seen.has(g.insertId)).toBe(true);       // global visible
    expect(seen.has(ids.v2)).toBe(true);           // empresa propia
    expect(seen.has(oc.insertId)).toBe(false);     // empresa ajena NO
    await conn.query('DELETE FROM labor_calendars WHERE id IN (?, ?)', [g.insertId, oc.insertId]);
    await conn.query('DELETE FROM companies WHERE id = ?', [coC.insertId]);
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

    test('incomplete: tabla SIN ninguna columna 073 → respuesta controlada (no error crudo)', async () => {
      await conn.query(
        `CREATE TABLE employee_schedule_history (
           id INT AUTO_INCREMENT PRIMARY KEY, employee_id INT, valid_from DATE, valid_to DATE, check_in TIME
         ) ENGINE=InnoDB`,
      );
      const r = await svc.readWorkdayForDate(1, '2026-01-05');
      expect(r.schema_state).toBe('incomplete');
      expect(r.workday).toBeNull();
    });

    test('incomplete: tabla con SÓLO work_regime (073 parcial) → incomplete, NO error SQL', async () => {
      // El viejo centinela único `work_regime` marcaría 'complete' y explotaría al
      // leer daily_target_minutes/night_start… Ahora exige TODAS las columnas.
      await conn.query(
        `CREATE TABLE employee_schedule_history (
           id INT AUTO_INCREMENT PRIMARY KEY, employee_id INT, valid_from DATE, valid_to DATE, work_regime VARCHAR(20)
         ) ENGINE=InnoDB`,
      );
      const r = await svc.readWorkdayForDate(1, '2026-01-05');
      expect(r.schema_state).toBe('incomplete');
      expect(r.workday).toBeNull();
    });

    test('incomplete: 7 columnas de 073 presentes pero FALTA base 072 (check_in/out) → incomplete', async () => {
      const cols = ALL_HIST_COLS.filter((c) => c !== 'check_in' && c !== 'check_out');
      await conn.query(createHistTableSQL(cols));
      const r = await svc.readWorkdayForDate(1, '2026-01-05');
      expect(r.schema_state).toBe('incomplete'); // nunca llega al SQL lector
      expect(r.workday).toBeNull();
    });

    test('incomplete: 075 parcial (faltan metadatos phaseC) → incomplete controlado (no error+reintento)', async () => {
      const cols = ALL_HIST_COLS.filter((c) => !PHASEC_075_COLS.includes(c));
      await conn.query(createHistTableSQL(cols));
      const r = await svc.readWorkdayForDate(1, '2026-01-05');
      expect(r.schema_state).toBe('incomplete');
      expect(r.workday).toBeNull();
    });

    test('complete: TODAS las columnas (072+073+075) presentes → workdaySchemaState = complete', async () => {
      // Se verifica el GATE explícito (workdaySchemaState). La delegación en
      // workdayConfig con esquema completo se cubre en el unit mockeado, para no
      // depender de tablas auxiliares 072/073 que el harness deja baselined.
      await conn.query(createHistTableSQL(ALL_HIST_COLS));
      expect(await svc.workdaySchemaState()).toBe('complete');
    });

    test('workday con fecha civil imposible (2026-02-30) → 400, sin tocar esquema', async () => {
      await expect(svc.readWorkdayForDate(1, '2026-02-30')).rejects.toMatchObject({ status: 400, code: 'INVALID_DATE' });
    });
  });

  // ── P1-A: aislamiento jerárquico de calendarios por sucursal (real) ──────────
  describe('alcance jerárquico de calendarios (A1 vs A2 de la misma empresa)', () => {
    const j = {};
    beforeAll(async () => {
      const u = `${ids.code}J`;
      const [a1] = await conn.query('INSERT INTO branches (name, code, company_id) VALUES (?, ?, ?)', [`${u}A1`, `${u}A1`, ids.company]);
      const [a2] = await conn.query('INSERT INTO branches (name, code, company_id) VALUES (?, ?, ?)', [`${u}A2`, `${u}A2`, ids.company]);
      j.a1 = a1.insertId; j.a2 = a2.insertId;
      const [cal2] = await conn.query(
        "INSERT INTO labor_calendars (code, name, company_id, branch_id, active, valid_from) VALUES (?, 'cal A2', ?, ?, 1, '2026-01-01')",
        [`${u}CALA2`, ids.company, j.a2],
      );
      j.calA2 = cal2.insertId;
      // Actor con alcance a la sucursal A1 (misma empresa que A2).
      j.scopeA1 = { unrestricted: false, companyIds: [ids.company], branchIds: [j.a1], departmentIds: [] };
    });
    afterAll(async () => {
      await conn.query('DELETE FROM labor_calendars WHERE id = ?', [j.calA2]);
      await conn.query('DELETE FROM branches WHERE id IN (?, ?)', [j.a1, j.a2]);
    });

    test('actor A1 NO lista el calendario de A2 (misma empresa, otra sucursal)', async () => {
      const rows = await svc.listCalendars(j.scopeA1);
      expect(rows.map((r) => r.id)).not.toContain(j.calA2);
    });

    test('canSeeCalendar(scopeA1, calA2) es false (sin fallback a empresa)', async () => {
      const orgScope = require('../../src/services/orgScope');
      const cal = await svc.getCalendar(j.calA2);
      expect(orgScope.canSeeCalendar(j.scopeA1, cal)).toBe(false);
    });

    test('resolveEffective de A2 con scope A1 → null (el caller responde 404)', async () => {
      const eff = await svc.resolveEffective(j.calA2, '2026-01-05', '2026-01-05', { scope: j.scopeA1 });
      expect(eff).toBeNull();
    });
  });

  // ── P2: createCalendar devuelve ID numérico real ─────────────────────────────
  test('createCalendar devuelve insertId numérico real (no undefined)', async () => {
    const prev = process.env.CALENDAR_WRITE_ENABLED;
    process.env.CALENDAR_WRITE_ENABLED = 'true';
    try {
      const id = await svc.createCalendar(
        { code: `${ids.code}NUM`, name: 'num', company_id: ids.company, valid_from: '2026-01-01' }, null,
      );
      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);
      await conn.query('DELETE FROM labor_calendars WHERE id = ?', [id]);
    } finally {
      if (prev === undefined) delete process.env.CALENDAR_WRITE_ENABLED; else process.env.CALENDAR_WRITE_ENABLED = prev;
    }
  });

  // ── P1-B: excepción con fecha imposible por la RUTA real → 400 y cero filas ───
  test('POST excepción con fecha imposible (2026-02-30) → 400 y CERO filas (ruta real)', async () => {
    const prev = process.env.CALENDAR_WRITE_ENABLED;
    process.env.CALENDAR_WRITE_ENABLED = 'true';
    const audit = require('../../src/services/audit');
    const auditSpy = jest.spyOn(audit, 'log').mockImplementation(() => {});
    try {
      const router = require('../../src/routes/laborCalendars');
      const layer = router.stack.find((l) => l.route && l.route.path === '/:id/exceptions' && l.route.methods.post);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const res = { status: jest.fn(function () { return this; }), json: jest.fn(function () { return this; }) };
      // Usuario global (unrestricted) → getOrgScope no necesita empleado.
      await handler({ user: { id: 1, role: 'admin' }, params: { id: String(ids.v2) }, body: { day: '2026-02-30', kind: 'nonworking' }, headers: {}, correlationId: 'itc' }, res, jest.fn());
      expect(res.status).toHaveBeenCalledWith(400);
      const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM calendar_exceptions WHERE calendar_id = ?', [ids.v2]);
      expect(Number(n)).toBe(0);             // cero filas
      expect(auditSpy).not.toHaveBeenCalled(); // sin auditoría
    } finally {
      auditSpy.mockRestore();
      if (prev === undefined) delete process.env.CALENDAR_WRITE_ENABLED; else process.env.CALENDAR_WRITE_ENABLED = prev;
    }
  });
});
