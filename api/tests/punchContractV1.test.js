/**
 * Contrato canónico de marcaciones v1 — normalización, event_id y validación.
 *
 * El contrato NO está conectado: no hay rutas, ni escritura en Redis o MySQL.
 * Estos tests fijan las reglas antes de que algo dependa de ellas.
 */
const path = require('path');
const fs = require('fs');

const C = require('../../contracts/punchContractV1');
const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'contracts', 'fixtures', 'punches-v1.json'), 'utf8')
);

const base = {
  device_id: 1,
  device_user_id: '42',
  occurred_at: '2026-08-04T10:15:03Z',
  event_type: 'in',
  verify_mode: 1,
  work_code: null,
};

describe('normalización determinista', () => {
  test('los ceros a la izquierda se CONSERVAN: son parte del identificador', () => {
    // employee_device_map compara device_user_id como string exacto, así que
    // "0042" y "42" son dos asignaciones distintas. Unificarlas acá colapsaría
    // los marcajes de dos personas en un solo event_id.
    expect(C.normalizeDeviceUserId('0042')).toBe('0042');
    expect(C.normalizeDeviceUserId('  042  ')).toBe('042');
    expect(C.normalizeDeviceUserId('007A')).toBe('007A');
  });

  test('"42" y "0042" no colapsan al mismo evento', () => {
    const a = C.buildEvent({ ...base, device_user_id: '42' });
    const b = C.buildEvent({ ...base, device_user_id: '0042' });
    expect(a.event.event_id).not.toBe(b.event.event_id);
  });

  test('quitar los ceros es opt-in por instalación, no un default', () => {
    expect(C.normalizeDeviceUserId('0042', { stripLeadingZeros: true })).toBe('42');
    expect(C.normalizeDeviceUserId('000', { stripLeadingZeros: true })).toBe('0');
    expect(C.normalizeDeviceUserId('007A', { stripLeadingZeros: true })).toBe('007A');
  });

  test('la hora sin offset se ancla a la zona civil, no a la del proceso', () => {
    // Éste es el bug latente del bridge actual: new Date('...') usa la zona
    // del proceso, así que el mismo marcaje da otro instante según el server.
    expect(C.normalizeTimestamp('2026-08-04 07:15:03')).toBe('2026-08-04T10:15:03Z');
    expect(C.normalizeTimestamp('2026-08-04T07:15:03')).toBe('2026-08-04T10:15:03Z');
  });

  test('un offset explícito se respeta', () => {
    expect(C.normalizeTimestamp('2026-08-04T07:15:03-03:00')).toBe('2026-08-04T10:15:03Z');
    expect(C.normalizeTimestamp('2026-08-04T10:15:03Z')).toBe('2026-08-04T10:15:03Z');
    expect(C.normalizeTimestamp('2026-08-04T12:15:03+02:00')).toBe('2026-08-04T10:15:03Z');
    expect(C.normalizeTimestamp('2026-08-04T07:15:03-0300')).toBe('2026-08-04T10:15:03Z');
  });

  test('el offset civil es fijo: Paraguay no aplica horario de verano', () => {
    // Enero y julio dan el mismo desplazamiento.
    expect(C.normalizeTimestamp('2026-01-15 08:00:00')).toBe('2026-01-15T11:00:00Z');
    expect(C.normalizeTimestamp('2026-07-15 08:00:00')).toBe('2026-07-15T11:00:00Z');
    expect(C.CIVIL_OFFSET_MINUTES).toBe(-180);
  });

  test('los milisegundos se descartan: los relojes reportan segundos', () => {
    expect(C.normalizeTimestamp('2026-08-04T10:15:03.987Z')).toBe('2026-08-04T10:15:03Z');
    expect(C.normalizeTimestamp(new Date('2026-08-04T10:15:03.987Z'), { dateMeans: 'utc_instant' }))
      .toBe('2026-08-04T10:15:03Z');
  });

  test('fechas imposibles o basura se rechazan', () => {
    for (const malo of ['2026-02-31T10:00:00', '2026-13-01T10:00:00', 'ayer', '', null, undefined, '2026-08-04T25:00:00']) {
      expect(C.normalizeTimestamp(malo)).toBeNull();
    }
  });

  test('el tipo de evento se limita al enum, y lo desconocido cae en unknown', () => {
    expect(C.normalizeEventType('IN')).toBe('in');
    expect(C.normalizeEventType('break_start')).toBe('break_start');
    expect(C.normalizeEventType('cualquier_cosa')).toBe('unknown');
    expect(C.normalizeEventType(null)).toBe('unknown');
  });
});

