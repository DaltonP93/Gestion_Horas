# Reporte de Arquitectura — SisHoras (Gestión de Horas)

**Rol:** Arquitecto de Software senior — solo análisis
**Fecha:** 2026-07-07
**Alcance:** `api/` (Express + MySQL), `web/` (Next.js 14), `bridge/` (ZKTeco Node.js), `analytics/` (FastAPI), `database/`, `ecosystem.config.js`

---

## 1. Visión general de la arquitectura

### 1.1 Topología actual

```
Relojes ZKTeco ──PUSH:8080──► bridge ──Redis pub/sub──► api:4000 ──Socket.io──► web:3000
     ▲                          │(attendance:new,                │
     └────POLL ZKLib────────────┘ device:status/alert)           ├── MySQL `asistencia`
                                                                 └── SQL Server `att2000` (mssql)
web:3000 ──axios JWT──► api:4000
web:3000 ──axios api_key──► analytics:5000 ──SQLAlchemy──► MySQL   ⚠ acoplamiento directo
```

### 1.2 Lo que está bien resuelto

- **Separación en 4 procesos** con responsabilidades razonables: la captura de marcajes (bridge) está desacoplada del core (api) mediante **Redis pub/sub** (`bridge/src/index.js:66-70` publica; `api/src/config/redis.js:18-26` consume). Es el patrón correcto para este dominio.
- **Tiempo real bien planteado**: Socket.io con autenticación JWT en el handshake y salas por rol/usuario (`api/src/socket/socketServer.js:31-48`).
- **Middleware de autorización en capas**: `authenticate` / `authorize` / `requireSuperAdmin` / `requirePermission` con matriz de permisos por módulo y defaults por rol (`api/src/middleware/auth.js`, `api/src/services/permissionMatrix.js`). Diseño RBAC + overrides sólido.
- **Idempotencia en la ingesta**: `INSERT IGNORE` con clave única en `attendance_logs` (`api/src/controllers/attendanceController.js:39-42`, migración `database/migrations/005_attendance_logs_unique.sql`).
- **Report builder con whitelist**: los campos se resuelven contra un catálogo, sin interpolar input del usuario (`api/src/routes/reportsBuilder.js:23-70`). Buen antídoto contra SQL injection.
- **Rate limiting diferenciado** login/auth/global (`api/src/index.js:95-123`) y Helmet activado.

### 1.3 Debilidades estructurales (resumen)

| Área | Diagnóstico |
|---|---|
| Capa de datos | No existe. Sequelize instalado pero usado solo como ejecutor de SQL crudo: **cero modelos**. SQL disperso en 44 rutas + 14 servicios + 5 controllers. |
| Capa de servicios | Parcial: existe `api/src/services/`, pero mucha lógica de negocio vive en las rutas (§2.2). |
| Validación | **Joi está en `api/package.json` pero no se usa en ningún archivo**. Validación ad-hoc `if (!x) return 400` dispersa. |
| Errores | Inconsistente y peligroso con Express 4 + handlers `async` (§2.1). |
| Configuración | Hosts/IPs/keys hardcodeados en código, contradiciendo la política del propio `CLAUDE.md` (§2.4). |
| Resiliencia | Pub/sub fire-and-forget: si la API está caída, los marcajes publicados por el bridge **se pierden** (§2.6). Crons arrancan antes de verificar la BD. |
| Acoplamiento | El frontend habla **directo** con analytics con una API key hardcodeada en el bundle del browser (§2.3 — crítico). |
| Testing | 3 archivos de test para ~13.500 líneas de API + ~16.700 de web. |

---

## 2. Hallazgos detallados (file:line)

### 2.1 CRÍTICO — Manejo de errores async: la API puede caerse con un solo request

Express 4 no captura promesas rechazadas en handlers `async`; en Node moderno un `unhandledRejection` termina el proceso, y **no hay handler global**. Rutas async sin `try/catch` cuyo error nunca llega al error-middleware de `api/src/index.js:185`:

- `api/src/routes/reports.js:10-38` (`GET /monthly`) y `:41-63` (`GET /weekly`).
- `api/src/routes/faceRecognition.js` — 5 handlers, **0** try/catch.
- `api/src/routes/attendance.js` — 6 handlers, 1 try; `routes/webhooks.js` — 6/1; `routes/employees.js` — 10/3; `routes/integration.js` — 5/1; `routes/notifications.js` — 10/4.
- `bridge/src/index.js:252-257` (`GET /devices/:id/users`) — sin catch.

