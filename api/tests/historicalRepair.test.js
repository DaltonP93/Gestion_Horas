/**
 * historicalRepair — núcleo de la reparación histórica.
 *
 * Corren en las tres zonas del CI con aserciones absolutas: toda la
 * aritmética es de hora de pared y no debe depender de la zona del proceso.
 */

const r = require('../src/services/historicalRepair');
const { parseArgs } = require('../scripts/historical-attendance-repair');

const S = r.STATUS;

/** Registro de attendance_logs de prueba. */
function logDe(over = {}) {
  return {
    id: 1, employee_id: 10, employee_code: '3091', device_id: 5,
    source: 'device', timestamp: '2024-04-29 02:42:29', type: 'in',
    ...over,
  };
}

/** Candidato de ATT2000. */
const cand = (checktime, checktype = null) => ({ checktime, checktype });

describe('aritmética de hora de pared', () => {
  test('suma minutos sin depender de la zona del proceso', () => {
    expect(r.addMinutesWall('2024-04-29 02:42:29', 240)).toBe('2024-04-29 06:42:29');
    expect(r.addMinutesWall('2025-01-02 03:50:41', 180)).toBe('2025-01-02 06:50:41');
  });

  test('★ cruce de medianoche, de mes y de año', () => {
    expect(r.addMinutesWall('2024-04-29 22:30:00', 180)).toBe('2024-04-30 01:30:00');
    expect(r.addMinutesWall('2024-04-30 23:00:00', 180)).toBe('2024-05-01 02:00:00');
    expect(r.addMinutesWall('2024-12-31 23:10:00', 240)).toBe('2025-01-01 03:10:00');
    expect(r.addMinutesWall('2024-02-28 23:00:00', 240)).toBe('2024-02-29 03:00:00'); // bisiesto
    expect(r.addMinutesWall('2025-02-28 23:00:00', 240)).toBe('2025-03-01 03:00:00'); // no bisiesto
  });

  test('normaliza Date y string al mismo formato de pared', () => {
    expect(r.toWall('2024-04-29T02:42:29.000Z')).toBe('2024-04-29 02:42:29');
    expect(r.toWall(new Date(Date.UTC(2024, 3, 29, 2, 42, 29)))).toBe('2024-04-29 02:42:29');
    expect(r.toWall(null)).toBeNull();
    expect(r.toWall('no es fecha')).toBeNull();
  });

  test('la clave UNIQUE trata device_id nulo como 0', () => {
    expect(r.uniqueKey(10, '2024-04-29 06:42:29', null))
      .toBe(r.uniqueKey(10, '2024-04-29 06:42:29', 0));
  });
});

