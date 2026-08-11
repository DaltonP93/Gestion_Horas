/**
 * Modo sombra — captura, allowlist e identidad del reloj.
 *
 * Las garantías que se prueban acá son las que hacen que encender la sombra
 * sea una decisión reversible y acotada: que apagada no exista, que sólo mire
 * relojes nombrados uno por uno, que su identidad no dependa del orden de una
 * variable de entorno, y que nada de lo que observa termine en un log.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createShadow, Shadow, readShadowConfig, parseAllowlist,
  canonicalSerial, stableDeviceKey, findConfiguredDevice, isDeviceAllowed, SHADOW_SKIP,
} = require('../src/shadow');
const { createShadowStore, deviceIdFromKey, SHADOW_ERRORS } = require('../src/shadowStore');
const { resolveDevices } = require('../src/deviceRegistry');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sishoras-shadow-cap-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

/** Los tres relojes reales, con nombres de la instalación. */
const RELOJES = [
  { id: 1, name: 'Gerencia', ip: '10.0.0.11', port: 4370, serial: 'GER-0001', test: false },
  { id: 2, name: 'Comedor',  ip: '10.0.0.12', port: 4370, serial: 'COM-0002', test: false },
  { id: 3, name: 'Lavadero', ip: '10.0.0.13', port: 4370, serial: 'LAV-0003', test: false },
];

function loggerMudo() {
  const l = { info: [], warn: [], error: [], debug: [] };
  return {
    calls: l,
    info: m => l.info.push(m),
    warn: m => l.warn.push(m),
    error: m => l.error.push(m),
    debug: m => l.debug.push(m),
    todo: () => [...l.info, ...l.warn, ...l.error, ...l.debug].join('\n'),
  };
}

function env(extra = {}) {
  return {
    BRIDGE_SHADOW_ENABLED: 'true',
    BRIDGE_SHADOW_PATH: path.join(dir, 'shadow.db'),
    BRIDGE_SHADOW_DEVICE_ALLOWLIST: 'Gerencia',
    ...extra,
  };
}

function sombra(extra = {}, { devices = RELOJES, logger = loggerMudo() } = {}) {
  const s = createShadow({ env: env(extra), devices, logger });
  s.start();
  return { s, logger };
}

/** Observación PUSH tal como la arma pushServer. */
function obs(extra = {}) {
  return {
    sn: 'GER-0001',
    ip: '10.0.0.11',
    deviceUserId: '1042',
    occurredAtRaw: '2026-03-11 08:15:00',
    eventType: 'in',
    verifyMode: '1',
    workCode: undefined,
    ...extra,
  };
}

// ── Flag apagada: no-op real ─────────────────────────────────────────

describe('con BRIDGE_SHADOW_ENABLED distinto de true', () => {
  test('capture no hace nada y no cuenta nada', () => {
    const s = createShadow({ env: env({ BRIDGE_SHADOW_ENABLED: 'false' }), devices: RELOJES });
    const r = s.capture(obs());

    expect(r.skipped).toBe(true);
    expect(r.error_code).toBe(SHADOW_SKIP.DISABLED);
    expect(s.metrics.events_received).toBe(0);
  });

  test('no se crea el archivo SQLite', () => {
    const ruta = path.join(dir, 'shadow.db');
    const s = createShadow({ env: env({ BRIDGE_SHADOW_ENABLED: 'false', BRIDGE_SHADOW_PATH: ruta }) });
    s.start();
    s.capture(obs());

    expect(fs.existsSync(ruta)).toBe(false);
    expect(s.opened).toBe(false);
  });

  test('start no toca el disco ni informa error', () => {
    const logger = loggerMudo();
    const s = createShadow({ env: env({ BRIDGE_SHADOW_ENABLED: 'false' }), logger });
    const r = s.start();

    expect(r.ok).toBe(false);
    expect(logger.calls.warn).toEqual([]);
  });

  test('la flag exige el valor exacto "true"', () => {
    for (const v of ['1', 'yes', 'TRUE', 'on', undefined, '']) {
      expect(readShadowConfig({ BRIDGE_SHADOW_ENABLED: v }).enabled).toBe(false);
    }
  });

  test('apagada, ni siquiera consulta la allowlist', () => {
    // Una allowlist enorme y un reloj permitido: aun así no pasa nada.
    const s = createShadow({
      env: env({ BRIDGE_SHADOW_ENABLED: 'false', BRIDGE_SHADOW_DEVICE_ALLOWLIST: 'Gerencia,Comedor,Lavadero' }),
      devices: RELOJES,
    });
    s.start();

    expect(s.capture(obs()).skipped).toBe(true);
    expect(s.metrics).toEqual(expect.objectContaining({
      events_received: 0, events_valid: 0, persisted: 0, errors: 0,
    }));
  });
});

