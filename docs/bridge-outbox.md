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

### El contrato valida antes de tocar el disco

`enqueue` corre `validateEvent` del contrato v1 **antes** de insertar. Una marcación que no pasa el contrato tampoco se va a poder transmitir después; guardarla sólo llenaría la cola de basura imposible de drenar.

## Qué NO se guarda

El Outbox es un archivo **sin cifrar** en el disco del Bridge, que vive en la misma LAN que los relojes. Guardar ahí selfies, plantillas biométricas o credenciales sería crear un objetivo nuevo.

Se descartan antes de escribir: `selfie`, `photo`, `image`, `face`, `face_template`, `biometric`, `fingerprint`, `template`, `password`, `comm_password`, `token`, `api_key`, `authorization`, y también `ip` / `device_ip` — la IP no aporta a la identidad de la marcación y es topología de red.

Hay un test que lee el **archivo `.db` en bruto** y verifica que las marcas no aparezcan, no sólo que el objeto devuelto no las tenga.

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
