/**
 * deviceIdentity.js — cómo se identifica un reloj, en UN solo lugar.
 *
 * ── Por qué existe ───────────────────────────────────────────────────
 *
 * Estas reglas nacieron dentro de `shadow.js`, para decidir sobre qué reloj se
 * acumula una copia de observaciones. Ahora el servidor PUSH necesita decidir
 * lo mismo —sobre qué reloj se suprime la publicación— y son exactamente la
 * misma pregunta: "¿este marcaje viene del reloj que nombré en la allowlist?".
 *
 * Tenerlas duplicadas sería peor que tenerlas en un módulo aparte. Si la
 * canonización divergiera entre los dos consumidores, un reloj podría quedar
 * en modo observación para la sombra y NO para el PUSH: se guardaría la copia
 * y además se publicaría la marcación, que es la combinación exacta que el
 * experimento existe para evitar.
 *
 * ── Qué NO decide este módulo ────────────────────────────────────────
 *
 * Nada sobre qué se hace con el reloj una vez identificado. Sólo responde
 * quién es y si está nombrado en una lista. La consecuencia —observar,
 * suprimir la publicación, las dos cosas— la decide quien pregunta.
 */

'use strict';

const crypto = require('crypto');

/** Cómo se resolvió el reloj contra la configuración. */
const MATCH = Object.freeze({
  SERIAL:    'serial',
  IP:        'ip',
  AMBIGUOUS: 'ambiguous',
  NONE:      'none',
});

/**
 * Tokens de una allowlist de relojes.
 *
 * Cada token puede nombrar al reloj por serial, por nombre (el de
 * `ZKTECO_DEVICES`) o por IP. Se comparan sin distinguir mayúsculas porque los
 * tres se tipean a mano en un `.env`.
 *
 * VACÍA SIGNIFICA NADIE, nunca "todos". Es la asimetría deliberada con
 * `ZKTECO_PUSH_WHITELIST`: aquella filtra quién puede marcar —abrirla de más
 * deja pasar relojes—, y estas listas activan un tratamiento especial sobre un
 * reloj concreto. El valor por defecto de un tratamiento especial es que no se
 * le aplica a nadie.
 */
