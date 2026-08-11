# Modo sombra del Bridge

Guarda una **copia** normalizada de lo que ya llega por PUSH, para poder compararla más adelante contra lo que ve el polling.

> **Estado: implementado y APAGADO.**
> `BRIDGE_SHADOW_ENABLED=false` en producción. Con la flag apagada no se crea el archivo, no se carga `better-sqlite3` y no se intercepta el PUSH. La mitad `polling` de la comparación está vacía porque todavía no hay nadie escribiendo con ese origen: el worker **no** está enganchado y este cambio no lo engancha.

---

## Qué es y qué no es

Sombra significa **observar**, no producir. El marcaje sigue exactamente por donde iba y no se entera de nada.

Lo que el modo sombra **no hace**, y no puede empezar a hacer sin una decisión explícita:

| No hace | Por qué importa |
|---|---|
| `INSERT` en `attendance` | no es una fuente de asistencia |
| `UPDATE` de `daily_summary` | no cambia horas trabajadas ni tardanzas |
| `XADD` a Redis Streams | no alimenta el tiempo real |
| `POST` a la API | no agrega tráfico ni un productor nuevo |
| ACK al reloj | el reloj no cambia su comportamiento |
| apagar el polling | el polling sigue como está |
| borrar logs del reloj | nada se consume ni se destruye en el hardware |

La consecuencia práctica: **encenderlo y apagarlo no cambia ningún número que el usuario vea.**

## Flags

```bash
BRIDGE_SHADOW_ENABLED=false            # apagado = no-op real
BRIDGE_SHADOW_DEVICE_ALLOWLIST=        # vacío = NINGÚN reloj
BRIDGE_SHADOW_CAPTURE_PUSH=true        # sólo tiene efecto con la sombra encendida
BRIDGE_SHADOW_PATH=                    # sin ruta la sombra no arranca
```

### Vacío significa *nadie*

Ojo con la asimetría respecto de `ZKTECO_PUSH_WHITELIST`, donde vacío significa **todos permitidos**. En la allowlist de sombra vacío significa **nadie**, y es a propósito:

- la whitelist filtra **quién puede marcar** — abrirla de más deja pasar relojes;
- la allowlist de sombra decide **sobre quién se acumula una copia de datos**.

El valor por defecto de una copia nueva tiene que ser "de nadie". Se enciende nombrando el reloj:

```bash
BRIDGE_SHADOW_DEVICE_ALLOWLIST=Gerencia
```

Cada entrada puede nombrar al reloj por **serial**, por **nombre** (el de `ZKTECO_DEVICES`) o por **IP**, sin distinguir mayúsculas.

## Identidad del reloj: estable, nunca posicional

`resolveDevices` asigna `id = índice + 1` dentro de `ZKTECO_DEVICES`. Ese id **no sirve como identidad**: agregar un reloj al principio de la variable renumera todos los que siguen, y filas ya escritas pasarían a "pertenecer" a otro reloj.

La sombra usa `device_key`, que sale de la identidad estable:

| Preferencia | Valor | Estabilidad |
|---|---|---|
| 1ª | `sn:<SERIAL>` reportado por el reloj | sobrevive a cambio de IP y a reordenar la variable |
| 2ª | `addr:<ip>:<puerto>` del reloj configurado | se rompe si se reasigna la IP, pero no depende del orden |

El contrato v1 exige un `device_id` **entero** positivo. Se deriva por hash de `device_key`, así que el mismo reloj da siempre el mismo número sin coordinación entre procesos — que es lo que necesita el `event_id` para ser comparable. Ese entero es un **subrogado local de la sombra**: no es `devices.id` de MySQL ni el índice de `ZKTECO_DEVICES`.

## Esquema

```sql
CREATE TABLE shadow_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       TEXT    NOT NULL,        -- del contrato v1
  device_key     TEXT    NOT NULL,        -- identidad estable
  device_id      INTEGER NOT NULL,        -- subrogado derivado de device_key
  source         TEXT    NOT NULL,        -- 'push' | 'polling'
  payload        TEXT    NOT NULL,
  occurred_at    TEXT    NOT NULL,
  observed_at    TEXT    NOT NULL,
  CHECK (source IN ('push','polling')),
  UNIQUE (source, event_id)
);
```

### Por qué `UNIQUE (source, event_id)` y no `UNIQUE (event_id)`

`event_id` sale de la **identidad** del marcaje —`device_id`, `device_user_id`, `occurred_at`, `event_type`— y de nada más. Eso es lo que hace posible la comparación: el mismo marcaje visto por PUSH y por polling calcula el mismo identificador sin coordinación.

Por eso mismo, un `UNIQUE` sobre `event_id` solo haría **imposible** guardar la observación de polling de un marcaje que PUSH ya vio — justo el caso que este almacén existe para poder contrastar. La unicidad va por `(source, event_id)`: una observación por origen.

`verify_mode` y `work_code` **no** entran en el identificador, así que son exactamente los atributos que pueden diferir entre los dos caminos sin dejar de ser el mismo marcaje.

## Independencia del Outbox

