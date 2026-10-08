'use strict';

/**
 * zkPilotAggregate.test.js — agregado SANEADO del piloto de estados por reloj.
 *
 * Los registros pasan por las clases y decodificadores REALES de node-zklib
 * con el transporte simulado (fixtures/fakeZk.js) y la captura de bytes
 * instalada antes de cargarlos. El agregado esperado está calculado a mano en
 * fixtures/pilotRecords.js. CI corre esta suite en UTC, America/Asuncion y
 * Asia/Tokyo: la hora de pared del reloj no depende de la zona del proceso.
 */
const path = require('path');
const {
  RECORDS, USER_IDS, EXPECTED_TCP40, CUTOFF, AFTER_CUTOFF, withAlteredBeforeCutoff,
} = require('./it/fixtures/pilotRecords');

const FIXTURE = path.join(__dirname, 'it', 'fixtures', 'fakeZk');
const NOW_PY = '2026-10-07 12:00:00';

/** Clave de pruebas de la huella del corte (64 hex): sólo para estas marcas sintéticas. */
const KEY = '0123456789abcdef'.repeat(4);

/**
 * Huella esperada del conjunto anterior al corte, calculada a mano desde la DEFINICIÓN de las marcas
 * sintéticas (no con el código bajo prueba): HMAC-SHA256 con la clave sobre el canon, la cantidad y las
 * líneas [usuario, hora de pared, estado, verificación] ordenadas.
 */
function expectedHuella(input, cutoff, key = KEY) {
  const lines = input
    .filter((r) => r.deviceUserId !== '' && !r.wall.startsWith('2000-') && r.wall <= cutoff)
    .map((r) => JSON.stringify([r.deviceUserId, r.wall, String(r.punchByte), String(r.verifyByte)]))
    .sort();
  return require('crypto').createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`sishoras.zk-raw-state-pilot.corte/2\n${lines.length}\n${lines.join('\n')}`).digest('hex');
}

async function decoded(transport, input = RECORDS) {
  let res;
  let aggregate;
  await jest.isolateModulesAsync(async () => {
    const capture = require('../src/services/zkRawCapture');
    expect(capture.install().installed).toBe(true);      // antes de cargar node-zklib
    res = await require(FIXTURE).readThroughNodeZklib(input, transport);
    aggregate = require('../src/services/zkPilot/aggregate');
  });
  return { records: res.data, aggregate };
}

