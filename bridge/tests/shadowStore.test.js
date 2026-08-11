/**
 * Almacén del modo sombra.
 *
 * Lo que se prueba no es que los métodos devuelvan objetos, sino las
 * propiedades de las que depende que la sombra sirva para algo: que un evento
 * sobreviva al reinicio, que reobservar lo mismo no duplique, que PUSH y
 * polling puedan coexistir para el MISMO marcaje —que es todo el punto de la
 * comparación— y que nada se borre solo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createShadowStore, ShadowStore, readStoreConfig,
  sanitizeShadowPayload, deviceIdFromKey, normalizeBefore,
  SHADOW_ERRORS, CAMPOS_PERSISTIDOS,
} = require('../src/shadowStore');
const { buildEvent } = require('../../contracts/punchContractV1');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sishoras-shadow-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

const RELOJ = 'sn:GER-0001';

function envOn(extra = {}) {
  return {
    BRIDGE_SHADOW_ENABLED: 'true',
    BRIDGE_SHADOW_PATH: path.join(dir, 'shadow.db'),
    ...extra,
  };
}

function abierto(extra = {}) {
  const s = createShadowStore(envOn(extra));
  const r = s.open();
  if (!r.ok) throw new Error('no abrió: ' + r.error_code + ' ' + (r.detail || ''));
  return s;
}

/** Observación canónica. Datos ficticios. */
function observacion({ i = 0, deviceKey = RELOJ, verify = 1, work = null } = {}) {
  const r = buildEvent({
    device_id: deviceIdFromKey(deviceKey),
    device_user_id: String(1000 + i),
    occurred_at: `2026-03-11T08:${String(i % 60).padStart(2, '0')}:00-03:00`,
    event_type: 'in',
    verify_mode: verify,
    work_code: work,
  });
  if (!r.ok) throw new Error('fixture inválido: ' + r.error_code);
  return r.event;
}

// ── Flag apagada ─────────────────────────────────────────────────────

describe('con la flag apagada no existe', () => {
  test('no crea el archivo ni abre SQLite', () => {
    const ruta = path.join(dir, 'shadow.db');
    const s = createShadowStore({ BRIDGE_SHADOW_ENABLED: 'false', BRIDGE_SHADOW_PATH: ruta });

    const r = s.open();

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(SHADOW_ERRORS.DISABLED);
    expect(s.isOpen).toBe(false);
    expect(fs.existsSync(ruta)).toBe(false);
  });

  test('sin ruta no se adivina ninguna', () => {
    const s = createShadowStore({ BRIDGE_SHADOW_ENABLED: 'true' });
    expect(s.open().error_code).toBe(SHADOW_ERRORS.PATH_MISSING);
    expect(s.isOpen).toBe(false);
  });

  test('operar sobre un almacén cerrado responde error, no lanza', () => {
    const s = createShadowStore({ BRIDGE_SHADOW_ENABLED: 'false' });
    expect(() => s.record(observacion(), { deviceKey: RELOJ })).not.toThrow();
    expect(s.record(observacion(), { deviceKey: RELOJ }).error_code).toBe(SHADOW_ERRORS.NOT_OPEN);
    expect(s.stats().error_code).toBe(SHADOW_ERRORS.NOT_OPEN);
    expect(s.compare().error_code).toBe(SHADOW_ERRORS.NOT_OPEN);
    expect(s.purge().error_code).toBe(SHADOW_ERRORS.NOT_OPEN);
  });

  test('la flag exige el valor exacto "true"', () => {
    for (const v of ['1', 'yes', 'TRUE', 'on', '']) {
      expect(readStoreConfig({ BRIDGE_SHADOW_ENABLED: v }).enabled).toBe(false);
    }
    expect(readStoreConfig({ BRIDGE_SHADOW_ENABLED: 'true' }).enabled).toBe(true);
  });
});

// ── Independencia del Outbox ─────────────────────────────────────────