function parseAllowlist(crudo) {
  return String(crudo || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Serial en forma canónica.
 *
 * La comparación con la allowlist y con `ZKTECO_DEVICES` ignora mayúsculas,
 * así que `ger-0001` y `GER-0001` son el MISMO reloj para decidir. La clave
 * derivada tiene que serlo también: si conservara el texto original, ese mismo
 * reloj produciría dos `device_id` distintos —la clave se hashea— y por lo
 * tanto dos `event_id` distintos para el mismo marcaje.
 *
 * El caso concreto no es teórico: el serial que el reloj anuncia por PUSH y el
 * que un operador tipea en `ZKTECO_DEVICES` para el polling son dos textos
 * escritos por manos distintas.
 */
function canonicalSerial(v) {
  return String(v || '').trim().toUpperCase();
}

function hashDireccion(ip, port) {
  return crypto.createHash('sha256').update(`${ip}:${port}`, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Clave estable del reloj.
 *
 * Preferencia: el serial que el propio reloj reporta, que no depende de la
 * configuración del Bridge ni cambia si al reloj le cambian la IP.
 *
 * Sin serial se cae a la dirección, pero HASHEADA. La IP es topología de red:
 * se usa para correlacionar y no se guarda. Escribirla en claro la persistiría
 * en `device_key` y la devolvería `stats()` en `by_device`.
 */
function stableDeviceKey({ sn, device }) {
  const serial = canonicalSerial(sn) || canonicalSerial(device?.serial);
  if (serial) return `sn:${serial}`;
  if (device?.ip) return `addr:${hashDireccion(device.ip, device.port)}`;
  return null;
}

/**
 * Resuelve qué reloj configurado corresponde a una observación.
 *
 * Devuelve `{ device, ambiguous, matchedBy }`. `ambiguous` es la parte que
 * importa: cuando la resolución NO es concluyente se dice, en vez de devolver
 * el primero que coincida y dejar que el llamador crea que acertó.
 *
 * El caso real es el de la IP. `resolveDevices` rechaza direcciones repetidas
 * (`ip:puerto`), pero NO dos relojes en la misma IP con puertos distintos
 * —`A@10.0.0.11:4370,B@10.0.0.11:4371` es configuración válida—. Si un reloj
 * hace PUSH sin declarar serial, esa IP no alcanza para saber cuál de los dos
 * es. Elegir el primero significaría, para el PUSH observe-only, suprimir la
 * publicación del reloj equivocado y perder sus marcaciones en silencio.
 *
 * No encontrar coincidencia NO es ambiguo: por PUSH el reloj se anuncia solo y
 * puede perfectamente no estar en `ZKTECO_DEVICES`.
 */
function resolveDevice({ sn, ip }, devices = []) {
  const serial = canonicalSerial(sn);

  // Candidatos para la búsqueda por IP. Arrancan siendo todos y se recortan
  // sólo si el reloj declaró un serial que no coincide con ninguno.
  let candidatos = devices;

  if (serial) {
    const porSerial = devices.filter(d => canonicalSerial(d.serial) === serial);
    if (porSerial.length === 1) return { device: porSerial[0], ambiguous: false, matchedBy: MATCH.SERIAL };
    if (porSerial.length > 1)  return { device: null, ambiguous: true, matchedBy: MATCH.AMBIGUOUS };

    // ── Sin coincidencia por serial: se sigue por IP ──────────────────
    //
    // En `ZKTECO_DEVICES` el `#serial` es OPCIONAL y el formato habitual no lo
    // lleva (`Gerencia@10.0.0.11:4370`). El POST ADMS sí trae `SN`, así que
    // cortar acá dejaría sin resolver al reloj entero: una allowlist por
    // nombre —la que recomiendan el `.env.example` y la documentación— no
    // activaría observe-only y el reloj volvería a publicar asistencia, que es
    // exactamente lo que este modo existe para impedir.
    //
    // Pero los candidatos se recortan a los que NO declaran serial: un reloj
    // configurado con un serial DISTINTO del reportado es demostrablemente
    // otro aparato, y emparejarlo por compartir la IP sería atribuir el
    // marcaje al reloj equivocado.
    candidatos = devices.filter(d => !canonicalSerial(d.serial));
  }

  const dir = String(ip || '').trim();
  if (dir) {
    const porIp = candidatos.filter(d => d.ip === dir);
    if (porIp.length === 1) return { device: porIp[0], ambiguous: false, matchedBy: MATCH.IP };
    if (porIp.length > 1)  return { device: null, ambiguous: true, matchedBy: MATCH.AMBIGUOUS };
  }

  return { device: null, ambiguous: false, matchedBy: MATCH.NONE };
}

/** Reloj configurado, o null. Envoltura de `resolveDevice` para quien no necesita el motivo. */
function findConfiguredDevice(observacion, devices = []) {
  return resolveDevice(observacion, devices).device;
}

/**
 * ¿Está este reloj explícitamente nombrado en la allowlist?
 *
 * Se acepta que el token nombre el serial reportado aunque el reloj no esté en
 * `ZKTECO_DEVICES`: por PUSH el reloj se anuncia solo, y exigir que además
 * esté declarado agregaría un modo de fallo silencioso.
 */
function isDeviceAllowed({ sn, ip, device }, allowlist = []) {
  if (allowlist.length === 0) return false;   // vacía = nadie

  const candidatos = [
    String(sn || '').trim(),
    device?.serial,
    device?.name,
    device?.ip,
    ip,
  ]
    .map(v => String(v || '').trim().toLowerCase())
    .filter(Boolean);

  return candidatos.some(c => allowlist.includes(c));
}

/**
 * ¿Cae este reloj dentro de la allowlist dada? Resolución completa en un paso.
 *
 * Devuelve `{ allowed, ambiguous, device }`. Un reloj ambiguo NUNCA queda
 * dentro: no se le puede aplicar un tratamiento especial a un reloj que no se
 * pudo identificar.
 */
function matchesAllowlist({ sn, ip }, devices, allowlist) {
  if (!allowlist || allowlist.length === 0) {
    return { allowed: false, ambiguous: false, device: null };
  }
  const { device, ambiguous } = resolveDevice({ sn, ip }, devices);
  if (ambiguous) return { allowed: false, ambiguous: true, device: null };

  return { allowed: isDeviceAllowed({ sn, ip, device }, allowlist), ambiguous: false, device };
}

/** IPv4 en notación decimal. Deliberadamente laxa: sólo distingue número de nombre. */
const ES_IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * ¿Se puede identificar este reloj cuando llegue su PUSH?
 *
 * En una petición PUSH sólo hay dos datos: el `SN` que el reloj declara y la
 * dirección numérica desde la que llega. Un reloj configurado se puede
 * enganchar a eso de dos maneras:
 *
 *   · declara `#serial` → coincide con el SN, sin depender de la red;
 *   · su host es una IP numérica → coincide con la dirección de origen.
 *
 * `ZKTECO_DEVICES` también admite hostnames (`Gerencia@reloj.local:4370`). Un
 * reloj configurado así y SIN serial no se puede resolver: `d.ip` guarda el
 * texto del hostname y la petición trae un número, y esa comparación no
 * coincide nunca. Nombrarlo por su NOMBRE en una allowlist no surtiría efecto
 * — y en observe-only eso significa que el reloj publica asistencia igual.
 */
function esIdentificableEnPush(device) {
  if (!device) return false;
  if (canonicalSerial(device.serial)) return true;
  return ES_IPV4.test(String(device.ip || '').trim());
}

/**
 * Revisa que cada token de una allowlist pueda surtir efecto de verdad.
 *
 * Existe porque el modo de fallo natural de estas listas es SILENCIOSO: un
 * token que no engancha con nada no produce ningún error, simplemente no
 * aplica, y en observe-only eso se traduce en un reloj que sigue publicando
 * asistencia mientras el operador cree haberlo puesto en observación.
 *
 * Un token que no coincide con ningún reloj configurado NO es un problema: por
 * PUSH el reloj se anuncia solo, y nombrarlo por su serial funciona aunque no
 * esté en `ZKTECO_DEVICES`. El problema es el token que SÍ nombra a un reloj
 * configurado que después no se va a poder identificar.
 */
function auditAllowlist(allowlist = [], devices = []) {
  const problemas = [];

  for (const token of allowlist) {
    const porNombre = devices.filter(d => String(d.name || '').trim().toLowerCase() === token);
    const porHost   = devices.filter(d => String(d.ip || '').trim().toLowerCase() === token);
    const porSerial = devices.filter(d => canonicalSerial(d.serial) === canonicalSerial(token));

    // Nombrado por serial: siempre funciona, el SN llega en cada PUSH.
    if (porSerial.length > 0) continue;

    const nombrados = [...porNombre, ...porHost];
    if (nombrados.length === 0) continue;   // se resolverá por el SN reportado

    if (nombrados.every(d => !esIdentificableEnPush(d))) {
      problemas.push({
        token,
        code: 'token_no_identificable',
        detail: 'el reloj se configuró con hostname y sin #serial: declarar el serial',
      });
    }
  }

  return problemas;
}

module.exports = {
  MATCH,
  esIdentificableEnPush,
  auditAllowlist,
  parseAllowlist,
  canonicalSerial,
  stableDeviceKey,
  hashDireccion,
  resolveDevice,
  findConfiguredDevice,
  isDeviceAllowed,
  matchesAllowlist,
};