// ── BRIDGE_SHADOW_CAPTURE_PUSH ───────────────────────────────────────

describe('captura de PUSH', () => {
  test('por defecto está encendida', () => {
    expect(readShadowConfig({}).capturePush).toBe(true);
  });

  test('en false, el PUSH no se observa aunque la sombra esté encendida', () => {
    const { s } = sombra({ BRIDGE_SHADOW_CAPTURE_PUSH: 'false' });
    const r = s.capture(obs());

    expect(r.skipped).toBe(true);
    expect(r.error_code).toBe(SHADOW_SKIP.PUSH_NOT_CAPTURED);
    expect(s.metrics.events_received).toBe(0);
    s.stop();
  });
});

// ── Allowlist ────────────────────────────────────────────────────────

describe('allowlist', () => {
  test('vacía significa NINGÚN reloj, no todos', () => {
    // Es la asimetría deliberada con ZKTECO_PUSH_WHITELIST, donde vacío = todos.
    expect(parseAllowlist('')).toEqual([]);
    expect(isDeviceAllowed({ sn: 'GER-0001', device: RELOJES[0] }, [])).toBe(false);
  });

  test('con allowlist vacía no se persiste nada', () => {
    const { s } = sombra({ BRIDGE_SHADOW_DEVICE_ALLOWLIST: '' });
    const r = s.capture(obs());

    expect(r.error_code).toBe(SHADOW_SKIP.DEVICE_NOT_ALLOWED);
    expect(s.metrics.skipped_not_allowed).toBe(1);
    expect(s.metrics.persisted).toBe(0);
    s.stop();
  });

  test('Gerencia permitido entra', () => {
    const { s } = sombra({ BRIDGE_SHADOW_DEVICE_ALLOWLIST: 'Gerencia' });
    const r = s.capture(obs());

    expect(r.ok).toBe(true);
    expect(r.inserted).toBe(true);
    expect(s.metrics.persisted).toBe(1);
    s.stop();
  });

  test('un reloj no permitido queda afuera', () => {
    const { s } = sombra({ BRIDGE_SHADOW_DEVICE_ALLOWLIST: 'Gerencia' });
    const r = s.capture(obs({ sn: 'COM-0002', ip: '10.0.0.12' }));

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(SHADOW_SKIP.DEVICE_NOT_ALLOWED);
    expect(s.metrics.skipped_not_allowed).toBe(1);
    expect(s.metrics.persisted).toBe(0);
    s.stop();
  });

  test('sólo Gerencia entra aunque marquen los tres', () => {
    const { s } = sombra({ BRIDGE_SHADOW_DEVICE_ALLOWLIST: 'Gerencia' });
    s.capture(obs({ sn: 'GER-0001', ip: '10.0.0.11', deviceUserId: '1' }));
    s.capture(obs({ sn: 'COM-0002', ip: '10.0.0.12', deviceUserId: '2' }));
    s.capture(obs({ sn: 'LAV-0003', ip: '10.0.0.13', deviceUserId: '3' }));

    expect(s.metrics.events_received).toBe(3);
    expect(s.metrics.persisted).toBe(1);
    expect(s.metrics.skipped_not_allowed).toBe(2);
    expect(s.store.stats().by_device).toEqual({ 'sn:GER-0001': 1 });
    s.stop();
  });

  test('se puede nombrar por serial', () => {
    const { s } = sombra({ BRIDGE_SHADOW_DEVICE_ALLOWLIST: 'GER-0001' });
    expect(s.capture(obs()).ok).toBe(true);
    s.stop();
  });

  test('se puede nombrar por IP', () => {
    const { s } = sombra({ BRIDGE_SHADOW_DEVICE_ALLOWLIST: '10.0.0.11' });
    expect(s.capture(obs()).ok).toBe(true);
    s.stop();
  });

  test('no distingue mayúsculas ni espacios sobrantes', () => {
    const { s } = sombra({ BRIDGE_SHADOW_DEVICE_ALLOWLIST: '  gerencia , comedor ' });
    expect(s.capture(obs()).ok).toBe(true);
    s.stop();
  });

  test('un reloj que hace PUSH sin estar en ZKTECO_DEVICES puede permitirse por serial', () => {
    const { s } = sombra({ BRIDGE_SHADOW_DEVICE_ALLOWLIST: 'DESCONOCIDO-9' }, { devices: [] });
    const r = s.capture(obs({ sn: 'DESCONOCIDO-9', ip: '10.0.0.99' }));

    expect(r.ok).toBe(true);
    s.stop();
  });

  test('el nombre de otro reloj no habilita a Gerencia', () => {
    const { s } = sombra({ BRIDGE_SHADOW_DEVICE_ALLOWLIST: 'Comedor' });
    expect(s.capture(obs()).error_code).toBe(SHADOW_SKIP.DEVICE_NOT_ALLOWED);
    s.stop();
  });
});

