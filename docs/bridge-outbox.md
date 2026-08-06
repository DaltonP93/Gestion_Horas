# Outbox local del Bridge

Cola durable en SQLite para que una marcación se guarde **antes** de transmitirse y se borre **sólo** después del ACK del servidor.

> **Estado: implementado y DESCONECTADO.**
> No lo llama el PUSH, ni el polling, ni la API, ni Redis, ni MySQL. Con la flag apagada no se crea el archivo ni se abre SQLite. Hoy sólo lo ejercitan los tests.

---

## El problema que resolverá

Hoy, si el core está caído cuando el reloj emite una marcación, la marcación se pierde. No hay ningún lugar donde quede esperando.

El Outbox introduce ese lugar:

```
reloj → Bridge → [outbox: pending] → transmitir → ACK → [acknowledged]
                       ↑                              │
                       └──── sin ACK: reintento ──────┘
```

Lo importante es el orden: **primero se guarda, después se transmite.** Una marcación sólo se considera entregada cuando el servidor lo confirma.

## Por qué SQLite y no un archivo

Hacen falta dos cosas que un JSON en disco no da:

- **Durabilidad ante corte de energía.** Un crash a mitad de escritura deja el archivo corrupto y se pierde todo, no sólo lo último.
- **Exclusión entre consumidores.** Dos procesos leyendo el mismo archivo transmiten la misma marcación dos veces.

## Esquema

```sql
CREATE TABLE outbox_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         TEXT    NOT NULL UNIQUE,   -- del contrato v1
  device_id        INTEGER NOT NULL,
  payload          TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TEXT    NULL,
  created_at       TEXT    NOT NULL,
  acknowledged_at  TEXT    NULL,
  last_error_code  TEXT    NULL,
  claimed_at       TEXT    NULL,              -- para rescatar lotes huérfanos
  claim_token      TEXT    NULL,              -- identifica UN reclamo concreto
  CHECK (status IN ('pending','sending','acknowledged','dead_letter'))
);
```

Índices: `(status, next_attempt_at)` para reclamar, `(created_at)`, `(device_id)`, y `(status, claimed_at)` para el rescate.

`event_id` es `UNIQUE`: la idempotencia la impone el esquema, no el código.

## Máquina de estados

```
pending ──claimBatch──> sending ──acknowledge──> acknowledged
   ^                       │
   └──releaseForRetry──────┤
                           └──moveToDeadLetter──> dead_letter
```

`recoverStaleClaims` devuelve a `pending` lo que quedó en `sending` porque el proceso murió con el lote en vuelo.

Los cuatro estados son cerrados, con `CHECK` en la tabla.

## API interna

| Función | Qué hace |
|---|---|
| `enqueue(evento)` | Valida contra el contrato v1 y guarda. Idempotente por `event_id`. |
| `claimBatch({limit})` | Reclama filas transmitibles y las marca `sending`. |
| `acknowledge(ids)` | Confirma la entrega. Idempotente. |
| `releaseForRetry(ids, {backoffMs})` | Vuelve a `pending`; al agotar intentos va a `dead_letter`. |
| `moveToDeadLetter(ids)` | Descarta explícitamente. No puede tocar algo ya confirmado. |
| `recoverStaleClaims()` | Rescata lotes huérfanos pasado el TTL. |
| `stats()` | Conteos por estado. Sin datos personales. |

Ninguna lanza: devuelven `{ ok, error_code }`. Un Bridge que no puede abrir su Outbox tiene que seguir recibiendo marcaciones por el camino actual, no caerse.

## Garantías y cómo se sostienen

### `IMMEDIATE`, no la transacción por defecto

`db.transaction()` de better-sqlite3 es **DEFERRED**: toma el lock de lectura en el primer `SELECT` y recién lo sube a escritura en el `UPDATE`. Dos procesos pueden entonces leer las **mismas** filas como `pending`.

`claimBatch` usa `tx.immediate()`, que toma el lock de escritura de entrada: el segundo proceso espera (`busy_timeout`) y vuelve a leer el estado ya actualizado.

**Esto no se puede probar dentro de un proceso.** better-sqlite3 es síncrono y JavaScript de un solo hilo, así que dos "consumidores" en el mismo proceso corren uno después del otro y jamás se interleavean. Una prueba de mutación lo dejó en evidencia: se podía quitar entera la transacción y los 37 tests del archivo principal seguían pasando.

Por eso existe `outboxConcurrency.test.js`, que levanta **procesos hijos de verdad**, los sincroniza para que entren juntos, y verifica que ninguna marcación se reclame dos veces. Ese archivo sí falla si se quita la transacción o si se degrada a `deferred`.

### `synchronous = FULL`, no `NORMAL`

`NORMAL` puede perder las últimas transacciones ante un corte de energía. Es justamente el caso que el Outbox existe para cubrir, así que se paga el costo de `FULL`.

