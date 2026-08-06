/**
 * Registro de relojes del Bridge.
 *
 * El caso que motiva todo: sin ZKTECO_DEVICES, el Bridge arrancaba en silencio
 * con un "Reloj test" inventado y /health informaba `devices: 1`. En producción
 * eso vuelve mentirosos health, push-status y cualquier Outbox futuro.
 */
const {
  resolveDevices, buildHealth, configurationSummary,
  DEVICE_SOURCE, PROBLEM, hostValido, puertoValido,
} = require('../src/deviceRegistry');

/** Entorno mínimo — sin heredar el del proceso, que trae ruido. */
function env(extra = {}) {
  return { NODE_ENV: 'production', ...extra };
}

describe('sin configuración no se inventa ningún reloj', () => {
  test('producción sin ZKTECO_DEVICES queda degradado y sin relojes', () => {
    const r = resolveDevices(env());

    expect(r.devices).toEqual([]);
    expect(r.degraded).toBe(true);
    expect(r.source).toBe(DEVICE_SOURCE.NONE);
  });

  test('ningún reloj resultante se llama "Reloj test" ni apunta a una IP inventada', () => {
    const r = resolveDevices(env());
    expect(r.devices).toHaveLength(0);   // no hay a qué conectarse
  });

  test('el reloj ficticio NO aparece sin la flag explícita, ni fuera de producción', () => {
    const r = resolveDevices({ NODE_ENV: 'development' });

    expect(r.devices).toEqual([]);
    expect(r.degraded).toBe(true);
  });

  test('la flag sola no alcanza en producción', () => {
    const r = resolveDevices(env({ BRIDGE_ALLOW_TEST_DEVICE: 'true' }));

    expect(r.devices).toEqual([]);
    expect(r.degraded).toBe(true);
    expect(r.problems.map(p => p.code)).toContain(PROBLEM.TEST_DEVICE_IN_PRODUCTION);
  });

  test('NODE_ENV ausente NO cuenta como desarrollo', () => {
    // Arranque directo, systemd o un PM2 sin bloque env dejan NODE_ENV vacío.
    // Con la regla anterior (!== 'production') eso habilitaba el reloj
    // ficticio en una máquina de producción.
    for (const entorno of [undefined, '', 'staging', 'produccion', 'PRODUCTION']) {
      const r = resolveDevices({ NODE_ENV: entorno, BRIDGE_ALLOW_TEST_DEVICE: 'true' });

      expect(r.devices).toEqual([]);
      expect(r.degraded).toBe(true);
      expect(r.problems.map(p => p.code)).toContain(PROBLEM.TEST_DEVICE_IN_PRODUCTION);
    }
  });

  test('sólo development y test lo habilitan', () => {
    for (const entorno of ['development', 'test']) {
      const r = resolveDevices({ NODE_ENV: entorno, BRIDGE_ALLOW_TEST_DEVICE: 'true' });
      expect(r.devices).toHaveLength(1);
    }
  });

  test('en desarrollo, con la flag, sí se permite un reloj ficticio', () => {
    const r = resolveDevices({ NODE_ENV: 'development', BRIDGE_ALLOW_TEST_DEVICE: 'true' });

    expect(r.devices).toHaveLength(1);
    expect(r.devices[0].test).toBe(true);
    expect(r.source).toBe(DEVICE_SOURCE.TEST_ONLY);
    expect(r.degraded).toBe(false);
  });

  test('la flag con cualquier valor que no sea "true" no habilita nada', () => {
    for (const valor of ['1', 'yes', 'TRUE', 'si', '']) {
      const r = resolveDevices({ NODE_ENV: 'development', BRIDGE_ALLOW_TEST_DEVICE: valor });
      expect(r.devices).toEqual([]);
    }
  });
});