describe('classify', () => {
  test('★ +240 — invierno de Paraguay (UTC-4)', () => {
    const res = r.classify(
      { timestamp: '2024-04-29 02:42:29', type: 'in' },
      [cand('2024-04-29 06:42:29', 'I')],
    );
    expect(res.status).toBe(S.MATCH_240);
    expect(res.proposed).toBe('2024-04-29 06:42:29');
    expect(res.delta).toBe(240);
  });

  test('★ +180 — Paraguay ya en UTC-3', () => {
    const res = r.classify(
      { timestamp: '2025-01-02 03:50:41', type: 'in' },
      [cand('2025-01-02 06:50:41', 'I')],
    );
    expect(res.status).toBe(S.MATCH_180);
    expect(res.delta).toBe(180);
  });

  test('★ ya correcto — el shift 0 manda y no se toca', () => {
    const res = r.classify(
      { timestamp: '2026-08-01 06:44:26', type: 'in' },
      [cand('2026-08-01 06:44:26', 'I')],
    );
    expect(res.status).toBe(S.ALREADY_CORRECT);
    expect(res.delta).toBe(0);
  });

  test('★ coincidir a shift 0 NO alcanza si otro desplazamiento también coincide', () => {
    // Caso realista: la persona marcó 03:00 y 06:00, y el evento de las 06:00
    // quedó guardado como 03:00 por el desfase. Los dos candidatos existen.
    // Declararlo ALREADY_CORRECT dejaría la fila corrupta EN SILENCIO, que es
    // el peor resultado posible para un reparador.
    const res = r.classify(
      { timestamp: '2025-01-02 03:50:41', type: 'in' },
      [cand('2025-01-02 03:50:41', 'I'), cand('2025-01-02 06:50:41', 'O')],
    );
    expect(res.status).toBe(S.AMBIGUOUS);
    expect(res.proposed).toBeNull();
  });

  test('★ sin candidato', () => {
    const res = r.classify(
      { timestamp: '2024-04-29 02:42:29', type: 'in' },
      [cand('2024-04-29 09:00:00', 'I')],
    );
    expect(res.status).toBe(S.NO_MATCH);
    expect(res.proposed).toBeNull();
  });

  test('sin ningún candidato del empleado', () => {
    expect(r.classify({ timestamp: '2024-04-29 02:42:29', type: 'in' }, []).status).toBe(S.NO_MATCH);
  });

  test('★ ambiguo — coinciden +180 y +240', () => {
    const res = r.classify(
      { timestamp: '2024-04-29 02:42:29', type: 'in' },
      [cand('2024-04-29 05:42:29', 'I'), cand('2024-04-29 06:42:29', 'I')],
    );
    expect(res.status).toBe(S.AMBIGUOUS);
    expect(res.proposed).toBeNull();
  });

  test('★ el CHECKTYPE NO desempata: sigue siendo ambiguo', () => {
    // El tipo del lado MySQL puede venir de detectMarkType, que alterna por
    // paridad de marcas del día. Si falta una marca histórica la paridad se
    // invierte, y con dos candidatos separados una hora ese tipo inferido
    // elegiría el desplazamiento equivocado. Preferimos no corregir.
    const res = r.classify(
      { timestamp: '2024-04-29 02:42:29', type: 'out' },
      [cand('2024-04-29 05:42:29', 'I'), cand('2024-04-29 06:42:29', 'O')],
    );
    expect(res.status).toBe(S.AMBIGUOUS);
    // Pero los tipos vistos se reportan, para resolverlo a mano.
    expect(res.reason).toMatch(/180=\[in\]/);
    expect(res.reason).toMatch(/240=\[out\]/);
  });

  test('el CHECKTYPE tampoco descarta la ÚNICA coincidencia', () => {
    const res = r.classify(
      { timestamp: '2024-04-29 02:42:29', type: 'out' },
      [cand('2024-04-29 06:42:29', 'I')],
    );
    expect(res.status).toBe(S.MATCH_240);
  });

  test('★ cruce de medianoche: la corrección mueve el registro de día', () => {
    const res = r.classify(
      { timestamp: '2024-04-29 22:30:00', type: 'in' },
      [cand('2024-04-30 02:30:00', 'I')],
    );
    expect(res.status).toBe(S.MATCH_240);
    expect(res.proposed).toBe('2024-04-30 02:30:00');
  });
});

