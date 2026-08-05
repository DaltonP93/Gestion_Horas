# Reconciliación de atributos de marcaciones — contrato v1

Complemento de [`punch-contract-v1.md`](./punch-contract-v1.md). Define qué pasa
cuando la **misma** marcación llega por más de un camino con atributos distintos.

Estado: **especificación y función pura**. No hay almacenamiento, no hay rutas,
no hay escrituras a MySQL ni a Redis, y el pipeline productivo no la usa.

---

## El hueco que cierra

El contrato v1 define la identidad de una marcación:

```
device_id + device_user_id + occurred_at + event_type  →  event_id
```

`verify_mode` y `work_code` quedaron deliberadamente **fuera** de esa identidad.
La razón está documentada en el contrato: la misma marcación llega por tres
caminos y no todos traen los mismos atributos.

| Camino | `verify_mode` | `work_code` |
|---|---|---|
| PUSH del reloj (`/iclock/cdata`) | casi siempre | a veces |
| Polling con node-zklib | a veces | rara vez |
| Importación desde `att2000` | rara vez | rara vez |

Dejarlos fuera de la identidad evitó el problema grave —que la misma marcación
generara dos `event_id` distintos y se duplicara— pero abrió otro que el
contrato no respondía: **si dos observaciones de la misma marcación difieren en
un atributo, ¿cuál gana?**

Este documento responde eso.

---

## Vocabulario

- **Observación**: lo que UNA fuente vio de una marcación, en UN momento.
  Lleva la identidad, los atributos que esa fuente conocía, y metadatos de
  recepción (`source`, `raw_reference`, `received_at`).
- **Marcación reconciliada** (`punch`): el resultado de fusionar todas las
  observaciones de un mismo `event_id`.

Una marcación reconciliada **conserva sus observaciones**. No se descarta lo que
perdió.

---

## La decisión de diseño

El merge **no resuelve atributos de a pares**. Hace la **unión del conjunto de
observaciones** y **deriva** todo lo demás de ese conjunto.

Resolver de a pares obligaría a demostrar caso por caso que el resultado no
depende del orden ni de la asociación, y esa demostración se rompe en cuanto
alguien agrega una regla. Con unión + derivación las propiedades salen de la
estructura:

| Propiedad | Por qué se cumple |
|---|---|
| Conmutativa | la unión de conjuntos lo es |
| Asociativa | la unión de conjuntos lo es |
| Idempotente | la unión de conjuntos lo es |
| Determinista | la derivación es una función pura del conjunto ordenado |

El precio es guardar las observaciones en vez de sólo el valor ganador. Es
justamente lo que se quiere: conservar la evidencia por fuente y nunca
sobrescribir en silencio.

---

## Reglas de reconciliación

### 1. Un valor conocido nunca lo pisa un nulo

`null` no compite. No discrepa de nada: sólo no aporta. Si el PUSH no trajo
`work_code` y el polling sí, gana el del polling — y **no** es un conflicto.

### 2. Precedencia por fuente

```
push (3)  >  polling (2)  >  att2000 (1)
```

- **PUSH** es lo que el reloj emitió en el momento del evento.
- **Polling** lee la misma memoria más tarde: puede venir de un reloj ya rotado
  o recortado.
- **att2000** es una base intermedia de un sistema legacy, con sus propias
  transformaciones encima.

### 3. Desempates

Cuando la prioridad empata (misma fuente):

1. gana la observación **recibida antes** (`received_at`), comparada **por
   instante**, no lexicográficamente;
2. una `received_at` desconocida (`null`) va **última** — no puede ganar "la más
   temprana" algo de lo que no se sabe cuándo llegó;
3. si todo empata, gana el **valor menor** por orden canónico.

El desempate no pretende ser "el correcto": pretende ser **total y
determinista**, para que el resultado no dependa del orden de llegada.

Que sea **total** no es un detalle. La primera versión comparaba los strings
directamente y no lo era:

```
null < '2026-03-11T08:00:00-03:00'   → false   (null→0, string→NaN)
'2026-03-11T08:00:00-03:00' < null   → false
```