El error-handler está registrado **antes** del 404 (`api/src/index.js:185-195`): funciona por la aridad, pero es orden no convencional.

### 2.2 ALTO — Lógica de negocio e infraestructura dentro de las rutas

- `api/src/routes/devices.js:13-23` ping TCP crudo con `net.Socket`; `:64-87` factory ZKTeco (`openZK`); `:93-120` retry (`withZK`). Está **triplicada**: `api/src/config/zkAdapter.js` y `bridge/src/zkManager.js`. ZKTeco admite **una sola sesión TCP** (`bridge/src/index.js:307-309`): API y bridge pueden pisarse la sesión.
- `api/src/routes/webhooks.js:101` define `fireWebhooks` y lo exporta desde el router (`:247`); un controller lo importa con `try { require('../routes/webhooks') } catch {}` (`api/src/controllers/attendanceController.js:4-5`): dependencia controller → ruta, invertida. Falta un `services/webhooks.js`.
- `api/src/services/scheduler.js` (538 líneas) god-service: reportes (`:41`), HTML de email (`:168`) y 3 crons (`:219, :377, :415`).
- `api/src/routes/sync.js:40-60`: al probar conexión **muta `process.env` en runtime** como mecanismo de configuración; `api/src/config/att2000.js:57-65` reconstruye config desde env en cada reconexión.

### 2.3 CRÍTICO — Acoplamiento web → analytics con secreto en el bundle

- `web/src/lib/api.ts:110-126`: el frontend llama a analytics con `api_key: 'analytics_secret_key'` **hardcodeada en el browser** (4 ocurrencias).
- `analytics/main.py:44`: el default del servidor es esa misma clave y se transmite por **query string** (`main.py:46`) → queda en access logs.
- Analytics expone datos de asistencia de **todos** los empleados sin JWT, sin roles, sin rate limit.
- El reporte mensual está **duplicado en dos lenguajes**: `api/src/routes/reports.js:19-35` y `analytics/main.py:137-156`.

### 2.4 ALTO — Configuración: el código contradice la política de CLAUDE.md

- Dominio interno hardcodeado en CORS: `api/src/index.js:76-77`, `api/src/socket/socketServer.js:16-17`, `analytics/main.py:33`.
- IPs privadas de relojes como default: `bridge/src/index.js:38-42` y docstring `:6-9`.
- Host interno y usuario `sa` como defaults de SQL Server: `api/src/config/att2000.js:22-24`.
- **Inconsistencia de nombres**: CLAUDE.md documenta `ATT2000_HOST/PORT/USER/PASSWORD`; el código lee `ATT_HOST/ATT_PORT/ATT_USER/ATT_PASSWORD` (`att2000.js:22-26`).
- Sin validación de entorno al boot.

### 2.5 CRÍTICO — Bridge: API HTTP sin autenticación

`bridge/src/index.js:141-261` (`startBridgeApi`) expone **sin autenticación**: forzar sync (`:163`), diagnóstico (`:188, :201`), **escaneo de subred LAN** (`:215`), probe de IPs arbitrarias (`:230`) y listado de usuarios enrolados (`:252`). Existe `authenticateServiceKey` para bridge→api (`auth.js:57-63`), pero LAN → bridge está abierto.

Además CLAUDE.md documenta PUSH en 8080 y API bridge en 8081, pero el código usa `PUSH_PORT || 8080` (`pushServer.js:160`) y `PORT || 8080` para la API (`bridge/src/index.js:259`): **con defaults ambos colisionan**.

### 2.6 ALTO — Resiliencia del pipeline de marcajes

- **Pub/sub sin durabilidad**: `redis.publish('attendance:new', ...)` (`bridge/src/index.js:68`) es fire-and-forget. Un deploy/crash de la API pierde marcajes.
- **Estado de sync en memoria**: `deviceState` (`bridge/src/index.js:92`) guarda `lastSync` en RAM.
- **Crons antes que la BD**: `api/src/index.js:207-223` arranca 6 crons **antes** de `sequelize.authenticate()` (`:226`), con `.catch(() => {})` silenciosos.
- **Ingesta secuencial**: `bridgeWebhook` procesa eventos en serie (`attendanceController.js:213-215`).

### 2.7 ALTO — Cuellos de botella de datos