describe('buildManifest', () => {
  const codes = (arr) => new Map([['3091', arr]]);

  test('arma la fila completa, sin datos personales de más', () => {
    const [f] = r.buildManifest({
      logs: [logDe()],
      candidatesByCode: codes([cand('2024-04-29 06:42:29', 'I')]),
    });

    expect(f).toEqual({
      attendance_log_id: 1, employee_id: 10, employee_code: '3091',
      device_id: 5, source: 'device', type: 'in',
      old_timestamp: '2024-04-29 02:42:29',
      proposed_timestamp: '2024-04-29 06:42:29',
      delta_minutes: 240, status: S.MATCH_240, reason: null,
      date_changes: false,
      digest: expect.any(String),
    });
    // Nada de nombre, documento ni datos personales.
    expect(Object.keys(f)).not.toContain('employee_name');
  });

  test('★ colisión contra una fila ya existente', () => {
    const existingKeys = new Set([r.uniqueKey(10, '2024-04-29 06:42:29', 5)]);
    const [f] = r.buildManifest({
      logs: [logDe()],
      candidatesByCode: codes([cand('2024-04-29 06:42:29', 'I')]),
      existingKeys,
    });
    expect(f.status).toBe(S.COLLISION);
    expect(r.isApplicable(f)).toBe(false);
  });

  test('★ colisión entre dos propuestas del mismo manifest', () => {
    // Dos registros distintos que proponen la misma hora final.
    const filas = r.buildManifest({
      logs: [
        logDe({ id: 1, timestamp: '2024-04-29 02:42:29' }),          // +240 → 06:42:29
        logDe({ id: 2, timestamp: '2024-04-29 03:42:29' }),          // +180 → 06:42:29
      ],
      candidatesByCode: codes([cand('2024-04-29 06:42:29', 'I')]),
    });
    expect(filas[0].status).toBe(S.MATCH_240);
    expect(filas[1].status).toBe(S.COLLISION);
    expect(filas[1].reason).toMatch(/choca con la propuesta del registro 1/);
  });

  test('marca los registros que cambian de día', () => {
    const [f] = r.buildManifest({
      logs: [logDe({ timestamp: '2024-04-29 22:30:00' })],
      candidatesByCode: codes([cand('2024-04-30 02:30:00', 'I')]),
    });
    expect(f.date_changes).toBe(true);
  });

  test('los estados no aplicables nunca habilitan escritura', () => {
    for (const st of [S.NO_MATCH, S.AMBIGUOUS, S.COLLISION, S.ALREADY_CORRECT]) {
      expect(r.isApplicable({ status: st, proposed_timestamp: '2024-01-01 00:00:00', old_timestamp: 'x' }))
        .toBe(false);
    }
  });
});

describe('★ idempotencia', () => {
  test('un segundo dry-run sobre los datos ya corregidos da ALREADY_CORRECT', () => {
    const candidatos = [cand('2024-04-29 06:42:29', 'I')];

    const [primera] = r.buildManifest({
      logs: [logDe()],
      candidatesByCode: new Map([['3091', candidatos]]),
    });
    expect(primera.status).toBe(S.MATCH_240);

    // Se simula la aplicación: el log queda con la hora propuesta.
    const [segunda] = r.buildManifest({
      logs: [logDe({ timestamp: primera.proposed_timestamp })],
      candidatesByCode: new Map([['3091', candidatos]]),
    });
    expect(segunda.status).toBe(S.ALREADY_CORRECT);
    expect(r.isApplicable(segunda)).toBe(false);
  });
});

describe('summarize', () => {
  test('agrupa por estado, mes, dispositivo y origen', () => {
    const filas = r.buildManifest({
      logs: [
        logDe({ id: 1, timestamp: '2024-04-29 02:42:29', device_id: 5 }),
        logDe({ id: 2, timestamp: '2025-01-02 03:50:41', device_id: 7 }),
        logDe({ id: 3, timestamp: '2024-04-29 09:00:00', device_id: null }),
      ],
      candidatesByCode: new Map([['3091', [
        cand('2024-04-29 06:42:29', 'I'),
        cand('2025-01-02 06:50:41', 'I'),
      ]]]),
    });
    const s = r.summarize(filas);

    expect(s.total_registros).toBe(3);
    expect(s.por_estado[S.MATCH_240]).toBe(1);
    expect(s.por_estado[S.MATCH_180]).toBe(1);
    expect(s.por_estado[S.NO_MATCH]).toBe(1);
    expect(s.aplicables).toBe(2);
    expect(s.por_mes['2024-04'][S.MATCH_240]).toBe(1);
    expect(s.por_mes['2025-01'][S.MATCH_180]).toBe(1);
    expect(s.por_device['5'][S.MATCH_240]).toBe(1);
    expect(s.por_device['sin_device'][S.NO_MATCH]).toBe(1);
    expect(s.por_source['device'][S.MATCH_240]).toBe(1);
  });
});