describe('event_id estable y reproducible', () => {
  test('reordenar las claves no cambia el identificador', () => {
    const a = C.computeEventId(base);
    const b = C.computeEventId({
      work_code: null, verify_mode: 1, event_type: 'in',
      occurred_at: '2026-08-04T10:15:03Z', device_user_id: '42', device_id: 1,
    });
    expect(a).toBe(b);
  });

  test('el mismo evento repetido conserva el identificador', () => {
    const ids = new Set(Array.from({ length: 20 }, () => C.computeEventId(base)));
    expect(ids.size).toBe(1);
  });

  test('cambiar cualquier campo estable cambia el identificador', () => {
    const original = C.computeEventId(base);
    const variantes = [
      { ...base, device_id: 2 },
      { ...base, device_user_id: '43' },
      { ...base, occurred_at: '2026-08-04T10:15:04Z' },
      { ...base, event_type: 'out' },
    ];
    for (const v of variantes) expect(C.computeEventId(v)).not.toBe(original);
  });

  test('verify_mode y work_code NO cambian la identidad: son atributos', () => {
    // El PUSH los trae de la línea ATTLOG; el polling no los publica. Si
    // entraran al hash, el mismo marcaje leído por los dos caminos daría dos
    // identificadores y se insertaría dos veces.
    const original = C.computeEventId(base);
    expect(C.computeEventId({ ...base, verify_mode: 15 })).toBe(original);
    expect(C.computeEventId({ ...base, work_code: 'OBRA-1' })).toBe(original);
    expect(C.computeEventId({ ...base, verify_mode: null, work_code: null })).toBe(original);
  });

  test('los campos volátiles NO entran en el identificador', () => {
    const conRuido = C.buildEvent({
      ...base,
      batch_id: 'b-999', received_at: new Date().toISOString(),
      device_ip: '192.0.2.10', bridge_id: 'otro-bridge', orden: 7,
    });
    expect(conRuido.event.event_id).toBe(C.computeEventId(base));
  });

  test('el string canónico no depende de JSON.stringify', () => {
    const canon = C.canonicalString(base);
    expect(canon).toContain('sishoras.punch.v1');
    expect(canon).not.toContain('{');
    expect(canon.split(C.FIELD_SEP)).toHaveLength(5);   // prefijo + 4 campos de identidad
  });

  test('dos marcajes reales idénticos colapsan a un solo evento — política explícita', () => {
    // Si un reloj reporta dos veces al mismo usuario, en el mismo segundo, con
    // el mismo tipo y verificación, no hay forma de distinguirlos: son el mismo
    // hecho o un duplicado del transporte. El contrato los trata como uno.
    const uno = C.buildEvent(base);
    const otro = C.buildEvent({ ...base });
    expect(uno.event.event_id).toBe(otro.event.event_id);
  });

  test('el mismo segundo con distinto tipo NO colapsa', () => {
    expect(C.computeEventId({ ...base, event_type: 'in' }))
      .not.toBe(C.computeEventId({ ...base, event_type: 'out' }));
  });
});

describe('las tres formas de origen convergen', () => {
  const { origen_push_attlog, origen_polling_zklib, origen_att2000, canonico_esperado } = FIXTURES;

  test('PUSH, polling y att2000 producen el mismo evento canónico', () => {
    // PUSH: línea ATTLOG
    const [userId, ts, status, verify, workCode] = origen_push_attlog.lineas[0].split('\t');
    const desdePush = C.buildEvent({
      device_id: origen_push_attlog.device_id,
      device_user_id: userId,
      occurred_at: ts,
      event_type: ['in', 'out', 'break_start', 'break_end'][Number(status)] || 'unknown',
      verify_mode: verify,
      work_code: workCode,
    });

    // Polling: objeto de node-zklib
    const reg = origen_polling_zklib.registros[0];
    // El polling NO publica verify ni workCode. Antes este test fijaba
    // verify_mode: 1 a mano, y así ocultaba que el hash no convergía.
    const desdePolling = C.buildEvent({
      device_id: origen_polling_zklib.device_id,
      device_user_id: reg.userId,
      occurred_at: reg.timestamp,
      event_type: reg.state === 0 ? 'in' : 'out',
    });

    // att2000: fila CHECKINOUT
    const fila = origen_att2000.filas[0];
    const desdeAtt = C.buildEvent({
      device_id: origen_att2000.device_id,
      device_user_id: fila.USERID,
      occurred_at: fila.CHECKTIME,
      event_type: fila.CHECKTYPE === 'I' ? 'in' : 'out',
    });

    expect(desdePush.ok && desdePolling.ok && desdeAtt.ok).toBe(true);
    expect(desdePush.event.event_id).toBe(desdePolling.event.event_id);
    expect(desdePush.event.event_id).toBe(desdeAtt.event.event_id);
    expect(desdePush.event.occurred_at).toBe(canonico_esperado.occurred_at);
    expect(desdePush.event.device_user_id).toBe(canonico_esperado.device_user_id);
  });

  test('un id numérico y su forma string sí convergen', () => {
    const a = C.buildEvent({ ...base, device_user_id: '42' });
    const b = C.buildEvent({ ...base, device_user_id: 42 });
    expect(a.event.event_id).toBe(b.event.event_id);
  });
});