// ── Identidad estable, no posicional ─────────────────────────────────

describe('la correlación no depende del orden de ZKTECO_DEVICES', () => {
  const A = 'Gerencia@10.0.0.11:4370#GER-0001';
  const B = 'Comedor@10.0.0.12:4370#COM-0002';

  test('resolveDevices sí numera por posición — por eso no se usa ese id', () => {
    const directo = resolveDevices({ ZKTECO_DEVICES: `${A},${B}` }).devices;
    const invertido = resolveDevices({ ZKTECO_DEVICES: `${B},${A}` }).devices;

    // Gerencia es id 1 en un orden y id 2 en el otro: el id posicional no
    // sirve como identidad y ésta es la prueba de por qué.
    expect(directo.find(d => d.name === 'Gerencia').id).toBe(1);
    expect(invertido.find(d => d.name === 'Gerencia').id).toBe(2);
  });

  test('la device_key de Gerencia es la misma en los dos órdenes', () => {
    const directo = resolveDevices({ ZKTECO_DEVICES: `${A},${B}` }).devices;
    const invertido = resolveDevices({ ZKTECO_DEVICES: `${B},${A}` }).devices;

    const k1 = stableDeviceKey({ sn: 'GER-0001', device: findConfiguredDevice({ sn: 'GER-0001' }, directo) });
    const k2 = stableDeviceKey({ sn: 'GER-0001', device: findConfiguredDevice({ sn: 'GER-0001' }, invertido) });

    expect(k1).toBe('sn:GER-0001');
    expect(k2).toBe('sn:GER-0001');
  });

  test('el event_id no cambia al reordenar la variable', () => {
    const directo = resolveDevices({ ZKTECO_DEVICES: `${A},${B}` }).devices;
    const invertido = resolveDevices({ ZKTECO_DEVICES: `${B},${A}` }).devices;

    const s1 = createShadow({ env: env({ BRIDGE_SHADOW_PATH: path.join(dir, 'a.db') }), devices: directo });
    const s2 = createShadow({ env: env({ BRIDGE_SHADOW_PATH: path.join(dir, 'b.db') }), devices: invertido });
    s1.start(); s2.start();

    const r1 = s1.capture(obs());
    const r2 = s2.capture(obs());

    expect(r1.event_id).toBe(r2.event_id);
    s1.stop(); s2.stop();
  });

  test('agregar un reloj al principio no reasigna las filas ya escritas', () => {
    const ruta = path.join(dir, 'shadow.db');
    const antes = resolveDevices({ ZKTECO_DEVICES: A }).devices;

    const s1 = createShadow({ env: env({ BRIDGE_SHADOW_PATH: ruta }), devices: antes });
    s1.start();
    s1.capture(obs());
    const claveAntes = Object.keys(s1.store.stats().by_device);
    s1.stop();

    // Se agrega Comedor ADELANTE: Gerencia pasa de id 1 a id 2.
    const despues = resolveDevices({ ZKTECO_DEVICES: `${B},${A}` }).devices;
    const s2 = createShadow({ env: env({ BRIDGE_SHADOW_PATH: ruta }), devices: despues });
    s2.start();
    s2.capture(obs({ deviceUserId: '2000' }));

    expect(Object.keys(s2.store.stats().by_device)).toEqual(claveAntes);
    s2.stop();
  });

  test('la clave sale del serial reportado, no del configurado', () => {
    // El reloj se anuncia solo por PUSH; su serial manda.
    expect(stableDeviceKey({ sn: 'REPORTADO', device: { serial: 'CONFIGURADO' } })).toBe('sn:REPORTADO');
  });

  test('sin serial cae a la dirección, hasheada', () => {
    const k = stableDeviceKey({ sn: '', device: { ip: '10.0.0.11', port: 4370 } });

    expect(k).toMatch(/^addr:[0-9a-f]{16}$/);
    expect(k).not.toContain('10.0.0.11');
  });

  test('la dirección hasheada es estable entre procesos', () => {
    const a = stableDeviceKey({ sn: '', device: { ip: '10.0.0.11', port: 4370 } });
    const b = stableDeviceKey({ sn: '', device: { ip: '10.0.0.11', port: 4370 } });
    const c = stableDeviceKey({ sn: '', device: { ip: '10.0.0.12', port: 4370 } });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test('por el camino de respaldo tampoco llega una IP al disco', () => {
    // El fallback `addr:` era la única vía por la que una IP terminaba
    // persistida: iba en claro a device_key y stats() la devolvía en by_device.
    const { s } = sombra({ BRIDGE_SHADOW_DEVICE_ALLOWLIST: '10.0.0.11' });
    const r = s.capture(obs({ sn: '' }));

    expect(r.ok).toBe(true);

    const fila = s.store.db.prepare('SELECT * FROM shadow_events').get();
    expect(JSON.stringify(fila)).not.toContain('10.0.0.11');
    expect(JSON.stringify(fila)).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(JSON.stringify(s.store.stats().by_device)).not.toContain('10.0.0.11');
    s.stop();
  });
});

// ── Serial canónico ──────────────────────────────────────────────────

describe('el serial se canoniza antes de derivar la identidad', () => {
  // La allowlist y ZKTECO_DEVICES ya comparan sin distinguir mayúsculas. Si la
  // clave conservara el texto original, el MISMO reloj daría dos device_id y
  // por lo tanto dos event_id, y la comparación PUSH↔polling mostraría todo
  // como only_push / only_polling sin que nada falle a la vista.

  test('mayúsculas y minúsculas dan la misma clave', () => {
    expect(stableDeviceKey({ sn: 'ger-0001' })).toBe(stableDeviceKey({ sn: 'GER-0001' }));
  });

  test('los espacios sobrantes no cambian la clave', () => {
    expect(stableDeviceKey({ sn: '  GER-0001  ' })).toBe('sn:GER-0001');
  });

  test('canonicalSerial normaliza a mayúsculas sin espacios', () => {
    expect(canonicalSerial('  ger-0001 ')).toBe('GER-0001');
    expect(canonicalSerial(null)).toBe('');
    expect(canonicalSerial(undefined)).toBe('');
  });

  test('el device_id derivado es el mismo con cualquier capitalización', () => {
    const a = deviceIdFromKey(stableDeviceKey({ sn: 'ger-0001' }));
    const b = deviceIdFromKey(stableDeviceKey({ sn: 'GER-0001' }));
    expect(a).toBe(b);
  });

  test('el mismo marcaje con el serial en otra capitalización da el MISMO event_id', () => {
    // Éste es el caso que rompía la comparación: el serial que el reloj
    // anuncia por PUSH y el que un operador tipea en ZKTECO_DEVICES para el
    // polling son dos textos escritos por manos distintas.
    const s1 = createShadow({ env: env({ BRIDGE_SHADOW_PATH: path.join(dir, 'a.db') }), devices: RELOJES });
    const s2 = createShadow({ env: env({ BRIDGE_SHADOW_PATH: path.join(dir, 'b.db') }), devices: RELOJES });
    s1.start(); s2.start();

    const r1 = s1.capture(obs({ sn: 'GER-0001' }));
    const r2 = s2.capture(obs({ sn: 'ger-0001' }));

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.event_id).toBe(r2.event_id);
    s1.stop(); s2.stop();
  });

  test('se guarda una sola fila aunque el serial llegue de las dos formas', () => {
    const { s } = sombra();
    s.capture(obs({ sn: 'GER-0001' }));
    s.capture(obs({ sn: 'ger-0001' }));

    expect(s.store.stats().stored).toBe(1);
    expect(s.metrics.duplicates).toBe(1);
    expect(Object.keys(s.store.stats().by_device)).toEqual(['sn:GER-0001']);
    s.stop();
  });

  test('sin serial y sin reloj configurado no hay identidad y no se guarda', () => {
    const { s } = sombra({ BRIDGE_SHADOW_DEVICE_ALLOWLIST: '10.0.0.77' }, { devices: [] });
    const r = s.capture(obs({ sn: '', ip: '10.0.0.77' }));

    expect(r.error_code).toBe(SHADOW_SKIP.DEVICE_UNKNOWN);
    expect(s.metrics.skipped_unknown_device).toBe(1);
    s.stop();
  });

  test('el fuente de la sombra nunca lee un id posicional', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '../src/shadow.js'), 'utf8');
    // `device.id` es exactamente el índice+1 de resolveDevices.
    expect(fuente).not.toMatch(/device\.id\b/);
    expect(fuente).not.toMatch(/devices\[\s*\d/);
  });
});