describe('la sombra no es el Outbox', () => {
  test('se abre con el Outbox apagado', () => {
    const s = createShadowStore({ ...envOn(), BRIDGE_OUTBOX_ENABLED: 'false' });
    expect(s.open().ok).toBe(true);
    s.close();
  });

  test('encender la sombra no crea el archivo del Outbox', () => {
    const rutaOutbox = path.join(dir, 'outbox.db');
    const s = createShadowStore({
      ...envOn(),
      BRIDGE_OUTBOX_ENABLED: 'false',
      BRIDGE_OUTBOX_PATH: rutaOutbox,
    });
    s.open();
    s.record(observacion(), { deviceKey: RELOJ });

    expect(fs.existsSync(rutaOutbox)).toBe(false);
    s.close();
  });

  test('no escribe en la tabla del Outbox', () => {
    const s = abierto();
    s.record(observacion(), { deviceKey: RELOJ });
    const tablas = s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);

    expect(tablas).toContain('shadow_events');
    expect(tablas).not.toContain('outbox_events');
    s.close();
  });
});

// ── Persistencia ─────────────────────────────────────────────────────

describe('lo observado sobrevive', () => {
  test('un evento guardado sigue estando tras cerrar y reabrir', () => {
    const s1 = abierto();
    s1.record(observacion({ i: 1 }), { deviceKey: RELOJ });
    s1.record(observacion({ i: 2 }), { deviceKey: RELOJ });
    s1.close();

    const s2 = abierto();
    expect(s2.stats().stored).toBe(2);
    s2.close();
  });

  test('sobrevive a un cierre abrupto: otro proceso lee lo ya escrito', () => {
    // Sin close(): se abandona la conexión como la abandonaría un kill -9.
    const s1 = abierto();
    s1.record(observacion({ i: 3 }), { deviceKey: RELOJ });

    const s2 = abierto();
    expect(s2.stats().stored).toBe(1);
    s1.close();
    s2.close();
  });

  test('el reinicio no reinicia el conteo almacenado', () => {
    const s1 = abierto();
    for (let i = 0; i < 5; i++) s1.record(observacion({ i }), { deviceKey: RELOJ });
    const antes = s1.stats();
    s1.close();

    const s2 = abierto();
    const despues = s2.stats();

    expect(despues.stored).toBe(antes.stored);
    expect(despues.first_event_at).toBe(antes.first_event_at);
    expect(despues.last_event_at).toBe(antes.last_event_at);
    s2.close();
  });
});

// ── Idempotencia ─────────────────────────────────────────────────────

describe('el mismo evento repetido', () => {
  test('no duplica la fila y se informa como duplicado', () => {
    const s = abierto();
    const e = observacion({ i: 4 });

    const a = s.record(e, { deviceKey: RELOJ });
    const b = s.record(e, { deviceKey: RELOJ });

    expect(a.inserted).toBe(true);
    expect(b.ok).toBe(true);
    expect(b.inserted).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(s.stats().stored).toBe(1);
    s.close();
  });

  test('un duplicado no pisa la fila original', () => {
    const s = abierto();
    const e = observacion({ i: 5 });
    s.record(e, { deviceKey: RELOJ, now: new Date('2026-03-11T11:00:00Z') });
    s.record(e, { deviceKey: RELOJ, now: new Date('2026-03-11T12:00:00Z') });

    const fila = s.db.prepare('SELECT observed_at FROM shadow_events').get();
    expect(fila.observed_at).toBe('2026-03-11T11:00:00.000Z');
    s.close();
  });

  test('el mismo marcaje visto por PUSH y por polling SÍ entra dos veces', () => {
    // Es la razón de que el UNIQUE sea (source, event_id) y no (event_id):
    // con la unicidad global no habría nada que comparar.
    const s = abierto();
    const e = observacion({ i: 6 });

    expect(s.record(e, { source: 'push', deviceKey: RELOJ }).inserted).toBe(true);
    expect(s.record(e, { source: 'polling', deviceKey: RELOJ }).inserted).toBe(true);
    expect(s.stats().stored).toBe(2);
    expect(s.stats().by_source).toEqual({ push: 1, polling: 1 });
    s.close();
  });

  test('un origen desconocido se rechaza', () => {
    const s = abierto();
    const r = s.record(observacion(), { source: 'att2000', deviceKey: RELOJ });
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(SHADOW_ERRORS.SOURCE_INVALID);
    s.close();
  });
});

