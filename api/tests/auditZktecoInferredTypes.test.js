/**
 * auditZktecoInferredTypes.test.js — Auditor DRY-RUN read-only.
 *
 * Cubre: clasificación (incl. EXPLICIT_STORED_MISMATCH), replay que NO usa el
 * current_type ambiguo como evidencia, match de raw por device, manifest +
 * SHA-256 + coverage, y guard de sólo-lectura. Sin nombres de empleados.
 */

const audit = require('../scripts/audit-zkteco-inferred-types');

describe('classifyCandidate — reglas de clasificación', () => {
  const base = { eligible: true, rawFound: true, isDuplicate: false, currentType: 'in', rawExplicitType: null, contextualType: 'unknown', contextualProvenance: 'unknown_no_context' };

  test('sin explícito + contexto determinista que difiere → DETERMINISTIC_CHANGE', () => {
    const v = audit.classifyCandidate({ ...base, currentType: 'in', contextualType: 'out', contextualProvenance: 'contextual' });
    expect(v.classification).toBe('DETERMINISTIC_CHANGE');
    expect(v.proposedType).toBe('out');
  });

  test('sin explícito + contexto determinista que coincide → ALREADY_CORRECT', () => {
    const v = audit.classifyCandidate({ ...base, currentType: 'out', contextualType: 'out', contextualProvenance: 'contextual' });
    expect(v.classification).toBe('ALREADY_CORRECT');
  });

  // ── Corrección 2: raw explícito ≠ current_type NUNCA es ALREADY_CORRECT ──
  test('raw OUT / stored IN / context OUT → EXPLICIT_STORED_MISMATCH (no ALREADY_CORRECT)', () => {
    const v = audit.classifyCandidate({ ...base, rawExplicitType: 'out', currentType: 'in', contextualType: 'out', contextualProvenance: 'contextual' });
    expect(v.classification).toBe('EXPLICIT_STORED_MISMATCH');
    expect(v.classification).not.toBe('ALREADY_CORRECT');
    expect(v.proposedType).toBe('in'); // read-only: no auto-corrige
  });
  test('raw OUT / stored IN / context UNKNOWN → EXPLICIT_STORED_MISMATCH', () => {
    const v = audit.classifyCandidate({ ...base, rawExplicitType: 'out', currentType: 'in', contextualType: 'unknown', contextualProvenance: 'unknown_no_context' });
    expect(v.classification).toBe('EXPLICIT_STORED_MISMATCH');
  });
  test('raw IN / stored OUT / context IN → EXPLICIT_STORED_MISMATCH', () => {
    const v = audit.classifyCandidate({ ...base, rawExplicitType: 'in', currentType: 'out', contextualType: 'in', contextualProvenance: 'contextual' });
    expect(v.classification).toBe('EXPLICIT_STORED_MISMATCH');
    expect(v.classification).not.toBe('ALREADY_CORRECT');
  });

  test('raw == stored pero el contexto lo contradice → EXPLICIT_CONFLICT', () => {
    const v = audit.classifyCandidate({ ...base, rawExplicitType: 'in', currentType: 'in', contextualType: 'out', contextualProvenance: 'contextual' });
    expect(v.classification).toBe('EXPLICIT_CONFLICT');
  });
  test('EXPLICIT_CONFLICT nunca es DETERMINISTIC_CHANGE', () => {
    const v = audit.classifyCandidate({ ...base, rawExplicitType: 'out', currentType: 'out', contextualType: 'in', contextualProvenance: 'contextual' });
    expect(v.classification).toBe('EXPLICIT_CONFLICT');
    expect(v.classification).not.toBe('DETERMINISTIC_CHANGE');
  });
  test('raw == stored, contexto consistente → ALREADY_CORRECT', () => {
    const v = audit.classifyCandidate({ ...base, rawExplicitType: 'in', currentType: 'in', contextualType: 'in', contextualProvenance: 'contextual' });
    expect(v.classification).toBe('ALREADY_CORRECT');
  });

  test('sin explícito y sin contexto, actual unknown → UNKNOWN_NO_CONTEXT', () => {
    expect(audit.classifyCandidate({ ...base, currentType: 'unknown' }).classification).toBe('UNKNOWN_NO_CONTEXT');
  });
  test('sin explícito y sin contexto determinista, actual in/out → AMBIGUOUS (sin cambio)', () => {
    const v = audit.classifyCandidate({ ...base, currentType: 'in' });
    expect(v.classification).toBe('AMBIGUOUS');
    expect(v.proposedType).toBe('in');
  });
  test('sin raw único enlazado → RAW_NOT_FOUND; fuera de scope → NOT_ELIGIBLE', () => {
    expect(audit.classifyCandidate({ ...base, rawFound: false }).classification).toBe('RAW_NOT_FOUND');
    expect(audit.classifyCandidate({ ...base, eligible: false }).classification).toBe('NOT_ELIGIBLE');
  });
  test('Corrección 6: NO existe clasificación DUPLICATE en el auditor', () => {
    expect(audit.CLASS.DUPLICATE).toBeUndefined();
  });
});

