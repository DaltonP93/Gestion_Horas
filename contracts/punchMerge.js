/**
 * punchMerge.js — política de reconciliación de atributos, contrato v1.
 *
 * El contrato v1 (punchContractV1.js) define la IDENTIDAD de una marcación:
 *
 *     device_id + device_user_id + occurred_at + event_type  →  event_id
 *
 * `verify_mode` y `work_code` quedaron deliberadamente FUERA de esa identidad,
 * porque la misma marcación llega por más de un camino y no todos traen los
 * mismos atributos: el PUSH del reloj manda verify_mode, el polling con
 * node-zklib a veces no, y la importación de att2000 casi nunca.
 *
 * Eso deja una pregunta que el contrato no respondía: si dos observaciones de
 * la MISMA marcación difieren en un atributo, ¿cuál gana? Este módulo la
 * responde y nada más — no guarda datos, no toca el pipeline, no se conecta a
 * nada. Es una función pura pensada para que después la usen el Outbox, el
 * Sync Worker y la API de ingesta, cuando existan.
 *
 * ── Decisión de diseño ──────────────────────────────────────────────────
 *
 * El merge NO resuelve atributos de a pares. Hace la UNIÓN DEL CONJUNTO de
 * observaciones y DERIVA todo lo demás de ese conjunto.
 *
 * La diferencia importa. Resolver de a pares obliga a demostrar caso por caso
 * que el resultado no depende del orden ni de la asociación, y esa demostración
 * se rompe en cuanto alguien agrega una regla. Con unión + derivación las tres
 * propiedades salen gratis:
 *
 *   - conmutativa   — la unión de conjuntos lo es;
 *   - asociativa    — la unión de conjuntos lo es;
 *   - idempotente   — la unión de conjuntos lo es;
 *   - determinista  — la derivación es una función pura del conjunto ordenado.
 *
 * El precio es guardar las observaciones en vez de sólo el valor ganador. Es
 * justamente lo que se pide: "conservar las observaciones por fuente" y "nunca
 * sobrescribir en silencio". Se paga con gusto.
 *
 * ── Precedencia ─────────────────────────────────────────────────────────
 *
 * Cuando dos observaciones no nulas discrepan, gana la de mayor confianza:
 *
 *     push (3)  >  polling (2)  >  att2000 (1)
 *
 * Razón: el PUSH es lo que el reloj emitió en el momento del evento. El polling
 * lee la misma memoria más tarde y puede venir de un reloj ya rotado o
 * recortado. att2000 es una base intermedia de un sistema legacy, con sus
 * propias transformaciones encima.
 *
 * Empate de prioridad → gana la observación recibida ANTES (`received_at`), y
 * si también empata, el valor menor por orden canónico. El desempate no busca
 * ser "el correcto": busca ser TOTAL y determinista, para que el resultado no
 * dependa del orden de llegada.
 *
 * Discrepar NUNCA crea una segunda marcación: la identidad no incluye estos
 * atributos. Se marca `attribute_conflict` y se deja el detalle en `conflicts`
 * para que alguien lo mire.
 */

'use strict';

const { computeEventId, EVENT_TYPES } = require('./punchContractV1');

/** Fuentes conocidas, de menor a mayor confianza. */
const SOURCE_PRIORITY = Object.freeze({
  att2000: 1,
  polling: 2,
  push: 3,
});

const SOURCES = Object.freeze(Object.keys(SOURCE_PRIORITY));

/** Atributos reconciliables. La identidad NO se reconcilia: se compara. */
const MERGEABLE_ATTRS = Object.freeze(['verify_mode', 'work_code']);

/** Campos que definen la identidad — deben coincidir en todas las entradas. */
const IDENTITY_FIELDS = Object.freeze([
  'device_id', 'device_user_id', 'occurred_at', 'event_type',
]);

const MERGE_ERRORS = Object.freeze({
  NO_INPUT:            'merge_no_input',
  NOT_OBJECT:          'merge_not_object',
  EVENT_ID_MISSING:    'merge_event_id_missing',
  EVENT_ID_MISMATCH:   'merge_event_id_mismatch',
  IDENTITY_MISMATCH:   'merge_identity_mismatch',
  EVENT_ID_INCONSISTENT: 'merge_event_id_inconsistent',
  SOURCE_INVALID:      'merge_source_invalid',
  RECEIVED_AT_INVALID: 'merge_received_at_invalid',
});