describe('los relojes reales se configuran y se nombran', () => {
  test('formato heredado ip:port sigue funcionando', () => {
    const r = resolveDevices(env({ ZKTECO_DEVICES: '10.0.0.11:4370,10.0.0.12:4370' }));

    expect(r.devices).toHaveLength(2);
    expect(r.degraded).toBe(false);
    expect(r.source).toBe(DEVICE_SOURCE.ENV_LIST);
  });

  test('el puerto por defecto es 4370', () => {
    const r = resolveDevices(env({ ZKTECO_DEVICES: '10.0.0.11' }));
    expect(r.devices[0].port).toBe(4370);
  });

  test('los relojes reales conservan su nombre propio', () => {
    const r = resolveDevices(env({
      ZKTECO_DEVICES: 'Gerencia@10.0.0.11:4370,Comedor@10.0.0.12:4370,Lavadero@10.0.0.13:4370',
    }));

    expect(r.devices.map(d => d.name)).toEqual(['Gerencia', 'Comedor', 'Lavadero']);
    expect(r.devices).toHaveLength(3);
  });

  test('acepta serial por entrada', () => {
    const r = resolveDevices(env({ ZKTECO_DEVICES: 'Gerencia@10.0.0.11:4370#SN-A1' }));
    expect(r.devices[0].serial).toBe('SN-A1');
  });

  test('acepta la forma JSON', () => {
    const r = resolveDevices(env({
      ZKTECO_DEVICES: JSON.stringify([
        { name: 'Gerencia', ip: '10.0.0.11', port: 4370, serial: 'SN-A1' },
        { name: 'Comedor', ip: 'reloj-comedor.local' },
      ]),
    }));

    expect(r.devices).toHaveLength(2);
    expect(r.devices[1].port).toBe(4370);
    expect(r.degraded).toBe(false);
  });

  test('un hostname válido se acepta', () => {
    const r = resolveDevices(env({ ZKTECO_DEVICES: 'Comedor@reloj-comedor.local:4370' }));
    expect(r.devices).toHaveLength(1);
  });
});

describe('validación de entradas', () => {
  const casos = [
    ['entrada vacía',            'Gerencia@10.0.0.11:4370,,Comedor@10.0.0.12:4370', PROBLEM.EMPTY_ENTRY],
    ['puerto no numérico',       '10.0.0.11:abcd',      PROBLEM.PORT_INVALID],
    ['puerto fuera de rango',    '10.0.0.11:70000',     PROBLEM.PORT_INVALID],
    ['puerto cero',              '10.0.0.11:0',         PROBLEM.PORT_INVALID],
    ['puerto decimal',           '10.0.0.11:43.70',     PROBLEM.PORT_INVALID],
    ['octeto fuera de rango',    '999.1.1.1:4370',      PROBLEM.HOST_INVALID],
    ['IP incompleta',            '10.0.0:4370',         PROBLEM.HOST_INVALID],
    ['nombre vacío antes de @',  '@10.0.0.11',          PROBLEM.DELIMITER_INVALID],
    ['separador punto y coma',   '10.0.0.11:4370;10.0.0.12:4370', PROBLEM.DELIMITER_INVALID],
    ['separador pipe',           '10.0.0.11:4370|10.0.0.12:4370', PROBLEM.DELIMITER_INVALID],
    ['doble arroba',             'a@b@10.0.0.11',       PROBLEM.DELIMITER_INVALID],
    ['doble numeral',            '10.0.0.11#a#b',       PROBLEM.DELIMITER_INVALID],
    ['JSON inválido',            '[{roto',              PROBLEM.JSON_INVALID],
  ];

  test.each(casos)('rechaza %s', (_nombre, valor, codigo) => {
    const r = resolveDevices(env({ ZKTECO_DEVICES: valor }));
    expect(r.problems.map(p => p.code)).toContain(codigo);
  });

  test('una entrada inválida no descarta las válidas', () => {
    const r = resolveDevices(env({
      ZKTECO_DEVICES: 'Gerencia@10.0.0.11:4370,rota@999.1.1.1:4370,Comedor@10.0.0.12:4370',
    }));

    expect(r.devices.map(d => d.name)).toEqual(['Gerencia', 'Comedor']);
    expect(r.degraded).toBe(false);
    expect(r.problems).toHaveLength(1);
  });

  test('si TODAS son inválidas, queda degradado — no se inventa un reemplazo', () => {
    const r = resolveDevices(env({ ZKTECO_DEVICES: '999.1.1.1:4370,10.0.0.11:abcd' }));

    expect(r.devices).toEqual([]);
    expect(r.degraded).toBe(true);
    expect(r.source).toBe(DEVICE_SOURCE.NONE);
  });
});