// ── Contrato ─────────────────────────────────────────────────────────

describe('lo que no pasa el contrato no se guarda', () => {
  test('un evento sin event_id se rechaza', () => {
    const s = abierto();
    const { event_id, ...sinId } = observacion();
    const r = s.record(sinId, { deviceKey: RELOJ });

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(SHADOW_ERRORS.CONTRACT_INVALID);
    expect(s.stats().stored).toBe(0);
    s.close();
  });

  test('un event_id que no corresponde al contenido se rechaza', () => {
    const s = abierto();
    const e = { ...observacion(), device_user_id: '9999' };   // id ya no coincide
    const r = s.record(e, { deviceKey: RELOJ });

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(SHADOW_ERRORS.CONTRACT_INVALID);
    s.close();
  });

  test('sin device_key no se guarda: no habría con qué correlacionar', () => {
    const s = abierto();
    const r = s.record(observacion(), { deviceKey: null });
    expect(r.error_code).toBe(SHADOW_ERRORS.DEVICE_KEY_MISSING);
    s.close();
  });
});

// ── Qué se persiste ──────────────────────────────────────────────────

describe('el payload guardado es una lista cerrada', () => {
  test('sólo entran los campos del contrato', () => {
    expect([...CAMPOS_PERSISTIDOS].sort()).toEqual([
      'device_id', 'device_user_id', 'event_id', 'event_type',
      'occurred_at', 'verify_mode', 'work_code',
    ]);
  });

  test('un campo no nombrado se descarta aunque el evento sea válido', () => {
    const sucio = {
      ...observacion(),
      auth_token: 'secreto',
      employee_name: 'Ana Giménez',
      device_ip: '10.0.0.11',
      photo: 'base64…',
      metadata: { token: 'anidado' },
    };

    const limpio = sanitizeShadowPayload(sucio);

    expect(limpio).not.toHaveProperty('auth_token');
    expect(limpio).not.toHaveProperty('employee_name');
    expect(limpio).not.toHaveProperty('device_ip');
    expect(limpio).not.toHaveProperty('photo');
    expect(limpio).not.toHaveProperty('metadata');
    expect(limpio.event_id).toBe(sucio.event_id);
  });

  test('nada de eso llega al disco', () => {
    const s = abierto();
    s.record({ ...observacion(), auth_token: 'secreto', employee_name: 'Ana Giménez' }, { deviceKey: RELOJ });

    const guardado = s.db.prepare('SELECT payload FROM shadow_events').get().payload;

    expect(guardado).not.toContain('secreto');
    expect(guardado).not.toContain('Ana');
    s.close();
  });

  test('la IP del reloj no se guarda en ninguna columna', () => {
    const s = abierto();
    s.record(observacion(), { deviceKey: RELOJ });
    const fila = s.db.prepare('SELECT * FROM shadow_events').get();

    expect(JSON.stringify(fila)).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    s.close();
  });
});

// ── Identidad del reloj ──────────────────────────────────────────────

describe('device_id derivado de la identidad estable', () => {
  test('el mismo reloj da siempre el mismo entero', () => {
    expect(deviceIdFromKey('sn:GER-0001')).toBe(deviceIdFromKey('sn:GER-0001'));
  });

  test('relojes distintos dan enteros distintos', () => {
    expect(deviceIdFromKey('sn:GER-0001')).not.toBe(deviceIdFromKey('sn:COM-0002'));
  });

  test('siempre es un entero positivo, como exige el contrato', () => {
    for (const k of ['sn:A', 'sn:B', 'addr:10.0.0.11:4370', 'sn:0']) {
      const id = deviceIdFromKey(k);
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    }
  });

  test('SQLite lo guarda como entero, no como float', () => {
    const s = abierto();
    s.record(observacion(), { deviceKey: RELOJ });
    const t = s.db.prepare('SELECT typeof(device_id) AS t FROM shadow_events').get().t;
    expect(t).toBe('integer');
    s.close();
  });
});