describe('piloto de estados: agregado saneado', () => {
  test('tcp40: conteos, formato, distribuciones, fechas, duplicados y supresión exactos', async () => {
    const { records, aggregate } = await decoded('tcp40');
    expect(aggregate.aggregateRecords(records, { nowPy: NOW_PY })).toEqual(EXPECTED_TCP40);
  });

  test('udp16: mismo conteo con el formato y el tamaño de 16 bytes', async () => {
    const { records, aggregate } = await decoded('udp16');
    const out = aggregate.aggregateRecords(records, { nowPy: NOW_PY });
    expect(out).toEqual({
      ...EXPECTED_TCP40,
      formatos: { udp16: EXPECTED_TCP40.formatos.tcp40 },
      bytes_estimados: { ...EXPECTED_TCP40.bytes_estimados, valor: 4 + 31 * 16 },
    });
  });

  test('udp8: se cuentan los bytes 7 y 2 por formato; la hora desalineada no se corrige aquí', async () => {
    const { records, aggregate } = await decoded('udp8');
    const out = aggregate.aggregateRecords(records, { nowPy: NOW_PY });
    expect(Object.keys(out.formatos)).toEqual(['udp8']);
    expect(out.captura).toEqual({ ok: 31, no_disponible: 0, longitud_inesperada: 0, otro: 0 });
    expect(out.bytes_estimados.valor).toBe(4 + 31 * 8);
    // La suma por valor coincide con los válidos de ese formato (nada se pierde ni se inventa).
    const f = out.formatos.udp8;
    expect(Object.values(f.zkPunchState).reduce((a, b) => a + b, 0)).toBe(f.validos);
    expect(Object.values(f.zkVerify).reduce((a, b) => a + b, 0)).toBe(f.validos);
  });

  test('captura ausente, longitud inesperada, bytes inválidos/ausentes y formato desconocido quedan explícitos', () => {
    const { aggregateRecords } = require('../src/services/zkPilot/aggregate');
    const at = (i) => new Date(2026, 9, 1, 8, i, 0);
    const recs = [
      { deviceUserId: '1', recordTime: at(0), zkCapture: 'no_disponible' },
      { deviceUserId: '2', recordTime: at(1), zkCapture: 'longitud_inesperada', zkRecordLength: 12 },
      { deviceUserId: '3', recordTime: at(2), zkCapture: 'ok', zkRecordFormat: 'tcp40', zkPunchState: 300, zkVerify: -1 },
      { deviceUserId: '4', recordTime: at(3), zkCapture: 'ok', zkRecordFormat: 'tcp40' },
      { deviceUserId: '5', recordTime: at(4), zkCapture: 'ok', zkRecordFormat: 'xyz', zkPunchState: 1, zkVerify: 1 },
      { deviceUserId: '6', recordTime: at(5), zkCapture: 'foo' },
    ];
    expect(aggregateRecords(recs, { nowPy: NOW_PY })).toEqual({
      registros: 6,
      basura: 0,
      validos: 6,
      captura: { ok: 3, no_disponible: 1, longitud_inesperada: 1, otro: 1 },
      validos_sin_captura: 3,
      formatos: {
        tcp40: {
          validos: 2,
          zkPunchState: { invalido: 1, ausente: 1 },
          zkVerify: { invalido: 1, ausente: 1 },
          combinaciones: { 'invalido/invalido': 1, 'ausente/ausente': 1 },
        },
        desconocido: { validos: 1, zkPunchState: { 1: 1 }, zkVerify: { 1: 1 }, combinaciones: { '1/1': 1 } },
      },
      fechas: { primera: '2026-10-01', ultima: '2026-10-01', dias_con_marcas: 1 },
      futuras: 0,
      duplicados_usuario_hora: 0,
      usuarios_distintos: 6,
      umbral_supresion: 5,
      por_hora: { '08': { sin_captura: '<5', invalido: '<5', ausente: '<5', 1: '<5' } },
      patrones_dia: { patrones: {}, suprimidos: { patrones: 4, dias: 6 } },
      bytes_estimados: { valor: 4 + 40 + 40 + 12, es_estimacion: true, metodo: 'tamano_por_registro_decodificado', registros_sin_longitud: 3 },
    });
  });

  test('sin usuarios, horas individuales ni interpretación entrada/salida en la salida', async () => {
    const { records, aggregate } = await decoded('tcp40');
    const text = JSON.stringify(aggregate.aggregateRecords(records, { nowPy: NOW_PY }));
    for (const uid of USER_IDS) expect(text).not.toContain(uid);
    expect(text).not.toMatch(/\d{2}:\d{2}(:\d{2})?/);          // ninguna hora individual
    expect(text).not.toMatch(/entrada|salida|"in"|"out"|check_?in|check_?out/i);
    expect(text).not.toMatch(/userSn|deviceUserId|recordTime|"ip"|127\.0\.0\./);
  });

  test('el umbral de supresión es explícito y configurable', async () => {
    const { records, aggregate } = await decoded('tcp40');
    const out = aggregate.aggregateRecords(records, { nowPy: NOW_PY, kMin: 1 });
    expect(out.umbral_supresion).toBe(1);
    expect(out.por_hora['03']).toEqual({ 2: 1 });
    expect(out.patrones_dia).toEqual({
      patrones: { '0,1': 10, '0': 1, '0,1,1': 1, '0,4,5,1': 1, 2: 1 },
      suprimidos: { patrones: 0, dias: 0 },
    });
  });

  // ─── Corte común: el mismo conjunto histórico en dos corridas ───

  const block = (aggregate, records, over = {}) => aggregate.cutoffBlock(records, {
    hasta: CUTOFF, clave: KEY, nowPy: NOW_PY, zona: 'UTC', ...over,
  });

  test('corte: sólo conteos y una huella con clave; posteriores, futuras y basura quedan fuera', async () => {
    const { records, aggregate } = await decoded('tcp40');
    const { claveId } = require('../src/services/zkPilot/corte');
    // 29 válidos: 28 hasta el corte; la marca de 2099 es posterior (y futura); 2 de relleno (basura).
    expect(block(aggregate, records)).toEqual({
      hasta: CUTOFF,
      canon: 'sishoras.zk-raw-state-pilot.corte/2',
      decodificacion: { zona: 'UTC' },
      conjunto: {
        registros: 28, usuarios: 7, dias_con_marcas: '<5', formato: 'tcp40', captura_completa: true,
        huella: expectedHuella(RECORDS, CUTOFF), huella_tipo: 'hmac-sha256', clave_id: claveId(KEY), huella_motivo: null,
      },
      fuera: { posteriores: 1, futuras: 1, basura: 2 },
    });
  });

  test('corte: marcas nuevas posteriores no alteran el conjunto; una anterior alterada o un duplicado sí', async () => {
    const base = await decoded('tcp40');
    const grown = await decoded('tcp40', [...RECORDS, ...AFTER_CUTOFF]);
    const altered = await decoded('tcp40', withAlteredBeforeCutoff());
    const b0 = block(base.aggregate, base.records);
    const b1 = block(grown.aggregate, grown.records);
    const b2 = block(altered.aggregate, altered.records);
    expect(b1.conjunto).toEqual(b0.conjunto);
    expect([b0.fuera.posteriores, b1.fuera.posteriores]).toEqual([1, 7]);
    expect(b2.conjunto.registros).toBe(b0.conjunto.registros);
    expect(b2.conjunto.huella).not.toBe(b0.conjunto.huella);
    expect(b2.conjunto.huella).toBe(expectedHuella(withAlteredBeforeCutoff(), CUTOFF));
    // Multiconjunto: no depende del orden del buffer y un duplicado exacto cuenta.
    expect(block(base.aggregate, [...base.records].reverse()).conjunto.huella).toBe(b0.conjunto.huella);
    expect(block(base.aggregate, [...base.records, base.records[0]]).conjunto.huella).not.toBe(b0.conjunto.huella);
  });

  test('corte: sin huella (null y motivo, nunca un sustituto comparable) sin clave o con conjunto chico', async () => {
    const { records, aggregate } = await decoded('tcp40');
    const motivo = (over, recs = records) => {
      const b = block(aggregate, recs, over).conjunto;
      return [b.huella, b.huella_motivo];
    };
    expect(motivo({ clave: null })).toEqual([null, 'sin_clave']);
    expect(block(aggregate, records, { clave: null }).conjunto.clave_id).toBeNull();
    // Límite inclusivo: 07:50:10 del 1/10 es la primera marca.
    expect(block(aggregate, records, { hasta: '2026-10-01 07:50:10' }).conjunto.registros).toBe(1);
    expect(block(aggregate, records, { hasta: '2026-10-01 07:50:09' }).conjunto.registros).toBe(0);
    expect(motivo({ hasta: '2026-10-01 07:50:10' })).toEqual([null, 'pocos_registros']);
    // Muchas marcas de pocas personas (7001 y 7002): el umbral cuenta personas, no marcas.
    const two = records.filter((r) => ['7001', '7002'].includes(String(r.deviceUserId)));
    expect(block(aggregate, two).conjunto.registros).toBeGreaterThanOrEqual(5);
    expect(motivo({}, two)).toEqual([null, 'pocos_usuarios']);
  });

  test('corte: sin huella con captura incompleta o formatos mezclados (TCP y UDP no son comparables)', async () => {
    const tcp = await decoded('tcp40');
    const udp = await decoded('udp16');
    const partial = tcp.records.map((r, i) => (i === 0 ? { ...r, zkCapture: 'no_disponible' } : r));
    expect(block(tcp.aggregate, partial).conjunto).toMatchObject({ huella: null, huella_motivo: 'captura_incompleta', captura_completa: false });
    const mixed = [...tcp.records.slice(0, 15), ...udp.records.slice(15)];
    expect(block(tcp.aggregate, mixed).conjunto).toMatchObject({ huella: null, huella_motivo: 'formatos_mixtos', formato: 'mixto' });
    // El mismo historial leído por UDP da otro formato: la comparación lo declara no comparable.
    expect(block(udp.aggregate, udp.records).conjunto.formato).toBe('udp16');
  });

  test('corte: ni registros, ni agregado del conjunto, ni la clave en el bloque', async () => {
    const { records, aggregate } = await decoded('tcp40');
    const b = block(aggregate, records);
    expect(Object.keys(b.conjunto)).not.toContain('agregado');
    const text = JSON.stringify(b, (k, v) => (['hasta', 'huella', 'clave_id'].includes(k) ? '…' : v));
    for (const uid of USER_IDS) expect(text).not.toContain(uid);
    expect(text).not.toMatch(/\d{2}:\d{2}(:\d{2})?/);
    expect(text).not.toMatch(/userSn|deviceUserId|recordTime|por_hora|zkPunchState|zkVerify/);
    expect(JSON.stringify(b)).not.toContain(KEY);
  });

  test('corte: la huella no depende de la zona horaria del proceso (fuera de horas inexistentes)', async () => {
    const { records, aggregate } = await decoded('tcp40');
    // Igual al cálculo independiente en UTC, America/Asuncion y Asia/Tokyo (CI corre las tres).
    expect(block(aggregate, records).conjunto.huella).toBe(expectedHuella(RECORDS, CUTOFF));
  });

  test('zona de decodificación: en America/Asuncion la hora del cambio de 2023 no existe (el hijo corre en UTC)', () => {
    const { decodingZoneOk } = require('../src/services/zkPilot/aggregate');
    const tz = process.env.TZ || '';
    if (tz === 'America/Asuncion') expect(decodingZoneOk()).toBe(false);
    if (tz === 'UTC' || tz === 'Asia/Tokyo') expect(decodingZoneOk()).toBe(true);
    expect(typeof decodingZoneOk()).toBe('boolean');
  });

  test('errores de lectura: sólo códigos, nunca el mensaje crudo', () => {
    const { classifyReadError } = require('../src/services/zkPilot/aggregate');
    const cases = [
      ['TIMEOUT_ON_WRITING_MESSAGE', 'sin_respuesta_escritura'],
      ['connect ECONNREFUSED 192.0.2.10:4370', 'conexion_rechazada'],
      ['connect EHOSTUNREACH 192.0.2.10:4370', 'inalcanzable'],
      ['TIMEOUT_IN_RECEIVING_RESPONSE_AFTER_REQUESTING_DATA', 'timeout_reloj'],
      ['connect ETIMEDOUT 192.0.2.10:4370', 'timeout_reloj'],
      ['Socket is disconnected unexpectedly', 'conexion_cortada'],
      ['read ECONNRESET', 'conexion_cortada'],
      ['algo raro con 192.0.2.10 y usuario 7001', 'error_lectura'],
    ];
    for (const [msg, code] of cases) {
      expect(classifyReadError(new Error(msg))).toBe(code);
      expect(classifyReadError({ err: { message: msg } })).toBe(code);
    }
    expect(classifyReadError(null)).toBe('error_lectura');
  });
});