describe('duplicados', () => {
  test('misma dirección dos veces: se conserva una', () => {
    const r = resolveDevices(env({ ZKTECO_DEVICES: 'Gerencia@10.0.0.11:4370,Otro@10.0.0.11:4370' }));

    expect(r.devices).toHaveLength(1);
    expect(r.devices[0].name).toBe('Gerencia');
    expect(r.problems.map(p => p.code)).toContain(PROBLEM.DUPLICATE_ADDRESS);
  });

  test('mismo host con puerto distinto NO es duplicado', () => {
    const r = resolveDevices(env({ ZKTECO_DEVICES: 'A@10.0.0.11:4370,B@10.0.0.11:4371' }));
    expect(r.devices).toHaveLength(2);
  });

  test('serial duplicado se rechaza', () => {
    const r = resolveDevices(env({
      ZKTECO_DEVICES: 'Gerencia@10.0.0.11:4370#SN-A,Comedor@10.0.0.12:4370#SN-A',
    }));

    expect(r.devices).toHaveLength(1);
    expect(r.problems.map(p => p.code)).toContain(PROBLEM.DUPLICATE_SERIAL);
  });

  test('nombre duplicado se rechaza, sin importar mayúsculas', () => {
    const r = resolveDevices(env({ ZKTECO_DEVICES: 'Comedor@10.0.0.11:4370,COMEDOR@10.0.0.12:4370' }));

    expect(r.devices).toHaveLength(1);
    expect(r.problems.map(p => p.code)).toContain(PROBLEM.DUPLICATE_NAME);
  });

  test('los id resultantes son consecutivos y sin huecos tras descartar', () => {
    const r = resolveDevices(env({
      ZKTECO_DEVICES: 'A@10.0.0.11:4370,A@10.0.0.11:4370,B@10.0.0.12:4370',
    }));
    expect(r.devices.map(d => d.id)).toEqual([1, 2]);
  });
});

describe('/health no filtra nada sensible', () => {
  const resolution = resolveDevices(env({
    ZKTECO_DEVICES: 'Gerencia@10.0.0.11:4370#SN-SECRETO,Comedor@10.0.0.12:4370',
  }));

  test('trae los campos pedidos', () => {
    const h = buildHealth(resolution, { pushPort: 8080 });

    expect(h.status).toBe('ok');
    expect(h.degraded).toBe(false);
    expect(h.configured_devices).toBe(2);
    expect(h.device_source).toBe(DEVICE_SOURCE.ENV_LIST);
    expect(h.push_server).toEqual({ enabled: true, port: 8080 });
    expect(typeof h.timestamp).toBe('string');
  });

  test('no expone IP, serial ni nombres de reloj', () => {
    const serializado = JSON.stringify(buildHealth(resolution, { pushPort: 8080 }));

    expect(serializado).not.toContain('10.0.0.11');
    expect(serializado).not.toContain('10.0.0.12');
    expect(serializado).not.toContain('SN-SECRETO');
    expect(serializado).not.toContain('Gerencia');
    expect(serializado).not.toContain('Comedor');
  });

  test('no expone ninguna clave del entorno', () => {
    const serializado = JSON.stringify(buildHealth(resolution, { pushPort: 8080 }));
    expect(serializado.toLowerCase()).not.toMatch(/api_key|secret|password|token/);
  });

  test('degradado se nota en el cuerpo', () => {
    const h = buildHealth(resolveDevices(env()), { pushPort: 8080 });

    expect(h.status).toBe('degraded');
    expect(h.degraded).toBe(true);
    expect(h.configured_devices).toBe(0);
    expect(h.device_source).toBe(DEVICE_SOURCE.NONE);
  });

  test('mantiene `devices` como alias del conteo, por compatibilidad', () => {
    const h = buildHealth(resolution, {});
    expect(h.devices).toBe(h.configured_devices);
  });
});

describe('push-status distingue "sin configurar" de "reloj inexistente"', () => {
  test('sin relojes devuelve un resumen de configuración incompleta', () => {
    const s = configurationSummary(resolveDevices(env()));

    expect(s.code).toBe('bridge_not_configured');
    expect(s.configured_devices).toBe(0);
  });

  test('con relojes configurados no hay resumen que devolver', () => {
    const s = configurationSummary(resolveDevices(env({ ZKTECO_DEVICES: '10.0.0.11:4370' })));
    expect(s).toBeNull();
  });
});