// ── Comparación ──────────────────────────────────────────────────────

describe('comparación PUSH ↔ polling', () => {
  test('sin polling escrito, lo dice explícitamente', () => {
    const s = abierto();
    s.record(observacion({ i: 1 }), { source: 'push', deviceKey: RELOJ });
    s.record(observacion({ i: 2 }), { source: 'push', deviceKey: RELOJ });

    const c = s.compare();

    expect(c.polling_connected).toBe(false);
    expect(c.totals.push).toBe(2);
    expect(c.totals.polling).toBe(0);
    expect(c.totals.only_push).toBe(2);
    s.close();
  });

  test('el mismo marcaje por los dos caminos cuenta como común', () => {
    const s = abierto();
    const e = observacion({ i: 7 });
    s.record(e, { source: 'push', deviceKey: RELOJ });
    s.record(e, { source: 'polling', deviceKey: RELOJ });

    const c = s.compare();

    expect(c.totals.common).toBe(1);
    expect(c.totals.only_push).toBe(0);
    expect(c.totals.only_polling).toBe(0);
    expect(c.polling_connected).toBe(true);
    s.close();
  });

  test('verify_mode distinto NO cambia la identidad: es una diferencia, no otro evento', () => {
    const s = abierto();
    s.record(observacion({ i: 8, verify: 1 }), { source: 'push', deviceKey: RELOJ });
    s.record(observacion({ i: 8, verify: 15 }), { source: 'polling', deviceKey: RELOJ });

    const c = s.compare();

    expect(c.totals.common).toBe(1);
    expect(c.totals.verify_mode_differs).toBe(1);
    s.close();
  });

  test('work_code distinto se reporta aparte', () => {
    const s = abierto();
    s.record(observacion({ i: 9, work: '10' }), { source: 'push', deviceKey: RELOJ });
    s.record(observacion({ i: 9, work: '20' }), { source: 'polling', deviceKey: RELOJ });

    const c = s.compare();

    expect(c.totals.common).toBe(1);
    expect(c.totals.work_code_differs).toBe(1);
    expect(c.totals.verify_mode_differs).toBe(0);
    s.close();
  });

  test('sólo polling se cuenta como sólo polling', () => {
    const s = abierto();
    s.record(observacion({ i: 10 }), { source: 'polling', deviceKey: RELOJ });

    expect(s.compare().totals.only_polling).toBe(1);
    s.close();
  });

  test('la ventana filtra por occurred_at', () => {
    const s = abierto();
    s.record(observacion({ i: 1 }), { source: 'push', deviceKey: RELOJ });   // 08:01
    s.record(observacion({ i: 40 }), { source: 'push', deviceKey: RELOJ });  // 08:40

    const c = s.compare({ from: '2026-03-11T11:30:00Z', to: '2026-03-11T11:59:59Z' });

    expect(c.totals.push).toBe(1);
    s.close();
  });

  test('se puede acotar a un reloj', () => {
    const s = abierto();
    s.record(observacion({ i: 1, deviceKey: 'sn:GER-0001' }), { source: 'push', deviceKey: 'sn:GER-0001' });
    s.record(observacion({ i: 2, deviceKey: 'sn:COM-0002' }), { source: 'push', deviceKey: 'sn:COM-0002' });

    expect(s.compare({ deviceKey: 'sn:GER-0001' }).totals.push).toBe(1);
    expect(s.compare().totals.push).toBe(2);
    s.close();
  });

  test('la comparación no devuelve marcaciones, sólo conteos', () => {
    const s = abierto();
    s.record(observacion({ i: 11 }), { source: 'push', deviceKey: RELOJ });

    const c = s.compare();

    // 1011 es el device_user_id del fixture: no puede aparecer en el informe.
    expect(JSON.stringify(c)).not.toContain('1011');
    expect(c).not.toHaveProperty('events');
    s.close();
  });

  test('es de sólo lectura: comparar no borra ni agrega', () => {
    const s = abierto();
    s.record(observacion({ i: 12 }), { source: 'push', deviceKey: RELOJ });
    s.compare();
    expect(s.stats().stored).toBe(1);
    s.close();
  });
});

