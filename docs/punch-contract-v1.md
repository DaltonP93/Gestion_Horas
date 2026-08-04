# Contrato canónico de marcaciones — versión 1

**Estado: definido, no conectado.** No hay rutas registradas, no se escribe en Redis ni en MySQL, y el pipeline actual (PUSH y polling) funciona exactamente igual. Este documento y `contracts/punchContractV1.js` fijan las reglas para que Bridge, API de ingesta, Outbox, Redis Stream y Sync Worker puedan usarlas más adelante.

## Punto de partida: tres formas de la misma marcación

| Origen | Forma |
|---|---|
| PUSH ADMS | línea ATTLOG: `userId \t datetime \t status \t verify \t workCode` |
| Polling `node-zklib` | `{ userId, timestamp, state }` |
| Importación att2000 | fila `CHECKINOUT`: `USERID`, `CHECKTIME`, `CHECKTYPE` (`I`/`O`) |

Cada camino arma su propio objeto antes de publicar. La deduplicación actual compara `(SN, userId, timestamp)` contra las últimas 24 h, o sea que **hay que consultar estado para saber si algo ya se procesó**.

Con un `event_id` determinista, la idempotencia deja de depender del estado: el mismo marcaje calcula el mismo identificador en cualquier proceso, en cualquier momento, sin coordinación.

## El contrato

### Lote

```json
{
  "schema_version": 1,
  "batch_id": "b-3f9a1c…",
  "bridge_id": "bridge-planta-1",
  "device_id": 1,
  "generated_at": "2026-08-04T10:20:00.000Z",
  "events": []
}
```

### Evento

```json
{
  "event_id": "sha256:f2b8432a…",
  "device_id": 1,
  "device_user_id": "42",
  "occurred_at": "2026-08-04T10:15:03Z",
  "event_type": "in",
  "verify_mode": 1,
  "work_code": null
}
```

`device_id` puede omitirse en el evento y heredarse del lote, pero **no puede contradecirlo**: un evento que declare otro reloj se rechaza.

## Normalización determinista

Sin reglas idénticas en los dos extremos, el mismo marcaje produce identificadores distintos y se duplica.

### Zona horaria — la regla más importante

Los relojes ZKTeco emiten **hora de pared sin offset**. Hoy el bridge hace:

```js
const ts = new Date(timestamp.trim().replace(' ', 'T'))
```

Eso interpreta el texto en la zona del **proceso**: el mismo marcaje da un instante distinto según dónde corra el bridge. Es un bug latente, no teórico.

En el contrato:

- una hora **sin** offset se interpreta en `America/Asuncion`, **UTC−03:00 fijo**;
- una hora **con** offset se respeta tal cual;
- el resultado siempre se normaliza a UTC.

Paraguay dejó de aplicar horario de verano en 2024, así que el offset es constante — pero se escribe explícito en vez de asumirse. Enero y julio dan el mismo desplazamiento, y hay un test que lo fija.

### Precisión

Segundos. Los milisegundos se descartan: los relojes reportan segundos, y conservarlos haría que el mismo marcaje leído por dos caminos distintos calculara identificadores distintos.

### Un objeto `Date` no se acepta a secas

Un `Date` **no dice de dónde viene**. El polling hace hoy `new Date(r.timestamp)` sobre la hora de pared del reloj, así que el objeto ya quedó anclado a la zona del proceso; hashearlo como instante conservaría justo la dependencia que este contrato existe para eliminar. Y mirando el objeto no hay forma de recuperar la intención.

Por eso hay que declararla:

| `dateMeans` | Significado |
|---|---|
| `'utc_instant'` | el `Date` ya es un instante absoluto correcto (por ejemplo, una fila de att2000 leída por el driver) |
| `'civil_wall'` | el `Date` lleva la hora de pared del reloj en sus componentes locales; se reancla al offset civil |
| ausente | **se rechaza** |

Preferir siempre pasar el string civil. La opción existe para los caminos que ya tienen un `Date` en la mano.

### Identificador de usuario

- NFC + trim.
- **Los ceros a la izquierda se conservan.** La tentación es quitarlos —`"0042"` y `"42"` parecen el mismo empleado— y así lo tenía la primera versión de este contrato. Es incorrecto: el sistema ya trata este campo como string exacto. `employee_device_map.device_user_id` se compara con el valor trimeado tal cual (`api/src/services/zktecoReader.js`), así que `"0042"` y `"42"` son **dos asignaciones distintas**; unificarlos acá colapsaría los marcajes de dos personas en un solo `event_id` — exactamente el fallo que este contrato existe para evitar. Si un despliegue confirma que su reloj rellena con ceros el mismo identificador, puede activarlo con `stripLeadingZeros: true`: es una decisión por instalación, no un default.

### Resto

| Campo | Regla |
|---|---|
| `event_type` | enum `in`, `out`, `break_start`, `break_end`, `unknown`; lo no reconocido cae en `unknown` |
| `verify_mode` | entero decimal 0–255 o `null`; en blanco o con espacios → `null`, **no** el modo 0 |
| `work_code` | string no vacío o `null` (vacío se normaliza a `null`) |

## `event_id`

```
sha256( "sishoras.punch.v1" ␟ device_id ␟ device_user_id ␟ occurred_at ␟ event_type )
```

Los campos van en orden fijo, con tipo codificado (`n` para null, `i:` para entero, `s:` para string) y separados por `U+001F`. **No se usa `JSON.stringify`**: el orden de las claves no puede influir en el resultado, y con esta construcción no puede por definición.

Si un valor contiene el separador, el evento se **rechaza** en vez de arriesgar una colisión de identificadores.

