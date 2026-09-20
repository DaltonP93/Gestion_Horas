/**
 * auditZktecoInferredTypes.test.js — Auditor DRY-RUN read-only.
 *
 * Verifica la clasificación (con fixtures sintéticos, sin BD ni red), el
 * manifest + SHA-256, y que el auditor NO puede ejecutar SQL de escritura
 * (guard de sólo-lectura). Sin nombres de empleados: sólo IDs.
 */

const audit = require('../scripts/audit-zkteco-inferred-types');

describe('classifyCandidate — reglas de clasificación', () => {
  const base = { eligible: true, rawFound: true, isDuplicate: false, currentType: 'in', rawExplicitType: null, contextualType: 'unknown', contextualProvenance: 'unknown_no_context' };

  test('sin explícito + contexto determinista que difiere del actual → DETERMINISTIC_CHANGE', () => {
    const v = audit.classifyCandidate({ ...base, currentType: 'in', contextualType: 'out', contextualProvenance: 'contextual' });
    expect(v.classification).toBe('DETERMINISTIC_CHANGE');
    expect(v.proposedType).toBe('out');
  });

  test('sin explícito + contexto determinista que coincide → ALREADY_CORRECT', () => {
    const v = audit.classifyCandidate({ ...base, currentType: 'out', contextualType: 'out', contextualProvenance: 'contextual' });
    expect(v.classification).toBe('ALREADY_CORRECT');
    expect(v.proposedType).toBe('out');
  });

  test('explícito que CONTRADICE el contexto → EXPLICIT_CONFLICT (nunca cambio automático)', () => {
    const v = audit.classifyCandidate({ ...base, rawExplicitType: 'in', currentType: 'in', contextualType: 'out', contextualProvenance: 'contextual' });
    expect(v.classification).toBe('EXPLICIT_CONFLICT');
    expect(v.proposedType).toBe('in');   // se conserva el actual/explícito, NO se invierte
  });

  test('EXPLICIT_CONFLICT NUNCA se reclasifica como DETERMINISTIC_CHANGE', () => {
    const v = audit.classifyCandidate({ ...base, rawExplicitType: 'out', currentType: 'out', contextualType: 'in', contextualProvenance: 'contextual' });
    expect(v.classification).toBe('EXPLICIT_CONFLICT');
    expect(v.classification).not.toBe('DETERMINISTIC_CHANGE');
  });

  test('explícito consistente con contexto → ALREADY_CORRECT', () => {
    const v = audit.classifyCandidate({ ...base, rawExplicitType: 'in', currentType: 'in', contextualType: 'in', contextualProvenance: 'contextual' });
    expect(v.classification).toBe('ALREADY_CORRECT');
  });

  test('sin explícito y sin contexto, actual unknown → UNKNOWN_NO_CONTEXT', () => {
    const v = audit.classifyCandidate({ ...base, currentType: 'unknown' });
    expect(v.classification).toBe('UNKNOWN_NO_CONTEXT');
    expect(v.proposedType).toBe('unknown');
  });

  test('sin explícito y sin contexto determinista, pero actual in/out → AMBIGUOUS (sin cambio)', () => {
    const v = audit.classifyCandidate({ ...base, currentType: 'in', contextualType: 'unknown', contextualProvenance: 'unknown_no_context' });
    expect(v.classification).toBe('AMBIGUOUS');
    expect(v.proposedType).toBe('in');
  });

  test('duplicado → DUPLICATE', () => {
    expect(audit.classifyCandidate({ ...base, isDuplicate: true }).classification).toBe('DUPLICATE');
  });

  test('sin raw → RAW_NOT_FOUND', () => {
    expect(audit.classifyCandidate({ ...base, rawFound: false }).classification).toBe('RAW_NOT_FOUND');
  });

  test('fuera de scope → NOT_ELIGIBLE', () => {
    expect(audit.classifyCandidate({ ...base, eligible: false }).classification).toBe('NOT_ELIGIBLE');
  });
});

describe('explicitFromRawJson — extracción del tipo explícito del crudo', () => {
  test('objeto con inOutStatus=1 → out; state=0 → in; sin campo → null', () => {
    expect(audit.explicitFromRawJson({ inOutStatus: 1 })).toBe('out');
    expect(audit.explicitFromRawJson({ state: 0 })).toBe('in');
    expect(audit.explicitFromRawJson({ foo: 'bar' })).toBeNull();
  });
  test('string JSON también se parsea', () => {
    expect(audit.explicitFromRawJson('{"status":"out"}')).toBe('out');
    expect(audit.explicitFromRawJson('no-json')).toBeNull();
  });
  test('verify=15 (cara) NO se confunde con in/out', () => {
    // Verify/verifyMode nunca determina in/out: sólo INOUT_FIELDS.
    expect(audit.explicitFromRawJson({ verify: 15, workCode: 0 })).toBeNull();
  });
});

