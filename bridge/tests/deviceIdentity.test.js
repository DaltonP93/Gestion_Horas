/**
 * Identidad de un reloj — la regla compartida por la sombra y el PUSH.
 *
 * Este módulo responde una sola pregunta, "¿este marcaje viene del reloj que
 * nombré?", y la responden dos consumidores con consecuencias distintas: la
 * sombra decide si guarda una copia, el servidor PUSH decide si SUPRIME la
 * publicación. Por eso las respuestas dudosas importan tanto como las claras:
 * suprimir la publicación del reloj equivocado pierde marcaciones en silencio.
 */
const {
  MATCH, parseAllowlist, canonicalSerial, stableDeviceKey,
  resolveDevice, findConfiguredDevice, isDeviceAllowed, matchesAllowlist,
} = require('../src/deviceIdentity');

const GERENCIA = { id: 1, name: 'Gerencia', ip: '10.0.0.11', port: 4370, serial: 'GER-0001' };
const COMEDOR  = { id: 2, name: 'Comedor',  ip: '10.0.0.12', port: 4370, serial: 'COM-0002' };
const RELOJES = [GERENCIA, COMEDOR];

// ── Canonización ─────────────────────────────────────────────────────

describe('serial canónico', () => {
  test('normaliza a mayúsculas y recorta', () => {
    expect(canonicalSerial('  ger-0001 ')).toBe('GER-0001');
  });

  test('lo ausente da cadena vacía, no "null" ni "undefined"', () => {
    expect(canonicalSerial(null)).toBe('');
    expect(canonicalSerial(undefined)).toBe('');
    expect(canonicalSerial('')).toBe('');
  });
});

describe('allowlist', () => {
  test('vacía es vacía, nunca "todos"', () => {
    expect(parseAllowlist('')).toEqual([]);
    expect(parseAllowlist(null)).toEqual([]);
    expect(parseAllowlist(' , ,, ')).toEqual([]);
  });

  test('recorta y baja a minúsculas cada token', () => {
    expect(parseAllowlist(' Gerencia , COM-0002 ')).toEqual(['gerencia', 'com-0002']);
  });
});

// ── Resolución ───────────────────────────────────────────────────────

describe('resolveDevice', () => {
  test('por serial, sin distinguir capitalización', () => {
    expect(resolveDevice({ sn: 'ger-0001' }, RELOJES)).toEqual({
      device: GERENCIA, ambiguous: false, matchedBy: MATCH.SERIAL,
    });
  });

  test('por IP cuando no hay serial', () => {
    expect(resolveDevice({ sn: '', ip: '10.0.0.12' }, RELOJES)).toEqual({
      device: COMEDOR, ambiguous: false, matchedBy: MATCH.IP,
    });
  });

  test('el serial manda sobre la IP', () => {
    // Un reloj detrás de NAT puede llegar con la IP de otro; su serial no.
    const r = resolveDevice({ sn: 'GER-0001', ip: '10.0.0.12' }, RELOJES);
    expect(r.device).toBe(GERENCIA);
  });

  test('un serial que no está configurado NO es ambiguo', () => {
    // Por PUSH el reloj se anuncia solo; puede no estar en ZKTECO_DEVICES.
    expect(resolveDevice({ sn: 'DESCONOCIDO-9' }, RELOJES)).toEqual({
      device: null, ambiguous: false, matchedBy: MATCH.NONE,
    });
  });

  test('sin serial y sin IP conocida tampoco es ambiguo', () => {
    expect(resolveDevice({ sn: '', ip: '192.168.1.1' }, RELOJES).ambiguous).toBe(false);
  });

  test('dos relojes en la misma IP y un PUSH sin serial SÍ es ambiguo', () => {
    // resolveDevices rechaza ip:puerto repetido, pero no la misma IP con
    // puertos distintos: es configuración válida.
    const mismos = [
      { id: 1, name: 'A', ip: '10.0.0.20', port: 4370, serial: null },
      { id: 2, name: 'B', ip: '10.0.0.20', port: 4371, serial: null },
    ];
    expect(resolveDevice({ sn: '', ip: '10.0.0.20' }, mismos)).toEqual({
      device: null, ambiguous: true, matchedBy: MATCH.AMBIGUOUS,
    });
  });

  test('con serial declarado, la misma IP repetida deja de importar', () => {
    const mismos = [
      { id: 1, name: 'A', ip: '10.0.0.20', port: 4370, serial: 'A-1' },
      { id: 2, name: 'B', ip: '10.0.0.20', port: 4371, serial: 'B-2' },
    ];
    const r = resolveDevice({ sn: 'B-2', ip: '10.0.0.20' }, mismos);
    expect(r.ambiguous).toBe(false);
    expect(r.device.name).toBe('B');
  });

  test('sin relojes configurados no se inventa ninguno', () => {
    expect(resolveDevice({ sn: 'GER-0001' }, []).device).toBeNull();
    expect(resolveDevice({ sn: 'GER-0001' }, []).ambiguous).toBe(false);
  });

  test('findConfiguredDevice es la misma resolución, sin el motivo', () => {
    expect(findConfiguredDevice({ sn: 'GER-0001' }, RELOJES)).toBe(GERENCIA);
    expect(findConfiguredDevice({ sn: '', ip: '10.0.0.20' }, [
      { id: 1, name: 'A', ip: '10.0.0.20', port: 4370, serial: null },
      { id: 2, name: 'B', ip: '10.0.0.20', port: 4371, serial: null },
    ])).toBeNull();
  });
});

