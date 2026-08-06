/**
 * Outbox local del Bridge — cola durable, todavía DESCONECTADA.
 *
 * Lo que se prueba no es "las funciones devuelven lo esperado" sino las
 * garantías que justifican tener una base en vez de un archivo: que una
 * marcación sobrevive al reinicio, que dos consumidores no se llevan la misma
 * fila, y que nada se da por transmitido antes del ACK.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createOutbox, Outbox, readConfig, sanitizePayload, STATUS, OUTBOX_ERRORS, CAMPOS_PERMITIDOS } = require('../src/outbox');
const { buildEvent } = require('../../contracts/punchContractV1');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sishoras-outbox-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

/** Entorno con la flag ENCENDIDA y una ruta propia por test. */
function envOn(extra = {}) {
  return {
    BRIDGE_OUTBOX_ENABLED: 'true',
    BRIDGE_OUTBOX_PATH: path.join(dir, 'outbox.db'),
    ...extra,
  };
}

/** Marcación canónica válida. Datos ficticios. */
function marcacion(i = 0, deviceId = 7) {
  const r = buildEvent({
    device_id: deviceId,
    device_user_id: String(1000 + i),
    occurred_at: `2026-03-11T08:${String(i % 60).padStart(2, '0')}:00-03:00`,
    event_type: 'in',
  });
  if (!r.ok) throw new Error('fixture inválido: ' + r.error_code);
  return r.event;
}

function abierto(extra = {}) {
  const o = createOutbox(envOn(extra));
  const r = o.open();
  if (!r.ok) throw new Error('no abrió: ' + r.error_code + ' ' + (r.detail || ''));
  return o;
}

// ── La flag apagada no toca nada ─────────────────────────────────────

describe('con la flag apagada no existe', () => {
  test('no crea el archivo ni abre SQLite', () => {
    const ruta = path.join(dir, 'outbox.db');
    const o = createOutbox({ BRIDGE_OUTBOX_ENABLED: 'false', BRIDGE_OUTBOX_PATH: ruta });

    const r = o.open();

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(OUTBOX_ERRORS.DISABLED);
    expect(o.isOpen).toBe(false);
    expect(fs.existsSync(ruta)).toBe(false);   // ← nada en disco
  });

  test('la flag ausente equivale a apagada', () => {
    const o = createOutbox({ BRIDGE_OUTBOX_PATH: path.join(dir, 'x.db') });
    expect(o.open().error_code).toBe(OUTBOX_ERRORS.DISABLED);
  });

  test('sólo el valor exacto "true" la enciende', () => {
    for (const v of ['1', 'yes', 'TRUE', 'si', '']) {
      const o = createOutbox({ BRIDGE_OUTBOX_ENABLED: v, BRIDGE_OUTBOX_PATH: path.join(dir, 'x.db') });
      expect(o.open().ok).toBe(false);
    }
  });

  test('ninguna operación intercepta nada estando cerrado', () => {
    const o = createOutbox({ BRIDGE_OUTBOX_ENABLED: 'false' });
    for (const r of [
      o.enqueue(marcacion()), o.claimBatch(), o.acknowledge(['x']),
      o.releaseForRetry(['x']), o.moveToDeadLetter(['x']),
      o.recoverStaleClaims(), o.stats(),
    ]) {
      expect(r.ok).toBe(false);
      expect(r.error_code).toBe(OUTBOX_ERRORS.NOT_OPEN);
    }
  });

  test('encendida pero sin ruta, no adivina una', () => {
    const o = createOutbox({ BRIDGE_OUTBOX_ENABLED: 'true' });
    expect(o.open().error_code).toBe(OUTBOX_ERRORS.PATH_MISSING);
  });
});

// ── Durabilidad ──────────────────────────────────────────────────────

