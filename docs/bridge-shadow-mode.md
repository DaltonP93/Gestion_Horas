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
| 1ª | `sn:<SERIAL>` reportado por el reloj, en mayúsculas | sobrevive a cambio de IP y a reordenar la variable |
| 2ª | `addr:<sha256(ip:puerto)[:16]>` del reloj configurado | se rompe si se reasigna la IP, pero no depende del orden |

### El serial se canoniza

La allowlist y `ZKTECO_DEVICES` ya comparan sin distinguir mayúsculas, así que `ger-0001` y `GER-0001` son el mismo reloj para decidir si se observa. La clave se normaliza a mayúsculas para que también sean el mismo reloj para **correlacionar**.

Sin eso, el serial que el reloj anuncia por PUSH y el que un operador tipea en `ZKTECO_DEVICES` para el polling —dos textos escritos por manos distintas— podían diferir sólo en capitalización y producir dos `event_id` para el mismo marcaje. La comparación habría mostrado todo como `only_push` / `only_polling` sin que nada fallara a la vista: un resultado falso con aspecto de hallazgo.

### La dirección de respaldo va hasheada

El fallback `addr:` se usa sólo si el reloj hace PUSH sin declarar serial. La dirección se hashea antes de formar la clave: la IP es topología de red, y escribirla en `device_key` la habría persistido en claro y devuelto en `by_device`, contradiciendo la garantía de que se usa para correlacionar y se descarta. El hash conserva lo único que hace falta —que el mismo reloj dé siempre la misma clave— sin dejar topología en un archivo sin cifrar.

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

`confirm: true` es obligatorio. Acepta `before` para acotar por fecha, que debe ser **ISO-8601 con offset explícito y sin fracción de segundo** — por ejemplo `2026-03-11T12:00:00Z` o `2026-03-11T09:00:00-03:00`.

Un `before` mal formado se rechaza con **400**; no se interpreta. La comparación de SQLite es lexicográfica, así que `occurred_at < 'not-a-date'` es verdadero para toda marca ISO —`'2' < 'n'`— y un corte mal tipeado no acotaba el borrado: lo volvía total.

Tres reglas que salen de ahí:

- **Una hora de pared sin offset se rechaza.** Decidir qué se borra obligaría a suponer una zona, y en una operación destructiva suponer está fuera de discusión.
- **Ausente ≠ presente e inválido.** Sólo omitir `before` (o mandarlo `null`) significa "purgar todo". `0`, `false` y `""` son inválidos y dan 400 — son triviales de producir desde un cliente con una variable de fecha sin inicializar, y colapsarlos a "sin corte" anularía la validación entera.
- **La fracción de segundo se rechaza.** `occurred_at` se guarda truncado al segundo y la comparación es textual, así que `12:00:00.999Z` no funciona de ninguna de las dos formas posibles: truncándolo a `12:00:00Z` deja sin borrar una fila de `12:00:00Z` que sí es anterior, y conservándolo la comparación cruza dos formatos y `'12:00:00Z' < '12:00:00.999Z'` resulta **falso** porque `Z` (0x5A) > `.` (0x2E). Rechazarla mantiene toda comparación entre cadenas de la misma forma.

### Bases del formato de identidad anterior

El archivo lleva su versión de identidad en `PRAGMA user_version`:

| Versión | Formato de `device_key` |
|---|---|
| 1 | serial tal cual lo mandó el reloj, dirección en claro |
| 2 | serial en mayúsculas, dirección hasheada |

Una base escrita con la versión 1 **se rechaza** al abrir (`shadow_open_failed` / `shadow_schema_outdated`) en vez de mezclarse. `CREATE TABLE IF NOT EXISTS` no migra nada: las filas viejas conservan claves distintas para el mismo reloj, así que un reenvío entraría como evento nuevo, la comparación quedaría partida en el punto del despliegue y las direcciones viejas seguirían en claro en `by_device`.

Se rechaza en vez de migrar porque la sombra es dato observacional sin consumidor todavía: descartarla no cuesta nada, y recalcular `event_id` de filas existentes es bastante más riesgoso que empezar de cero. El Bridge sigue recibiendo marcaciones igual — la sombra es best-effort y con el almacén cerrado no interrumpe nada.

Para recuperarse: borrar o mover el archivo y dejar que se cree de nuevo.

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

## PUSH en modo observe-only

> **`BRIDGE_SHADOW_ENABLED=true` NO implica observe-only.** Son dos decisiones distintas y se toman por separado.

### El problema que resuelve

La sombra es pasiva, pero el servidor sobre el que cuelga no lo es. El recorrido real de un ATTLOG es:

```
ATTLOG → shadow.capture() → dedupe Redis → publishAttendance()
                                              ├─ XADD stream:attendance
                                              └─ PUBLISH attendance:new
```

Configurar un reloj para ADMS con la sombra encendida **no** lo convierte en observado: lo convierte en un **segundo productor** de asistencia mientras el polling sigue siendo el autoritativo. Eso es exactamente lo que el experimento existe para evitar.

### La flag

```bash
BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST=      # vacía = ningún reloj (comportamiento histórico)
```

Es una **allowlist por reloj**, nunca un interruptor global. Una flag global podría apagar la publicación de relojes que sí deben publicar, y esa pérdida sería silenciosa: el reloj recibe `OK`, el operador ve tráfico llegando, y la asistencia simplemente no aparece.

Cada token puede nombrar al reloj por serial, por nombre (el de `ZKTECO_DEVICES`) o por IP, con la **misma** canonización que usa la sombra — las reglas viven en `deviceIdentity.js` y las comparten los dos. Si divergieran, un reloj podría quedar observado por la sombra y publicado por el PUSH a la vez.