describe('buildManifest — counts, SHA y sin PII', () => {
  const rows = [
    { attendance_log_id: 1, employee_id: 10, device_id: 2, wall_clock_timestamp: '2026-09-16 08:00:00', current_type: 'in', raw_explicit_type: null, proposed_type: 'in', classification: 'ALREADY_CORRECT', reason: 'x' },
    { attendance_log_id: 2, employee_id: 10, device_id: 2, wall_clock_timestamp: '2026-09-17 07:00:00', current_type: 'in', raw_explicit_type: null, proposed_type: 'out', classification: 'DETERMINISTIC_CHANGE', reason: 'y' },
    { attendance_log_id: 3, employee_id: 11, device_id: 3, wall_clock_timestamp: '2026-09-17 09:00:00', current_type: 'in', raw_explicit_type: 'in', proposed_type: 'in', classification: 'EXPLICIT_CONFLICT', reason: 'z' },
  ];
  test('counts por clasificación / dispositivo / fecha', () => {
    const { manifest } = audit.buildManifest(rows, { cutover: '2026-09-16', generated_at: 'fixed', baseline_commit: 'abc' });
    expect(manifest.counts.total).toBe(3);
    expect(manifest.counts.by_classification).toEqual({ ALREADY_CORRECT: 1, DETERMINISTIC_CHANGE: 1, EXPLICIT_CONFLICT: 1 });
    expect(manifest.counts.by_device).toEqual({ '2': 2, '3': 1 });
    expect(manifest.counts.by_date).toEqual({ '2026-09-16': 1, '2026-09-17': 2 });
    expect(manifest.apply).toBe(false);
    expect(manifest.mode).toBe('dry-run');
  });
  test('SHA-256 estable y reproducible para el mismo contenido', () => {
    const a = audit.buildManifest(rows, { generated_at: 'fixed', baseline_commit: 'abc', cutover: '2026-09-16' });
    const b = audit.buildManifest(rows, { generated_at: 'fixed', baseline_commit: 'abc', cutover: '2026-09-16' });
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  test('el manifest no contiene claves de nombre de empleado', () => {
    const { manifest } = audit.buildManifest(rows, {});
    const json = JSON.stringify(manifest);
    expect(json).not.toMatch(/first_name|last_name|employee_name|"name"/i);
  });
});

describe('makeReadOnlyRunner — guard de sólo-lectura', () => {
  test('rechaza UPDATE/INSERT/DELETE/DDL antes de tocar la BD', async () => {
    const spy = jest.fn(async () => [[]]);
    const q = audit.makeReadOnlyRunner({ query: spy });
    for (const sql of [
      'UPDATE attendance_logs SET type=? WHERE id=?',
      'INSERT INTO attendance_logs VALUES (1)',
      'DELETE FROM attendance_logs WHERE id=1',
      'TRUNCATE attendance_logs',
      '  update  x set a=1',
      'REPLACE INTO x VALUES (1)',
    ]) {
      await expect(q(sql)).rejects.toThrow(/READONLY_VIOLATION/);
    }
    expect(spy).not.toHaveBeenCalled();   // nunca llegó a la BD
  });
  test('permite SELECT', async () => {
    const spy = jest.fn(async () => [[{ ok: 1 }]]);
    const q = audit.makeReadOnlyRunner({ query: spy });
    const [rows] = await q('SELECT 1');
    expect(rows[0].ok).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('runAudit — end-to-end con sequelize sintético (sin BD real)', () => {
  // sequelize falso: responde por patrón de SQL. Sólo SELECT (si intentara
  // escribir, el guard lo cortaría).
  function fakeDb() {
    const cutover = '2026-09-16 00:00:00';
    return {
      query: jest.fn(async (sql, opts) => {
        if (/FROM attendance_logs\s+WHERE source/i.test(sql)) {
          // candidatos: turno nocturno mal inferido (20/09 07:01 quedó 'in')
          return [[
            { id: 101, empId: 55, deviceId: 1, wall: '2026-09-19 18:16:00', type: 'in' },
            { id: 102, empId: 55, deviceId: 1, wall: '2026-09-20 07:01:00', type: 'in' },
          ]];
        }
        if (/FROM attendance_logs/i.test(sql)) {
          // contexto: las mismas dos filas (tipos almacenados)
          return [[
            { id: 101, empId: 55, wall: '2026-09-19 18:16:00', type: 'in' },
            { id: 102, empId: 55, wall: '2026-09-20 07:01:00', type: 'in' },
          ]];
        }
        if (/FROM raw_device_punches/i.test(sql)) {
          // raw sin tipo explícito (getAttendances masivo no trae inout)
          return [[
            { empId: 55, wall: '2026-09-19 18:16:00', mapping_status: 'mapped', raw_json: '{}' },
            { empId: 55, wall: '2026-09-20 07:01:00', mapping_status: 'mapped', raw_json: '{}' },
          ]];
        }
        return [[]];
      }),
      close: jest.fn(async () => {}),
      __cutover: cutover,
    };
  }

  test('detecta la 2ª marca (07:01) como DETERMINISTIC_CHANGE in→out; la 1ª sin cambio', async () => {
    const db = fakeDb();
    const { manifest, sha256 } = await audit.runAudit({ sequelize: db, cutover: '2026-09-16', limit: 100, generatedAt: 'fixed', baselineCommit: 'test' });
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    const byId = Object.fromEntries(manifest.candidate_rows.map(r => [r.attendance_log_id, r]));
    // 1ª marca (18:16 in): sin contexto previo → AMBIGUOUS (actual in, sin explícito, contexto unknown)
    expect(byId[101].classification).toBe('AMBIGUOUS');
    expect(byId[101].proposed_type).toBe('in');
    // 2ª marca (07:01): contexto IN previo dentro de ventana → out determinista, difiere del actual 'in'
    expect(byId[102].classification).toBe('DETERMINISTIC_CHANGE');
    expect(byId[102].proposed_type).toBe('out');
    expect(manifest.counts.by_classification.DETERMINISTIC_CHANGE).toBe(1);
  });

  test('runAudit no ejecuta ningún SQL de escritura', async () => {
    const db = fakeDb();
    await audit.runAudit({ sequelize: db, cutover: '2026-09-16', limit: 100 });
    for (const call of db.query.mock.calls) {
      expect(String(call[0])).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
    }
  });
});