describe('sobrevive al reinicio del proceso', () => {
  test('lo encolado sigue ahí después de cerrar y reabrir', () => {
    const uno = abierto();
    uno.enqueue(marcacion(1));
    uno.enqueue(marcacion(2));
    uno.close();

    const dos = abierto();
    const s = dos.stats();

    expect(s.by_status[STATUS.PENDING]).toBe(2);
    dos.close();
  });

  test('un ACK dado antes del reinicio no se deshace', () => {
    const uno = abierto();
    const e = marcacion(1);
    uno.enqueue(e);
    const A = uno.claimBatch();
    uno.acknowledge([e.event_id], { claimToken: A.claim_token });
    uno.close();

    const dos = abierto();
    expect(dos.stats().by_status[STATUS.ACKNOWLEDGED]).toBe(1);
    dos.close();
  });

  test('un crash con el lote en vuelo deja las filas rescatables', () => {
    const uno = abierto();
    uno.enqueue(marcacion(1));
    uno.enqueue(marcacion(2));
    uno.claimBatch();          // quedan en `sending`
    uno.close();               // ← "crash": nadie confirmó ni liberó

    const dos = abierto();
    expect(dos.stats().by_status[STATUS.SENDING]).toBe(2);

    // Pasado el TTL vuelven a pending y se pueden reintentar.
    const r = dos.recoverStaleClaims({ now: new Date(Date.now() + 10 * 60 * 1000) });

    expect(r.recovered).toBe(2);
    expect(dos.stats().by_status[STATUS.PENDING]).toBe(2);
    dos.close();
  });

  test('el rescate NO toca un lote reclamado hace un instante', () => {
    const o = abierto();
    o.enqueue(marcacion(1));
    o.claimBatch();

    expect(o.recoverStaleClaims().recovered).toBe(0);   // sigue vivo
    expect(o.stats().by_status[STATUS.SENDING]).toBe(1);
    o.close();
  });
});

// ── Idempotencia ─────────────────────────────────────────────────────

describe('duplicados', () => {
  test('encolar el mismo event_id dos veces guarda una sola fila', () => {
    const o = abierto();
    const e = marcacion(1);

    expect(o.enqueue(e).inserted).toBe(true);
    expect(o.enqueue(e).inserted).toBe(false);

    expect(o.stats().total).toBe(1);
    o.close();
  });

  test('reencolar no revive una marcación ya confirmada', () => {
    const o = abierto();
    const e = marcacion(1);
    o.enqueue(e);
    const A = o.claimBatch();
    o.acknowledge([e.event_id], { claimToken: A.claim_token });

    o.enqueue(e);   // el reloj reenvía el mismo lote

    expect(o.stats().by_status[STATUS.ACKNOWLEDGED]).toBe(1);
    expect(o.stats().by_status[STATUS.PENDING]).toBe(0);
    o.close();
  });

  test('el ACK repetido no falla ni cambia nada', () => {
    const o = abierto();
    const e = marcacion(1);
    const A0 = (o.enqueue(e), o.claimBatch());

    expect(o.acknowledge([e.event_id], { claimToken: A0.claim_token }).acknowledged).toBe(1);
    expect(o.acknowledge([e.event_id], { claimToken: A0.claim_token }).acknowledged).toBe(0);   // ya estaba
    expect(o.stats().by_status[STATUS.ACKNOWLEDGED]).toBe(1);
    o.close();
  });

  test('confirmar un event_id inexistente no rompe', () => {
    const o = abierto();
    expect(o.acknowledge(['sha256:no-existe'], { claimToken: 'cualquiera' }).acknowledged).toBe(0);
    o.close();
  });
});

// ── Exclusión entre consumidores ─────────────────────────────────────