describe('recalcTargets', () => {
  test('incluye el día viejo y el nuevo cuando la corrección cruza medianoche', () => {
    const filas = r.buildManifest({
      logs: [logDe({ timestamp: '2024-04-29 22:30:00' })],
      candidatesByCode: new Map([['3091', [cand('2024-04-30 02:30:00', 'I')]]]),
    });
    expect(r.recalcTargets(filas)).toEqual([
      { employee_id: 10, date: '2024-04-29' },
      { employee_id: 10, date: '2024-04-30' },
    ]);
  });

  test('no incluye nada de las filas no aplicables', () => {
    const filas = r.buildManifest({
      logs: [logDe({ timestamp: '2024-04-29 09:00:00' })],
      candidatesByCode: new Map([['3091', []]]),
    });
    expect(r.recalcTargets(filas)).toEqual([]);
  });
});

describe('nextDayISO — el intervalo semiabierto', () => {
  test('día siguiente, incluidos cruces de mes y año', () => {
    expect(r.nextDayISO('2024-04-29')).toBe('2024-04-30');
    expect(r.nextDayISO('2024-04-30')).toBe('2024-05-01');
    expect(r.nextDayISO('2024-12-31')).toBe('2025-01-01');
    expect(r.nextDayISO('2024-02-28')).toBe('2024-02-29');   // bisiesto
    expect(r.nextDayISO('2025-02-28')).toBe('2025-03-01');   // no bisiesto
  });

  test('fecha inválida devuelve null en vez de un rango silenciosamente roto', () => {
    expect(r.nextDayISO('no-es-fecha')).toBeNull();
    expect(r.nextDayISO('')).toBeNull();
    expect(r.nextDayISO(null)).toBeNull();
  });

  test('★ rechaza fechas civiles INEXISTENTES en vez de normalizarlas', () => {
    // Date.UTC normaliza lo que está fuera de rango: 2025-02-29 se convertiría
    // en el 1 de marzo y `--to 2025-02-29` abarcaría días de más sin avisar.
    // 2024-13-01 era todavía peor: caía en enero del año siguiente.
    expect(r.nextDayISO('2025-02-29')).toBeNull();   // 2025 no es bisiesto
    expect(r.nextDayISO('2024-02-30')).toBeNull();
    expect(r.nextDayISO('2024-04-31')).toBeNull();
    expect(r.nextDayISO('2024-13-01')).toBeNull();
    expect(r.nextDayISO('2024-00-10')).toBeNull();

    // Y sigue aceptando las que sí existen.
    expect(r.nextDayISO('2024-02-29')).toBe('2024-03-01');   // 2024 sí es bisiesto
  });

  test('isCivilDate distingue existente de inexistente', () => {
    expect(r.isCivilDate('2024-02-29')).toBe(true);
    expect(r.isCivilDate('2025-02-29')).toBe(false);
    expect(r.isCivilDate('2024-4-5')).toBe(false);      // exige dos dígitos
    expect(r.isCivilDate('2024-04-05 10:00')).toBe(false);
  });
});

