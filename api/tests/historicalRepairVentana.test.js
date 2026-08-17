/**
 * Acotado por ventana de las consultas del reparador.
 *
 * Medido en producción: para analizar 10.849 attendance_logs de enero 2025 el
 * proceso cargaba 346.134 claves de MySQL y 331.270 CHECKINOUT de ATT2000,
 * ~378 MiB de RSS. Con 400.031 registros históricos eso no escala.
 *
 * Los candidatos válidos están en +0, +180 y +240 minutos, así que para un
 * rango de logs [desde, hasta) alcanza con mirar [desde, hasta + 240min].
 *
 * Lo que estos tests protegen es que acotar NO cambie ninguna clasificación:
 * el mock de ATT2000 FILTRA de verdad por los parámetros recibidos, así que si
 * la ventana fuera demasiado angosta se perderían coincidencias y el test
 * fallaría.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockQuery = jest.fn();
const mockTransaction = jest.fn();
jest.mock('../src/config/database', () => ({
  sequelize: {
    query: (...a) => mockQuery(...a),
    transaction: (...a) => mockTransaction(...a),
    close: async () => {},
  },
  DB_TIMEZONE: '-03:00',
}));

const mockAtt = jest.fn();
jest.mock('../src/config/att2000', () => ({ queryAtt2000: (...a) => mockAtt(...a) }), { virtual: true });

const { dryRun, apply } = require('../scripts/historical-attendance-repair');
const repair = require('../src/services/historicalRepair');

const ARGS = {
  apply: false, out: null, source: 'device', from: null, to: null,
  employee: null, limit: null, batchSize: 500, manifest: null,
};

let dir;
beforeEach(() => {
  mockQuery.mockReset();
  mockAtt.mockReset();
  mockTransaction.mockReset();
  mockTransaction.mockResolvedValue({ commit: async () => {}, rollback: async () => {} });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ventana-'));
  process.exitCode = 0;
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

const logDe = (id, ts, over = {}) => ({
  id, employee_id: 10, employee_code: '3091', device_id: 5,
  source: 'device', timestamp: ts, type: 'in', ...over,
});

/**
 * Monta MySQL y ATT2000 con datos fijos. El mock de ATT2000 aplica de verdad
 * el filtro `@desde`/`@hasta` que recibe; el de claves aplica el suyo.
 */