### Deliberadamente fuera del identificador

`batch_id`, fecha de recepción, orden dentro del lote, IP del reloj, `bridge_id`, y cualquier dato variable del transporte. Si el mismo marcaje se reenvía por otro lote, otro bridge o meses después, el identificador es el mismo.

**Y también `verify_mode` y `work_code`**, que son *atributos* del marcaje y no su identidad. La razón es concreta: el PUSH parsea `verify` y `workCode` de la línea ATTLOG, pero **el polling no los publica**. Con esos campos dentro del hash, el mismo marcaje leído por PUSH y por polling producía dos identificadores distintos, y el sistema lo habría insertado dos veces — exactamente lo que el contrato promete evitar.

La identidad de un marcaje es *qué reloj, qué persona, cuándo y de qué tipo*. Cómo se identificó la persona (huella, tarjeta, rostro) y con qué código de obra son datos del marcaje, no el marcaje.

> Cuando dos fuentes reporten el mismo evento con atributos distintos, el consumidor decide con cuál se queda. Queda fuera de este contrato, pero hay que resolverlo antes de conectar el Outbox.

### Política ante marcajes idénticos

**Dos marcaciones con los mismos campos de identidad y el mismo segundo son el mismo evento.** No hay forma de distinguirlas: un reloj no registra dos hechos diferentes para el mismo usuario, en el mismo segundo y con el mismo tipo. Si llegan dos, o es el mismo hecho reenviado, o un duplicado del transporte — y en ambos casos colapsar es lo correcto.

La consecuencia hay que aceptarla con los ojos abiertos: si un dispositivo real produjera dos marcajes legítimos indistinguibles, el sistema los contaría como uno. A cambio, la idempotencia no necesita estado.

Dos marcajes en el **mismo segundo** con distinto usuario o distinto tipo conservan identidades distintas.

Dos marcajes que difieran **sólo** en `verify_mode` o `work_code` **colapsan**, porque esos campos no son identidad. Es la consecuencia directa de sacarlos del hash, y hay que tenerla presente al diseñar el merge río abajo: si la misma persona ficha dos veces en el mismo segundo con el mismo tipo y distinto código de obra, el sistema lo cuenta una sola vez.

## Validación

### Límites

| Límite | Valor |
|---|---|
| Eventos por lote | 100 |
| Tamaño sin comprimir | 256 KB |
| `device_user_id` | 64 caracteres |
| `work_code` | 32 caracteres |
| `batch_id` / `bridge_id` | 64 caracteres |
| Margen hacia el futuro | 5 min |
| Antigüedad máxima | ~13 meses |

### Motivos de rechazo

`PUNCH_UNSUPPORTED_VERSION`, `PUNCH_BATCH_NOT_OBJECT`, `PUNCH_BATCH_EMPTY`, `PUNCH_BATCH_TOO_LARGE`, `PUNCH_BATCH_TOO_MANY_EVENTS`, `PUNCH_BATCH_ID_INVALID`, `PUNCH_BRIDGE_ID_INVALID`, `PUNCH_DEVICE_ID_INVALID`, `PUNCH_GENERATED_AT_INVALID`, `PUNCH_EVENT_NOT_OBJECT`, `PUNCH_USER_ID_INVALID`, `PUNCH_TIMESTAMP_INVALID`, `PUNCH_TIMESTAMP_FUTURE`, `PUNCH_TIMESTAMP_TOO_OLD`, `PUNCH_EVENT_TYPE_INVALID`, `PUNCH_VERIFY_MODE_INVALID`, `PUNCH_WORK_CODE_INVALID`, `PUNCH_EVENT_ID_MISMATCH`, `PUNCH_SEPARATOR_IN_VALUE`.

> Esta lista y la tabla de límites las verifica un test contra el módulo: la documentación de este contrato se desincronizó tres veces durante su desarrollo, y una regla que el código no cumple es peor que no escribirla.

El validador **recalcula cada `event_id`** y exige que coincida con el declarado. Si el emisor normalizó distinto —por ejemplo, quitando los ceros a la izquierda o dejando un `work_code` vacío en vez de `null`— es mejor rechazar el lote que aceptar identificadores que romperían la idempotencia río abajo.

## Un solo archivo para los dos lados

`contracts/punchContractV1.js` es **un único archivo** que importan API y Bridge. No hay copias: una divergencia en las reglas de normalización produciría identificadores distintos para el mismo marcaje y duplicaría marcaciones en silencio, que es el peor fallo posible de este contrato.

> **Al conectarlo:** el `Dockerfile` del Bridge copia sólo `bridge/`. Antes de que el Bridge lo importe en runtime hay que incluir `contracts/` en la imagen (o publicar el módulo como paquete). Hoy sólo lo usan los tests, así que no bloquea nada.

## Feature flag

`PUNCH_CONTRACT_V1_ENABLED` — sin uso todavía, reservado para cuando exista un consumidor. En este PR:

- no se registra ninguna ruta;
- no se escribe en Redis ni en MySQL;
- no se modifica el worker;
- no se cambia PUSH ni polling.

Hay tests que lo verifican: el módulo no importa `express`, `redis`, `sequelize` ni `node-zklib`, y ni `bridge/src/index.js` ni `bridge/src/pushServer.js` lo mencionan.

## Fixtures

`contracts/fixtures/punches-v1.json` — anonimizados: IPs de documentación (RFC 5737), seriales y usuarios ficticios. Incluyen las tres formas de origen para el mismo marcaje, un caso Unicode y nueve entradas maliciosas (inyección SQL, separador embebido, `device_id` de path traversal, fechas imposibles).
