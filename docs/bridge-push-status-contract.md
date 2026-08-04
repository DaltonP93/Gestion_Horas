# Contrato API ↔ Bridge: estado PUSH de un reloj

Versión del contrato: **1**

## Por qué existe

`GET /api/devices/:id/push-status` devolvía **502** con el Bridge sano:

- `sishoras-bridge` online, escuchando en `127.0.0.1:8081`;
- `GET /health` → **200**;
- `GET /api/devices/1/push-status` → **502**.

El inventario dio dos fallas independientes, ninguna del lado del Bridge:

### 1 · La API no mandaba la clave

La API del Bridge exige `x-api-key` en **todas** las rutas salvo `/health`, y falla cerrado. La llamada de `push-status` no enviaba ninguna cabecera:

```js
const r = await fetch(`${bridgeUrl}/devices/${device.id}/push-state`)   // sin x-api-key
if (!r.ok) throw new Error(`Bridge respondió ${r.status}`)              // 401 → excepción
// …catch → res.status(502)
```

Por eso `/health` respondía 200 y `push-status` 502: **no eran el mismo tipo de ruta**. Otras llamadas del mismo archivo (`bridgeRequest`) sí mandaban la clave, así que la variable de entorno ya estaba configurada — simplemente no se usaba acá.

### 2 · Dos espacios de identificadores distintos

La API pedía `/devices/<devices.id de MySQL>/push-state`. El Bridge arma su lista desde `ZKTECO_DEVICES` y asigna ids **por posición**:

```js
return envDevices.split(',').map((entry, idx) => ({ id: idx + 1, /* … */ }))
```

`id` en un lado es la clave primaria de MySQL; en el otro, un índice de array. Coincidían sólo por casualidad. Incluso con la clave arreglada, el reloj con `devices.id = 7` habría dado 404.

Además, el Bridge cruzaba el estado PUSH con `s.ip === device.ip`, donde `device.ip` viene del entorno del Bridge — no de `devices.ip_address` de la API.

## El contrato

### Petición

```
GET /push-status?serial=<sn>&ip=<ipv4>
x-api-key: <BRIDGE_API_KEY>
x-correlation-id: <id de la petición>
```

Se identifica el reloj por **serial o IP** — los dos datos que ambos lados comparten de verdad. Al menos uno es obligatorio; con ambos, el serial gana. Sin ninguno: `400`.

### Respuesta (200)

```json
{
  "contract_version": 1,
  "found": true,
  "serial": "ABC123456",
  "last_push_at": "2026-08-04T18:22:31.000Z",
  "last_event_at": "2026-08-04T18:20:05.000Z",
  "matched_by": "serial"
}
```

| Campo | Significado |
|---|---|
| `contract_version` | Cambia sólo ante cambios incompatibles. El consumidor **rechaza** una versión que no entiende en vez de interpretarla a medias. |
| `found` | Si el Bridge tiene estado PUSH para ese reloj. |
| `last_push_at` | Último contacto del reloj (heartbeat o registro). |
| `last_event_at` | Último marcaje recibido. |
| `matched_by` | `serial`, `ip` o `none` — **cómo** se resolvió, sin revelar la dirección. |

La respuesta **no** incluye la IP del reloj, tokens ni secretos: la API ya sabe la dirección, y un endpoint de diagnóstico no tiene por qué repetirla.

## Respuesta de la API al navegador

```json
{
  "available": true,
  "device_id": 1,
  "device": "Reloj Recepción",
  "serial": "ABC123456",
  "last_push_at": "2026-08-04T18:22:31.000Z",
  "last_event_at": "2026-08-04T18:20:05.000Z",
  "status": "online",
  "correlation_id": "sh-9f2a1c4b7e01"
}
```

`status`:

| Valor | Cuándo |
|---|---|
| `online` | Hubo contacto dentro de `PUSH_ONLINE_WINDOW_MS` (default 5 min). |
| `stale` | Hay estado, pero más viejo que esa ventana. |
| `never_seen` | El Bridge responde bien y no tiene estado para ese reloj. |
| `unavailable` | No se pudo consultar al Bridge. |

## Códigos de error y su HTTP

Un 502 para todo hacía indistinguible «el Bridge está caído» de «me falta configurar una clave».

| `error_code` | HTTP | Qué pasó |
|---|---|---|
| `DEVICE_NOT_FOUND` | 404 | El reloj no existe en la base de la API. |
| `BRIDGE_NOT_CONFIGURED` | 503 | Falta `BRIDGE_API_KEY` en la API. |
| `BRIDGE_UNAUTHORIZED` | 503 | El Bridge rechazó la clave — configuración nuestra, no del cliente. |
| `BRIDGE_ROUTE_MISSING` | 502 | Bridge sin este endpoint (versión anterior). |
| `BRIDGE_TIMEOUT` | 504 | No respondió dentro de `BRIDGE_TIMEOUT_MS` (default 4 s). |
| `BRIDGE_UNREACHABLE` | 502 | Conexión rechazada, DNS, socket caído. |
| `BRIDGE_BAD_CONTRACT` | 502 | Respondió algo que no cumple este contrato. |
| `BRIDGE_ERROR` | 502 | 5xx u otro estado inesperado. |

Los mensajes al cliente son **fijos**: nunca el texto crudo del error, la URL del Bridge ni el estado HTTP interno. El detalle técnico va al log junto al `correlation_id`, que también viaja al Bridge como `x-correlation-id`.

## Variables de entorno

| Variable | Default | Para qué |
|---|---|---|
| `BRIDGE_URL` | `http://localhost:8081` | Base de la API del Bridge. |
| `BRIDGE_API_KEY` | — | **Obligatoria.** Sin ella toda consulta responde `BRIDGE_NOT_CONFIGURED`. |
| `BRIDGE_TIMEOUT_MS` | `4000` | Timeout de cada consulta. |
| `PUSH_ONLINE_WINDOW_MS` | `300000` | Ventana para considerar el reloj `online`. |

## Compatibilidad

`GET /devices/:id/push-state` **sigue existiendo sin cambios** en el Bridge. El endpoint nuevo se agrega al lado; nada del camino PUSH (`/iclock/cdata`), del procesamiento de marcaciones, del scheduling, del polling ni de Redis se toca.

Si se despliega la API nueva contra un Bridge viejo, la respuesta es `BRIDGE_ROUTE_MISSING` (502) con mensaje claro, no un fallo silencioso.