Archivo, flag y tabla **separados**. Son ciclos de vida opuestos:

- el **Outbox** es una cola de transmisión: sus filas existen para salir y se borran tras el ACK;
- la **sombra** es un registro de observación: no sale a ningún lado y se conserva para poder mirarla después.

Encender la sombra no enciende la cola de transmisión. Hoy `BRIDGE_OUTBOX_ENABLED=false` y sigue así.

## Observa antes del dedupe

La copia se toma **antes** del dedupe de Redis, a propósito: la sombra mide lo que el reloj **emitió**, no lo que este pipeline decidió conservar. Filtrar ahí la volvería ciega justamente a los reenvíos que se quiere cuantificar.

Su idempotencia es propia (`UNIQUE (source, event_id)`), así que un reenvío suma a `duplicates` en vez de duplicar la fila.

## Best-effort

Cualquier error de la sombra —almacén roto, SQLite ausente, disco lleno— **no puede** impedir el procesamiento PUSH existente. `capture()` no lanza nunca, y el llamador en `pushServer.js` lo envuelve igual. Un observador que puede tirar abajo lo observado no es un observador, es un riesgo nuevo.

## Privacidad

Se persiste una **lista cerrada** de campos, la del contrato v1:

```
event_id, device_id, device_user_id, occurred_at, event_type, verify_mode, work_code
```

Una lista de prohibidos no alcanzaría: `validateEvent` ignora las propiedades que no conoce, así que un `auth_token` —o un `metadata` anidado— pasaría entero al disco. Con lista blanca, nada nuevo entra por descuido.

**No se guarda**: nombre del empleado, IP del reloj, plantilla biométrica, foto, ni la línea ATTLOG cruda. La IP se usa sólo para correlacionar con el reloj configurado y se descarta.

**No se registra en logs**: nada de lo anterior, y tampoco el código de empleado ni la hora cruda. Los logs de la sombra llevan sólo conteos agregados y códigos de error.

## Endpoints

Todos detrás de `x-api-key` (`BRIDGE_API_KEY`). Ninguno cuelga de `/health`.

### `GET /shadow/status`

Métricas agregadas. Nunca devuelve marcaciones.

```json
{
  "enabled": true,
  "capture_push": true,
  "allowlist_size": 1,
  "store_open": true,
  "runtime": {
    "events_received": 0, "events_valid": 0, "duplicates": 0,
    "invalid": 0, "persisted": 0, "errors": 0,
    "skipped_not_allowed": 0, "skipped_unknown_device": 0,
    "first_event_at": null, "last_event_at": null
  },
  "stored": { "stored": 0, "by_source": {}, "by_device": {} }
}
```

`runtime` se reinicia con el proceso; `stored` se lee del disco y sobrevive al reinicio.

### `GET /shadow/compare`

Comparación PUSH ↔ polling, de sólo lectura. Parámetros opcionales: `from`, `to`, `device_key`.

```json
{
  "polling_connected": false,
  "totals": {
    "push": 95, "polling": 0, "common": 0,
    "only_push": 95, "only_polling": 0,
    "verify_mode_differs": 0, "work_code_differs": 0
  }
}
```

`polling_connected: false` dice que **nadie está escribiendo ese origen todavía**. Sin ese campo, un informe con `only_push == push` se leería como "el polling no vio nada", que es un diagnóstico distinto y equivocado.

### `POST /shadow/purge`

Vaciado administrativo explícito. **No hay limpieza automática** por edad ni por tamaño: una sombra que se borra sola perdería justamente el período que se quiere comparar.

```bash
curl -X POST http://127.0.0.1:8081/shadow/purge \
  -H "x-api-key: $BRIDGE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"confirm": true}'
```

`confirm: true` es obligatorio. Acepta `before` (ISO) para acotar por fecha.

## Encenderlo para Gerencia

```bash
# bridge/.env
BRIDGE_SHADOW_ENABLED=true
BRIDGE_SHADOW_DEVICE_ALLOWLIST=Gerencia
BRIDGE_SHADOW_PATH=/var/lib/sishoras/shadow.db
```

```bash
pm2 reload bridge
curl -s -H "x-api-key: $BRIDGE_API_KEY" http://127.0.0.1:8081/shadow/status
```

Para apagarlo, `BRIDGE_SHADOW_ENABLED=false` y `pm2 reload bridge`. El archivo queda donde está: apagar no borra.

### Línea base de Gerencia

Como referencia de volumen, con polling (80 corridas/día): 424.941 registros leídos, 95 importados, ~40 MiB/día de tráfico, ~2,56 s promedio por corrida. La sombra sobre PUSH no agrega ninguna de esas lecturas — sólo escribe una fila por marcaje observado.

## Qué falta para la comparación real

Este cambio deja la mitad PUSH lista y la consulta escrita. Falta, en un cambio aparte:

1. que el worker de polling escriba sus observaciones con `source: 'polling'`;
2. correr los dos caminos en paralelo sobre el mismo período;
3. leer `/shadow/compare` y decidir a partir de los números.

Nada de eso está enganchado todavía.