function montar({ logs, checkinout = [], clavesExistentes = [] }) {
  mockQuery.mockImplementation((sql, opts) => {
    const s = String(sql);
    if (/DATE_FORMAT\(al\.timestamp/i.test(s)) return Promise.resolve([logs]);
    if (/DATE_FORMAT\(timestamp/i.test(s)) {
      // Emula el acotado por ventana de la consulta de claves.
      const r = opts.replacements;
      const desde = r.find(v => typeof v === 'string' && v > '1000');
      const hasta = r.slice().reverse().find(v => typeof v === 'string' && v > '1000');
      const dentro = clavesExistentes.filter(k =>
        (!desde || k.timestamp >= desde) && (!hasta || k.timestamp <= hasta));
      return Promise.resolve([dentro]);
    }
    if (/SELECT id FROM attendance_logs/i.test(s)) return Promise.resolve([[]]);
    return Promise.resolve([[], { affectedRows: 1 }]);
  });

  mockAtt.mockImplementation((sql, params) => {
    const dentro = checkinout.filter(c =>
      (params.desde == null || c.CHECKTIME >= params.desde) &&
      (params.hasta == null || c.CHECKTIME <= params.hasta));
    return Promise.resolve(dentro);
  });
}

const leerManifest = () => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const attSql = () => String(mockAtt.mock.calls.at(-1)[0]);
const attParams = () => mockAtt.mock.calls.at(-1)[1];

// ─────────────────────────────────────────────────────────────────
describe('la consulta a ATT2000 se acota', () => {
  test('★ con rango, CHECKTIME se limita a la ventana', async () => {
    montar({ logs: [logDe(1, '2025-01-15 03:50:41')] });
    await dryRun({ ...ARGS, out: dir, from: '2025-01-01', to: '2025-01-31' });

    expect(attSql()).toMatch(/CHECKTIME >= @desde/);
    expect(attSql()).toMatch(/CHECKTIME <= @hasta/);
    expect(attParams().desde).toBe('2025-01-01 00:00:00');
    // Fin del rango + 240 min: el margen del mayor desplazamiento.
    expect(attParams().hasta).toBe('2025-02-01 04:00:00');
  });

  test('sin rango NO se acota — comportamiento histórico intacto', async () => {
    montar({ logs: [logDe(1, '2025-01-15 03:50:41')] });
    await dryRun({ ...ARGS, out: dir });

    expect(attSql()).not.toMatch(/CHECKTIME >=/);
    expect(attParams().desde).toBeUndefined();
  });

  test('★ cambio de mes', async () => {
    montar({ logs: [logDe(1, '2024-04-15 02:00:00')] });
    await dryRun({ ...ARGS, out: dir, from: '2024-04-01', to: '2024-04-30' });
    expect(attParams().hasta).toBe('2024-05-01 04:00:00');
  });

  test('★ cambio de año', async () => {
    montar({ logs: [logDe(1, '2024-12-15 02:00:00')] });
    await dryRun({ ...ARGS, out: dir, from: '2024-12-01', to: '2024-12-31' });
    expect(attParams().hasta).toBe('2025-01-01 04:00:00');
  });

  test('febrero bisiesto', async () => {
    montar({ logs: [logDe(1, '2024-02-15 02:00:00')] });
    await dryRun({ ...ARGS, out: dir, from: '2024-02-01', to: '2024-02-29' });
    expect(attParams().hasta).toBe('2024-03-01 04:00:00');
  });
});

describe('la ventana no pierde coincidencias', () => {
  test('★ candidato a +240 que cae en el día siguiente', async () => {
    // Log a las 22:30 del último día del rango; su candidato +240 está a las
    // 02:30 del día siguiente, FUERA del rango de logs pero DENTRO de la
    // ventana. Si el margen faltara, esto saldría NO_MATCH.
    montar({
      logs: [logDe(1, '2024-04-30 22:30:00')],
      checkinout: [{ USERID: '3091', CHECKTIME: '2024-05-01 02:30:00', CHECKTYPE: 'I' }],
    });
    await dryRun({ ...ARGS, out: dir, from: '2024-04-01', to: '2024-04-30' });

    const [f] = leerManifest().filas;
    expect(f.status).toBe('MATCH_240');
    expect(f.proposed_timestamp).toBe('2024-05-01 02:30:00');
    expect(f.date_changes).toBe(true);
  });

  test('★ el borde exacto: candidato a +240 del último instante del rango', async () => {
    // Log a las 23:59:59 del último día → candidato a las 03:59:59 del
    // siguiente. Es el caso más extremo que la ventana debe cubrir.
    montar({
      logs: [logDe(1, '2024-04-30 23:59:59')],
      checkinout: [{ USERID: '3091', CHECKTIME: '2024-05-01 03:59:59', CHECKTYPE: 'I' }],
    });
    await dryRun({ ...ARGS, out: dir, from: '2024-04-01', to: '2024-04-30' });

    const [f] = leerManifest().filas;
    expect(f.status).toBe('MATCH_240');
    expect(f.proposed_timestamp).toBe('2024-05-01 03:59:59');
  });

  test('★ un candidato FUERA de la ventana no se considera', async () => {
    // A +300 minutos: no es un desplazamiento válido y además queda fuera de
    // la ventana. Tiene que dar NO_MATCH, no una corrección inventada.
    montar({
      logs: [logDe(1, '2024-04-15 02:00:00')],
      checkinout: [{ USERID: '3091', CHECKTIME: '2024-04-15 07:00:00', CHECKTYPE: 'I' }],
    });
    await dryRun({ ...ARGS, out: dir, from: '2024-04-01', to: '2024-04-30' });

    expect(leerManifest().filas[0].status).toBe('NO_MATCH');
  });

  test('★ ALREADY_CORRECT sobrevive al acotado', async () => {
    montar({
      logs: [logDe(1, '2026-06-15 06:44:26')],
      checkinout: [{ USERID: '3091', CHECKTIME: '2026-06-15 06:44:26', CHECKTYPE: 'I' }],
    });
    await dryRun({ ...ARGS, out: dir, from: '2026-06-01', to: '2026-06-30' });

    expect(leerManifest().filas[0].status).toBe('ALREADY_CORRECT');
  });
});

describe('la consulta de claves existentes se acota', () => {
  test('★ se limita a la ventana', async () => {
    montar({ logs: [logDe(1, '2025-01-15 03:50:41')] });
    await dryRun({ ...ARGS, out: dir, from: '2025-01-01', to: '2025-01-31' });

    const [, opts] = mockQuery.mock.calls.find(c => /DATE_FORMAT\(timestamp/i.test(String(c[0])));
    expect(opts.replacements).toContain('2025-01-01 00:00:00');
    expect(opts.replacements).toContain('2025-02-01 04:00:00');
  });

  test('★ una colisión DENTRO del margen +240 se sigue detectando', async () => {
    // La hora propuesta cae en el día siguiente al rango de logs; la clave que
    // choca también. Si la ventana de claves no tuviera margen, esta colisión
    // pasaría desapercibida y el apply reventaría contra el UNIQUE.
    montar({
      logs: [logDe(1, '2024-04-30 22:30:00')],
      checkinout: [{ USERID: '3091', CHECKTIME: '2024-05-01 02:30:00', CHECKTYPE: 'I' }],
      clavesExistentes: [{ employee_id: 10, timestamp: '2024-05-01 02:30:00', device_id: 5 }],
    });
    await dryRun({ ...ARGS, out: dir, from: '2024-04-01', to: '2024-04-30' });

    const [f] = leerManifest().filas;
    expect(f.status).toBe('COLLISION');
    expect(repair.isApplicable(f)).toBe(false);
  });

  test('sin rango se cargan todas las claves del empleado', async () => {
    montar({
      logs: [logDe(1, '2025-01-15 03:50:41')],
      clavesExistentes: [{ employee_id: 10, timestamp: '2019-01-01 00:00:00', device_id: 5 }],
    });
    await dryRun({ ...ARGS, out: dir });

    const [, opts] = mockQuery.mock.calls.find(c => /DATE_FORMAT\(timestamp/i.test(String(c[0])));
    expect(opts.replacements).toEqual([10]);   // sólo el employee_id
  });
});

describe('★ equivalencia funcional: acotar no cambia ninguna clasificación', () => {
  // Fixture con un caso de cada tipo. Se corre el mismo conjunto CON ventana y
  // SIN ventana, y se comparan los campos que deciden la reparación.
  const LOGS = [
    logDe(1, '2025-01-02 03:50:41'),                 // +180 → MATCH_180
    logDe(2, '2025-01-03 02:42:29'),                 // +240 → MATCH_240
    logDe(3, '2025-01-04 06:44:26'),                 // shift 0 → ALREADY_CORRECT
    logDe(4, '2025-01-05 09:00:00'),                 // sin candidato → NO_MATCH
    logDe(5, '2025-01-06 02:00:00'),                 // dos candidatos → AMBIGUOUS
    logDe(6, '2025-01-31 22:30:00'),                 // +240 cruzando de mes
  ];
  const CHECKINOUT = [
    { USERID: '3091', CHECKTIME: '2025-01-02 06:50:41', CHECKTYPE: 'I' },
    { USERID: '3091', CHECKTIME: '2025-01-03 06:42:29', CHECKTYPE: 'I' },
    { USERID: '3091', CHECKTIME: '2025-01-04 06:44:26', CHECKTYPE: 'I' },
    { USERID: '3091', CHECKTIME: '2025-01-06 05:00:00', CHECKTYPE: 'I' },   // +180
    { USERID: '3091', CHECKTIME: '2025-01-06 06:00:00', CHECKTYPE: 'O' },   // +240
    { USERID: '3091', CHECKTIME: '2025-02-01 02:30:00', CHECKTYPE: 'I' },
    // Ruido histórico muy anterior: sólo lo ve la corrida sin ventana.
    { USERID: '3091', CHECKTIME: '2019-05-05 08:00:00', CHECKTYPE: 'I' },
  ];

  const decisivos = (filas) => filas.map(f => ({
    id: f.attendance_log_id,
    status: f.status,
    proposed_timestamp: f.proposed_timestamp,
    delta_minutes: f.delta_minutes,
    date_changes: f.date_changes,
  }));

  test('mismos status, proposed, delta y date_changes', async () => {
    montar({ logs: LOGS, checkinout: CHECKINOUT });
    await dryRun({ ...ARGS, out: dir, from: '2025-01-01', to: '2025-01-31' });
    const conVentana = decisivos(leerManifest().filas);

    // Segunda corrida sin rango: el mock devuelve TODO, incluido el ruido.
    fs.rmSync(path.join(dir, 'manifest.json'));
    montar({ logs: LOGS, checkinout: CHECKINOUT });
    await dryRun({ ...ARGS, out: dir });
    const sinVentana = decisivos(leerManifest().filas);

    expect(conVentana).toEqual(sinVentana);

    // Y el fixture cubre de verdad todos los estados.
    expect(new Set(conVentana.map(f => f.status))).toEqual(new Set([
      'MATCH_180', 'MATCH_240', 'ALREADY_CORRECT', 'NO_MATCH', 'AMBIGUOUS',
    ]));
  });
});

describe('★ volumen: no se carga la historia completa cuando hay rango', () => {
  // Sin fijar tiempos, que serían frágiles. Lo que se demuestra es que la
  // consulta acotada NO trae las filas de fuera de la ventana.
  test('el ruido histórico no llega al proceso', async () => {
    const ruido = [];
    for (let a = 2019; a <= 2024; a++) {
      for (let m = 1; m <= 12; m++) {
        ruido.push({ USERID: '3091', CHECKTIME: `${a}-${String(m).padStart(2, '0')}-10 08:00:00`, CHECKTYPE: 'I' });
      }
    }
    const utiles = [{ USERID: '3091', CHECKTIME: '2025-01-02 06:50:41', CHECKTYPE: 'I' }];

    montar({ logs: [logDe(1, '2025-01-02 03:50:41')], checkinout: [...ruido, ...utiles] });
    await dryRun({ ...ARGS, out: dir, from: '2025-01-01', to: '2025-01-31' });

    // El mock filtra por la ventana: sólo debería haber devuelto la fila útil.
    const devueltas = await mockAtt.mock.results.at(-1).value;
    expect(devueltas).toHaveLength(1);
    expect(devueltas[0].CHECKTIME).toBe('2025-01-02 06:50:41');

    // Y la clasificación es la correcta pese al recorte.
    expect(leerManifest().filas[0].status).toBe('MATCH_180');
  });

  test('las claves existentes fuera de la ventana tampoco llegan', async () => {
    const claves = [];
    for (let a = 2019; a <= 2024; a++) {
      claves.push({ employee_id: 10, timestamp: `${a}-06-10 08:00:00`, device_id: 5 });
    }
    montar({ logs: [logDe(1, '2025-01-02 03:50:41')], clavesExistentes: claves });
    await dryRun({ ...ARGS, out: dir, from: '2025-01-01', to: '2025-01-31' });

    const salida = console.log.mock.calls.flat().join('\n');
    expect(salida).toMatch(/0 clave\(s\) únicas existentes cargadas/);
  });
});

describe('★ el apply revalida con la ventana derivada de las filas', () => {
  function manifestCon(filas) {
    const conDigest = filas.map(f => ({ ...f, digest: repair.rowDigest(f) }));
    const f = path.join(dir, 'manifest.json');
    fs.writeFileSync(f, JSON.stringify({
      manifest_version: repair.MANIFEST_VERSION,
      repair_algorithm_version: repair.REPAIR_ALGORITHM_VERSION,
      aplicable: true,
      parametros: { source: 'device' },
      digest: repair.manifestDigest(conDigest),
      filas: conDigest,
    }));
    return f;
  }

  const FILA = {
    attendance_log_id: 1, employee_id: 10, employee_code: '3091', device_id: 5,
    source: 'device', type: 'in', old_timestamp: '2025-01-02 03:50:41',
    proposed_timestamp: '2025-01-02 06:50:41', delta_minutes: 180,
    status: 'MATCH_180', reason: null, date_changes: false,
  };

  test('la ventana sale de las horas viejas más el margen', async () => {
    montar({
      logs: [],
      checkinout: [{ USERID: '3091', CHECKTIME: '2025-01-02 06:50:41', CHECKTYPE: 'I' }],
    });
    const segunda = { ...FILA, attendance_log_id: 2, old_timestamp: '2025-01-20 08:00:00',
                      proposed_timestamp: '2025-01-20 11:00:00' };

    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA, segunda]) });

    expect(attParams().desde).toBe('2025-01-02 03:50:41');      // la más vieja
    expect(attParams().hasta).toBe('2025-01-20 12:00:00');      // la más nueva + 240
  });

  test('la revalidación sigue encontrando el candidato con la ventana puesta', async () => {
    montar({
      logs: [],
      checkinout: [{ USERID: '3091', CHECKTIME: '2025-01-02 06:50:41', CHECKTYPE: 'I' }],
    });
    await apply({ ...ARGS, apply: true, manifest: manifestCon([FILA]) });

    const updates = mockQuery.mock.calls.filter(c => /UPDATE/i.test(String(c[0])));
    expect(updates).toHaveLength(1);
    expect(updates[0][1].replacements[0]).toBe('2025-01-02 06:50:41');
  });

  test('★ una fila que cruza de mes revalida dentro de su ventana', async () => {
    const cruza = {
      ...FILA, attendance_log_id: 9,
      old_timestamp: '2025-01-31 22:30:00', proposed_timestamp: '2025-02-01 02:30:00',
      delta_minutes: 240, status: 'MATCH_240', date_changes: true,
    };
    montar({
      logs: [],
      checkinout: [{ USERID: '3091', CHECKTIME: '2025-02-01 02:30:00', CHECKTYPE: 'I' }],
    });
    await apply({ ...ARGS, apply: true, manifest: manifestCon([cruza]) });

    expect(attParams().hasta).toBe('2025-02-01 02:30:00');
    expect(mockQuery.mock.calls.filter(c => /UPDATE/i.test(String(c[0])))).toHaveLength(1);
  });
});