- **Consultas no sargables sobre la tabla más caliente**: `WHERE DATE(timestamp) = ?` en `attendanceController.js:95,111,255` y `reports.js:102`. Debe ser rango `timestamp >= ? AND timestamp < ?`.
- **Recalculo por marcaje**: cada punch ejecuta `recalcDailySummary` completo (4 queries) síncrono en el consumidor Redis.
- **`detectMarkType` por paridad** (`attendanceController.js:98-99`): decide in/out por par/impar del count del día. Frágil.
- **N+1 en escritura a att2000**: `writeCheckinOut` hace SELECT + INSERT **por registro** (`att2000.js:161-180`).
- **`io.emit` global de marcajes** (`attendanceController.js:69,319,357`): difunde a *todos* los sockets, incluido rol `employee` — fuga de datos.

### 2.8 MEDIO — Despliegue y esquema

- **`ecosystem.config.js` no incluye analytics** (solo api, web, bridge).
- **37 migraciones sin runner**: se aplican a mano; no hay tabla de control.
- `instances: 1, exec_mode: 'fork'`: no escala sin adapter Redis de Socket.io y rate-limit store compartido.

### 2.9 MEDIO — Seguridad de sesión en el frontend

- `access_token`/`refresh_token` en `localStorage` (`web/src/lib/api.ts:37,49,61-66`): XSS exfiltra la sesión.
- JWT por query string para descargas (`auth.js:18`): queda en logs de nginx y `morgan('combined')`.
- CLAUDE.md declara att2000 **SOLO LECTURA**, pero `writeCheckinOut` escribe (`att2000.js:138-190`).

### 2.10 MEDIO — Frontend

- **God-components**: `configuracion/page.tsx` **1.548 líneas**; `reportes/page.tsx` 802; `empleados/page.tsx` 767.
- `web/src/lib/api.ts` mezcla cliente HTTP, tokens, refresh y catálogo; el refresh no encola requests concurrentes.

---

## 3. Patrones de diseño recomendados

### 3.1 `asyncHandler` + jerarquía de errores (elimina §2.1)

```js
// api/src/utils/asyncHandler.js
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// api/src/utils/errors.js
class AppError extends Error {
  constructor(message, status = 500, code = 'INTERNAL') { super(message); this.status = status; this.code = code; }
}
class NotFoundError extends AppError { constructor(m) { super(m, 404, 'NOT_FOUND'); } }
class ValidationError extends AppError { constructor(m) { super(m, 400, 'VALIDATION'); } }
```

Más un único error-middleware que loguea con stack, responde `{ error, code }` sin filtrar `err.message` interno en 500, registrado **después** del 404; y `process.on('unhandledRejection')` como red de seguridad.

### 3.2 Capa Service + Repository sobre el SQL existente

```
api/src/repositories/attendanceRepo.js  // findLogsByDay(), insertLog(), upsertDailySummary()
api/src/repositories/employeeRepo.js    // findByCode(), findActive()
api/src/services/attendanceService.js   // processAttendanceEvent(), recalcDailySummary()
api/src/services/reportService.js       // monthly(), weekly(), marcadas() ← única fuente de verdad
```

Analytics debería consumir la API o una vista SQL compartida (`v_monthly_summary`), no duplicar el SQL en Python.

### 3.3 Middleware de validación con Joi (ya instalado, sin usar)

```js
// api/src/middleware/validate.js
const validate = (schema, source = 'body') => (req, res, next) => {
  const { error, value } = schema.validate(req[source], { stripUnknown: true });
  if (error) return next(new ValidationError(error.details.map(d => d.message).join('; ')));
  req[source] = value; next();
};
```

### 3.4 Un solo adaptador ZKTeco (Factory + Adapter — consolida 3 implementaciones)

Regla arquitectónica: **solo el bridge habla con los relojes** (dueño exclusivo de la única sesión TCP); la API pide operaciones al bridge vía HTTP autenticado con `x-api-key`.

### 3.5 Event-driven durable: Redis Streams en lugar de pub/sub

```js
// bridge: XADD en vez de PUBLISH
await redis.xAdd('stream:attendance', '*', { payload: JSON.stringify(event) });
// api: consumer group con ACK y reintento (XAUTOCLAIM tras restart)
```

Un deploy/crash de la API ya no pierde marcajes.

### 3.6 BFF: el browser nunca habla con analytics

```js
// api/src/routes/analytics.js — proxy con el secreto en servidor
router.use(authenticate, requirePermission('reportes', 'view'));
router.get('/*', asyncHandler(async (req, res) => {
  const r = await axios.get(`${process.env.ANALYTICS_URL}${req.path}`, {
    params: req.query, headers: { 'X-API-Key': process.env.ANALYTICS_API_KEY },
  });
  res.json(r.data);
}));
```