// ── Normalización ────────────────────────────────────────────────────

describe('normalización con el contrato v1', () => {
  test('la hora del reloj se ancla a la zona civil, no a la del proceso', () => {
    const { s } = sombra();
    s.capture(obs({ occurredAtRaw: '2026-03-11 08:15:00' }));

    const fila = s.store.db.prepare('SELECT occurred_at FROM shadow_events').get();
    expect(fila.occurred_at).toBe('2026-03-11T11:15:00Z');   // -03:00
    s.stop();
  });

  test('el mismo marcaje da el mismo event_id en dos procesos distintos', () => {
    const s1 = createShadow({ env: env({ BRIDGE_SHADOW_PATH: path.join(dir, '1.db') }), devices: RELOJES });
    const s2 = createShadow({ env: env({ BRIDGE_SHADOW_PATH: path.join(dir, '2.db') }), devices: RELOJES });
    s1.start(); s2.start();

    expect(s1.capture(obs()).event_id).toBe(s2.capture(obs()).event_id);
    s1.stop(); s2.stop();
  });

  test('verify_mode y work_code se conservan', () => {
    const { s } = sombra();
    s.capture(obs({ verifyMode: '15', workCode: '77' }));

    const p = JSON.parse(s.store.db.prepare('SELECT payload FROM shadow_events').get().payload);
    expect(p.verify_mode).toBe(15);
    expect(p.work_code).toBe('77');
    s.stop();
  });
});

