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
  MATCH, parseAllowlist, canonicalSerial, stableDeviceKey, esIdentificableEnPush, auditAllowlist, tokensEnConflicto,
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

  // ── El #serial de ZKTECO_DEVICES es OPCIONAL ───────────────────────
  //
  // El formato habitual —`Gerencia@10.0.0.11:4370`— no lo lleva, pero el POST
  // ADMS sí trae SN. Si la resolución cortara al no encontrar el serial, el
  // reloj quedaría sin resolver entero: una allowlist por nombre no activaría
  // observe-only y el reloj volvería a publicar asistencia.

  test('con el serial sin configurar, se resuelve por IP', () => {
    const sinSerial = [{ id: 1, name: 'Gerencia', ip: '10.0.0.11', port: 4370 }];

    expect(resolveDevice({ sn: 'GER-0001', ip: '10.0.0.11' }, sinSerial)).toEqual({
      device: sinSerial[0], ambiguous: false, matchedBy: MATCH.IP,
    });
  });

  test('y así la allowlist por nombre sigue funcionando', () => {
    const sinSerial = [{ id: 1, name: 'Gerencia', ip: '10.0.0.11', port: 4370 }];
    const r = matchesAllowlist({ sn: 'GER-0001', ip: '10.0.0.11' }, sinSerial, parseAllowlist('Gerencia'));

    expect(r.allowed).toBe(true);
    expect(r.device.name).toBe('Gerencia');
  });

  test('un serial CONFLICTIVO no se empareja por compartir la IP', () => {
    // El reloj dice OTRO-9; la config dice que en esa IP vive GER-0001. Son
    // aparatos demostrablemente distintos: emparejarlos atribuiría el marcaje
    // al reloj equivocado.
    expect(resolveDevice({ sn: 'OTRO-9', ip: '10.0.0.11' }, RELOJES)).toEqual({
      device: null, ambiguous: false, matchedBy: MATCH.NONE,
    });
  });

  test('dos relojes sin serial en la misma IP siguen siendo ambiguos', () => {
    const mismos = [
      { id: 1, name: 'A', ip: '10.0.0.20', port: 4370 },
      { id: 2, name: 'B', ip: '10.0.0.20', port: 4371 },
    ];
    expect(resolveDevice({ sn: 'X-1', ip: '10.0.0.20' }, mismos).ambiguous).toBe(true);
  });

  test('el reloj con serial declarado no compite con los que no lo declaran', () => {
    const mezcla = [
      { id: 1, name: 'ConSerial', ip: '10.0.0.30', port: 4370, serial: 'CS-1' },
      { id: 2, name: 'SinSerial', ip: '10.0.0.30', port: 4371 },
    ];
    // El reloj reporta un serial que no es CS-1: sólo SinSerial es candidato.
    const r = resolveDevice({ sn: 'OTRO-9', ip: '10.0.0.30' }, mezcla);

    expect(r.ambiguous).toBe(false);
    expect(r.device.name).toBe('SinSerial');
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

  // ── La IP observada no contradice un serial ───────────────────────
  //
  // Suprimir al reloj equivocado es la peor falla posible acá: se pierden
  // marcaciones en silencio.

  test('un reloj que llega por NAT desde la IP de otro NO cae en su allowlist', () => {
    // Comedor (COM-0002) llega desde 10.0.0.11, la IP de Gerencia. La
    // allowlist nombra esa IP para observar Gerencia — no a Comedor.
    const r = matchesAllowlist({ sn: 'COM-0002', ip: '10.0.0.11' }, RELOJES, parseAllowlist('10.0.0.11'));

    expect(r.allowed).toBe(false);
    expect(r.device).toBe(COMEDOR);   // se resolvió bien, sólo no está nombrado
  });

  test('el reloj correcto sí entra por su IP configurada', () => {
    const r = matchesAllowlist({ sn: 'GER-0001', ip: '10.0.0.11' }, RELOJES, parseAllowlist('10.0.0.11'));
    expect(r.allowed).toBe(true);
  });

  test('sin serial, la IP observada sigue siendo identidad válida', () => {
    // Es la única disponible: ahí sí tiene que contar.
    const r = matchesAllowlist({ sn: '', ip: '10.0.0.11' }, RELOJES, parseAllowlist('10.0.0.11'));
    expect(r.allowed).toBe(true);
  });

  test('un reloj sin configurar tampoco se captura por la IP ajena', () => {
    const r = matchesAllowlist({ sn: 'NUEVO-9', ip: '10.0.0.11' }, RELOJES, parseAllowlist('10.0.0.11'));
    expect(r.allowed).toBe(false);
  });

  // ── Colisión entre tipos de identificador ─────────────────────────
  //
  // Serial, nombre e IP comparten un espacio de nombres sin tipo, así que un
  // token puede alcanzar dos relojes por vías distintas.

  const CRUZADOS = [
    { id: 1, name: 'Gerencia', ip: '10.0.0.11', port: 4370, serial: 'GER-1' },
    { id: 2, name: 'Comedor',  ip: '10.0.0.12', port: 4370, serial: 'Gerencia' },
  ];

  test('un token que alcanza dos relojes no se aplica a ninguno', () => {
    // `Gerencia` entra por el NOMBRE del primero y por el SERIAL del segundo.
    // Aplicarlo habría suprimido las marcaciones de Comedor, que nadie nombró.
    const lista = parseAllowlist('Gerencia');

    expect(matchesAllowlist({ sn: 'GER-1', ip: '10.0.0.11' }, CRUZADOS, lista).allowed).toBe(false);
    expect(matchesAllowlist({ sn: 'Gerencia', ip: '10.0.0.12' }, CRUZADOS, lista).allowed).toBe(false);
  });

  test('la colisión se reporta en la auditoría', () => {
    const problemas = auditAllowlist(parseAllowlist('Gerencia'), CRUZADOS);

    expect(problemas).toHaveLength(1);
    expect(problemas[0].code).toBe('token_colision');
  });

  test('tokensEnConflicto nombra exactamente el token ambiguo', () => {
    const enConflicto = tokensEnConflicto(parseAllowlist('Gerencia,Comedor'), CRUZADOS);

    expect([...enConflicto]).toEqual(['gerencia']);
  });

  test('los tokens sanos de la misma lista siguen funcionando', () => {
    // Descartar el token en conflicto no puede desarmar el resto de la lista.
    const lista = parseAllowlist('Gerencia,Comedor');

    expect(matchesAllowlist({ sn: 'Gerencia', ip: '10.0.0.12' }, CRUZADOS, lista).allowed).toBe(true);
  });

  test('sin colisión, nada cambia', () => {
    expect(tokensEnConflicto(parseAllowlist('Gerencia'), RELOJES).size).toBe(0);
    expect(matchesAllowlist({ sn: 'GER-0001' }, RELOJES, parseAllowlist('Gerencia')).allowed).toBe(true);
  });

  // ── La colisión puede aparecer recién en tiempo de ejecución ───────
  //
  // Por PUSH un reloj se anuncia solo, y con `ZKTECO_PUSH_WHITELIST` vacía
  // cualquiera puede hacerlo. Mirar únicamente `ZKTECO_DEVICES` no alcanza:
  // el segundo aparato de la colisión puede no estar configurado.

  test('un reloj NO configurado que reporta el nombre de otro no se suprime', () => {
    // SN='Gerencia' colisiona con el token que nombra al reloj Gerencia.
    const r = matchesAllowlist({ sn: 'Gerencia', ip: '10.0.0.99' }, RELOJES, parseAllowlist('Gerencia'));

    expect(r.allowed).toBe(false);
    expect(r.device).toBeNull();
  });

  test('y el reloj que sí se nombró sigue entrando', () => {
    const r = matchesAllowlist({ sn: 'GER-0001', ip: '10.0.0.11' }, RELOJES, parseAllowlist('Gerencia'));
    expect(r.allowed).toBe(true);
  });

  test('un reloj no configurado nombrado por SU PROPIO serial sí entra', () => {
    // Alcanzar a ningún reloj configurado es válido: es cómo se nombra por
    // serial a uno que todavía no está en la configuración.
    const r = matchesAllowlist({ sn: 'NUEVO-1', ip: '10.0.0.99' }, RELOJES, parseAllowlist('NUEVO-1'));
    expect(r.allowed).toBe(true);
  });

  test('el token que colisiona con una IP configurada tampoco captura al ajeno', () => {
    const r = matchesAllowlist({ sn: '10.0.0.11', ip: '10.0.0.99' }, RELOJES, parseAllowlist('10.0.0.11'));
    expect(r.allowed).toBe(false);
  });

  test('un token que alcanza al MISMO reloj por dos vías no es colisión', () => {
    // Nombre e IP del mismo aparato: sigue siendo uno solo.
    const uno = [{ id: 1, name: '10.0.0.11', ip: '10.0.0.11', port: 4370, serial: 'X-1' }];
    expect(tokensEnConflicto(parseAllowlist('10.0.0.11'), uno).size).toBe(0);
  });
});