describe('explicitFromRawJson — extractor compartido', () => {
  test('inOutStatus=1 → out; state=0 → in; sin campo → null; string JSON parsea', () => {
    expect(audit.explicitFromRawJson({ inOutStatus: 1 })).toBe('out');
    expect(audit.explicitFromRawJson({ state: 0 })).toBe('in');
    expect(audit.explicitFromRawJson({ foo: 'bar' })).toBeNull();
    expect(audit.explicitFromRawJson('{"status":"out"}')).toBe('out');
    expect(audit.explicitFromRawJson('no-json')).toBeNull();
  });
  test('verify=15 (cara) NO se confunde con in/out', () => {
    expect(audit.explicitFromRawJson({ verify: 15, workCode: 0 })).toBeNull();
  });
});

describe('buildManifest — counts, coverage, SHA y sin PII', () => {
  const rows = [
    { attendance_log_id: 1, employee_id: 10, device_id: 2, wall_clock_timestamp: '2026-09-16 08:00:00', current_type: 'in', raw_explicit_type: null, proposed_type: 'in', classification: 'AMBIGUOUS', reason: 'x' },
    { attendance_log_id: 2, employee_id: 10, device_id: 2, wall_clock_timestamp: '2026-09-17 07:00:00', current_type: 'in', raw_explicit_type: null, proposed_type: 'in', classification: 'AMBIGUOUS', reason: 'y' },
  ];
  test('coverage.truncated cuando total_scoped_rows > rows_audited', () => {
    const { manifest } = audit.buildManifest(rows, { total_scoped_rows: 212, cutover: '2026-09-16', generated_at: 'fixed', baseline_commit: 'abc' });
    expect(manifest.coverage).toEqual({ total_scoped_rows: 212, rows_audited: 2, truncated: true });
    expect(manifest.counts.total).toBe(2);
    expect(manifest.apply).toBe(false);
  });
  test('SHA-256 estable y sin claves de nombre de empleado', () => {
    const a = audit.buildManifest(rows, { generated_at: 'fixed', baseline_commit: 'abc', cutover: '2026-09-16', total_scoped_rows: 2 });
    const b = audit.buildManifest(rows, { generated_at: 'fixed', baseline_commit: 'abc', cutover: '2026-09-16', total_scoped_rows: 2 });
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(a.manifest)).not.toMatch(/first_name|last_name|employee_name|"name"/i);
  });
});

describe('makeReadOnlyRunner — guard de sólo-lectura', () => {
  test('rechaza escritura antes de tocar la BD; permite SELECT', async () => {
    const spy = jest.fn(async () => [[]]);
    const q = audit.makeReadOnlyRunner({ query: spy });
    for (const sql of ['UPDATE x SET a=1', 'INSERT INTO x VALUES (1)', 'DELETE FROM x', 'TRUNCATE x', '  update  x set a=1', 'REPLACE INTO x VALUES (1)']) {
      await expect(q(sql)).rejects.toThrow(/READONLY_VIOLATION/);
    }
    expect(spy).not.toHaveBeenCalled();
    const [rows] = await audit.makeReadOnlyRunner({ query: async () => [[{ ok: 1 }]] })('SELECT 1');
    expect(rows[0].ok).toBe(1);
  });
});

