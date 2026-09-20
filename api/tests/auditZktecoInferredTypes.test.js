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
  test('duplicado → DUPLICATE; sin raw → RAW_NOT_FOUND; fuera de scope → NOT_ELIGIBLE', () => {
    expect(audit.classifyCandidate({ ...base, isDuplicate: true }).classification).toBe('DUPLICATE');
    expect(audit.classifyCandidate({ ...base, rawFound: false }).classification).toBe('RAW_NOT_FOUND');
    expect(audit.classifyCandidate({ ...base, eligible: false }).classification).toBe('NOT_ELIGIBLE');
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

describe('runAudit — replay, device-key y coverage (sequelize sintético)', () => {
  // fake por patrón de SQL. COUNT → total; scope → candidatos; timeline → JOIN.
  function fakeDb({ total, candidates, timeline }) {
    return {
      query: jest.fn(async (sql) => {
        if (/COUNT\(\*\) AS n/i.test(sql)) return [[{ n: total }]];
        if (/LEFT JOIN raw_device_punches/i.test(sql)) return [timeline];
        if (/FROM attendance_logs\s+WHERE source/i.test(sql)) return [candidates];
        return [[]];
      }),
      close: jest.fn(async () => {}),
    };
  }

  test('Corrección 1: 18:16 AMBIGUOUS y 07:01 NO se vuelve DETERMINISTIC_CHANGE por el current ambiguo', async () => {
    // Dos zkteco_direct sin raw explícito y sin contexto confiable previo.
    const rows = [
      { id: 101, empId: 55, deviceId: 1, wall: '2026-09-19 18:16:00', storedType: 'in', source: 'zkteco_direct', rawJson: '{}', mappingStatus: 'mapped' },
      { id: 102, empId: 55, deviceId: 1, wall: '2026-09-20 07:01:00', storedType: 'in', source: 'zkteco_direct', rawJson: '{}', mappingStatus: 'mapped' },
    ];
    const db = fakeDb({
      total: 2,
      candidates: rows.map(r => ({ id: r.id, empId: r.empId, deviceId: r.deviceId, wall: r.wall, type: r.storedType })),
      timeline: rows,
    });
    const { manifest } = await audit.runAudit({ sequelize: db, cutover: '2026-09-16', limit: 100, generatedAt: 'fixed', baselineCommit: 't' });
    const byId = Object.fromEntries(manifest.candidate_rows.map(r => [r.attendance_log_id, r]));
    expect(byId[101].classification).toBe('AMBIGUOUS');
    expect(byId[102].classification).toBe('AMBIGUOUS');       // <-- NO DETERMINISTIC_CHANGE
    expect(manifest.counts.by_classification.DETERMINISTIC_CHANGE).toBeUndefined();
  });

  test('DETERMINISTIC_CHANGE sólo con ancla CONFIABLE (contexto device) previa', async () => {
    const rows = [
      { id: 300, empId: 60, deviceId: 9, wall: '2026-09-16 08:00:00', storedType: 'in', source: 'device', rawJson: null, mappingStatus: null },       // contexto confiable
      { id: 301, empId: 60, deviceId: 1, wall: '2026-09-16 17:00:00', storedType: 'in', source: 'zkteco_direct', rawJson: '{}', mappingStatus: 'mapped' }, // candidato
    ];
    const db = fakeDb({
      total: 1,
      candidates: [{ id: 301, empId: 60, deviceId: 1, wall: '2026-09-16 17:00:00', type: 'in' }],
      timeline: rows,
    });
    const { manifest } = await audit.runAudit({ sequelize: db, cutover: '2026-09-16', limit: 100, generatedAt: 'fixed' });
    const r = manifest.candidate_rows.find(x => x.attendance_log_id === 301);
    expect(r.classification).toBe('DETERMINISTIC_CHANGE');
    expect(r.proposed_type).toBe('out');
    expect(manifest.coverage).toEqual({ total_scoped_rows: 1, rows_audited: 1, truncated: false });
  });

  test('Corrección 3: dos dispositivos, mismo empleado/segundo → cada candidato usa el raw de SU device', async () => {
    const rows = [
      { id: 400, empId: 70, deviceId: 1, wall: '2026-09-18 09:00:00', storedType: 'in', source: 'zkteco_direct', rawJson: '{"inOutStatus":0}', mappingStatus: 'mapped' },
      { id: 401, empId: 70, deviceId: 2, wall: '2026-09-18 09:00:00', storedType: 'out', source: 'zkteco_direct', rawJson: '{"inOutStatus":1}', mappingStatus: 'mapped' },
    ];
    const db = fakeDb({
      total: 2,
      candidates: rows.map(r => ({ id: r.id, empId: r.empId, deviceId: r.deviceId, wall: r.wall, type: r.storedType })),
      timeline: rows,
    });
    const { manifest } = await audit.runAudit({ sequelize: db, cutover: '2026-09-16', limit: 100 });
    const byId = Object.fromEntries(manifest.candidate_rows.map(r => [r.attendance_log_id, r]));
    // Cada candidato leyó el raw de SU PROPIO device (no cross-read): si hubiera
    // pisado el otro, el raw explícito no coincidiría con el device.
    expect(byId[400].raw_explicit_type).toBe('in');   // device 1
    expect(byId[401].raw_explicit_type).toBe('out');  // device 2
    // El explícito se conserva (proposed == stored), nunca invertido.
    expect(byId[400].proposed_type).toBe('in');
    expect(byId[401].proposed_type).toBe('out');
    // Ninguno es EXPLICIT_STORED_MISMATCH (eso indicaría haber leído el raw del otro device).
    expect(byId[400].classification).not.toBe('EXPLICIT_STORED_MISMATCH');
    expect(byId[401].classification).not.toBe('EXPLICIT_STORED_MISMATCH');
    expect(byId[400].classification).toBe('ALREADY_CORRECT');
    // 401 comparte el mismo segundo que 400: el IN explícito de 400 entra al
    // historial y, por ventana de dedupe, el contexto de 401 espera IN → como su
    // raw dice OUT, se REPORTA EXPLICIT_CONFLICT (explícito preservado, no invertido).
    expect(byId[401].classification).toBe('EXPLICIT_CONFLICT');
  });

  test('coverage.truncated=true cuando el scope excede el LIMIT', async () => {
    const rows = [{ id: 500, empId: 88, deviceId: 1, wall: '2026-09-16 08:00:00', storedType: 'in', source: 'zkteco_direct', rawJson: '{}', mappingStatus: 'mapped' }];
    const db = fakeDb({
      total: 212,
      candidates: rows.map(r => ({ id: r.id, empId: r.empId, deviceId: r.deviceId, wall: r.wall, type: r.storedType })),
      timeline: rows,
    });
    const { manifest } = await audit.runAudit({ sequelize: db, cutover: '2026-09-16', limit: 1 });
    expect(manifest.coverage.total_scoped_rows).toBe(212);
    expect(manifest.coverage.rows_audited).toBe(1);
    expect(manifest.coverage.truncated).toBe(true);
  });

  test('runAudit no ejecuta ningún SQL de escritura', async () => {
    const rows = [{ id: 900, empId: 91, deviceId: 1, wall: '2026-09-16 08:00:00', storedType: 'in', source: 'zkteco_direct', rawJson: '{}', mappingStatus: 'mapped' }];
    const db = fakeDb({ total: 1, candidates: rows.map(r => ({ id: r.id, empId: r.empId, deviceId: r.deviceId, wall: r.wall, type: r.storedType })), timeline: rows });
    await audit.runAudit({ sequelize: db, cutover: '2026-09-16', limit: 100 });
    for (const call of db.query.mock.calls) {
      expect(String(call[0])).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
    }
  });
});