// ── Retención ────────────────────────────────────────────────────────

describe('no se borra solo', () => {
  test('escribir muchos eventos no dispara ninguna limpieza', () => {
    const s = abierto();
    for (let i = 0; i < 50; i++) s.record(observacion({ i }), { deviceKey: RELOJ });
    expect(s.stats().stored).toBe(50);
    s.close();
  });

  test('reabrir no purga nada', () => {
    const s1 = abierto();
    for (let i = 0; i < 10; i++) s1.record(observacion({ i }), { deviceKey: RELOJ });
    s1.close();

    const s2 = abierto();
    expect(s2.stats().stored).toBe(10);
    s2.close();
  });

  test('purge explícito vacía', () => {
    const s = abierto();
    for (let i = 0; i < 3; i++) s.record(observacion({ i }), { deviceKey: RELOJ });

    const r = s.purge();

    expect(r.deleted).toBe(3);
    expect(s.stats().stored).toBe(0);
    s.close();
  });

  test('un before mal formado NO borra nada', () => {
    // La comparación de SQLite es lexicográfica: 'not-a-date' es mayor que
    // cualquier timestamp ISO ('2' < 'n'), así que sin validación un corte mal
    // tipeado no acotaba el borrado — lo volvía total.
    const s = abierto();
    for (let i = 0; i < 3; i++) s.record(observacion({ i }), { deviceKey: RELOJ });

    const r = s.purge({ before: 'not-a-date' });

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(SHADOW_ERRORS.BEFORE_INVALID);
    expect(s.stats().stored).toBe(3);
    s.close();
  });

  test('una hora de pared sin offset se rechaza: habría que suponer una zona', () => {
    const s = abierto();
    s.record(observacion(), { deviceKey: RELOJ });

    expect(s.purge({ before: '2026-03-11 12:00:00' }).error_code).toBe(SHADOW_ERRORS.BEFORE_INVALID);
    expect(s.stats().stored).toBe(1);
    s.close();
  });

  test('una fecha civil imposible se rechaza', () => {
    const s = abierto();
    s.record(observacion(), { deviceKey: RELOJ });

    expect(s.purge({ before: '2026-02-31T12:00:00Z' }).error_code).toBe(SHADOW_ERRORS.BEFORE_INVALID);
    expect(s.stats().stored).toBe(1);
    s.close();
  });

  test('normalizeBefore acepta sólo ISO con offset explícito', () => {
    expect(normalizeBefore(null)).toEqual({ ok: true, value: null });
    expect(normalizeBefore('')).toEqual({ ok: true, value: null });
    expect(normalizeBefore('2026-03-11T12:00:00Z').ok).toBe(true);
    expect(normalizeBefore('2026-03-11T09:00:00-03:00').ok).toBe(true);

    for (const malo of ['not-a-date', '2026-03-11', '2026-03-11T12:00:00', 'ayer', '99999', '2026-13-01T00:00:00Z']) {
      expect(normalizeBefore(malo).ok).toBe(false);
    }
  });

  test('un offset distinto de Z se normaliza al mismo instante', () => {
    const s = abierto();
    s.record(observacion({ i: 1 }), { deviceKey: RELOJ });    // 11:01Z
    s.record(observacion({ i: 40 }), { deviceKey: RELOJ });   // 11:40Z

    // 08:30-03:00 == 11:30Z
    const r = s.purge({ before: '2026-03-11T08:30:00-03:00' });

    expect(r.deleted).toBe(1);
    s.close();
  });

  test('purge puede acotarse por fecha', () => {
    const s = abierto();
    s.record(observacion({ i: 1 }), { deviceKey: RELOJ });    // 08:01 -03 → 11:01Z
    s.record(observacion({ i: 40 }), { deviceKey: RELOJ });   // 08:40 -03 → 11:40Z

    const r = s.purge({ before: '2026-03-11T11:30:00Z' });

    expect(r.deleted).toBe(1);
    expect(s.stats().stored).toBe(1);
    s.close();
  });

  test('el módulo no expone ningún borrado automático', () => {
    const metodos = Object.getOwnPropertyNames(ShadowStore.prototype);
    expect(metodos).toContain('purge');
    expect(metodos.filter(m => /prune|evict|cleanup|rotate|trim|expire/i.test(m))).toEqual([]);
  });

  test('el fuente no programa temporizadores de limpieza', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '../src/shadowStore.js'), 'utf8');
    expect(fuente).not.toMatch(/setInterval|setTimeout|cron/);
  });
});