### 3.7 Módulo de configuración validado al boot

```js
// api/src/config/env.js — falla el arranque si falta un secreto
const schema = Joi.object({
  JWT_SECRET: Joi.string().min(32).required(),
  DB_HOST: Joi.string().required(), DB_NAME: Joi.string().required(),
  ATT_HOST: Joi.string().required(),
  BRIDGE_API_KEY: Joi.string().min(24).required(),
  FRONTEND_URL: Joi.string().uri().required(),
  ANALYTICS_API_KEY: Joi.string().min(24).required(),
}).unknown(true);
```

### 3.8 Registro automático de rutas

Reemplazar los 45 `require` + 45 `app.use` manuales (`api/src/index.js:17-169`) por convención (`fs.readdirSync('routes')`).

---

## 4. Recomendaciones priorizadas

| # | Prioridad | Recomendación | Esfuerzo |
|---|---|---|---|
| 1 | **Crítico** | Sacar la API key de analytics del bundle: proxy vía API (§3.6), clave por header, sin default, rotar | 0,5–1 día |
| 2 | **Crítico** | `asyncHandler` + error-middleware único + `process.on('unhandledRejection')` | 2–3 días |
| 3 | **Crítico** | Autenticar la API del bridge con `x-api-key` y corregir colisión de puertos 8080/8081 | 0,5 día |
| 4 | **Alto** | Redis Streams + consumer group para `attendance:new`; persistir `lastSync` | 2–3 días |
| 5 | **Alto** | Validación de config al boot, eliminar dominio/IPs hardcodeados, unificar `ATT_*` vs `ATT2000_*` | 1–2 días |
| 6 | **Alto** | Consultas sargables (rangos en vez de `DATE(timestamp)=?`) + índice `(employee_id, timestamp)`; `detectMarkType` por última marca | 1 día |
| 7 | **Alto** | Consolidar cliente ZKTeco; bridge como único dueño de la sesión | 3–5 días |
| 8 | **Alto** | Capa service/repository (asistencia y reportes); mover `fireWebhooks` a `services/` | 5–8 días |
| 9 | **Medio** | Middleware de validación Joi en endpoints de escritura | 2–3 días |
| 10 | **Medio** | Agregar analytics a `ecosystem.config.js`; runner de migraciones con tabla de control | 1–2 días |
| 11 | **Medio** | Arrancar crons **después** de `sequelize.authenticate()`; health check real | 0,5 día |
| 12 | **Medio** | Socket.io: emitir marcajes a salas en vez de `io.emit` global | 0,5 día |
| 13 | **Medio** | Refresh token a cookie httpOnly; descargas con URL firmada | 2–3 días |
| 14 | **Medio** | Resolver contradicción att2000 read-only | 0,5–1 día |
| 15 | **Bajo** | Partir god-components del web | 3–5 días |
| 16 | **Bajo** | Registro automático de rutas; preparar cluster | 1–2 días |
| 17 | **Bajo** | Tests sobre la nueva capa de servicios | continuo |

**Orden sugerido:** 1 → 3 → 2 → 5 → 11 → 6 → 12 → 4 → 9 → 8 → 7 → resto (~4–6 semanas incrementales, sin big-bang).

---

## Resumen

1. Macro-arquitectura correcta (4 servicios, Redis como bus, Socket.io con JWT, RBAC granular); micro-arquitectura frágil.
2. CRÍTICO: API key de analytics hardcodeada en el bundle (`web/src/lib/api.ts:113-124`) con default idéntico en `analytics/main.py:44`.
3. CRÍTICO: rutas async sin try/catch en Express 4 y sin handler de `unhandledRejection`.
4. CRÍTICO: la API HTTP del bridge no tiene autenticación y sus dos servidores colisionan en 8080 con defaults.
5. ALTO: pub/sub fire-and-forget pierde marcajes — migrar a Redis Streams.
6. ALTO: sin capa de datos, Joi instalado pero sin usar, lógica ZKTeco triplicada.
7. ALTO: `DATE(timestamp)=?` no sargable y `detectMarkType` por paridad.
8. ALTO: CLAUDE.md se contradice con el código (dominio, IPs, `ATT_*` vs `ATT2000_*`, att2000 "solo lectura" con escritura).
9. MEDIO: analytics ausente de `ecosystem.config.js`, migraciones sin runner, tokens en localStorage, `io.emit` global.
10. Nada exige reescritura: orden 1→3→2→5→11→6→12→4→9→8→7, ~4–6 semanas incrementales.
