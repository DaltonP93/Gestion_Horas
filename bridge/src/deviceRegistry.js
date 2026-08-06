/**
 * deviceRegistry.js — resolución y validación de los relojes del Bridge.
 *
 * ── Fuente canónica ACTUAL (inventario, antes de cambiar nada) ────────
 *
 * El Bridge NO consulta MySQL. No tiene `mysql2` ni `sequelize` entre sus
 * dependencias y nunca abrió una conexión a la base. Su única fuente de
 * relojes es el entorno del proceso. Conviene decirlo explícito porque es
 * fácil suponer lo contrario:
 *
 *   | Superficie              | ¿Configura relojes del Bridge?              |
 *   |-------------------------|---------------------------------------------|
 *   | `ZKTECO_DEVICES` (.env) | SÍ — única fuente real                      |
 *   | `DEFAULT_DEVICES`       | SÍ — el fallback que este módulo elimina    |
 *   | `bridge/.env`           | SÍ, vía dotenv (hoy no define ZKTECO_DEVICES)|
 *   | PM2 `ecosystem.config`  | Sólo BRIDGE_API_PORT y BRIDGE_BIND          |
 *   | MySQL tabla `devices`   | NO para el Bridge — la usan API y worker    |
 *   | `discovery.js`          | NO — escanea la LAN bajo demanda, no registra|
 *
 * Los relojes de MySQL (`devices`) alimentan al sync-worker y a la API por
 * caminos propios. Son DOS espacios de identificadores distintos que hoy no se
 * cruzan, y este PR no los cruza: cambiar el Bridge para que lea MySQL es una
 * decisión de arquitectura aparte, no un efecto colateral de arreglar el
 * fallback.
 *
 * ── El problema que se corrige ────────────────────────────────────────
 *
 * `DEFAULT_DEVICES` inventaba un "Reloj test" cuando faltaba configuración.
 * En producción eso significaba que `/health` informaba `devices: 1` sin que
 * existiera ningún reloj: health, push-status y cualquier Outbox futuro
 * quedaban mintiendo con una IP que no es de nadie. Un Bridge sin relojes
 * configurados tiene que decir que no tiene relojes.
 */

'use strict';

/** Formatos aceptados por ZKTECO_DEVICES. */
const DEVICE_SOURCE = Object.freeze({
  ENV_LIST:  'zkteco_devices_env',
  TEST_ONLY: 'test_device_explicit',
  NONE:      'none',
});

const PROBLEM = Object.freeze({
  EMPTY_ENTRY:       'entry_empty',
  DELIMITER_INVALID: 'delimiter_invalid',
  HOST_INVALID:      'host_invalid',
  PORT_INVALID:      'port_invalid',
  NAME_INVALID:      'name_invalid',
  DUPLICATE_ADDRESS: 'duplicate_address',
  DUPLICATE_SERIAL:  'duplicate_serial',
  DUPLICATE_NAME:    'duplicate_name',
  JSON_INVALID:      'json_invalid',
  TEST_DEVICE_IN_PRODUCTION: 'test_device_refused_in_production',
});

const PORT_MIN = 1;
const PORT_MAX = 65535;
const DEFAULT_PORT = 4370;
const MAX_NAME = 60;
const MAX_SERIAL = 64;

/** Reloj ficticio — sólo fuera de producción y sólo con la flag explícita. */
const TEST_DEVICE = Object.freeze({
  id: 999, name: 'Reloj de prueba', ip: '127.0.0.1', port: DEFAULT_PORT, serial: null, test: true,
});

// ── Validadores ──────────────────────────────────────────────────────

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// Hostname RFC 1123: etiquetas alfanuméricas con guiones internos.
const HOSTNAME = /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function hostValido(host) {
  if (typeof host !== 'string' || !host) return false;
  const m = host.match(IPV4);
  if (m) {
    // Un IPv4 tiene que tener octetos en rango: '999.1.1.1' matchea el regex
    // pero no es una dirección. Se compara la forma NORMALIZADA contra el texto
    // original para rechazar ceros a la izquierda ('1.2.3.04'), que según la
    // implementación se interpretan como octal.
    return m.slice(1).every((o) => {
      const n = Number(o);
      return String(n) === o && n >= 0 && n <= 255;
    });
  }
  // Un hostname puramente numérico con puntos sería un IPv4 mal formado, no un
  // nombre: se rechaza en lugar de dejarlo pasar como host DNS.
  if (/^[\d.]+$/.test(host)) return false;
  return HOSTNAME.test(host);
}

function puertoValido(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= PORT_MIN && v <= PORT_MAX;
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!/^\d+$/.test(s)) return false;           // '4370abc', '43.70', '0x10', ''
  const n = Number(s);
  return n >= PORT_MIN && n <= PORT_MAX;
}

// ── Parseo ───────────────────────────────────────────────────────────