// ── Duplicados e inválidos ───────────────────────────────────────────

describe('el mismo evento repetido', () => {
  test('se cuenta como duplicado y no se guarda dos veces', () => {
    const { s } = sombra();
    const a = s.capture(obs());
    const b = s.capture(obs());

    expect(a.inserted).toBe(true);
    expect(b.ok).toBe(true);
    expect(b.duplicate).toBe(true);
    expect(s.metrics.persisted).toBe(1);
    expect(s.metrics.duplicates).toBe(1);
    expect(s.store.stats().stored).toBe(1);
    s.stop();
  });

  test('un reenvío del reloj no infla el conteo de persistidos', () => {
    const { s } = sombra();
    for (let i = 0; i < 5; i++) s.capture(obs());

    expect(s.metrics.events_received).toBe(5);
    expect(s.metrics.events_valid).toBe(5);
    expect(s.metrics.persisted).toBe(1);
    expect(s.metrics.duplicates).toBe(4);
    s.stop();
  });
});

describe('eventos inválidos', () => {
  test('sin código de usuario no se guarda', () => {
    const { s } = sombra();
    const r = s.capture(obs({ deviceUserId: '' }));

    expect(r.invalid).toBe(true);
    expect(s.metrics.invalid).toBe(1);
    expect(s.metrics.persisted).toBe(0);
    s.stop();
  });

  test('una hora imposible no se guarda', () => {
    const { s } = sombra();
    const r = s.capture(obs({ occurredAtRaw: '2026-02-31 08:00:00' }));

    expect(r.invalid).toBe(true);
    expect(s.metrics.invalid).toBe(1);
    s.stop();
  });

  test('una hora basura no se guarda', () => {
    const { s } = sombra();
    expect(s.capture(obs({ occurredAtRaw: 'ayer' })).invalid).toBe(true);
    s.stop();
  });

  test('un marcaje del futuro lejano no se guarda', () => {
    const { s } = sombra();
    const futuro = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    expect(s.capture(obs({ occurredAtRaw: futuro })).invalid).toBe(true);
    s.stop();
  });

  test('un evento inválido no interrumpe los siguientes', () => {
    const { s } = sombra();
    s.capture(obs({ deviceUserId: '', deviceUserId: '' }));
    s.capture(obs({ deviceUserId: '5001' }));
    s.capture(obs({ deviceUserId: '5002' }));

    expect(s.metrics.invalid).toBe(1);
    expect(s.metrics.persisted).toBe(2);
    s.stop();
  });
});

