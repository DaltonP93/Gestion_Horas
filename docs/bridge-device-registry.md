# Registro de relojes del Bridge

Cómo el ZKTeco Bridge decide qué relojes existen, y por qué dejó de inventarse uno.

---

## Inventario: dónde se configuran los relojes hoy

Antes de cambiar nada hay que saber qué toca qué. El resultado del relevamiento:

| Superficie | ¿Configura relojes del Bridge? | Notas |
|---|---|---|
| `ZKTECO_DEVICES` (entorno) | **Sí** — única fuente real | leída vía `dotenv` desde `bridge/.env` |
| `DEFAULT_DEVICES` (código) | **Sí** — el fallback que se elimina | inventaba `Reloj test` |
| `bridge/.env` | Sí, indirectamente | hoy no define `ZKTECO_DEVICES` |
| PM2 (`ecosystem.config.js`) | No | sólo define `BRIDGE_API_PORT` y `BRIDGE_BIND` |
| MySQL, tabla `devices` | **No — para el Bridge** | la usan la API y el sync-worker |
| `discovery.js` | No | escanea la LAN bajo demanda; no registra nada |
| Variables individuales | No existen | no hay `DEVICE_IP` / `DEVICE_PORT` |

### La fuente canónica actual es el entorno, no MySQL

Vale la pena decirlo explícito porque es natural suponer lo contrario: **el Bridge nunca consultó MySQL.** No tiene `mysql2` ni `sequelize` entre sus dependencias.

Existen **dos espacios de identificadores distintos** que hoy no se cruzan:

- **Bridge** → relojes de `ZKTECO_DEVICES`, con `id` derivado de la posición en la lista.
- **API / sync-worker** → relojes de la tabla `devices` de MySQL, con `id` de base.

Que el Bridge lea MySQL sería una decisión de arquitectura con consecuencias propias (acoplar el Bridge a la base, decidir qué pasa si la base no responde, unificar los dos espacios de `id`). **No se toma en este PR**, que sólo corrige el fallback. El sync-worker sigue usando los relojes de MySQL, sin cambios.

---

## El problema

Sin `ZKTECO_DEVICES`, el Bridge arrancaba con:

```
📍 Reloj test          x.x.x.x:4370
```

y `/health` informaba `devices: 1`. En producción eso significa que health, push-status y cualquier Outbox futuro afirman que hay un reloj cuando no hay ninguno. Un diagnóstico que miente es peor que uno que falta.

El parser heredado además aceptaba basura en silencio:

| `ZKTECO_DEVICES` | Comportamiento anterior | Ahora |
|---|---|---|
| *(ausente)* | 1 reloj inventado | 0 relojes, `degraded` |
| `999.1.1.1:4370` | 1 reloj con IP imposible | rechazado, `host_invalid` |
| `10.0.0.11:abcd` | 1 reloj con `port: NaN` | rechazado, `port_invalid` |
| `,,` | **3 relojes** con IP vacía | rechazado, `entry_empty` ×3 |
| `10.0.0.11:4370;10.0.0.12:4370` | 1 reloj, el segundo desaparecía | rechazado, `delimiter_invalid` |

---

## Formato de configuración

```
[nombre@]host[:puerto][#serial]
```

Separador entre entradas: **coma**. El formato heredado `ip:port` sigue funcionando igual.

```bash
ZKTECO_DEVICES=Gerencia@10.0.0.11:4370,Comedor@10.0.0.12:4370,Lavadero@10.0.0.13:4370
```

El nombre existe porque los relojes reales tienen nombre propio y el `Reloj 1` que generaba el parser viejo no sirve para operar ni para leer un log.

También se acepta JSON, útil si la configuración se genera:

```bash
ZKTECO_DEVICES=[{"name":"Gerencia","ip":"10.0.0.11","port":4370,"serial":"SN-A1"}]
```

### Validación

Se rechazan, entrada por entrada: vacías, delimitadores incorrectos (`;`, `|`, `@` o `#` repetidos), puertos no numéricos o fuera de `1..65535`, IP con octetos fuera de rango o con ceros a la izquierda, hostnames mal formados, y direcciones, seriales o nombres duplicados.

**Una entrada inválida no descarta las válidas.** Se conserva lo que se pueda parsear y se registra el problema. Si *todas* fallan, el Bridge queda degradado — nunca se sustituye por un reloj inventado.

---

## Reloj de prueba

Sólo con la variable explícita, y **nunca en producción**:

```bash
BRIDGE_ALLOW_TEST_DEVICE=true
```

- El valor tiene que ser exactamente `true`. `1`, `yes`, `TRUE` no habilitan nada.
- Con `NODE_ENV=production` se **rechaza aunque la flag esté puesta**, y se registra `test_device_refused_in_production`. Es la regla que este módulo existe para sostener: si bastara con poner una variable, el fallback silencioso volvería por la puerta de al lado.

---

## Estado degradado

Sin relojes configurados el proceso **sigue levantando**. Caerse dejaría al operador sin forma de preguntar qué pasa.

- `/health` responde **HTTP 200** con `status: "degraded"`.
- No se intenta ninguna conexión a ningún reloj.
- Si `ZKTECO_AUTO_POLL=true` pero no hay relojes, el polling no arranca y se registra el motivo.

### Por qué 200 y no 503

El proceso está vivo; lo que falta es configuración. Un 503 haría que `/api/health/detailed` reportara el Bridge como **inalcanzable**, que es un diagnóstico distinto y equivocado. El estado degradado viaja en el cuerpo, donde se puede leer sin confundirlo con una caída.

---

## Cuerpo de `/health`

```json
{
  "status": "degraded",
  "degraded": true,
  "configured_devices": 0,
  "devices": 0,
  "device_source": "none",
  "config_problems": 2,
  "push_server": { "enabled": true, "port": 8080 },
  "timestamp": "2026-08-05T14:02:11.001Z"
}
```

`device_source` es uno de `zkteco_devices_env`, `test_device_explicit`, `none`.

`devices` se mantiene como alias del conteo por compatibilidad: la API ya consultaba este endpoint y no conviene romperle la forma en el mismo PR que corrige el registro.

### Qué NO aparece

`/health` **no lleva autenticación** — es lo primero que ve cualquiera que alcance el puerto. Por eso no expone IP, seriales, nombres de reloj ni ninguna clave. Un conteo y un estado alcanzan para operar; una lista de IPs y seriales es un mapa de la red interna. Hay tests que lo verifican por serialización, no por inspección de campos.

---

## push-status con el Bridge sin configurar

`GET /devices/:id/push-state` responde **503** con:

```json
{ "error": "Bridge sin configurar", "code": "bridge_not_configured",
  "device_source": "none", "configured_devices": 0, "config_problems": 0 }
```

Del lado de la API, `bridgeClient` traduce ese caso a `BRIDGE_DEVICES_UNCONFIGURED` → HTTP 503, distinto de:

- `BRIDGE_NOT_CONFIGURED` — falta `BRIDGE_API_KEY` **de nuestro lado**;
- `BRIDGE_ERROR` — el Bridge respondió un 5xx cualquiera.

Sin esa distinción, un Bridge sano sin relojes caía en `BRIDGE_ERROR` → 502, el mismo síntoma que un Bridge caído. Es la falla que corrigió el PR #116 reapareciendo por otro camino: no convertir todo en un 502 genérico.

---

## Fuera de alcance

No se modifican el sync-worker, el polling, el scheduling, `USER_WRQ`, la ingestión PUSH, Redis ni MySQL.