describe('dos consumidores no se llevan la misma fila', () => {
  test('el segundo claim no ve lo que reclamó el primero', () => {
    const o = abierto();
    for (let i = 1; i <= 6; i++) o.enqueue(marcacion(i));

    const a = o.claimBatch({ limit: 4 });
    const b = o.claimBatch({ limit: 4 });

    expect(a.events).toHaveLength(4);
    expect(b.events).toHaveLength(2);            // sólo lo que quedaba

    const ids = [...a.events, ...b.events].map(e => e.event_id);
    expect(new Set(ids).size).toBe(6);           // ← ninguna repetida
    o.close();
  });

  test('dos conexiones al MISMO archivo tampoco se pisan', () => {
    // Es el caso real: dos procesos, no dos objetos en el mismo proceso.
    const uno = abierto();
    for (let i = 1; i <= 5; i++) uno.enqueue(marcacion(i));

    const dos = new Outbox(readConfig(envOn()));
    expect(dos.open().ok).toBe(true);

    const a = uno.claimBatch({ limit: 3 });
    const b = dos.claimBatch({ limit: 3 });

    const ids = [...a.events, ...b.events].map(e => e.event_id);
    expect(new Set(ids).size).toBe(ids.length);  // sin solapamiento
    expect(ids).toHaveLength(5);

    uno.close(); dos.close();
  });

  test('lo reclamado no vuelve a aparecer hasta liberarse', () => {
    const o = abierto();
    o.enqueue(marcacion(1));
    o.claimBatch();

    expect(o.claimBatch().events).toHaveLength(0);
    o.close();
  });
});

// ── Reintentos y dead letter ─────────────────────────────────────────

describe('reintentos', () => {
  test('liberar devuelve a pending con backoff', () => {
    const o = abierto();
    const e = marcacion(1);
    const A1 = (o.enqueue(e), o.claimBatch());

    const r = o.releaseForRetry([e.event_id], { errorCode: 'http_503', backoffMs: 60000, claimToken: A1.claim_token });

    expect(r.released).toBe(1);
    expect(o.stats().by_status[STATUS.PENDING]).toBe(1);
    // Todavía no es transmisible: el backoff no venció.
    expect(o.claimBatch().events).toHaveLength(0);
    // Pasado el backoff, sí.
    expect(o.claimBatch({ now: new Date(Date.now() + 120000) }).events).toHaveLength(1);
    o.close();
  });

  test('al agotar los intentos va a dead_letter, no a un bucle infinito', () => {
    const o = abierto({ BRIDGE_OUTBOX_MAX_ATTEMPTS: '3' });
    const e = marcacion(1);
    o.enqueue(e);

    let futuro = Date.now();
    for (let i = 0; i < 3; i++) {
      futuro += 120000;
      const c = o.claimBatch({ now: new Date(futuro) });
      o.releaseForRetry([e.event_id], { errorCode: 'http_500', backoffMs: 1000, now: new Date(futuro), claimToken: c.claim_token });
    }

    expect(o.stats().by_status[STATUS.DEAD_LETTER]).toBe(1);
    expect(o.stats().by_status[STATUS.PENDING]).toBe(0);
    o.close();
  });

  test('una fila en dead_letter no se vuelve a reclamar', () => {
    const o = abierto();
    const e = marcacion(1);
    o.enqueue(e); o.claimBatch();
    o.moveToDeadLetter([e.event_id], { errorCode: 'contrato_roto' });

    expect(o.claimBatch({ now: new Date(Date.now() + 3600000) }).events).toHaveLength(0);
    o.close();
  });

  test('no se puede descartar algo ya confirmado', () => {
    const o = abierto();
    const e = marcacion(1);
    const A2 = (o.enqueue(e), o.claimBatch());
    o.acknowledge([e.event_id], { claimToken: A2.claim_token });

    expect(o.moveToDeadLetter([e.event_id]).dead_lettered).toBe(0);
    expect(o.stats().by_status[STATUS.ACKNOWLEDGED]).toBe(1);
    o.close();
  });

  test('liberar algo que no está en vuelo no hace nada', () => {
    const o = abierto();
    const e = marcacion(1);
    o.enqueue(e);   // pending, nunca reclamada

    expect(o.releaseForRetry([e.event_id], { claimToken: 'cualquiera' }).released).toBe(0);
    o.close();
  });
});