// ── Utilidades ───────────────────────────────────────────────────────

function esObjeto(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Orden canónico total para valores de atributo.
 *
 * `null` no participa (se filtra antes). Se compara por tipo primero para que
 * el orden no dependa de coerciones: 0 y '0' son valores distintos y hay que
 * poder ordenarlos de forma estable.
 */
function compararValores(a, b) {
  const ta = typeof a, tb = typeof b;
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (ta === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * Clave canónica de una observación — dos observaciones iguales colapsan.
 *
 * El orden de los campos dentro de la clave es indiferente para el dedupe (es
 * igualdad de strings), pero NO para el desempate: la clave se usa como último
 * criterio en `compararObservaciones`, y si arrancara con `source` y
 * `received_at` terminaría re-implementando por accidente la misma política que
 * ya expresan las ramas explícitas de arriba.
 *
 * Eso pasó: con la clave encabezada por `[source, received_at, …]` se podía
 * borrar entera la rama de `received_at` y los 27 tests seguían pasando, porque
 * la comparación lexicográfica de la clave ordenaba igual. Los campos que
 * deciden la política van al FINAL, para que la política viva en un solo lugar
 * y una prueba de mutación pueda encontrarla.
 */
function claveObservacion(o) {
  return JSON.stringify([
    o.raw_reference,
    ...MERGEABLE_ATTRS.map((a) => (o[a] === undefined ? null : o[a])),
    o.source,
    o.received_at,
  ]);
}

/**
 * Orden total y determinista de las observaciones dentro del resultado.
 *
 * Existe para que merge(A,B) y merge(B,A) sean estructuralmente idénticos, no
 * sólo equivalentes: si el array quedara en orden de llegada, un `toEqual`
 * fallaría y —peor— dos réplicas que recibieron lo mismo en distinto orden
 * guardarían filas distintas.
 */
function compararObservaciones(a, b) {
  const pa = SOURCE_PRIORITY[a.source] || 0;
  const pb = SOURCE_PRIORITY[b.source] || 0;
  if (pa !== pb) return pb - pa;                       // más confiable primero

  const ra = instanteRecepcion(a.received_at);
  const rb = instanteRecepcion(b.received_at);
  if (ra !== rb) {
    // Recepción desconocida va última: no puede ganar el desempate de
    // "la más temprana" algo de lo que no se sabe cuándo llegó.
    if (ra === null) return 1;
    if (rb === null) return -1;
    return ra - rb;                                    // más temprana primero
  }

  const ka = claveObservacion(a), kb = claveObservacion(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * `received_at` como instante comparable, o null si no se sabe.
 *
 * Comparar los strings directamente NO sirve, y romperlo costó una violación
 * de conmutatividad en 8 de 64 pares:
 *
 *   null < '2026-03-11T08:00:00-03:00'   → false   (null→0, string→NaN)
 *   '2026-03-11T08:00:00-03:00' < null   → false
 *
 * Las dos comparaciones daban false, el comparador devolvía 1 en ambos
 * sentidos, y con un comparador que no es un orden total el resultado de
 * `sort` depende del orden de entrada — que es exactamente lo que este módulo
 * promete que no pasa.
 *
 * Comparar por instante y no lexicográficamente también arregla el caso de dos
 * offsets distintos: '2026-03-11T08:00:00-03:00' y '2026-03-11T12:00:00+01:00'
 * son el mismo momento y ordenan igual.
 */
function instanteRecepcion(v) {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// Nota deliberada: NO hay una función `ganadora(a, b)` aparte.
//
// La hubo, y era redundante con `compararObservaciones`: ambas codificaban la
// misma precedencia (prioridad, luego received_at, luego valor) y el resultado
// era correcto sólo mientras las dos coincidieran. Una prueba de mutación lo
// dejó claro — se podía borrar entera la rama de prioridad de `ganadora` y los
// 27 tests seguían pasando, porque el conjunto ya venía ordenado y el pliegue
// devolvía igual el primer elemento.
//
// Dos mecanismos que tienen que estar de acuerdo, sin ningún test capaz de
// distinguirlos, es una trampa: el día que alguien toque uno, el otro tapa el
// error. Queda UNO. El orden de `conjunto` ES la política de precedencia, y
// resolver un atributo es tomar el primero que lo tenga.

// ── Normalización de entrada ─────────────────────────────────────────

function normalizarObservacion(o) {
  if (!esObjeto(o)) return { ok: false, error_code: MERGE_ERRORS.NOT_OBJECT };
  if (!o.source || !SOURCE_PRIORITY[o.source]) {
    return { ok: false, error_code: MERGE_ERRORS.SOURCE_INVALID, detail: String(o.source) };
  }
  if (o.received_at !== null && o.received_at !== undefined && typeof o.received_at !== 'string') {
    return { ok: false, error_code: MERGE_ERRORS.RECEIVED_AT_INVALID };
  }

  return {
    ok: true,
    observation: {
      source: o.source,
      received_at: o.received_at ?? null,
      raw_reference: o.raw_reference ?? null,
      verify_mode: o.verify_mode ?? null,
      work_code: o.work_code ?? null,
    },
  };
}

/**
 * Acepta tanto una observación suelta como un resultado previo de merge y
 * devuelve siempre { identity, event_id, observations[] }.
 *
 * Que el merge acepte su propia salida es lo que hace posible
 * `merge(merge(a,b), c)` — y por lo tanto la asociatividad y la idempotencia.
 */
function aConjunto(entrada) {
  if (!esObjeto(entrada)) return { ok: false, error_code: MERGE_ERRORS.NOT_OBJECT };

  const event_id = entrada.event_id;
  if (typeof event_id !== 'string' || !event_id) {
    return { ok: false, error_code: MERGE_ERRORS.EVENT_ID_MISSING };
  }

  const identity = {};
  for (const campo of IDENTITY_FIELDS) identity[campo] = entrada[campo] ?? null;

  // Ya es una salida de merge: trae sus observaciones.
  if (Array.isArray(entrada.observations)) {
    const observations = [];
    for (const o of entrada.observations) {
      const r = normalizarObservacion(o);
      if (!r.ok) return r;
      observations.push(r.observation);
    }
    return { ok: true, event_id, identity, observations };
  }

  // Observación suelta: los atributos viven en la raíz.
  const r = normalizarObservacion(entrada);
  if (!r.ok) return r;
  return { ok: true, event_id, identity, observations: [r.observation] };
}

// ── Derivación ───────────────────────────────────────────────────────

/**
 * Resuelve un atributo sobre el conjunto completo de observaciones.
 * Devuelve { value, conflict } — `conflict` sólo si hay dos NO NULOS distintos.
 *
 * PRECONDICIÓN: `observaciones` viene ordenado por `compararObservaciones`, que
 * es donde vive la política de precedencia. Acá sólo se toma el primero que
 * tenga valor. Ver la nota sobre por qué no hay una `ganadora` aparte.
 *
 * Un null nunca compite: no discrepa de nada, sólo no aporta. Por eso "un valor
 * conocido no se pierde porque otra fuente no lo traiga".
 */
function resolverAtributo(observaciones, attr) {
  const conValor = observaciones.filter((o) => o[attr] !== null && o[attr] !== undefined);
  if (conValor.length === 0) return { value: null, conflict: null };

  const elegida = conValor[0];   // el conjunto ya está en orden de precedencia

  const distintos = [];
  for (const o of conValor) {
    if (compararValores(o[attr], elegida[attr]) !== 0 &&
        !distintos.some((d) => compararValores(d, o[attr]) === 0)) {
      distintos.push(o[attr]);
    }
  }
  if (distintos.length === 0) return { value: elegida[attr], conflict: null };

  return {
    value: elegida[attr],
    conflict: {
      attribute: attr,
      chosen: elegida[attr],
      chosen_source: elegida.source,
      // Todas las lecturas, para que el conflicto sea auditable y no una
      // nota suelta: quién dijo qué y cuándo.
      observed: conValor
        .map((o) => ({ source: o.source, value: o[attr], received_at: o.received_at }))
        .sort((a, b) => compararObservaciones(
          { source: a.source, received_at: a.received_at, raw_reference: null, [attr]: a.value },
          { source: b.source, received_at: b.received_at, raw_reference: null, [attr]: b.value },
        )),
    },
  };
}

// ── API pública ──────────────────────────────────────────────────────

/**
 * Reconcilia N observaciones de la MISMA marcación.
 *
 * Acepta observaciones sueltas, resultados previos de merge, o una mezcla.
 * Devuelve { ok: true, punch } o { ok: false, error_code, detail }.
 *
 * Propiedades garantizadas, todas cubiertas por tests:
 *   merge(a, b)            ≡ merge(b, a)
 *   merge(a, a)            ≡ merge(a)
 *   merge(merge(a,b), c)   ≡ merge(a, merge(b,c))   ≡ merge(a, b, c)
 */
function mergePunchObservations(...entradas) {
  const args = entradas.length === 1 && Array.isArray(entradas[0]) ? entradas[0] : entradas;
  if (args.length === 0) return { ok: false, error_code: MERGE_ERRORS.NO_INPUT };

  let event_id = null;
  let identity = null;
  const observaciones = [];

  for (const entrada of args) {
    const r = aConjunto(entrada);
    if (!r.ok) return r;

    if (event_id === null) {
      event_id = r.event_id;
      identity = r.identity;
    } else {
      // Identidades distintas son marcaciones distintas: no se fusionan.
      // Se comprueban las dos cosas por separado para que el error diga cuál
      // falló — un event_id igual con identidad distinta es un bug muy
      // diferente de dos marcaciones legítimamente distintas.
      if (r.event_id !== event_id) {
        return {
          ok: false,
          error_code: MERGE_ERRORS.EVENT_ID_MISMATCH,
          detail: `${event_id} ≠ ${r.event_id}`,
        };
      }
      for (const campo of IDENTITY_FIELDS) {
        if (identity[campo] !== r.identity[campo]) {
          return {
            ok: false,
            error_code: MERGE_ERRORS.IDENTITY_MISMATCH,
            detail: campo,
          };
        }
      }
    }
    observaciones.push(...r.observations);
  }

  // El event_id tiene que corresponder a la identidad declarada. Sin esto, dos
  // observaciones podrían traer el mismo event_id inventado y fusionarse pese
  // a ser marcaciones distintas.
  if (IDENTITY_FIELDS.every((c) => identity[c] !== null && identity[c] !== undefined)) {
    if (EVENT_TYPES.includes(identity.event_type) && computeEventId(identity) !== event_id) {
      return { ok: false, error_code: MERGE_ERRORS.EVENT_ID_INCONSISTENT };
    }
  }

  // Unión: observaciones idénticas colapsan (reenvío del mismo lote).
  const unicas = new Map();
  for (const o of observaciones) unicas.set(claveObservacion(o), o);
  const conjunto = [...unicas.values()].sort(compararObservaciones);

  const attrs = {};
  const conflicts = [];
  for (const attr of MERGEABLE_ATTRS) {
    const { value, conflict } = resolverAtributo(conjunto, attr);
    attrs[attr] = value;
    if (conflict) conflicts.push(conflict);
  }

  // Por instante, no lexicográfico: dos offsets distintos del mismo momento
  // ordenan igual, y un orden alfabético daría un primero/último equivocado.
  const recibidas = conjunto
    .map((o) => o.received_at)
    .filter((v) => instanteRecepcion(v) !== null)
    .sort((x, y) => instanteRecepcion(x) - instanteRecepcion(y));

  return {
    ok: true,
    punch: {
      event_id,
      ...identity,
      ...attrs,
      sources: [...new Set(conjunto.map((o) => o.source))]
        .sort((a, b) => SOURCE_PRIORITY[b] - SOURCE_PRIORITY[a]),
      attribute_conflict: conflicts.length > 0,
      conflicts,
      observations: conjunto,
      first_received_at: recibidas[0] ?? null,
      last_received_at: recibidas[recibidas.length - 1] ?? null,
    },
  };
}

module.exports = {
  mergePunchObservations,
  SOURCE_PRIORITY,
  SOURCES,
  MERGEABLE_ATTRS,
  IDENTITY_FIELDS,
  MERGE_ERRORS,
};