// ── Identificable en PUSH ────────────────────────────────────────────

describe('esIdentificableEnPush', () => {
  test('con serial declarado, sí', () => {
    expect(esIdentificableEnPush({ name: 'A', ip: 'reloj.local', port: 4370, serial: 'A-1' })).toBe(true);
  });

  test('con IP numérica, sí', () => {
    expect(esIdentificableEnPush({ name: 'A', ip: '10.0.0.11', port: 4370 })).toBe(true);
  });

  test('con hostname y sin serial, NO', () => {
    // `d.ip` guarda el texto del hostname y la petición trae un número: esa
    // comparación no coincide nunca.
    expect(esIdentificableEnPush({ name: 'A', ip: 'reloj-gerencia.local', port: 4370 })).toBe(false);
  });

  test('sin reloj, no', () => {
    expect(esIdentificableEnPush(null)).toBe(false);
  });
});

describe('auditAllowlist', () => {
  test('un token que nombra un reloj con hostname y sin serial se reporta', () => {
    // ZKTECO_DEVICES=Gerencia@reloj-gerencia.local:4370
    const conHostname = [{ id: 1, name: 'Gerencia', ip: 'reloj-gerencia.local', port: 4370 }];
    const problemas = auditAllowlist(parseAllowlist('Gerencia'), conHostname);

    expect(problemas).toHaveLength(1);
    expect(problemas[0].token).toBe('gerencia');
    expect(problemas[0].code).toBe('token_no_identificable');
  });

  test('el mismo reloj con #serial declarado no da problema', () => {
    const conSerial = [{ id: 1, name: 'Gerencia', ip: 'reloj-gerencia.local', port: 4370, serial: 'GER-0001' }];
    expect(auditAllowlist(parseAllowlist('Gerencia'), conSerial)).toEqual([]);
  });

  test('el mismo reloj con IP numérica tampoco', () => {
    expect(auditAllowlist(parseAllowlist('Gerencia'), RELOJES)).toEqual([]);
  });

  test('nombrarlo por serial siempre funciona', () => {
    const conHostname = [{ id: 1, name: 'Gerencia', ip: 'reloj-gerencia.local', port: 4370, serial: 'GER-0001' }];
    expect(auditAllowlist(parseAllowlist('GER-0001'), conHostname)).toEqual([]);
  });

  test('un token que no nombra ningún reloj configurado NO es problema', () => {
    // Por PUSH el reloj se anuncia solo: su SN puede engancharlo igual.
    expect(auditAllowlist(parseAllowlist('RELOJ-NUEVO-9'), RELOJES)).toEqual([]);
  });

  test('una allowlist vacía no reporta nada', () => {
    expect(auditAllowlist([], RELOJES)).toEqual([]);
  });

  test('sin relojes configurados tampoco', () => {
    expect(auditAllowlist(parseAllowlist('Gerencia'), [])).toEqual([]);
  });

  test('reporta sólo el token roto de una lista mixta', () => {
    const mezcla = [
      { id: 1, name: 'Gerencia', ip: '10.0.0.11', port: 4370 },
      { id: 2, name: 'Comedor',  ip: 'comedor.local', port: 4370 },
    ];
    const problemas = auditAllowlist(parseAllowlist('Gerencia,Comedor'), mezcla);

    expect(problemas.map(p => p.token)).toEqual(['comedor']);
  });

  test('dos seriales que sólo difieren en mayúsculas se reportan', () => {
    // Canonizados son el MISMO serial, así que `resolveDevice` los da por
    // ambiguos y el reloj nunca entra en observe-only. Sin este chequeo el
    // arranque no decía nada y el reloj seguía publicando.
    const duplicados = [
      { id: 1, name: 'Gerencia', ip: '10.0.0.11', port: 4370, serial: 'ABC' },
      { id: 2, name: 'Otro',     ip: '10.0.0.12', port: 4370, serial: 'abc' },
    ];
    const problemas = auditAllowlist(parseAllowlist('ABC'), duplicados);

    expect(problemas).toHaveLength(1);
    expect(problemas[0].code).toBe('serial_duplicado');
  });

  test('un serial que lleva un solo reloj no se reporta', () => {
    expect(auditAllowlist(parseAllowlist('GER-0001'), RELOJES)).toEqual([]);
  });

  test('dos relojes sin serial que comparten IP se reportan', () => {
    // `A@10.0.0.20:4370,B@10.0.0.20:4371` es configuración válida. Los dos
    // pasan esIdentificableEnPush —la IP es numérica— pero resolveDevice da
    // por ambiguo todo PUSH que llegue de ahí, así que observe-only nunca se
    // aplica y el reloj sigue publicando.
    const compartida = [
      { id: 1, name: 'A', ip: '10.0.0.20', port: 4370 },
      { id: 2, name: 'B', ip: '10.0.0.20', port: 4371 },
    ];
    const problemas = auditAllowlist(parseAllowlist('A'), compartida);

    expect(problemas).toHaveLength(1);
    expect(problemas[0].code).toBe('ip_ambigua');
  });

  test('nombrar esa IP directamente también se reporta', () => {
    const compartida = [
      { id: 1, name: 'A', ip: '10.0.0.20', port: 4370 },
      { id: 2, name: 'B', ip: '10.0.0.20', port: 4371 },
    ];
    expect(auditAllowlist(parseAllowlist('10.0.0.20'), compartida)).toHaveLength(1);
  });

  test('si declaran serial, compartir IP deja de ser problema', () => {
    const conSerial = [
      { id: 1, name: 'A', ip: '10.0.0.20', port: 4370, serial: 'A1' },
      { id: 2, name: 'B', ip: '10.0.0.20', port: 4371, serial: 'B1' },
    ];
    expect(auditAllowlist(parseAllowlist('A'), conSerial)).toEqual([]);
  });

  test('una IP no compartida no se reporta', () => {
    const solo = [{ id: 1, name: 'A', ip: '10.0.0.20', port: 4370 }];
    expect(auditAllowlist(parseAllowlist('A'), solo)).toEqual([]);
  });

  test('el hostname usado como token también se reporta', () => {
    const conHostname = [{ id: 1, name: 'Gerencia', ip: 'reloj-gerencia.local', port: 4370 }];
    expect(auditAllowlist(parseAllowlist('reloj-gerencia.local'), conHostname)).toHaveLength(1);
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