// ── Contrato y datos sensibles ───────────────────────────────────────

describe('el contrato v1 valida antes de tocar el disco', () => {
  test('una marcación que no pasa el contrato no se guarda', () => {
    const o = abierto();
    const roto = { ...marcacion(1), event_id: 'sha256:inventado' };

    const r = o.enqueue(roto);

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(OUTBOX_ERRORS.CONTRACT_INVALID);
    expect(o.stats().total).toBe(0);        // nada llegó al disco
    o.close();
  });

  test.each([
    ['sin event_id',      (e) => { delete e.event_id; return e; }],
    ['device_id inválido', (e) => ({ ...e, device_id: -1 })],
    ['event_type raro',    (e) => ({ ...e, event_type: 'almuerzo' })],
    ['timestamp inválido', (e) => ({ ...e, occurred_at: 'ayer' })],
  ])('rechaza: %s', (_n, romper) => {
    const o = abierto();
    expect(o.enqueue(romper({ ...marcacion(1) })).ok).toBe(false);
    expect(o.stats().total).toBe(0);
    o.close();
  });
});

describe('no se guarda nada sensible', () => {
  test('selfies, biometría, credenciales e IP se descartan', () => {
    const sucio = {
      ...marcacion(1),
      selfie: 'data:image/jpeg;base64,AAAA',
      face_template: 'BBBB',
      fingerprint: 'CCCC',
      comm_password: 'secreto',
      api_key: 'clave',
      ip: '10.0.0.11',
      device_ip: '10.0.0.11',
    };

    const limpio = sanitizePayload(sucio);

    for (const k of ['selfie', 'face_template', 'fingerprint', 'comm_password', 'api_key', 'ip', 'device_ip']) {
      expect(limpio[k]).toBeUndefined();
    }
    expect(limpio.event_id).toBe(sucio.event_id);   // la identidad se conserva
  });

  test('sólo sobreviven los campos del contrato, nada más', () => {
    // La lista blanca es la garantía: una lista negra sólo detiene lo que
    // alguien pensó en nombrar.
    const limpio = sanitizePayload({ ...marcacion(1), cualquier_cosa_nueva: 'x' });
    expect(Object.keys(limpio).every(k => CAMPOS_PERMITIDOS.includes(k))).toBe(true);
  });

  test('un campo sensible con nombre NO previsto tampoco pasa', () => {
    // `auth_token` no estaba en la vieja lista de prohibidos, y `validateEvent`
    // ignora las propiedades desconocidas: el evento era válido y el token
    // terminaba en el SQLite sin cifrar.
    const limpio = sanitizePayload({
      ...marcacion(1),
      auth_token: 'MARCA-TOKEN',
      credencial_rara: 'MARCA-RARA',
    });

    expect(limpio.auth_token).toBeUndefined();
    expect(limpio.credencial_rara).toBeUndefined();
  });

  test('un objeto anidado con secretos no pasa entero', () => {
    // Una comprobación de primer nivel no ve `metadata.token`.
    const limpio = sanitizePayload({ ...marcacion(1), metadata: { token: 'MARCA-ANIDADA' } });

    expect(limpio.metadata).toBeUndefined();
    expect(JSON.stringify(limpio)).not.toContain('MARCA-ANIDADA');
  });

  test('lo guardado en disco tampoco los tiene', () => {
    const o = abierto();
    o.enqueue({ ...marcacion(1), selfie: 'AAAA', ip: '10.0.0.11' });

    const guardado = JSON.stringify(o.claimBatch().events);

    expect(guardado).not.toContain('AAAA');
    expect(guardado).not.toContain('10.0.0.11');
    o.close();
  });

  test('el archivo en bruto tampoco los contiene', () => {
    const o = abierto();
    o.enqueue({
      ...marcacion(1),
      selfie: 'MARCA-SELFIE', comm_password: 'MARCA-CLAVE',
      auth_token: 'MARCA-TOKEN', metadata: { token: 'MARCA-ANIDADA' },
    });
    o.close();

    const bytes = fs.readFileSync(path.join(dir, 'outbox.db')).toString('latin1');

    for (const marca of ['MARCA-SELFIE', 'MARCA-CLAVE', 'MARCA-TOKEN', 'MARCA-ANIDADA']) {
      expect(bytes).not.toContain(marca);
    }
  });
});