// ── Pertenencia a la allowlist ───────────────────────────────────────

describe('matchesAllowlist', () => {
  const lista = parseAllowlist('Gerencia');

  test('el reloj nombrado entra', () => {
    expect(matchesAllowlist({ sn: 'GER-0001' }, RELOJES, lista).allowed).toBe(true);
  });

  test('con el serial en otra capitalización, también', () => {
    expect(matchesAllowlist({ sn: 'ger-0001' }, RELOJES, lista).allowed).toBe(true);
  });

  test('otro reloj queda afuera', () => {
    expect(matchesAllowlist({ sn: 'COM-0002' }, RELOJES, lista).allowed).toBe(false);
  });

  test('allowlist vacía deja a todos afuera', () => {
    expect(matchesAllowlist({ sn: 'GER-0001' }, RELOJES, []).allowed).toBe(false);
    expect(matchesAllowlist({ sn: 'GER-0001' }, RELOJES, null).allowed).toBe(false);
  });

  test('un reloj ambiguo NUNCA entra', () => {
    // No se le puede aplicar un tratamiento especial a un reloj que no se
    // pudo identificar: para el PUSH eso significaría suprimir la publicación
    // del equivocado y perder sus marcaciones sin que nadie se entere.
    const mismos = [
      { id: 1, name: 'A', ip: '10.0.0.20', port: 4370, serial: null },
      { id: 2, name: 'B', ip: '10.0.0.20', port: 4371, serial: null },
    ];
    const r = matchesAllowlist({ sn: '', ip: '10.0.0.20' }, mismos, parseAllowlist('10.0.0.20'));

    expect(r.ambiguous).toBe(true);
    expect(r.allowed).toBe(false);
  });

  test('se puede nombrar por serial, por nombre o por IP', () => {
    for (const token of ['GER-0001', 'Gerencia', '10.0.0.11']) {
      expect(matchesAllowlist({ sn: 'GER-0001' }, RELOJES, parseAllowlist(token)).allowed).toBe(true);
    }
  });

  test('un reloj sin configurar puede nombrarse por su serial reportado', () => {
    const r = matchesAllowlist({ sn: 'NUEVO-1' }, [], parseAllowlist('nuevo-1'));
    expect(r.allowed).toBe(true);
    expect(r.device).toBeNull();
  });

  test('isDeviceAllowed no acepta una lista vacía como comodín', () => {
    expect(isDeviceAllowed({ sn: 'GER-0001', device: GERENCIA }, [])).toBe(false);
  });
});

// ── Clave estable ────────────────────────────────────────────────────

describe('stableDeviceKey', () => {
  test('sale del serial reportado, canonizado', () => {
    expect(stableDeviceKey({ sn: 'ger-0001' })).toBe('sn:GER-0001');
  });

  test('el serial reportado gana sobre el configurado', () => {
    expect(stableDeviceKey({ sn: 'REPORTADO', device: { serial: 'CONFIGURADO' } })).toBe('sn:REPORTADO');
  });

  test('el serial configurado se usa cuando el reloj no lo reporta', () => {
    expect(stableDeviceKey({ sn: '', device: GERENCIA })).toBe('sn:GER-0001');
  });

  test('sin serial por ningún lado, la dirección va hasheada', () => {
    const sinSerial = { name: 'Sin serial', ip: '10.0.0.11', port: 4370, serial: null };
    const k = stableDeviceKey({ sn: '', device: sinSerial });

    expect(k).toMatch(/^addr:[0-9a-f]{16}$/);
    expect(k).not.toContain('10.0.0.11');
  });

  test('sin nada, no hay clave', () => {
    expect(stableDeviceKey({ sn: '', device: null })).toBeNull();
  });

  test('el puerto forma parte de la dirección hasheada', () => {
    const a = stableDeviceKey({ sn: '', device: { ip: '10.0.0.20', port: 4370 } });
    const b = stableDeviceKey({ sn: '', device: { ip: '10.0.0.20', port: 4371 } });
    expect(a).not.toBe(b);
  });
});