Las dos comparaciones daban `false`, el comparador devolvía `1` en ambos
sentidos, y con un comparador que no es un orden total el resultado de `sort`
depende del orden de entrada — justo lo que este módulo promete que no pasa.
Rompía la conmutatividad en 8 de 64 pares.

Comparar por instante arregla además el caso de dos offsets distintos:
`2026-03-11T08:00:00-03:00` y `2026-03-11T12:00:00+01:00` son el mismo momento
y ordenan igual. Lo mismo vale para `first_received_at` / `last_received_at`.

### 4. Discrepar nunca crea una segunda marcación

La identidad no incluye estos atributos. Dos valores distintos de `verify_mode`
son dos lecturas del mismo hecho, no dos hechos.

### 5. El conflicto se marca y se audita

Si hay dos valores **no nulos distintos**:

- `attribute_conflict: true`
- `conflicts[]` lleva el atributo, el valor elegido, la fuente que ganó, y
  **todas** las lecturas con su fuente y su `received_at`.

Nada se pierde en silencio.

---

## Forma del resultado

```js
{
  event_id: 'sha256:…',

  // identidad — sale intacta, nunca se reconcilia
  device_id: 7,
  device_user_id: '0041',
  occurred_at: '2026-03-11T08:02:13-03:00',
  event_type: 'in',

  // atributos resueltos
  verify_mode: 1,
  work_code: 'OT',

  // procedencia
  sources: ['push', 'polling', 'att2000'],   // por confianza, descendente
  attribute_conflict: true,
  conflicts: [
    {
      attribute: 'verify_mode',
      chosen: 1,
      chosen_source: 'push',
      observed: [
        { source: 'push',    value: 1, received_at: '…' },
        { source: 'polling', value: 4, received_at: '…' },
      ],
    },
  ],

  // evidencia completa, en orden determinista
  observations: [ /* … */ ],
  first_received_at: '…',
  last_received_at:  '…',
}
```

---

## Rechazos

| `error_code` | Cuándo |
|---|---|
| `merge_no_input` | sin entradas |
| `merge_not_object` | una entrada no es un objeto |
| `merge_event_id_missing` | falta `event_id` |
| `merge_event_id_mismatch` | dos entradas con `event_id` distinto |
| `merge_identity_mismatch` | mismo `event_id`, identidad distinta |
| `merge_event_id_inconsistent` | el `event_id` no corresponde a la identidad declarada |
| `merge_source_invalid` | `source` fuera de `push` / `polling` / `att2000` |
| `merge_received_at_invalid` | `received_at` no es string ni nulo |

`merge_event_id_inconsistent` es el que impide fusionar dos marcaciones
distintas que declaren el mismo `event_id`: se recalcula desde la identidad y se
compara.

---

## Una sola fuente de la política

La precedencia vive **únicamente** en `compararObservaciones`. No hay una
función `ganadora()` aparte, y la clave de deduplicación tiene los campos de
política (`source`, `received_at`) **al final** a propósito.

Las dos cosas son consecuencia de pruebas de mutación. Con el diseño anterior:

- se podía borrar entera la rama de prioridad de `ganadora()` y los 27 tests
  seguían pasando, porque el conjunto ya venía ordenado por prioridad;
- se podía borrar entera la rama de `received_at` y los 27 tests seguían
  pasando, porque la clave empezaba con `[source, received_at, …]` y su
  comparación lexicográfica ordenaba igual.

Dos mecanismos que tienen que estar de acuerdo, sin ningún test capaz de
distinguirlos, es una trampa: el día que alguien toque uno, el otro tapa el
error. Quedó uno solo, y las 12 mutaciones se detectan.

---

## Qué NO hace este módulo

- No guarda nada. No hay tabla, no hay migración, no hay Outbox.
- No toca el pipeline: ni PUSH, ni polling, ni la importación de att2000.
- No escribe en MySQL ni en Redis.
- No agrega rutas ni cambia el worker.

Es una función pura pensada para que la usen el Outbox, el Sync Worker y la API
de ingesta **cuando existan**. Hasta entonces sólo la ejercitan los tests.