// ── Fallos de entorno ────────────────────────────────────────────────

describe('fallos de entorno no tumban el Bridge', () => {
  test('base corrupta: devuelve error, no lanza', () => {
    const ruta = path.join(dir, 'corrupta.db');
    fs.writeFileSync(ruta, 'esto no es una base SQLite');

    const o = createOutbox(envOn({ BRIDGE_OUTBOX_PATH: ruta }));
    const r = o.open();

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(OUTBOX_ERRORS.OPEN_FAILED);
    expect(o.isOpen).toBe(false);
  });

  test('directorio sin permisos: devuelve error, no lanza', () => {
    const sinPermiso = path.join(dir, 'bloqueado');
    fs.mkdirSync(sinPermiso);
    fs.chmodSync(sinPermiso, 0o400);

    const o = createOutbox(envOn({ BRIDGE_OUTBOX_PATH: path.join(sinPermiso, 'sub', 'outbox.db') }));
    const r = o.open();

    // root ignora los permisos de archivo: si el proceso pudo crear igual, el
    // caso no aplica y lo que importa es que no haya lanzado.
    if (!r.ok) expect(r.error_code).toBe(OUTBOX_ERRORS.OPEN_FAILED);
    expect(() => o.close()).not.toThrow();

    fs.chmodSync(sinPermiso, 0o700);
  });

  test('abrir dos veces es idempotente', () => {
    const o = abierto();
    expect(o.open().ok).toBe(true);
    expect(o.isOpen).toBe(true);
    o.close();
  });

  test('cerrar dos veces no lanza', () => {
    const o = abierto();
    o.close();
    expect(() => o.close()).not.toThrow();
  });
});

// ── Configuración ────────────────────────────────────────────────────

describe('configuración', () => {
  test('los valores por defecto se usan si la variable está vacía o es basura', () => {
    const c = readConfig({ BRIDGE_OUTBOX_CLAIM_TTL_MS: 'abc', BRIDGE_OUTBOX_MAX_ATTEMPTS: '' });
    expect(c.claimTtlMs).toBeGreaterThan(0);
    expect(c.maxAttempts).toBeGreaterThan(0);
  });

  test('un TTL o maxAttempts negativo no se acepta', () => {
    const c = readConfig({ BRIDGE_OUTBOX_CLAIM_TTL_MS: '-5', BRIDGE_OUTBOX_MAX_ATTEMPTS: '0' });
    expect(c.claimTtlMs).toBeGreaterThan(0);
    expect(c.maxAttempts).toBeGreaterThan(0);
  });
});

describe('stats', () => {
  test('cuenta por estado y da la marcación sin transmitir más vieja', () => {
    const o = abierto();
    o.enqueue(marcacion(1), { now: new Date('2026-03-11T08:00:00Z') });
    o.enqueue(marcacion(2), { now: new Date('2026-03-11T09:00:00Z') });
    const e3 = marcacion(3);
    o.enqueue(e3);
    const A3 = o.claimBatch({ limit: 1 });
    o.acknowledge([marcacion(1).event_id], { claimToken: A3.claim_token });

    const s = o.stats();

    expect(s.total).toBe(3);
    expect(s.by_status[STATUS.ACKNOWLEDGED]).toBe(1);
    expect(s.oldest_unsent_at).toBeTruthy();
    o.close();
  });

  test('no expone ninguna marcación ni dato personal', () => {
    const o = abierto();
    o.enqueue(marcacion(1));

    const serializado = JSON.stringify(o.stats());

    expect(serializado).not.toContain('1001');       // device_user_id
    expect(serializado).not.toContain('sha256:');    // event_id
    o.close();
  });
});