// ── Best-effort ──────────────────────────────────────────────────────

describe('un fallo de la sombra no escala', () => {
  test('capture nunca lanza aunque el almacén reviente', () => {
    const roto = {
      open: () => ({ ok: true }),
      close: () => {},
      record: () => { throw new Error('disco lleno'); },
      stats: () => ({ ok: false }),
    };
    const s = createShadow({ env: env(), devices: RELOJES, store: roto });
    s.start();

    expect(() => s.capture(obs())).not.toThrow();
    expect(s.capture(obs()).ok).toBe(false);
    expect(s.metrics.errors).toBeGreaterThan(0);
  });

  test('con SQLite ausente sigue respondiendo, sin guardar', () => {
    const sinDriver = {
      open: () => ({ ok: false, error_code: SHADOW_ERRORS.OPEN_FAILED, detail: 'better-sqlite3 no instalado' }),
      close: () => {},
      record: () => ({ ok: false, error_code: SHADOW_ERRORS.NOT_OPEN }),
      stats: () => ({ ok: false, error_code: SHADOW_ERRORS.NOT_OPEN }),
    };
    const logger = loggerMudo();
    const s = createShadow({ env: env(), devices: RELOJES, logger, store: sinDriver });

    expect(() => s.start()).not.toThrow();
    expect(s.opened).toBe(false);

    const r = s.capture(obs());
    expect(r.ok).toBe(false);
    expect(s.metrics.errors).toBe(1);
    // Se validó igual: el conteo sirve para saber cuánto se perdió.
    expect(s.metrics.events_valid).toBe(1);
  });

  test('sin ruta configurada tampoco lanza', () => {
    const s = createShadow({ env: { BRIDGE_SHADOW_ENABLED: 'true', BRIDGE_SHADOW_DEVICE_ALLOWLIST: 'Gerencia' }, devices: RELOJES });
    expect(() => s.start()).not.toThrow();
    expect(() => s.capture(obs())).not.toThrow();
    expect(s.opened).toBe(false);
  });

  test('stop sobre una sombra que nunca abrió no lanza', () => {
    const s = createShadow({ env: env({ BRIDGE_SHADOW_ENABLED: 'false' }) });
    expect(() => s.stop()).not.toThrow();
  });
});

// ── Reinicio ─────────────────────────────────────────────────────────