describe('runAudit — replay, vínculo por imported_attendance_log_id y coverage', () => {
  // fake por patrón de SQL. COUNT → total; raw_device_punches (group) → rawLinks
  // filtrados por los ids pedidos; scope → candidatos; timeline (sin join) → rows.
  // rawLinks: [{ alId, c, anyRaw }]
  function fakeDb({ total, candidates, timeline, rawLinks = [] }) {
    return {
      query: jest.fn(async (sql, opts) => {
        if (/COUNT\(\*\) AS n/i.test(sql)) return [[{ n: total }]];
        if (/FROM raw_device_punches/i.test(sql)) {
          const ids = new Set((opts && opts.replacements) || []);
          return [rawLinks.filter(r => ids.has(r.alId))];
        }
        if (/FROM attendance_logs\s+WHERE source/i.test(sql)) return [candidates];
        if (/FROM attendance_logs/i.test(sql)) return [timeline];
        return [[]];
      }),
      close: jest.fn(async () => {}),
    };
  }
  const candOf = (rows) => rows.map(r => ({ id: r.id, empId: r.empId, deviceId: r.deviceId, wall: r.wall, type: r.storedType }));

  test('Corrección 1: 18:16 AMBIGUOUS y 07:01 NO se vuelve DETERMINISTIC_CHANGE por el current ambiguo', async () => {
    const rows = [
      { id: 101, empId: 55, deviceId: 1, wall: '2026-09-19 18:16:00', storedType: 'in', source: 'zkteco_direct' },
      { id: 102, empId: 55, deviceId: 1, wall: '2026-09-20 07:01:00', storedType: 'in', source: 'zkteco_direct' },
    ];
    // raw enlazado por imported id, sin tipo explícito.
    const rawLinks = [{ alId: 101, c: 1, anyRaw: '{}' }, { alId: 102, c: 1, anyRaw: '{}' }];
    const db = fakeDb({ total: 2, candidates: candOf(rows), timeline: rows, rawLinks });
    const { manifest } = await audit.runAudit({ sequelize: db, cutover: '2026-09-16', limit: 100, generatedAt: 'fixed', baselineCommit: 't' });
    const byId = Object.fromEntries(manifest.candidate_rows.map(r => [r.attendance_log_id, r]));
    expect(byId[101].classification).toBe('AMBIGUOUS');
    expect(byId[102].classification).toBe('AMBIGUOUS');      // NO DETERMINISTIC_CHANGE
    expect(manifest.counts.by_classification.DETERMINISTIC_CHANGE).toBeUndefined();
  });

  test('Corrección 6.1/6.2: raw mapping_status irrelevante; log con raw enlazado sin explícito → AMBIGUOUS, NO DUPLICATE', async () => {
    // Aunque el raw haya sido re-observado (mapping_status='duplicate' en prod),
    // aquí no se lee mapping_status: sólo el vínculo por imported id + su explícito.
    const rows = [{ id: 700, empId: 71, deviceId: 1, wall: '2026-09-16 08:00:00', storedType: 'in', source: 'zkteco_direct' }];
    const rawLinks = [{ alId: 700, c: 1, anyRaw: '{}' }]; // sin tipo explícito
    const db = fakeDb({ total: 1, candidates: candOf(rows), timeline: rows, rawLinks });
    const { manifest } = await audit.runAudit({ sequelize: db, cutover: '2026-09-16', limit: 100 });
    const r = manifest.candidate_rows[0];
    expect(r.classification).toBe('AMBIGUOUS');
    expect(manifest.counts.by_classification.DUPLICATE).toBeUndefined();
  });

  test('Corrección 6.3: raw enlazado con explícito IN/OUT es evidencia confiable (aunque fuese re-observado)', async () => {
    const rows = [{ id: 710, empId: 72, deviceId: 1, wall: '2026-09-16 08:00:00', storedType: 'in', source: 'zkteco_direct' }];
    const rawLinks = [{ alId: 710, c: 1, anyRaw: '{"inOutStatus":0}' }]; // explícito IN
    const db = fakeDb({ total: 1, candidates: candOf(rows), timeline: rows, rawLinks });
    const { manifest } = await audit.runAudit({ sequelize: db, cutover: '2026-09-16', limit: 100 });
    const r = manifest.candidate_rows[0];
    expect(r.raw_explicit_type).toBe('in');
    expect(r.classification).toBe('ALREADY_CORRECT'); // raw in == stored in
  });

  test('Corrección 6.4: dos devices, mismo empleado/segundo → imported_attendance_log_id enlaza cada log con SU raw', async () => {
    const rows = [
      { id: 400, empId: 70, deviceId: 1, wall: '2026-09-18 09:00:00', storedType: 'in', source: 'zkteco_direct' },
      { id: 401, empId: 70, deviceId: 2, wall: '2026-09-18 09:00:00', storedType: 'out', source: 'zkteco_direct' },
    ];
    const rawLinks = [{ alId: 400, c: 1, anyRaw: '{"inOutStatus":0}' }, { alId: 401, c: 1, anyRaw: '{"inOutStatus":1}' }];
    const db = fakeDb({ total: 2, candidates: candOf(rows), timeline: rows, rawLinks });
    const { manifest } = await audit.runAudit({ sequelize: db, cutover: '2026-09-16', limit: 100 });
    const byId = Object.fromEntries(manifest.candidate_rows.map(r => [r.attendance_log_id, r]));
    expect(byId[400].raw_explicit_type).toBe('in');   // su propio raw
    expect(byId[401].raw_explicit_type).toBe('out');  // su propio raw
    expect(byId[400].classification).not.toBe('EXPLICIT_STORED_MISMATCH');
    expect(byId[401].classification).not.toBe('EXPLICIT_STORED_MISMATCH');
    expect(byId[400].classification).toBe('ALREADY_CORRECT');
    expect(byId[401].classification).toBe('EXPLICIT_CONFLICT'); // mismo segundo: dedupe espera IN, raw dice OUT
  });

  test('Corrección 6.5: imported_attendance_log_id NULL (0 links) o múltiple (>1) → RAW_NOT_FOUND (nunca raw ajeno)', async () => {
    const rows = [
      { id: 800, empId: 80, deviceId: 1, wall: '2026-09-16 08:00:00', storedType: 'in', source: 'zkteco_direct' }, // 0 links
      { id: 801, empId: 80, deviceId: 1, wall: '2026-09-16 09:00:00', storedType: 'in', source: 'zkteco_direct' }, // >1 links
    ];
    const rawLinks = [{ alId: 801, c: 2, anyRaw: '{"inOutStatus":0}' }]; // 801 ambiguo; 800 sin link
    const db = fakeDb({ total: 2, candidates: candOf(rows), timeline: rows, rawLinks });
    const { manifest } = await audit.runAudit({ sequelize: db, cutover: '2026-09-16', limit: 100 });
    const byId = Object.fromEntries(manifest.candidate_rows.map(r => [r.attendance_log_id, r]));
    expect(byId[800].classification).toBe('RAW_NOT_FOUND');
    expect(byId[801].classification).toBe('RAW_NOT_FOUND');
    expect(byId[801].raw_explicit_type).toBeNull(); // no se elige el raw ambiguo
  });

  test('DETERMINISTIC_CHANGE sólo con ancla CONFIABLE (contexto device) previa', async () => {
    const rows = [
      { id: 300, empId: 60, deviceId: 9, wall: '2026-09-16 08:00:00', storedType: 'in', source: 'device' },       // contexto confiable (otra fuente)
      { id: 301, empId: 60, deviceId: 1, wall: '2026-09-16 17:00:00', storedType: 'in', source: 'zkteco_direct' }, // candidato
    ];
    const rawLinks = [{ alId: 301, c: 1, anyRaw: '{}' }]; // 300 es device (contexto no candidato); 301 sin explícito
    const db = fakeDb({ total: 1, candidates: candOf([rows[1]]), timeline: rows, rawLinks });
    const { manifest } = await audit.runAudit({ sequelize: db, cutover: '2026-09-16', limit: 100 });
    const r = manifest.candidate_rows.find(x => x.attendance_log_id === 301);
    expect(r.classification).toBe('DETERMINISTIC_CHANGE');
    expect(r.proposed_type).toBe('out');
    expect(manifest.coverage).toEqual({ total_scoped_rows: 1, rows_audited: 1, truncated: false });
  });

  test('coverage.truncated=true cuando el scope excede el LIMIT', async () => {
    const rows = [{ id: 500, empId: 88, deviceId: 1, wall: '2026-09-16 08:00:00', storedType: 'in', source: 'zkteco_direct' }];
    const db = fakeDb({ total: 212, candidates: candOf(rows), timeline: rows, rawLinks: [{ alId: 500, c: 1, anyRaw: '{}' }] });
    const { manifest } = await audit.runAudit({ sequelize: db, cutover: '2026-09-16', limit: 1 });
    expect(manifest.coverage).toEqual({ total_scoped_rows: 212, rows_audited: 1, truncated: true });
  });

  test('runAudit no ejecuta ningún SQL de escritura', async () => {
    const rows = [{ id: 900, empId: 91, deviceId: 1, wall: '2026-09-16 08:00:00', storedType: 'in', source: 'zkteco_direct' }];
    const db = fakeDb({ total: 1, candidates: candOf(rows), timeline: rows, rawLinks: [{ alId: 900, c: 1, anyRaw: '{}' }] });
    await audit.runAudit({ sequelize: db, cutover: '2026-09-16', limit: 100 });
    for (const call of db.query.mock.calls) {
      expect(String(call[0])).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
    }
  });
});
