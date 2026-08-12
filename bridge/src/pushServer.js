/**
 * pushServer.js
 * Servidor HTTP para recibir datos en modo PUSH desde relojes ZKTeco.
 *
 * Configuración en el reloj ZKTeco:
 *   - Comm → Cloud Server Setting (ADMS)
 *   - Server Address: IP del servidor Bridge
 *   - Server Port: 8080
 *   - HTTPS: OFF — Proxy: OFF
 *   - Reboot del reloj
 *
 * El reloj hace GET a /iclock/cdata para registrarse, luego
 * POST a /iclock/cdata con los marcajes en formato TSV (text/plain).
 */

const express = require('express');
const { parseAllowlist, matchesAllowlist } = require('./deviceIdentity');
const { parseAttlogLine, lineasDe } = require('./attlog');

// Estado en memoria: último heartbeat y último marcaje recibido por SN/IP
const pushState = {};   // { [sn]: { lastSeen, lastPunch, punches, ip, observeOnly } }

/**
 * Contadores agregados del proceso. Sólo números: ni código de empleado, ni
 * IP, ni payload, ni nada que identifique a una persona.
 */
const pushMetrics = {
  observe_only_received: 0,
  observe_only_suppressed_publish: 0,
  observe_only_ambiguous: 0,

  // Recepción de ATTLOG. Sin estos contadores, un cuerpo que no parsea se ve
  // igual que un reloj sin tráfico: el reloj recibe OK, no hay error en el log
  // y la sombra queda en cero. Es exactamente cómo se perdió tiempo con el
  // Content-Type ausente.
  attlog_lines_received: 0,
  attlog_lines_valid: 0,
  attlog_malformed_fields: 0,
  attlog_invalid_timestamp: 0,
};

function resetPushMetrics() {
  for (const k of Object.keys(pushMetrics)) pushMetrics[k] = 0;
}

/**
 * Relojes en modo OBSERVE-ONLY: se recibe su PUSH y se observa, pero NO se
 * publica su asistencia.
 *
 * ── Por qué hace falta ───────────────────────────────────────────────
 *
 * La sombra es pasiva, pero el servidor sobre el que cuelga no lo es: después
 * de `shadow.capture()` viene `publishAttendance()`, que hace XADD a
 * `stream:attendance` y PUBLISH a `attendance:new`. Configurar un reloj para
 * ADMS con la sombra encendida no lo convertiría en un observado: lo
 * convertiría en un SEGUNDO PRODUCTOR de asistencia mientras el polling sigue
 * siendo el autoritativo. Eso es justo lo que el experimento existe para
 * evitar.
 *
 * `BRIDGE_SHADOW_ENABLED=true` NO implica observe-only. Son dos decisiones
 * distintas y se toman por separado: una dice qué se guarda para comparar, la
 * otra dice qué NO se publica.
 *
 * ── Por reloj, nunca global ──────────────────────────────────────────
 *
 * Una flag global podría apagar la publicación de relojes que sí deben
 * publicar, y esa pérdida sería silenciosa: el reloj recibe OK, el operador ve
 * marcajes llegando y la asistencia simplemente no aparece. Por eso es una
 * allowlist por identidad estable, vacía por defecto.
 */
function getObserveOnlyAllowlist(env = process.env) {
  return parseAllowlist(env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST);
}

function mapZKStatus(status) {
  const n = parseInt(status);
  const map = { 0: 'in', 1: 'out', 2: 'break_start', 3: 'break_end', 4: 'in', 5: 'out' };
  return map[n] ?? 'unknown';
}

// Whitelist de SN autorizados (opcional — si está vacío, todos permitidos)
function getWhitelist() {
  const wl = process.env.ZKTECO_PUSH_WHITELIST || '';
  return wl.split(',').map(s => s.trim()).filter(Boolean);
}

function isAllowed(sn) {
  const wl = getWhitelist();
  if (wl.length === 0) return true;
  return wl.includes(String(sn));
}

/**
 * Puerto del servidor PUSH — UNA sola forma de resolverlo.
 *
 * Acá se leía `PUSH_PORT` mientras el health del Bridge leía
 * `ZKTECO_PUSH_PORT`: con la segunda definida, /health anunciaba un puerto en
 * el que nadie escuchaba. Se acepta el nombre documentado y se mantiene el
 * heredado como alias para no romper una instalación que ya lo use.
 */