/**
 * Una entrada del formato CSV: `[nombre@]host[:puerto][#serial]`
 *
 * `10.0.0.5:4370` sigue funcionando igual que antes. El nombre y el serial son
 * opcionales y existen porque los relojes reales tienen nombre propio
 * (Gerencia, Comedor, Lavadero) y el `Reloj 1` que generaba el parser viejo no
 * sirve para operar ni para leer un log.
 */
function parseEntrada(raw, indice) {
  const problemas = [];
  const texto = String(raw).trim();

  if (!texto) {
    return { problemas: [{ code: PROBLEM.EMPTY_ENTRY, entry: indice }] };
  }

  // Delimitadores mal usados: se detectan antes de intentar interpretar nada,
  // porque un `;` o un `@` de más produce silenciosamente un host absurdo.
  if ((texto.match(/@/g) || []).length > 1) {
    problemas.push({ code: PROBLEM.DELIMITER_INVALID, entry: indice, detail: 'más de un "@"' });
  }
  if ((texto.match(/#/g) || []).length > 1) {
    problemas.push({ code: PROBLEM.DELIMITER_INVALID, entry: indice, detail: 'más de un "#"' });
  }
  if (/[;|]/.test(texto)) {
    problemas.push({ code: PROBLEM.DELIMITER_INVALID, entry: indice, detail: 'separador debe ser ","' });
  }
  if (problemas.length) return { problemas };

  let resto = texto;
  let name = null;
  let serial = null;

  const corteSerial = resto.indexOf('#');
  if (corteSerial !== -1) {
    serial = resto.slice(corteSerial + 1).trim() || null;
    resto = resto.slice(0, corteSerial).trim();
  }
  const corteNombre = resto.indexOf('@');
  if (corteNombre !== -1) {
    name = resto.slice(0, corteNombre).trim();
    resto = resto.slice(corteNombre + 1).trim();
    // Un '@' con nada delante es una entrada mal escrita, no un nombre omitido:
    // para omitirlo se escribe la dirección sola.
    if (!name) {
      return { problemas: [{ code: PROBLEM.DELIMITER_INVALID, entry: indice, detail: 'nombre vacío antes de "@"' }] };
    }
  }

  if (name !== null && (name.length > MAX_NAME || /[\r\n\t]/.test(name))) {
    return { problemas: [{ code: PROBLEM.NAME_INVALID, entry: indice }] };
  }
  if (serial !== null && (serial.length > MAX_SERIAL || !/^[\w-]+$/.test(serial))) {
    return { problemas: [{ code: PROBLEM.DUPLICATE_SERIAL, entry: indice, detail: 'serial inválido' }] };
  }

  // El host puede traer puerto. Se parte por el ÚLTIMO ':' para no romper un
  // hostname con ':' (no debería tenerlo, pero el corte por el último es el
  // que no sorprende).
  let host = resto;
  let port = DEFAULT_PORT;
  const cortePuerto = resto.lastIndexOf(':');
  if (cortePuerto !== -1) {
    host = resto.slice(0, cortePuerto).trim();
    const puertoTexto = resto.slice(cortePuerto + 1).trim();
    if (!puertoValido(puertoTexto)) {
      return { problemas: [{ code: PROBLEM.PORT_INVALID, entry: indice, detail: puertoTexto.slice(0, 20) }] };
    }
    port = Number(puertoTexto);
  }

  if (!hostValido(host)) {
    return { problemas: [{ code: PROBLEM.HOST_INVALID, entry: indice }] };
  }

  return { device: { name, ip: host, port, serial } };
}

/** Forma JSON: `[{"name":"Gerencia","ip":"10.0.0.5","port":4370,"serial":"ABC"}]` */
function parseJson(texto) {
  let crudo;
  try {
    crudo = JSON.parse(texto);
  } catch {
    return { problemas: [{ code: PROBLEM.JSON_INVALID }] };
  }
  if (!Array.isArray(crudo)) return { problemas: [{ code: PROBLEM.JSON_INVALID, detail: 'no es un array' }] };

  const devices = [];
  const problemas = [];
  crudo.forEach((d, i) => {
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      problemas.push({ code: PROBLEM.EMPTY_ENTRY, entry: i });
      return;
    }
    const port = d.port === undefined || d.port === null ? DEFAULT_PORT : d.port;
    if (!puertoValido(port)) {
      problemas.push({ code: PROBLEM.PORT_INVALID, entry: i });
      return;
    }
    if (!hostValido(d.ip)) {
      problemas.push({ code: PROBLEM.HOST_INVALID, entry: i });
      return;
    }
    const name = d.name ? String(d.name).trim() : null;
    if (name && name.length > MAX_NAME) {
      problemas.push({ code: PROBLEM.NAME_INVALID, entry: i });
      return;
    }
    devices.push({ name, ip: d.ip, port: Number(port), serial: d.serial ? String(d.serial).trim() : null });
  });
  return { devices, problemas };
}

// ── Resolución ───────────────────────────────────────────────────────

/**
 * Resuelve los relojes desde el entorno.
 *
 * Devuelve SIEMPRE una forma completa — nunca lanza. Un Bridge que no puede
 * resolver sus relojes tiene que levantar igual para responder /health y decir
 * que está degradado; caerse deja al operador sin forma de preguntar qué pasa.
 */
function resolveDevices(env = process.env) {
  const crudo = (env.ZKTECO_DEVICES || '').trim();
  const enProduccion = env.NODE_ENV === 'production';
  const permiteTest = env.BRIDGE_ALLOW_TEST_DEVICE === 'true';

  const problemas = [];
  let candidatos = [];

  if (crudo) {
    const r = crudo.startsWith('[')
      ? parseJson(crudo)
      : crudo.split(',').reduce((acc, entrada, i) => {
        const res = parseEntrada(entrada, i);
        if (res.device) acc.devices.push(res.device);
        if (res.problemas) acc.problemas.push(...res.problemas);
        return acc;
      }, { devices: [], problemas: [] });

    candidatos = r.devices || [];
    problemas.push(...(r.problemas || []));
  }

  // Duplicados: se descarta la repetición y se conserva la primera aparición.
  const porDireccion = new Set();
  const porSerial = new Set();
  const porNombre = new Set();
  const devices = [];

  candidatos.forEach((d, i) => {
    const direccion = `${d.ip}:${d.port}`;
    if (porDireccion.has(direccion)) {
      problemas.push({ code: PROBLEM.DUPLICATE_ADDRESS, entry: i });
      return;
    }
    if (d.serial && porSerial.has(d.serial)) {
      problemas.push({ code: PROBLEM.DUPLICATE_SERIAL, entry: i });
      return;
    }
    if (d.name && porNombre.has(d.name.toLowerCase())) {
      problemas.push({ code: PROBLEM.DUPLICATE_NAME, entry: i });
      return;
    }
    porDireccion.add(direccion);
    if (d.serial) porSerial.add(d.serial);
    if (d.name) porNombre.add(d.name.toLowerCase());

    devices.push({
      id: devices.length + 1,
      name: d.name || `Reloj ${devices.length + 1}`,
      ip: d.ip,
      port: d.port,
      serial: d.serial,
      test: false,
    });
  });

  if (devices.length > 0) {
    return { devices, source: DEVICE_SOURCE.ENV_LIST, degraded: false, problems: problemas };
  }

  // Sin relojes reales. El reloj de prueba NO es un fallback: hay que pedirlo.
  if (permiteTest) {
    if (enProduccion) {
      // Ni con la flag. Es la regla que este módulo existe para sostener.
      problemas.push({ code: PROBLEM.TEST_DEVICE_IN_PRODUCTION });
      return { devices: [], source: DEVICE_SOURCE.NONE, degraded: true, problems: problemas };
    }
    return {
      devices: [{ ...TEST_DEVICE }],
      source: DEVICE_SOURCE.TEST_ONLY,
      degraded: false,
      problems: problemas,
    };
  }

  return { devices: [], source: DEVICE_SOURCE.NONE, degraded: true, problems: problemas };
}

// ── Health ───────────────────────────────────────────────────────────

/**
 * Cuerpo de /health. Sin IP, sin serial, sin nombres de reloj, sin claves.
 *
 * /health no lleva autenticación: es lo primero que ve cualquiera que alcance
 * el puerto. Un conteo y un estado alcanzan para operar; una lista de IPs y
 * seriales es un mapa de la red interna.
 *
 * Se mantiene `devices` como alias del conteo por compatibilidad: la API ya
 * consultaba este endpoint y no conviene romperle la forma en el mismo PR que
 * corrige el registro.
 */
function buildHealth(resolution, opts = {}) {
  const { devices, source, degraded, problems } = resolution;
  return {
    status: degraded ? 'degraded' : 'ok',
    degraded: Boolean(degraded),
    configured_devices: devices.length,
    devices: devices.length,            // alias de compatibilidad
    device_source: source,
    config_problems: problems.length,
    push_server: {
      enabled: opts.pushEnabled !== false,
      port: opts.pushPort ?? null,
    },
    timestamp: new Date().toISOString(),
  };
}

/** Motivo legible para push-status cuando no hay configuración. */
function configurationSummary(resolution) {
  if (resolution.devices.length > 0) return null;
  return {
    code: 'bridge_not_configured',
    device_source: resolution.source,
    configured_devices: 0,
    config_problems: resolution.problems.length,
  };
}

module.exports = {
  resolveDevices,
  buildHealth,
  configurationSummary,
  DEVICE_SOURCE,
  PROBLEM,
  DEFAULT_PORT,
  hostValido,
  puertoValido,
};