describe('validadores', () => {
  test('hosts válidos', () => {
    for (const h of ['10.0.0.11', '192.168.1.1', '127.0.0.1', '203.0.113.10',
      'reloj.local', 'reloj-comedor.empresa.com', 'a']) {
      expect(hostValido(h)).toBe(true);
    }
  });

  test('hosts inválidos', () => {
    for (const h of ['', '999.1.1.1', '10.0.0', '10.0.0.11.5', '-reloj.local',
      'reloj_.local', '10.0.0.256', null, undefined, 42, '1.2.3.04']) {
      expect(hostValido(h)).toBe(false);
    }
  });

  test('rechaza direcciones que no son un destino unicast alcanzable', () => {
    // Validar sólo el rango de los octetos las dejaba pasar, y el polling
    // terminaba intentando conectarse a algo que no es un equipo. Peor:
    // 0.0.0.0 se resuelve al host local en varios sistemas.
    const noUnicast = [
      '0.0.0.0',          // «esta red» — sin especificar
      '0.1.2.3',          // 0.0.0.0/8
      '255.255.255.255',  // broadcast
      '224.0.0.1',        // multicast
      '239.255.255.250',  // multicast (SSDP)
      '240.0.0.1',        // reservada
    ];
    for (const h of noUnicast) expect(hostValido(h)).toBe(false);
  });

  test('una entrada no unicast queda como host_invalid, no como reloj', () => {
    const r = resolveDevices(env({ ZKTECO_DEVICES: 'Falso@0.0.0.0:4370,Real@10.0.0.11:4370' }));

    expect(r.devices.map(d => d.name)).toEqual(['Real']);
    expect(r.problems.map(p => p.code)).toContain(PROBLEM.HOST_INVALID);
  });

  test('puertos válidos e inválidos', () => {
    for (const p of [1, 4370, 65535, '4370', '1']) expect(puertoValido(p)).toBe(true);
    for (const p of [0, -1, 65536, 'abc', '', '43.70', '0x10', '1e3', null, true, 4370.5]) {
      expect(puertoValido(p)).toBe(false);
    }
  });
});

describe('el puerto PUSH se resuelve en un solo lugar', () => {
  // `pushServer` leía PUSH_PORT y el health leía ZKTECO_PUSH_PORT: con la
  // segunda definida, /health anunciaba un puerto en el que nadie escuchaba.
  // El .env.example documentaba justamente el nombre que nadie leía.
  const { resolvePushPort } = require('../src/pushServer');

  test('acepta el nombre documentado', () => {
    expect(resolvePushPort({ ZKTECO_PUSH_PORT: '9090' })).toBe(9090);
  });

  test('mantiene el heredado como alias', () => {
    expect(resolvePushPort({ PUSH_PORT: '9091' })).toBe(9091);
  });

  test('el documentado gana sobre el heredado', () => {
    expect(resolvePushPort({ ZKTECO_PUSH_PORT: '9090', PUSH_PORT: '9091' })).toBe(9090);
  });

  test('sin ninguno, 8080', () => {
    expect(resolvePushPort({})).toBe(8080);
  });

  test('un valor inválido no deja el puerto en NaN', () => {
    for (const v of ['abc', '', '0', '70000', '-1']) {
      expect(resolvePushPort({ ZKTECO_PUSH_PORT: v })).toBe(8080);
    }
  });

  test('health anuncia exactamente el puerto donde escucha el servidor PUSH', () => {
    const env = { ZKTECO_PUSH_PORT: '9090' };
    const h = buildHealth(resolveDevices({ NODE_ENV: 'production', ZKTECO_DEVICES: '10.0.0.11:4370' }),
      { pushPort: resolvePushPort(env) });

    expect(h.push_server.port).toBe(9090);
  });

  test('la variable se lee en un solo lugar, dentro del resolvedor', () => {
    const fs2 = require('fs'), path2 = require('path');
    const src = fs2.readFileSync(path2.join(__dirname, '..', 'src', 'pushServer.js'), 'utf8');
    const idx = fs2.readFileSync(path2.join(__dirname, '..', 'src', 'index.js'), 'utf8');

    // Cada nombre se lee exactamente una vez, y sólo dentro de resolvePushPort.
    expect(src.match(/env\.ZKTECO_PUSH_PORT/g) || []).toHaveLength(1);
    expect(src.match(/env\.PUSH_PORT/g) || []).toHaveLength(1);

    const cuerpo = src.slice(src.indexOf('function resolvePushPort'), src.indexOf('function startPushServer'));
    expect(cuerpo).toContain('env.ZKTECO_PUSH_PORT');
    expect(cuerpo).toContain('env.PUSH_PORT');

    // index.js no vuelve a leerla: usa el resolvedor.
    expect(idx).not.toMatch(/process\.env\.(ZKTECO_)?PUSH_PORT/);
    expect(idx).toContain('resolvePushPort()');
  });
});