function resolvePushPort(env = process.env) {
  const crudo = env.ZKTECO_PUSH_PORT || env.PUSH_PORT || '8080';
  const n = parseInt(String(crudo).trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 8080;
}

function startPushServer(publishAttendance, logger, opts = {}) {
  const { redis, shadow = null, devices = [] } = opts;
  const app = express();

  /**
   * ¿Este reloj está en modo observe-only?
   *
   * Se lee del entorno en cada consulta, igual que `ZKTECO_PUSH_WHITELIST`:
   * un `pm2 reload` basta para cambiarlo y no hay estado que se desincronice.
   *
   * La identidad la resuelve `deviceIdentity`, el MISMO módulo que usa la
   * sombra. Si las reglas divergieran, un reloj podría quedar observado por la
   * sombra y publicado por el PUSH a la vez — la combinación exacta que esto
   * viene a impedir.
   *
   * Un reloj que no se puede identificar sin ambigüedad NO entra: suprimir la
   * publicación del reloj equivocado perdería sus marcaciones en silencio.
   */
  function esObserveOnly(sn, ip) {
    const allowlist = getObserveOnlyAllowlist();
    if (allowlist.length === 0) return false;   // vacía = comportamiento histórico

    const r = matchesAllowlist({ sn, ip }, devices, allowlist);
    if (r.ambiguous) {
      pushMetrics.observe_only_ambiguous++;
      // Sin IP ni serial en el log: alcanza con saber que pasó.
      logger.warn('⚠️  PUSH observe-only: reloj no identificable sin ambigüedad, se procesa normal');
      return false;
    }
    return r.allowed;
  }

  /**
   * Copia en modo sombra — best-effort y sin efecto sobre el PUSH.
   *
   * `shadow.capture()` ya se compromete a no lanzar; este try/catch existe
   * igual porque la garantía que importa se sostiene ACÁ: si la observación
   * llegara a fallar de una forma no prevista, la marcación tiene que seguir
   * su camino de todos modos. Sin `shadow` en las opciones esto es una
   * comparación contra null y nada más.
   */
  function observarEnSombra(observacion) {
    if (!shadow) return;
    try { shadow.capture(observacion, { source: 'push' }); } catch { /* nunca corta el PUSH */ }
  }

  // Dedupe vía Redis SET con TTL — clave: push:dedupe:<SN>:<userId>:<timestamp>
  async function alreadySeen(sn, userId, ts) {
    if (!redis?.isReady) return false;
    const key = `push:dedupe:${sn}:${userId}:${ts}`;
    try {
      // SET NX con TTL 24 h: si la clave ya existía, devuelve null
      const set = await redis.set(key, '1', { NX: true, EX: 86400 });
      return set === null; // null = ya existía = duplicado
    } catch (e) {
      logger.warn(`dedupe Redis falló: ${e.message}`);
      return false;
    }
  }

  /**
   * Cuerpo de /iclock: SIEMPRE texto, decidido por la ruta y no por el header.
   *
   * ── Por qué una función y no el comodín ──────────────────────────────
   *
   * El firmware ZKTeco NO envía `Content-Type`. Verificado contra una captura
   * de tráfico real: el POST llega con `Content-Length` y `User-Agent: iClock
   * Proxy`, y ningún Content-Type.
   *
   * `express.text({ type: '*∕*' })` parece aceptar todo, pero no: body-parser
   * resuelve `type` CONTRA el Content-Type de la petición, así que sin ese
   * header no hay nada que comparar y no parsea — `req.body` queda en `{}`.
   * El comodín cubre "cualquier tipo declarado", no "tipo ausente".
   *
   * La función decide por ruta: este middleware está montado sólo en
   * `/iclock`, así que el alcance es el del reloj y nada más. Un GET sin
   * cuerpo lo saltea igual, porque body-parser exige `Content-Length` o
   * `Transfer-Encoding` antes de llamar a `type`.
   *
   * No se infiere el tipo del contenido: el aparato que hay que soportar es
   * justamente el que no lo declara.
   */
  app.use('/iclock', express.text({ type: () => true, limit: '5mb' }));

  // Registro inicial del reloj
  app.get('/iclock/cdata', (req, res) => {
    const { SN, options } = req.query;
    const ip = req.ip?.replace(/^::ffff:/, '');

    if (!isAllowed(SN)) {
      logger.warn(`⛔ SN=${SN} (${ip}) rechazado — no está en ZKTECO_PUSH_WHITELIST`);
      return res.status(403).type('text/plain').send('FORBIDDEN');
    }

    pushState[SN] = { ...(pushState[SN] || {}), lastSeen: new Date().toISOString(), ip };
    logger.info(`🔌 Reloj ZKTeco registrado vía PUSH — SN: ${SN} (${ip})`);

    res.type('text/plain').send([
      `GET OPTION FROM: ${SN}`,
      'ATTLOGStamp=None',
      'OPERLOGStamp=9999',
      'ATTPHOTOStamp=None',
      'ErrorDelay=30',
      'Delay=1',
      'TransTimes=00:00;14:05',
      'TransInterval=1',
      'TransFlag=TransData AttLog OpLog',
      'TimeZone=-3',
      'Realtime=1',
      'Encrypt=None'
    ].join('\n'));
  });

  // POST con los marcajes
  app.post('/iclock/cdata', async (req, res) => {
    const { SN, table } = req.query;
    const ip = req.ip?.replace(/^::ffff:/, '');

    if (!isAllowed(SN)) {
      return res.status(403).type('text/plain').send('FORBIDDEN');
    }

    // `lineasDe` sólo acepta texto (string o Buffer). El `.toString()` que
    // había acá convertía el `{}` de un cuerpo no parseado en la cadena
    // "[object Object]", que se contaba como una línea ATTLOG ilegible.
    const lines = lineasDe(req.body);
    pushState[SN] = { ...(pushState[SN] || {}), lastSeen: new Date().toISOString(), ip };

    // Se resuelve UNA vez por lote, no por línea: todas las líneas de un POST
    // vienen del mismo reloj.
    const observeOnly = esObserveOnly(SN, ip);
    if (observeOnly) pushState[SN].observeOnly = true;

    if (table === 'ATTLOG') {
      // Se marca la recepción del POST aunque no haya ni una línea legible: es
      // lo que distingue "el reloj no habla" de "el reloj habla y no lo
      // entendemos".
      pushState[SN].lastAttlogReceived = new Date().toISOString();
      let parsed = 0, deduped = 0, observados = 0, validas = 0;

      pushMetrics.attlog_lines_received += lines.length;

      for (const line of lines) {
        const campos = parseAttlogLine(line);
        if (!campos.ok) {
          if (campos.motivo === 'timestamp_invalido') pushMetrics.attlog_invalid_timestamp++;
          else pushMetrics.attlog_malformed_fields++;
          continue;
        }
        pushMetrics.attlog_lines_valid++;
        validas++;

        // Ya vienen recortados y validados por `parseAttlogLine`.
        const userId = campos.deviceUserId;
        const timestamp = campos.occurredAtRaw;
        const { status, verify, workCode } = campos;
        try {
          // `parseAttlogLine` ya garantizó forma y rangos, así que esto no
          // puede quedar en Invalid Date. La validación vive allá, donde se
          // puede probar sin levantar el servidor.
          const ts = new Date(timestamp.replace(' ', 'T'));

          // La sombra observa ANTES del dedupe de Redis, a propósito: mide lo
          // que el reloj emitió, no lo que este pipeline decidió conservar.
          // Filtrar acá la volvería ciega justamente a los reenvíos que se
          // quiere cuantificar. Su idempotencia es propia (UNIQUE por
          // (source, event_id)), así que un reenvío suma a `duplicates` en vez
          // de duplicar la fila.
          //
          // Se le pasa la hora de pared CRUDA del reloj, no `ts`: `ts` ya
          // quedó anclado a la zona del proceso y el contrato v1 existe para
          // no arrastrar esa dependencia.
          observarEnSombra({
            sn: SN,
            ip,
            deviceUserId: userId,
            occurredAtRaw: timestamp,
            eventType: mapZKStatus(status),
            verifyMode: verify,
            workCode: workCode,
          });

          // ── OBSERVE-ONLY: acá termina el recorrido ──────────────────
          //
          // Se corta ANTES del dedupe de Redis, no sólo antes de publicar. El
          // dedupe hace SET NX, que es una ESCRITURA: dejarlo correr metería
          // en Redis claves de un reloj que por definición no está
          // produciendo asistencia. La sombra ya tiene su propia idempotencia
          // por event_id, así que no hace falta ninguna otra.
          //
          // Este `continue` no depende de que la sombra haya funcionado: si
          // `observarEnSombra` falló, se pierde la observación —que es
          // best-effort— pero NO se publica igual. Un fallo de la herramienta
          // de diagnóstico no puede convertir al reloj en productor.
          if (observeOnly) {
            observados++;
            pushMetrics.observe_only_received++;
            pushMetrics.observe_only_suppressed_publish++;
            continue;
          }

          // Dedupe: si ya vimos este (SN, userId, timestamp) en las últimas 24 h, saltar
          const dup = await alreadySeen(SN, userId, ts.toISOString());
          if (dup) { deduped++; continue; }

          await publishAttendance({
            employeeCode: userId,
            timestamp:    ts.toISOString(),
            deviceIp:     ip,
            deviceSn:     SN,
            deviceId:     null,
            type:         mapZKStatus(status),
            raw: {
              sn: SN, userId: userId, timestamp: timestamp,
              status: status, verify: verify, workCode: workCode
            }
          });
          parsed++;
        } catch (err) {
          logger.error(`Error parseando línea PUSH: ${line} — ${err.message}`);
        }
      }

      // ── Tres marcas de tiempo, tres preguntas distintas ─────────────
      //
      //   lastSeen            — ¿el reloj habla? (cualquier petición suya)
      //   lastAttlogReceived  — ¿mandó marcajes? (llegó un POST ATTLOG)
      //   lastPunch           — ¿le ENTENDIMOS alguno? (≥1 línea aceptada)
      //
      // `lastPunch` se escribía en todo POST ATTLOG, hubiera o no una línea
      // legible. Con el Content-Type ausente eso producía el estado imposible
      // que se vio en producción: `lastPunch` con fecha reciente y `punches`
      // en 0 — un reloj con cara de sano que no entregó un solo marcaje.
      //
      // La marca del medio es la que hacía falta para no perder el "sí llegó
      // tráfico" al dejar de mentir con la de abajo.
      const aceptadas = parsed + observados;
      if (aceptadas > 0) {
        // Se mantiene también en observe-only: observar no es publicar, pero
        // tampoco es no ver nada.
        pushState[SN].lastPunch = new Date().toISOString();
        pushState[SN].punches = (pushState[SN].punches || 0) + aceptadas;
      }

      // Llegó texto y NO se entendió ni una línea. Este aviso es el que
      // faltaba: el modo de fallo del Content-Type ausente era indistinguible
      // de un reloj tranquilo, porque el reloj recibía OK y nadie registraba
      // nada. Sin PIN ni payload en el mensaje — sólo cuántas y por qué.
      if (lines.length > 0 && validas === 0) {
        logger.warn(`⚠️  PUSH SN=${SN}: ${lines.length} línea(s) ATTLOG recibidas y NINGUNA legible ` +
                    '— revisar formato del cuerpo (¿llegó sin Content-Type o con otro separador?)');
      }

      if (observeOnly) {
        // Sin IP en esta línea: es la que se agrega en este modo.
        logger.info(`👁️  PUSH observe-only SN=${SN}: ${observados}/${lines.length} observados, 0 publicados`);
      } else {
        logger.info(`📥 PUSH de SN=${SN} (${ip}): ${parsed}/${lines.length} procesados, ${deduped} duplicados`);
      }
    }

    res.type('text/plain').send('OK');
  });

  // Heartbeat — el reloj pregunta si hay comandos pendientes
  app.get('/iclock/getrequest', (req, res) => {
    const { SN } = req.query;
    const ip = req.ip?.replace(/^::ffff:/, '');
    if (SN) pushState[SN] = { ...(pushState[SN] || {}), lastSeen: new Date().toISOString(), ip };
    res.type('text/plain').send('OK');
  });

  app.post('/iclock/devicecmd', (req, res) => {
    res.type('text/plain').send('OK');
  });

  // Endpoint interno para consultar estado PUSH (usado por la API)
  app.get('/push-state', (req, res) => res.json(pushState));

  const PUSH_PORT = resolvePushPort();
  app.listen(PUSH_PORT, () => {
    logger.info(`📡 Servidor PUSH ZKTeco escuchando en puerto ${PUSH_PORT}`);
  });

  return { pushState };
}

module.exports = {
  startPushServer,
  pushState,
  resolvePushPort,
  pushMetrics,
  resetPushMetrics,
  getObserveOnlyAllowlist,
};