describe('el reclamo viejo no pisa al nuevo (token de reclamo)', () => {
  /**
   * La carrera: el consumidor A reclama, se cuelga, `recoverStaleClaims`
   * devuelve la fila a pending, el consumidor B la reclama — y recién ahí A
   * revive y llama a `releaseForRetry`. Sin token, A devolvería a pending un
   * lote que B tiene en vuelo y sano, o le sumaría un intento hacia
   * dead_letter. Serializar la transacción no arregla esto: es una carrera
   * semántica, no de concurrencia de escritura.
   */
  test('releaseForRetry del consumidor viejo no toca el reclamo nuevo', () => {
    const o = abierto();
    const e = marcacion(1);
    o.enqueue(e);

    const A = o.claimBatch();                       // consumidor A reclama
    expect(A.claim_token).toBeTruthy();

    // A se cuelga; pasa el TTL y la fila se rescata.
    o.recoverStaleClaims({ now: new Date(Date.now() + 10 * 60 * 1000) });
    const B = o.claimBatch();                       // consumidor B la reclama
    expect(B.events).toHaveLength(1);
    expect(B.claim_token).not.toBe(A.claim_token);

    // A revive y quiere liberar SU reclamo.
    const r = o.releaseForRetry([e.event_id], { claimToken: A.claim_token });

    expect(r.released).toBe(0);                     // no hizo nada
    expect(r.dead_lettered).toBe(0);
    expect(o.stats().by_status[STATUS.SENDING]).toBe(1);   // B sigue en vuelo
    o.close();
  });

  test('el ACK del consumidor viejo tampoco confirma el reclamo nuevo', () => {
    const o = abierto();
    const e = marcacion(1);
    o.enqueue(e);

    const A = o.claimBatch();
    o.recoverStaleClaims({ now: new Date(Date.now() + 10 * 60 * 1000) });
    o.claimBatch();                                  // B reclama

    const r = o.acknowledge([e.event_id], { claimToken: A.claim_token });

    expect(r.acknowledged).toBe(0);
    expect(o.stats().by_status[STATUS.ACKNOWLEDGED]).toBe(0);
    o.close();
  });

  test('con su propio token, el consumidor sí confirma', () => {
    const o = abierto();
    const e = marcacion(1);
    o.enqueue(e);
    const A = o.claimBatch();

    expect(o.acknowledge([e.event_id], { claimToken: A.claim_token }).acknowledged).toBe(1);
    o.close();
  });

  test('cada reclamo recibe un token distinto', () => {
    const o = abierto();
    o.enqueue(marcacion(1)); o.enqueue(marcacion(2));

    const a = o.claimBatch({ limit: 1 });
    const b = o.claimBatch({ limit: 1 });

    expect(a.claim_token).not.toBe(b.claim_token);
    o.close();
  });

  test('el token se limpia al confirmar y al rescatar', () => {
    const o = abierto();
    const e = marcacion(1);
    o.enqueue(e);
    const A = o.claimBatch();
    o.acknowledge([e.event_id], { claimToken: A.claim_token });

    // Reconfirmar con el mismo token ya no encuentra nada que cambiar.
    expect(o.acknowledge([e.event_id], { claimToken: A.claim_token }).acknowledged).toBe(0);
    o.close();
  });
});