describe('reinicio del Bridge', () => {
  test('los eventos ya guardados siguen ahí', () => {
    const ruta = path.join(dir, 'shadow.db');

    const s1 = createShadow({ env: env({ BRIDGE_SHADOW_PATH: ruta }), devices: RELOJES });
    s1.start();
    s1.capture(obs({ deviceUserId: '1' }));
    s1.capture(obs({ deviceUserId: '2' }));
    s1.stop();

    const s2 = createShadow({ env: env({ BRIDGE_SHADOW_PATH: ruta }), devices: RELOJES });
    s2.start();

    expect(s2.store.stats().stored).toBe(2);
    s2.stop();
  });

  test('los contadores del proceso arrancan en cero, el disco no', () => {
    const ruta = path.join(dir, 'shadow.db');
    const s1 = createShadow({ env: env({ BRIDGE_SHADOW_PATH: ruta }), devices: RELOJES });
    s1.start();
    s1.capture(obs());
    s1.stop();

    const s2 = createShadow({ env: env({ BRIDGE_SHADOW_PATH: ruta }), devices: RELOJES });
    s2.start();

    expect(s2.metrics.persisted).toBe(0);          // contador del proceso
    expect(s2.status().stored.stored).toBe(1);     // lo que sobrevivió
    s2.stop();
  });

  test('tras un corte abrupto lo escrito sigue disponible', () => {
    const ruta = path.join(dir, 'shadow.db');
    const s1 = createShadow({ env: env({ BRIDGE_SHADOW_PATH: ruta }), devices: RELOJES });
    s1.start();
    s1.capture(obs());
    // sin stop(): se abandona el proceso

    const s2 = createShadow({ env: env({ BRIDGE_SHADOW_PATH: ruta }), devices: RELOJES });
    s2.start();
    expect(s2.store.stats().stored).toBe(1);
    s1.stop(); s2.stop();
  });

  test('reobservar lo mismo tras reiniciar no duplica', () => {
    const ruta = path.join(dir, 'shadow.db');
    const s1 = createShadow({ env: env({ BRIDGE_SHADOW_PATH: ruta }), devices: RELOJES });
    s1.start(); s1.capture(obs()); s1.stop();

    const s2 = createShadow({ env: env({ BRIDGE_SHADOW_PATH: ruta }), devices: RELOJES });
    s2.start();
    const r = s2.capture(obs());

    expect(r.duplicate).toBe(true);
    expect(s2.store.stats().stored).toBe(1);
    s2.stop();
  });
});

// ── Métricas ─────────────────────────────────────────────────────────

describe('métricas agregadas', () => {
  test('status expone exactamente los conteos pedidos', () => {
    const { s } = sombra();
    s.capture(obs());

    const st = s.status().runtime;

    expect(Object.keys(st).sort()).toEqual([
      'duplicates', 'errors', 'events_received', 'events_valid',
      'first_event_at', 'invalid', 'last_event_at', 'persisted',
      'skipped_not_allowed', 'skipped_unknown_device',
    ]);
    s.stop();
  });

  test('la ventana observada se informa', () => {
    const { s } = sombra();
    s.capture(obs({ occurredAtRaw: '2026-03-11 08:00:00', deviceUserId: '1' }));
    s.capture(obs({ occurredAtRaw: '2026-03-11 17:30:00', deviceUserId: '2' }));

    expect(s.metrics.first_event_at).toBe('2026-03-11T11:00:00Z');
    expect(s.metrics.last_event_at).toBe('2026-03-11T20:30:00Z');
    s.stop();
  });

  test('status no contiene datos de persona', () => {
    const { s } = sombra();
    s.capture(obs({ deviceUserId: '1042' }));

    expect(JSON.stringify(s.status())).not.toContain('1042');
    s.stop();
  });
});

// ── Nada de PII en logs ──────────────────────────────────────────────