### Qué hace y qué no

Para un reloj en la allowlist:

| Sí | No |
|---|---|
| acepta `GET /iclock/cdata` (registro) | `publishAttendance()` |
| acepta el heartbeat | `XADD stream:attendance` |
| acepta `POST` ATTLOG | `PUBLISH attendance:new` |
| ejecuta `shadow.capture()` | dedupe en Redis (`SET NX` es una **escritura**) |
| mantiene `lastSeen` / `lastPunch` / conteo | insertar en MySQL o tocar `daily_summary` |
| responde `OK`, protocolo idéntico | ACK distinto, borrar logs del reloj, tocar el polling o el Outbox |

El corte ocurre **antes** del dedupe, no sólo antes de publicar: `SET NX` escribiría en Redis claves de un reloj que por definición no está produciendo asistencia. La sombra ya tiene su propia idempotencia por `event_id`.

Y el corte **no depende de que la sombra funcione**. Con la sombra apagada, sin sombra, o con el almacén roto, el reloj observe-only sigue sin publicar: un fallo de la herramienta de diagnóstico no puede convertirlo en productor.

### Cómo se resuelve el reloj

En orden:

1. **Por serial**, si el reloj lo reporta y coincide con un `#serial` de `ZKTECO_DEVICES`.
2. **Por IP**, si el serial no coincide con ninguno configurado. El `#serial` es **opcional** y el formato habitual no lo lleva (`Gerencia@10.x.x.11:4370`), así que sin este paso el reloj quedaría sin resolver y una allowlist por nombre no activaría observe-only.

En el paso 2 sólo compiten los relojes que **no** declaran serial. Uno configurado con un serial distinto del reportado es demostrablemente otro aparato, y emparejarlo por compartir la IP atribuiría el marcaje al reloj equivocado.

### Relojes no identificables

Un reloj que no se puede resolver sin ambigüedad **no entra** en observe-only y se procesa normal. El caso concreto: `resolveDevices` rechaza direcciones repetidas (`ip:puerto`) pero admite dos relojes en la misma IP con puertos distintos; si ninguno declara serial, esa IP no alcanza para saber cuál es.

La dirección de fallo segura es **publicar**: suprimir la publicación del reloj equivocado perdería sus marcaciones sin que nadie se entere. Se cuenta en `observe_only_ambiguous` y se registra una advertencia sin IP ni serial.

> **Lo más robusto es declarar el `#serial`** en `ZKTECO_DEVICES` y nombrar el reloj por su serial en la allowlist: así la identidad no depende de la IP, que puede reasignarse.

### Relojes configurados por hostname

`ZKTECO_DEVICES` admite hostnames (`Gerencia@reloj-gerencia.local:4370`). Un reloj configurado así **y sin `#serial`** no se puede resolver: la configuración guarda el texto del hostname y la petición PUSH llega con una dirección numérica, y esa comparación no coincide nunca. Nombrarlo por su **nombre** en la allowlist no surtiría efecto — y en observe-only eso significa que el reloj publica asistencia igual.

El Bridge lo detecta al arrancar y lo dice en voz alta:

```
❌ BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST: "gerencia" no va a surtir efecto —
   el reloj se configuró con hostname y sin #serial: declarar el serial
   ese reloj SEGUIRÍA PUBLICANDO asistencia. Corregir antes de configurarlo para ADMS.
```

También se expone en `GET /push-metrics` como `observe_only_config_problems`, para poder comprobarlo **antes** de tocar el reloj. La solución es declarar el `#serial`.

> El modo de fallo natural de estas listas es **silencioso**: un token que no engancha con nada no produce ningún error, simplemente no aplica. Por eso el chequeo existe.

### Despliegue con Docker

`bridge/.env` **no llega al contenedor** — el `Dockerfile` sólo copia `package*.json` y `src/`. Toda flag del Bridge tiene que reenviarse explícitamente desde el `.env` raíz; `docker-compose.yml` ya lo hace para `BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST` y las de la sombra.

Sin ese passthrough, un despliegue Docker arranca con la allowlist vacía y el reloj publica asistencia junto con el polling, aunque el operador haya seguido el ejemplo del `.env.example`.

Si se define `BRIDGE_SHADOW_PATH`, la ruta debe caer en un volumen montado o la sombra se pierde en cada recreación del contenedor.

### Métricas

`GET /push-metrics` (detrás de `x-api-key`):

```json
{
  "observe_only_allowlist_size": 1,
  "observe_only_received": 0,
  "observe_only_suppressed_publish": 0,
  "observe_only_ambiguous": 0
}
```

Sólo conteos: ni código de empleado, ni IP, ni payload. `pushState` sigue llevando `lastSeen`, `lastPunch` y el conteo también para los relojes observados —marcados con `observeOnly: true`—, porque sin eso un reloj en observación se vería idéntico a uno desconectado.

### Encenderlo para Gerencia

```bash
# bridge/.env
BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST=<serial de Gerencia>
```

`pm2 reload bridge`, y **recién entonces** configurar el reloj para ADMS. En ese orden: si el reloj empieza a hacer PUSH antes de que la flag esté puesta, publica.

## Qué falta para la comparación real

Este cambio deja la mitad PUSH lista y la consulta escrita. Falta, en un cambio aparte:

1. que el worker de polling escriba sus observaciones con `source: 'polling'`;
2. correr los dos caminos en paralelo sobre el mismo período;
3. leer `/shadow/compare` y decidir a partir de los números.

Nada de eso está enganchado todavía.
