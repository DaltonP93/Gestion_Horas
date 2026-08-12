/**
 * attlog.js
 * Lectura del cuerpo ATTLOG que envían los relojes ZKTeco por PUSH (ADMS).
 *
 * Funciones puras: no tocan red, ni estado, ni registran nada. Existen aparte
 * para que el formato se pueda probar línea por línea, sin levantar el
 * servidor.
 *
 * ── El formato, tal como lo emite el firmware ────────────────────────
 *
 *   PIN <TAB> YYYY-MM-DD HH:mm:ss <TAB> Status <TAB> Verify <TAB> WorkCode <TAB> …
 *
 * Verificado contra una captura de tráfico de un reloj en producción. Tres
 * cosas que de ahí se desprenden y NO hay que "arreglar":
 *
 *   · el separador es TAB (0x09), no coma ni espacio;
 *   · `WorkCode` viene VACÍO en el caso normal, así que un campo vacío en el
 *     medio de la línea es válido y no señal de corrupción;
 *   · la línea termina en TAB, con campos reservados vacíos después.
 */

/** Qué campo ocupa cada posición. Sólo los cinco primeros se usan. */
const CAMPOS = ['deviceUserId', 'occurredAtRaw', 'status', 'verify', 'workCode'];

/**
 * Mínimo aceptable: PIN y fecha. Los tres siguientes pueden faltar — hay
 * firmwares que recortan la línea— y eso no invalida el marcaje: se sabe quién
 * y cuándo, que es lo que la asistencia necesita.
 */
const CAMPOS_MINIMOS = 2;

/**
 * `YYYY-MM-DD HH:mm:ss`, con T o espacio de separador.
 *
 * La forma se valida con expresión regular ANTES de construir un `Date`, y no
 * al revés, porque `new Date()` es demasiado permisivo: acepta `'2026'` y
 * `'Aug 12 2026'` y les inventa los campos que faltan. Un cuerpo corrupto que
 * casualmente empiece con dígitos no debe convertirse en un marcaje con hora
 * inventada.
 */
const FORMA_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

/**
 * ¿Es una hora de pared real?
 *
 * Se comprueban los rangos a mano en vez de delegar en `Date`. Con `Date`, el
 * 31 de febrero se desborda en silencio al 3 de marzo y quedaría aceptado como
 * válido; acá se rechaza.
 *
 * No se convierte a instante ni se aplica zona horaria: esto decide si la
 * cadena es una fecha, nada más. La zona del reloj es un problema aparte y por
 * eso el resto del sistema transporta la hora de pared cruda.
 */
function timestampValido(texto) {
  const m = FORMA_TIMESTAMP.exec(texto);
  if (!m) return false;

  const [, a, mes, dia, hh, mm, ss] = m.map(Number);
  if (mes < 1 || mes > 12) return false;
  if (hh > 23 || mm > 59 || ss > 59) return false;

  // Días reales del mes, con año bisiesto.
  const bisiesto = (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0;
  const dias = [31, bisiesto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mes - 1];
  return dia >= 1 && dia <= dias;
}

/**
 * Parsea UNA línea ATTLOG.
 *
 * Devuelve `{ ok: true, … }` con los campos, o `{ ok: false, motivo }` donde
 * `motivo` es uno de:
 *
 *   · `campos_insuficientes` — no llegan ni PIN ni fecha;
 *   · `pin_vacio`            — el PIN está en blanco;
 *   · `timestamp_invalido`   — la fecha no tiene la forma esperada.
 *
 * Nunca lanza: un cuerpo corrupto es un dato de entrada esperable, no un error
 * del programa.
 */
function parseAttlogLine(linea) {
  if (typeof linea !== 'string') return { ok: false, motivo: 'campos_insuficientes' };

  // Se recorta SÓLO el final de línea, nunca el principio.
  //
  // Un `trim()` sobre la línea entera parece equivalente y no lo es: se lleva
  // el TAB INICIAL, que es un PIN vacío. Con eso los campos se corren un lugar
  // —la fecha pasa a leerse como PIN— y una línea sin PIN se reporta como
  // "timestamp inválido", mandando a investigar el reloj equivocado.
  //
  // El TAB final del firmware sí se puede ir: sólo deja campos reservados
  // vacíos que nadie lee.
  const partes = linea.replace(/[\r\n\t ]+$/, '').split('\t');
  if (partes.length < CAMPOS_MINIMOS) return { ok: false, motivo: 'campos_insuficientes' };

  const valores = {};
  CAMPOS.forEach((nombre, i) => { valores[nombre] = (partes[i] ?? '').trim(); });

  if (!valores.deviceUserId) return { ok: false, motivo: 'pin_vacio' };
  if (!timestampValido(valores.occurredAtRaw)) return { ok: false, motivo: 'timestamp_invalido' };

  return { ok: true, ...valores };
}

/**
 * Convierte el cuerpo de un POST en líneas candidatas.
 *
 * ── Por qué esto no acepta cualquier cosa ────────────────────────────
 *
 * El firmware ZKTeco NO envía `Content-Type`. Con el parser de Express elegido
 * por Content-Type, `req.body` quedaba en `{}` — un objeto— y el código lo
 * pasaba por `.toString()`, que en un objeto devuelve la cadena literal
 * `"[object Object]"`. Esa cadena es no vacía, así que sobrevivía al chequeo de
 * cuerpo vacío y se contaba como UNA línea ATTLOG que después no parseaba:
 * "1 línea recibida, 0 observados", con la sombra en cero y sin ningún error.
 *
 * Por eso acá sólo se admite texto: `string`, o `Buffer` decodificado. Un
 * objeto arbitrario devuelve cuerpo vacío, que es la verdad — no llegó texto.
 */
function cuerpoATexto(body) {
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  return '';
}

/** Divide el cuerpo en líneas no vacías. */
function lineasDe(body) {
  const texto = cuerpoATexto(body);
  if (!texto.trim()) return [];
  return texto.split(/\r?\n/).filter(l => l.trim());
}

module.exports = {
  parseAttlogLine,
  timestampValido,
  cuerpoATexto,
  lineasDe,
  CAMPOS_MINIMOS,
};