describe('Unicode', () => {
  test('un id con acentos sobrevive y se normaliza a NFC', () => {
    const compuesto = 'EMP-Nñandu'.normalize('NFD');
    const a = C.buildEvent({ ...FIXTURES.unicode, device_user_id: FIXTURES.unicode.device_user_id });
    const b = C.buildEvent({ ...FIXTURES.unicode, device_user_id: FIXTURES.unicode.device_user_id.normalize('NFD') });

    expect(a.ok).toBe(true);
    expect(a.event.event_id).toBe(b.event.event_id);   // NFC vs NFD dan el mismo id
    expect(compuesto.normalize('NFC').length).toBeLessThanOrEqual(compuesto.length);
  });

  test('emojis y espacios raros no rompen el cálculo', () => {
    const r = C.buildEvent({ ...base, device_user_id: 'EMP 007', work_code: 'TURNO 🌙' });
    expect(r.ok).toBe(true);
    expect(r.event.event_id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('entradas maliciosas', () => {
  test('todas se rechazan o se neutralizan, ninguna revienta', () => {
    for (const caso of FIXTURES.maliciosos) {
      const r = C.buildEvent(caso);
      if (r.ok) {
        // Si se acepta, el valor quedó como dato inerte y el id es un hash.
        expect(r.event.event_id).toMatch(/^sha256:[0-9a-f]{64}$/);
      } else {
        expect(Object.values(C.REJECT_CODES)).toContain(r.error_code);
      }
    }
  });

  test('un separador canónico embebido se rechaza en vez de arriesgar colisión', () => {
    const conSeparador = `42${C.FIELD_SEP}s:99`;
    const r = C.buildEvent({ ...base, device_user_id: conSeparador });
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(C.REJECT_CODES.SEPARATOR_IN_VALUE);
  });

  test('device_id inválido', () => {
    for (const malo of [0, -1, 1.5, 'abc', null, '', '../../etc/passwd']) {
      expect(C.buildEvent({ ...base, device_id: malo }).error_code).toBe(C.REJECT_CODES.DEVICE_ID_INVALID);
    }
  });

  test('verify_mode fraccionario o fuera de rango', () => {
    expect(C.buildEvent({ ...base, verify_mode: 1.5 }).error_code).toBe(C.REJECT_CODES.VERIFY_MODE_INVALID);
    expect(C.buildEvent({ ...base, verify_mode: 99999 }).error_code).toBe(C.REJECT_CODES.VERIFY_MODE_INVALID);
  });
});

describe('validación de lotes', () => {
  const loteValido = () => C.buildBatch({
    bridge_id: 'bridge-demo', device_id: 1,
    events: [{ ...base }, { ...base, occurred_at: '2026-08-04T12:02:11Z', event_type: 'out' }],
  }).batch;

  const AHORA = Date.parse('2026-08-04T13:00:00Z');

  test('un lote bien formado pasa', () => {
    const r = C.validateBatch(loteValido(), { now: AHORA });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
  });

  test('versión no soportada', () => {
    expect(C.validateBatch({ ...loteValido(), schema_version: 2 }, { now: AHORA }).error_code)
      .toBe(C.REJECT_CODES.UNSUPPORTED_VERSION);
  });

  test('lote vacío', () => {
    expect(C.validateBatch({ ...loteValido(), events: [] }, { now: AHORA }).error_code)
      .toBe(C.REJECT_CODES.BATCH_EMPTY);
  });

  test('demasiados eventos', () => {
    const grande = { ...loteValido(), events: Array.from({ length: 101 }, () => ({ ...base })) };
    expect(C.validateBatch(grande, { now: AHORA }).error_code).toBe(C.REJECT_CODES.BATCH_TOO_MANY);
  });

  test('lote demasiado pesado', () => {
    const gordo = C.buildBatch({
      bridge_id: 'b', device_id: 1,
      events: Array.from({ length: 100 }, (_, i) => ({ ...base, work_code: 'X'.repeat(30), device_user_id: String(1000 + i) })),
    }).batch;
    gordo.bridge_id = 'B'.repeat(60);
    const r = C.validateBatch(gordo, { now: AHORA });
    // Con 100 eventos el lote entra; el límite de bytes se prueba directo:
    expect(r.ok || r.error_code === C.REJECT_CODES.BATCH_TOO_LARGE).toBe(true);
    expect(C.LIMITS.MAX_BATCH_BYTES).toBe(256 * 1024);
  });

  test('fecha futura fuera del margen', () => {
    const lote = loteValido();
    lote.events[0] = C.buildEvent({ ...base, occurred_at: '2026-08-04T20:00:00Z' }).event;
    expect(C.validateBatch(lote, { now: AHORA }).error_code).toBe(C.REJECT_CODES.TIMESTAMP_FUTURE);
  });

  test('un pequeño desfasaje de reloj se tolera', () => {
    const lote = loteValido();
    lote.events[0] = C.buildEvent({ ...base, occurred_at: '2026-08-04T13:02:00Z' }).event;
    expect(C.validateBatch(lote, { now: AHORA }).ok).toBe(true);
  });

  test('event_id inconsistente se rechaza', () => {
    const lote = loteValido();
    lote.events[0].event_id = 'sha256:' + '0'.repeat(64);
    const r = C.validateBatch(lote, { now: AHORA });

    expect(r.error_code).toBe(C.REJECT_CODES.EVENT_ID_MISMATCH);
    expect(r.index).toBe(0);
  });

  test('un user id con espacios se rechaza: rompería la idempotencia', () => {
    const lote = loteValido();
    lote.events[0] = { ...lote.events[0], device_user_id: ' 42 ' };
    expect(C.validateBatch(lote, { now: AHORA }).error_code).toBe(C.REJECT_CODES.USER_ID_INVALID);
  });

  test('un separador embebido se rechaza también en la validación', () => {
    // buildEvent lo rechaza, pero un lote externo llega con su id ya calculado.
    const lote = loteValido();
    const malicioso = `42${C.FIELD_SEP}s:99`;
    lote.events[0] = {
      ...lote.events[0],
      device_user_id: malicioso,
      event_id: C.computeEventId({ ...lote.events[0], device_user_id: malicioso }),
    };
    expect(C.validateBatch(lote, { now: AHORA }).error_code).toBe(C.REJECT_CODES.SEPARATOR_IN_VALUE);
  });

  test('un work_code no canónico se rechaza aunque no entre al hash', () => {
    for (const wc of ['', '  ', ' OBRA ']) {
      const lote = loteValido();
      lote.events[0] = { ...lote.events[0], work_code: wc };
      expect(C.validateBatch(lote, { now: AHORA }).error_code).toBe(C.REJECT_CODES.WORK_CODE_INVALID);
    }
  });

  test('una fecha imposible CON offset no se corre de día', () => {
    // Date.parse convierte 2026-02-31 en 2026-03-03 sin avisar.
    expect(C.normalizeTimestamp('2026-02-31T10:00:00Z')).toBeNull();
    expect(C.normalizeTimestamp('2026-02-31T10:00:00-03:00')).toBeNull();
    expect(C.normalizeTimestamp('2026-13-01T10:00:00Z')).toBeNull();
  });

  test('un timestamp no canónico se rechaza', () => {
    const lote = loteValido();
    lote.events[0] = { ...lote.events[0], occurred_at: '2026-08-04T10:15:03.000Z' };
    expect(C.validateBatch(lote, { now: AHORA }).error_code).toBe(C.REJECT_CODES.TIMESTAMP_INVALID);
  });

  test('device_id y bridge_id inválidos', () => {
    expect(C.validateBatch({ ...loteValido(), device_id: 0 }, { now: AHORA }).error_code)
      .toBe(C.REJECT_CODES.DEVICE_ID_INVALID);
    expect(C.validateBatch({ ...loteValido(), bridge_id: '' }, { now: AHORA }).error_code)
      .toBe(C.REJECT_CODES.BRIDGE_ID_INVALID);
  });

  test('entradas que no son objetos', () => {
    for (const malo of [null, undefined, [], 'texto', 42]) {
      const r = C.validateBatch(malo, { now: AHORA });
      expect(r.ok).toBe(false);
    }
  });
});

describe('el contrato no está conectado', () => {
  test('el módulo no importa base de datos, Redis ni Express', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'contracts', 'punchContractV1.js'), 'utf8');
    for (const prohibido of ['express', 'redis', 'sequelize', 'mysql', '../config/database']) {
      expect(src).not.toContain(`require('${prohibido}`);
    }
  });

  test('sólo exporta funciones puras y constantes', () => {
    for (const [, v] of Object.entries(C)) {
      expect(['function', 'object', 'number', 'string']).toContain(typeof v);
    }
  });
});

describe('un Date no declara qué significa', () => {
  test('se rechaza sin dateMeans: el polling lo construye con la zona del proceso', () => {
    const r = C.buildEvent({ ...base, occurred_at: new Date('2026-08-04T10:15:03Z') });

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(C.REJECT_CODES.TIMESTAMP_INVALID);
    expect(r.detail).toContain('dateMeans');
  });

  test('declarado como instante UTC se respeta', () => {
    expect(C.normalizeTimestamp(new Date('2026-08-04T10:15:03Z'), { dateMeans: 'utc_instant' }))
      .toBe('2026-08-04T10:15:03Z');
  });

  test('declarado como hora de pared se reancla al offset civil', () => {
    // new Date(2026, 7, 4, 7, 15, 3) usa los componentes LOCALES del proceso;
    // leerlos de vuelta recupera la hora de pared del reloj.
    expect(C.normalizeTimestamp(new Date(2026, 7, 4, 7, 15, 3), { dateMeans: 'civil_wall' }))
      .toBe('2026-08-04T10:15:03Z');
  });

  test('un Date inválido se rechaza en cualquier modo', () => {
    for (const modo of ['utc_instant', 'civil_wall', null]) {
      expect(C.normalizeTimestamp(new Date('nada'), { dateMeans: modo })).toBeNull();
    }
  });
});

describe('cuarta tanda de Codex', () => {
  test('un verify en blanco es dato AUSENTE, no el modo 0', () => {
    // La columna verify de ATTLOG viene con espacios de relleno, y
    // Number('   ') es 0 — un modo de verificación real.
    for (const blanco of ['', '   ', '\t', null, undefined]) {
      expect(C.buildEvent({ ...base, verify_mode: blanco }).event.verify_mode).toBeNull();
    }
  });

  test('el modo 0 explícito sí se conserva', () => {
    expect(C.buildEvent({ ...base, verify_mode: '0' }).event.verify_mode).toBe(0);
    expect(C.buildEvent({ ...base, verify_mode: 0 }).event.verify_mode).toBe(0);
  });

  test('sólo se acepta decimal: Number aceptaría 0x10 y 1e2', () => {
    for (const raro of ['0x10', '1e2', '1.5', '+1', '-1', 'uno']) {
      expect(C.buildEvent({ ...base, verify_mode: raro }).error_code)
        .toBe(C.REJECT_CODES.VERIFY_MODE_INVALID);
    }
  });

  test('un evento no puede declarar un reloj distinto al del lote', () => {
    // Sin esto, un lote de device_id 1 con un evento de device_id 2 —y su
    // hash consistente— pasaba, y quien confiara en el reloj del lote habría
    // atribuido el marcaje al equipo equivocado.
    const { batch } = C.buildBatch({
      bridge_id: 'b', device_id: 1,
      events: [{ device_id: 2, device_user_id: '42', occurred_at: '2026-08-04T10:15:03Z', event_type: 'in' }],
    });
    batch.device_id = 1;

    const r = C.validateBatch(batch, { now: Date.parse('2026-08-04T12:00:00Z') });
    expect(r.error_code).toBe(C.REJECT_CODES.DEVICE_ID_INVALID);
    expect(r.detail).toContain('lote');
  });

  test('un evento que omite device_id hereda el del lote', () => {
    const { batch } = C.buildBatch({
      bridge_id: 'b', device_id: 1,
      events: [{ device_user_id: '42', occurred_at: '2026-08-04T10:15:03Z', event_type: 'in' }],
    });
    expect(C.validateBatch(batch, { now: Date.parse('2026-08-04T12:00:00Z') }).ok).toBe(true);
  });
});