### WAL

Un lector no bloquea al escritor, y la base sobrevive a un corte sin quedar a medias.

### Token de reclamo

`claimBatch` devuelve un `claim_token`, y `acknowledge` / `releaseForRetry` lo aceptan para condicionar la transición.

Sin él hay una carrera **semántica** que serializar la transacción no arregla: el consumidor A reclama, se cuelga, `recoverStaleClaims` devuelve la fila a `pending`, B la reclama — y recién ahí A revive y llama a `releaseForRetry`. A estaría devolviendo a `pending` un lote que B tiene en vuelo y sano, o sumándole un intento hacia `dead_letter`.

Con token, la operación de A no encuentra nada que cambiar.

### `SQLITE_BUSY` se devuelve, no se lanza

Si otro escritor mantiene el lock más allá de `busy_timeout`, SQLite lanza. El contrato del módulo es que **ninguna operación lanza**, así que las transacciones se envuelven y el error se traduce a `{ ok: false, error_code: 'outbox_busy' }`. Una vez conectado, esto deja al consumidor reintentar en vez de morir.

### El contrato valida antes de tocar el disco

`enqueue` corre `validateEvent` del contrato v1 **antes** de insertar. Una marcación que no pasa el contrato tampoco se va a poder transmitir después; guardarla sólo llenaría la cola de basura imposible de drenar.

## Qué NO se guarda

El Outbox es un archivo **sin cifrar** en el disco del Bridge, que vive en la misma LAN que los relojes. Guardar ahí selfies, plantillas biométricas o credenciales sería crear un objetivo nuevo.

El payload se construye desde una **lista cerrada** de campos —exactamente los del contrato v1— y no desde una lista de prohibidos.

La lista negra era insuficiente por construcción: `validateEvent` ignora las propiedades desconocidas, así que un evento perfectamente válido con `auth_token`, o con `metadata: { token }` anidado e invisible para una comprobación de primer nivel, pasaba entero al disco. Una lista negra sólo detiene lo que alguien pensó en nombrar.

Queda fuera también la **IP**: no aporta a la identidad de la marcación y es topología de red.

Hay un test que lee el **archivo `.db` en bruto** y verifica que las marcas no aparezcan, no sólo que el objeto devuelto no las tenga.

## Driver y versión

`better-sqlite3` **fijado a `^12.11.1`**, no a la última.

`node:sqlite` no sirve: el repo declara `engines: node >=20` y CI corre en Node 20; `node:sqlite` recién existe en 22.5 y es experimental.

Y dentro de `better-sqlite3`, la `13.x` declara `engines: node >=22` — instalarla habría roto CI y el `Dockerfile` del Bridge, que también usa Node 20. La `12.x` declara `20.x || 22.x || 23.x || 24.x`.

Al ser un módulo nativo, si el despliegue lo compila desde fuente hace falta toolchain. Como el `require` es **perezoso**, una instalación donde falle no rompe el Bridge mientras la flag esté apagada.

## Configuración

```bash
BRIDGE_OUTBOX_ENABLED=false          # sólo "true" exacto lo enciende
BRIDGE_OUTBOX_PATH=                  # sin ruta no arranca; no se adivina ninguna
BRIDGE_OUTBOX_CLAIM_TTL_MS=300000    # lote en vuelo > 5 min = huérfano
BRIDGE_OUTBOX_MAX_ATTEMPTS=10        # luego va a dead_letter
```

Con la flag apagada: **no se crea el archivo, no se abre SQLite, no se carga el driver nativo** (el `require` es perezoso, así que una instalación sin `better-sqlite3` funciona igual), y toda operación responde `outbox_not_open`.

## Límites y operación

- **El archivo debe estar en disco local.** SQLite necesita bloqueo de archivo real; sobre NFS o un montaje de red el bloqueo no es confiable y la exclusión entre consumidores deja de valer.
- **Un solo archivo por Bridge.** No está pensado para compartirse entre hosts.
- **La cola no se purga sola.** Las filas `acknowledged` y `dead_letter` se acumulan; hará falta una tarea de retención cuando esto se conecte. No se implementó ahora para no inventar una política de retención sin datos de uso.
- **`dead_letter` requiere intervención.** Nada las reintenta; hay que mirarlas y decidir.
- **Tamaño.** Cada fila es el payload canónico, del orden de 200–300 bytes. Un reloj con 500 marcaciones diarias sin conexión durante una semana ronda el megabyte.

### Inspección manual

```bash
sqlite3 /var/lib/sishoras/outbox.db \
  "SELECT status, COUNT(*) FROM outbox_events GROUP BY status;"
```

## Fuera de alcance

No se conecta al polling, al PUSH, a la API, a Redis ni a MySQL. No se modifica el worker ni el scheduling. Conectarlo es un paso posterior y deliberado.