describe('no se registra nada personal', () => {
  test('una captura normal no escribe ningún log', () => {
    const { s, logger } = sombra();
    s.capture(obs());

    expect(logger.todo()).toBe('');
    s.stop();
  });

  test('ni el código de empleado, ni la IP, ni la hora cruda llegan al log', () => {
    const logger = loggerMudo();
    const roto = {
      open: () => ({ ok: true }),
      close: () => {},
      record: () => { throw new Error('fallo con 1042 y 10.0.0.11 adentro'); },
      stats: () => ({ ok: false }),
    };
    const s = createShadow({ env: env(), devices: RELOJES, logger, store: roto });
    s.start();
    s.capture(obs({ deviceUserId: '1042', ip: '10.0.0.11' }));

    const salida = logger.todo();
    expect(salida).not.toContain('1042');
    expect(salida).not.toContain('10.0.0.11');
    expect(salida).not.toContain('2026-03-11 08:15:00');
    expect(salida).not.toContain('fallo con');
  });

  test('el error de apertura se registra por código, sin la ruta del archivo', () => {
    // Un archivo normal donde debería ir un directorio: mkdir falla con
    // ENOTDIR al instante y sin depender de permisos del sistema.
    const bloqueado = path.join(dir, 'bloqueado');
    fs.writeFileSync(bloqueado, 'no soy un directorio');
    const ruta = path.join(bloqueado, 'shadow.db');

    const logger = loggerMudo();
    const s = createShadow({
      env: { BRIDGE_SHADOW_ENABLED: 'true', BRIDGE_SHADOW_PATH: ruta, BRIDGE_SHADOW_DEVICE_ALLOWLIST: 'Gerencia' },
      devices: RELOJES, logger,
    });
    s.start();

    expect(s.opened).toBe(false);
    const salida = logger.todo();
    expect(salida).not.toContain(ruta);
    expect(salida).not.toContain('bloqueado');
    expect(salida).toContain('shadow_open_failed');
  });

  test('el fuente no registra campos sensibles', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '../src/shadow.js'), 'utf8');
    const logs = fuente.match(/logger\.(info|warn|error|debug)\([^\n]*/g) || [];

    for (const l of logs) {
      expect(l).not.toMatch(/deviceUserId|device_user_id|employee|nombre|\bip\b|occurredAtRaw|payload|token|selfie|photo|biometr/i);
    }
  });
});

// ── Ningún efecto colateral ──────────────────────────────────────────

describe('la sombra no produce nada hacia afuera', () => {
  // Se mira el CÓDIGO, no los comentarios: los dos módulos documentan
  // largamente lo que NO hacen —"no hay UPDATE de daily_summary", "no manda
  // ACK"— y buscar esos nombres en la prosa daría positivo justamente por
  // estar bien documentados.
  // Incluye los comentarios `--` del DDL: el esquema explica ahí mismo que
  // device_id NO es devices.id de MySQL, y esa aclaración no puede leerse
  // como una dependencia de MySQL.
  const sinComentarios = txt => txt
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^\s*--.*$/gm, '');

  const fuentes = ['../src/shadow.js', '../src/shadowStore.js']
    .map(f => sinComentarios(fs.readFileSync(path.join(__dirname, f), 'utf8')))
    .join('\n');

  test('el filtro de comentarios no vacía el fuente', () => {
    // Si `sinComentarios` se rompiera y devolviera vacío, todas las
    // comprobaciones de abajo pasarían sin comprobar nada.
    expect(fuentes).toContain('class Shadow');
    expect(fuentes).toContain('INSERT INTO shadow_events');
    expect(fuentes).not.toContain('no manda ACK');
  });

  test('no habla con Redis', () => {
    expect(fuentes).not.toMatch(/require\(['"]redis['"]\)|xAdd|createClient|\.publish\(/);
  });

  test('no habla con MySQL', () => {
    expect(fuentes).not.toMatch(/mysql|sequelize|attendance_logs|daily_summary/i);
  });

  test('no hace peticiones HTTP a la API', () => {
    expect(fuentes).not.toMatch(/require\(['"]axios['"]\)|fetch\(|http\.request|\.post\(/);
  });

  test('no manda ACK al reloj ni borra sus logs', () => {
    expect(fuentes).not.toMatch(/clearAttendanceLog|clearLog|ACK|zklib|node-zklib/i);
  });

  test('no toca el polling', () => {
    expect(fuentes).not.toMatch(/ZKTECO_AUTO_POLL|pollDevice|setInterval/);
  });

  test('sus dependencias son sólo el contrato, la identidad y el almacén', () => {
    const requires = [...fuentes.matchAll(/require\((['"])(.+?)\1\)/g)].map(m => m[2]);
    expect([...new Set(requires)].sort()).toEqual([
      '../../contracts/punchContractV1',
      './deviceIdentity',
      './shadowStore',
      'better-sqlite3',
      'crypto',
      'fs',
      'path',
    ]);
  });
});