describe('SQLITE_BUSY se devuelve como resultado, no se lanza', () => {
  test('el contrato "ninguna operación lanza" se cumple también con la base ocupada', () => {
    const o = abierto();
    o.enqueue(marcacion(1));

    // Se simula el lock sostenido: `db.transaction` devuelve un objeto cuyo
    // `.immediate` lanza el error que better-sqlite3 propaga ante un timeout
    // de lock. (No se puede sobreescribir `.immediate` del objeto real: es de
    // sólo lectura y la asignación falla en silencio.)
    const real = o.db.transaction.bind(o.db);
    o.db.transaction = () => {
      const t = () => { throw new Error('no debería llamarse'); };
      t.immediate = () => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); };
      return t;
    };

    let r;
    expect(() => { r = o.claimBatch(); }).not.toThrow();
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(OUTBOX_ERRORS.BUSY);

    o.db.transaction = real;
    o.close();
  });
});

describe('el token de reclamo es obligatorio, no opcional', () => {
  /**
   * La primera corrección lo dejó opcional razonando que "un ACK es
   * idempotente y confirmar de más no pierde datos". Pero ese camino sin token
   * conserva ÍNTEGRA la carrera que el token vino a cerrar: un consumidor
   * rescatado tras el TTL confirmaría —o peor, devolvería a pending— el
   * reclamo de otro. Como todavía no hay consumidores conectados, no hay
   * compatibilidad que preservar.
   */
  test('acknowledge sin token se rechaza', () => {
    const o = abierto();
    const e = marcacion(1);
    o.enqueue(e); o.claimBatch();

    const r = o.acknowledge([e.event_id]);

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(OUTBOX_ERRORS.CLAIM_TOKEN_REQUIRED);
    expect(o.stats().by_status[STATUS.ACKNOWLEDGED]).toBe(0);   // no cambió nada
    o.close();
  });

  test('releaseForRetry sin token se rechaza', () => {
    const o = abierto();
    const e = marcacion(1);
    o.enqueue(e); o.claimBatch();

    const r = o.releaseForRetry([e.event_id]);

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(OUTBOX_ERRORS.CLAIM_TOKEN_REQUIRED);
    expect(o.stats().by_status[STATUS.SENDING]).toBe(1);        // sigue en vuelo
    o.close();
  });

  test('no queda ninguna rama que omita la condición del token', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'outbox.js'), 'utf8');

    // El patrón `claimToken ? ... : ...` era justamente el fallback inseguro.
    expect(src).not.toMatch(/claimToken \?/);
  });
});

describe('SQLITE_BUSY también se traduce al encolar', () => {
  test('enqueue devuelve outbox_busy en vez de lanzar', () => {
    // enqueue es la ruta de INGESTA: si el error escapara, la contención
    // abortaría el ciclo que recibe la marcación del reloj, que es justo lo
    // que el Outbox existe para evitar.
    const o = abierto();
    const real = o.db.prepare.bind(o.db);
    o.db.prepare = (sql) => {
      if (/INSERT INTO outbox_events/.test(sql)) {
        return { run: () => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); } };
      }
      return real(sql);
    };

    let r;
    expect(() => { r = o.enqueue(marcacion(1)); }).not.toThrow();
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(OUTBOX_ERRORS.BUSY);

    o.db.prepare = real;
    o.close();
  });

  test('ninguna operación pública lanza, con la base ocupada', () => {
    const o = abierto();
    o.enqueue(marcacion(1));

    const real = o.db.prepare.bind(o.db);
    const realTx = o.db.transaction.bind(o.db);
    const romper = () => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); };
    o.db.prepare = () => ({ run: romper, get: romper, all: romper });
    o.db.transaction = () => { const t = romper; t.immediate = romper; return t; };

    for (const llamada of [
      () => o.enqueue(marcacion(2)),
      () => o.claimBatch(),
      () => o.acknowledge(['x'], { claimToken: 't' }),
      () => o.releaseForRetry(['x'], { claimToken: 't' }),
    ]) {
      expect(llamada).not.toThrow();
    }

    o.db.prepare = real; o.db.transaction = realTx;
    o.close();
  });
});