// ── Métricas ─────────────────────────────────────────────────────────

describe('stats agregadas', () => {
  test('cuenta por origen y por reloj', () => {
    const s = abierto();
    s.record(observacion({ i: 1, deviceKey: 'sn:GER-0001' }), { source: 'push', deviceKey: 'sn:GER-0001' });
    s.record(observacion({ i: 2, deviceKey: 'sn:GER-0001' }), { source: 'push', deviceKey: 'sn:GER-0001' });
    s.record(observacion({ i: 3, deviceKey: 'sn:COM-0002' }), { source: 'polling', deviceKey: 'sn:COM-0002' });

    const st = s.stats();

    expect(st.stored).toBe(3);
    expect(st.by_source).toEqual({ push: 2, polling: 1 });
    expect(st.by_device).toEqual({ 'sn:GER-0001': 2, 'sn:COM-0002': 1 });
    s.close();
  });

  test('informa la ventana observada', () => {
    const s = abierto();
    s.record(observacion({ i: 5 }), { deviceKey: RELOJ });
    s.record(observacion({ i: 30 }), { deviceKey: RELOJ });

    const st = s.stats();

    expect(st.first_event_at).toBe('2026-03-11T11:05:00Z');
    expect(st.last_event_at).toBe('2026-03-11T11:30:00Z');
    s.close();
  });

  test('sin eventos no es error', () => {
    const s = abierto();
    const st = s.stats();
    expect(st.ok).toBe(true);
    expect(st.stored).toBe(0);
    expect(st.first_event_at).toBeNull();
    s.close();
  });

  test('las stats no contienen datos de persona', () => {
    const s = abierto();
    s.record(observacion({ i: 11 }), { deviceKey: RELOJ });
    expect(JSON.stringify(s.stats())).not.toContain('1011');
    s.close();
  });
});

// ── SQLite ausente ───────────────────────────────────────────────────

describe('SQLite no disponible', () => {
  test('open informa el problema y no lanza', () => {
    const s = new ShadowStore({ enabled: true, dbPath: path.join(dir, 'x.db') });
    const original = require.cache;

    // Se simula un driver que no resuelve reemplazando la ruta del módulo.
    jest.isolateModules(() => {
      jest.doMock('better-sqlite3', () => { throw new Error('MODULE_NOT_FOUND'); });
      const { ShadowStore: SS } = require('../src/shadowStore');
      const s2 = new SS({ enabled: true, dbPath: path.join(dir, 'y.db') });
      const r = s2.open();
      expect(r.ok).toBe(false);
      expect(r.error_code).toBe(SHADOW_ERRORS.OPEN_FAILED);
      expect(s2.isOpen).toBe(false);
    });

    expect(require.cache).toBe(original);
    expect(() => s.close()).not.toThrow();
  });

  test('una ruta imposible se informa como open_failed', () => {
    // Un archivo normal donde debería ir un directorio: mkdir falla con
    // ENOTDIR sin depender de permisos ni de sistemas de archivos especiales.
    const bloqueado = path.join(dir, 'bloqueado');
    fs.writeFileSync(bloqueado, 'no soy un directorio');

    const s = new ShadowStore({ enabled: true, dbPath: path.join(bloqueado, 'shadow.db') });
    const r = s.open();

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(SHADOW_ERRORS.OPEN_FAILED);
    expect(s.isOpen).toBe(false);
  });
});