describe('versionado y huellas', () => {
  test('la huella cambia si cambia cualquier campo decisivo', () => {
    const base = {
      attendance_log_id: 1, employee_id: 10, employee_code: '3091', device_id: 5,
      source: 'device', type: 'in', old_timestamp: '2024-04-29 02:42:29',
      proposed_timestamp: '2024-04-29 06:42:29', delta_minutes: 240, status: S.MATCH_240,
    };
    const d = r.rowDigest(base);

    for (const cambio of [
      { status: S.AMBIGUOUS },
      { proposed_timestamp: '2024-04-29 05:42:29' },
      { employee_id: 11 },
      { device_id: 6 },
      { source: 'zkteco_direct' },
      { type: 'out' },
      { old_timestamp: '2024-04-29 02:42:30' },
    ]) {
      expect(r.rowDigest({ ...base, ...cambio })).not.toBe(d);
    }
  });

  test('★ promover el estado a mano invalida la huella', () => {
    const ambigua = {
      attendance_log_id: 7, employee_id: 10, employee_code: '3091', device_id: 5,
      source: 'device', type: 'in', old_timestamp: '2024-04-29 02:42:29',
      proposed_timestamp: null, delta_minutes: null, status: S.AMBIGUOUS,
    };
    const conHuella = { ...ambigua, digest: r.rowDigest(ambigua) };
    expect(r.rowDigestOk(conHuella)).toBe(true);

    const promovida = { ...conHuella, status: S.MATCH_240, proposed_timestamp: '2024-04-29 06:42:29', delta_minutes: 240 };
    expect(r.rowDigestOk(promovida)).toBe(false);
  });

  test('una fila sin huella no se considera válida', () => {
    expect(r.rowDigestOk({ status: S.MATCH_240 })).toBe(false);
  });

  test('la huella global cambia al agregar o quitar filas', () => {
    const f1 = { attendance_log_id: 1, employee_id: 10, employee_code: 'a', device_id: 1, source: 'device', type: 'in', old_timestamp: '2024-01-01 00:00:00', proposed_timestamp: '2024-01-01 03:00:00', delta_minutes: 180, status: S.MATCH_180 };
    const f2 = { ...f1, attendance_log_id: 2 };
    const uno = r.manifestDigest([{ ...f1, digest: r.rowDigest(f1) }]);
    const dos = r.manifestDigest([{ ...f1, digest: r.rowDigest(f1) }, { ...f2, digest: r.rowDigest(f2) }]);
    expect(uno).not.toBe(dos);
  });

  test('isApplicable exige el origen autorizado', () => {
    const fila = {
      status: S.MATCH_240, source: 'device',
      old_timestamp: '2024-04-29 02:42:29', proposed_timestamp: '2024-04-29 06:42:29',
    };
    expect(r.isApplicable(fila)).toBe(true);
    for (const src of ['zkteco_direct', 'att2000', 'push', 'manual', '', null]) {
      expect(r.isApplicable({ ...fila, source: src })).toBe(false);
    }
  });
});

describe('CLI — argumentos', () => {
  test('★ el modo por defecto NO aplica', () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(['--from', '2024-01-01']).apply).toBe(false);
  });

  test('--apply se activa sólo explícitamente', () => {
    expect(parseArgs(['--apply', '--manifest', 'm.json']).apply).toBe(true);
  });

  test('el origen por defecto es device y no se tocan los demás', () => {
    expect(parseArgs([]).source).toBe('device');
  });

  test('★ --apply rechaza cualquier source distinto de device', () => {
    for (const src of ['zkteco_direct', 'att2000', 'push', 'manual']) {
      expect(() => parseArgs(['--apply', '--manifest', 'm.json', '--source', src]))
        .toThrow(/sólo está autorizado para source='device'/);
    }
  });

  test('★ un source distinto exige --diagnostic, y ése no puede aplicar', () => {
    expect(() => parseArgs(['--source', 'zkteco_direct'])).toThrow(/requiere --diagnostic/);
    expect(parseArgs(['--source', 'zkteco_direct', '--diagnostic']).source).toBe('zkteco_direct');
    // Diagnóstico + apply sigue rechazado por el primer chequeo.
    expect(() => parseArgs(['--source', 'zkteco_direct', '--diagnostic', '--apply']))
      .toThrow(/sólo está autorizado/);
  });

  test('--diagnostic con device es inocuo', () => {
    expect(parseArgs(['--diagnostic']).source).toBe('device');
  });

  test('rechaza argumentos desconocidos en vez de ignorarlos', () => {
    // Un typo en --apply no debe correr un dry-run silencioso ni al revés.
    expect(() => parseArgs(['--aply'])).toThrow(/desconocido/);
  });
});
