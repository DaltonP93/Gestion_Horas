# Reporte de Análisis Técnico — SisHoras (Gestión de Horas)

**Rol:** Desarrollador Full Stack Senior (Node.js/Express + Next.js 14)
**Fecha:** 2026-07-07
**Alcance:** `api/src/` (~12.600 líneas JS) y `web/src/` (~21.300 líneas TS/TSX)

---

## Resumen ejecutivo

El sistema es funcional y con buenas decisiones puntuales (rate limiting, `INSERT IGNORE` idempotente, React Query configurado, dynamic import de `xlsx`, permisos granulares). Los problemas dominantes son:

1. **Rutas async sin `try/catch` en Express 4** → una consulta fallida deja el request colgado y puede tumbar el proceso (unhandled rejection).
2. **N+1 masivo en importación de empleados** (3+ queries por fila).
3. **`DATE(timestamp)` en cláusulas WHERE** en las tablas más grandes (`attendance_logs`) → índices inutilizables, full scan por consulta.
4. **Búsqueda sin debounce + `limit: 500`** en el frontend → una request por tecla.
5. **Deuda transversal:** 235 respuestas `500` que filtran `err.message` crudo, `joi` instalado pero sin uso, 322 `: any`, 83 `alert()`, componente de 1.548 líneas, secretos/IPs internas hardcodeados.

---

## 1. Cuellos de botella de rendimiento

### 1.1 Backend (api/src)

**P-01 — N+1 en importación de empleados — Crítico**
`api/src/routes/employees.js:61-135`. Por **cada** fila del CSV se ejecutan hasta 3-4 queries secuenciales: lookup de departamento (`:82-85`), `INSERT` de departamento (`:90-93`), lookup de existencia (`:98-100`) y el `INSERT`/`UPDATE` final. Un import de 1.000 empleados ≈ 3.000-4.000 round-trips a MySQL, en serie y sin transacción.

**P-02 — `DATE(timestamp)` no sargable en tablas de alto volumen — Crítico**
`attendance_logs` es la tabla que más crece. Estas consultas anulan cualquier índice sobre `timestamp`:
- `api/src/services/scheduler.js:63` (`generateMarcadasReport`)
- `api/src/services/scheduler.js:351` (`bulkRecalcDailySummary`, cron)
- `api/src/controllers/attendanceController.js:95,111,255`
- `api/src/routes/reports.js:102`, `api/src/routes/me.js:152-153`, `api/src/services/reconciliation.js:21,40`, `api/src/routes/processing.js:20`

Fix: reemplazar `DATE(al.timestamp) BETWEEN ? AND ?` por rango semiabierto `al.timestamp >= ? AND al.timestamp < DATE_ADD(?, INTERVAL 1 DAY)`.

**P-03 — Subconsulta correlacionada por empleado (N+1 en SQL) — Alto**
`api/src/routes/supervisor.js:40-41`: `(SELECT MAX(timestamp) FROM attendance_logs WHERE employee_id = e.id AND DATE(timestamp) = ?)` se ejecuta una vez **por cada empleado**. Fix: `LEFT JOIN (SELECT employee_id, MAX(timestamp) ... GROUP BY employee_id)`.

**P-04 — Procesamiento secuencial del webhook del bridge — Alto**
`api/src/controllers/attendanceController.js:210-221` (`bridgeWebhook`): `for (const event of events) { await processAttendanceEvent(event) }`. Cada evento ~6 queries en serie. Un lote de 50 marcajes ≈ 300 queries secuenciales. El primer error aborta el lote y responde 500 aunque parte ya se insertó.

**P-05 — Queries independientes en serie (falta `Promise.all`) — Medio**
- `attendanceController.js:233-258` (`getDashboardStats`): stats + recentLogs en serie.
- `employeeController.js:28-49` (`getAll`): listado + `COUNT(*)` en serie.
- `attendanceController.js:109-119` (`recalcDailySummary`): logs + feriado + horario.
- `me.js:315-326`: notificaciones + contador unread.

**P-06 — Loops de INSERT/UPDATE fila a fila — Medio**
- `settings.js:130-138`: un upsert **por cada** setting.
- `users.js:199-212`: `DELETE` + un `INSERT` por módulo, **sin transacción**.
- `courses.js:141-153`: un `INSERT` por empleado al asignar curso masivo.

**P-07 — Endpoints sin paginación real — Medio**
- `me.js:155-162,177-184,193-203`: `LIMIT 500`/`200` fijos.
- `employeeController.js:146-160` (`getAttendanceHistory`): **sin `LIMIT`**.
- `reports.js:19-37` (`/monthly`): todos los empleados sin límite.

**P-08 — Generación PDF/Excel CPU-bound en el event loop — Bajo**
`reports.js:123-228` y `:370-625`. Mitigación: cache corto en Redis o worker thread.

### 1.2 Frontend (web/src)

**P-09 — Búsqueda sin debounce + límite 500 — Alto**
`web/src/app/(app)/empleados/page.tsx:559-568` y `:620`: cada tecla dispara una request de hasta 500 filas con 3 JOINs.

**P-10 — 22 páginas con `useEffect + fetch` pese a tener React Query — Medio**
29 archivos usan React Query; otros 22 hacen fetch manual sin cache/dedupe: `auditoria`, `aprobaciones`, `supervisor`, `mi-perfil`, `mis-permisos`, `nomina`, `onboarding`, `evaluaciones`, etc.

**P-11 — `configuracion/page.tsx` monolítico: 1.548 líneas — Medio**
Monta los 5 tabs en el mismo chunk; `RelojesTab`/`SyncTab` se descargan aunque el usuario no pueda verlos.

**P-12 — Estado derivado y re-render evitable — Bajo**
- `empleados/page.tsx:570-572`: `.filter()` en cada render sin `useMemo`.
- `dashboard/page.tsx:81,182`: lista live con `key={i}` (índice).
- `helpContent.ts` (876 líneas) importado estático en `HelpButton.tsx:5`.

**P-13 — `use client` global: 85/85 componentes son client — Bajo**

---

## 2. Deuda técnica

**D-01 — Rutas async sin manejo de errores — Crítico**
El error middleware de `api/src/index.js:185-190` **nunca recibe** errores de handlers `async` sin `try/catch`: `reports.js:10-38,41-63,267-285`, `employees.js:11-16`, `me.js:145-163,167-185,189-204`.

**D-02 — Manejo de errores inconsistente con fuga de información — Alto**
**235 ocurrencias** de `res.status(500).json({ error: err.message })` exponen mensajes SQL/estructura interna (`me.js:77,114,139`, `settings.js:143`, `users.js:189,214,222`, `reports.js:74,226,261`).

**D-03 — Validación artesanal; `joi` instalado pero sin uso — Alto**
`require('joi')` no aparece en ningún archivo. `employeeController.js:83-85` solo valida 3 campos; `attendanceController.js:301-303` no valida `type` ∈ {in,out}.

**D-04 — Secretos, IPs internas y dominios hardcodeados — Alto**
- `web/src/lib/api.ts:113,117,121,124`: `api_key: 'analytics_secret_key'` en el bundle.
- `configuracion/page.tsx:41`: `host: 'sqlserver.example.internal', user: '<usuario_integracion>'`.
- `devices.js:260-263`: IPs de relojes `10.0.0.160-162`.
- `index.js:76-77`: dominio `sishoras.saa.com.py` en CORS.
- JWT como `?access_token=` en URL para descargas (`api.ts:30-42`, `auth.js:18-19`).

**D-05 — Funciones y archivos gigantes — Medio**
`reports.js:370-625` (255 líneas), `scheduler.js` (538), `configuracion/page.tsx` (1.548), `reportes/page.tsx` (802), `empleados/page.tsx` (767).

**D-06 — Código duplicado — Medio**
- Formato fecha Paraguay triplicado: `attendanceController.js:91-93` vs `scheduler.js:20-27` vs `dashboard/page.tsx:188-197`.
- **Regla de tardanza con 3 implementaciones**: `attendanceController.js:154-167`, `:186-207`, `scheduler.js:318-349`.
- Bloque `for (const k of allowed)` de updates parciales repetido en 8+ routers.

**D-07 — Magic numbers y strings — Medio**
`limit: 500`, offset `'-03:00'` repetido, `slice(11,16)` para hora, estados como strings sueltos sin enum.

**D-08 — Tipado débil — Medio**
322 `: any` en `web/src`; sin tipos compartidos de respuestas del API.

**D-09 — UX de errores con `alert()`/`confirm()` — Bajo** — 83 `alert(` sin toasts.

**D-10 — Menores — Bajo**
`scheduler.js:62` no-op muerto; `index.js:208,219` `setTimeout` mágicos; `xlsx@0.18.5` con CVEs.

---

## 3. Refactorizaciones propuestas (antes/después)

### R-1 — Wrapper de errores async + middleware central — Crítico, S (0,5-1 día)

```js
// utils/asyncHandler.js
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// routes/reports.js
router.get('/monthly', asyncHandler(async (req, res) => {
  const [rows] = await sequelize.query(`...`);
  res.json({ data: rows });
}));

// index.js — reemplaza :185-190
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  logger.error(`${status} ${req.method} ${req.originalUrl} — ${err.message}`, { stack: err.stack });
  res.status(status).json({ error: status < 500 ? err.message : 'Error interno del servidor' });
});
```

### R-2 — Import de empleados: de N+1 a 3 queries — Crítico, M (1-2 días)

Precarga de departamentos (1 query) + creación en bloque de faltantes (1 query) + upsert masivo en chunks de 500 dentro de `sequelize.transaction()` con `ON DUPLICATE KEY UPDATE`.

### R-3 — Settings y permisos: bulk upsert atómico — Alto, S (medio día)

```js
const entries = Object.entries(updates).filter(([k]) => SETTING_KEYS.includes(k));
if (entries.length) {
  await sequelize.query(
    `INSERT INTO notification_settings (setting_key, setting_value)
     VALUES ${entries.map(() => '(?,?)').join(',')}
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    { replacements: entries.flatMap(([k, v]) => [k, v == null ? '' : String(v)]) });
}
```
Aplicar a `users.js /:id/permissions` (dentro de transacción) y `courses.js:141-153`.

### R-4 — Empleados: debounce + paginación real con React Query — Alto, M (1 día)

`useDebounce<T>(value, ms)` + `useEmployees()` con `keepPreviousData`, `limit: 50` y paginación real (el API ya devuelve total/pages).

### R-5 — DTOs de validación con joi (ya instalado) — Alto, M (1-2 días)

`middleware/validate.js` con `stripUnknown` + schemas por recurso. Cobertura prioritaria: `POST/PUT /employees`, `POST /attendance/manual`, `POST /me/permissions`, `PUT /settings`, query params de `/reports/*`.

**Complementario:** extraer SQL de routers a `services/`, unificar la regla de tardanza en una función, mover secretos a `.env`/BD.

---

## 4. Priorización y esfuerzo

| ID | Hallazgo | Prioridad | Esfuerzo |
|----|----------|-----------|----------|
| D-01/R-1 | Rutas async sin try/catch | **Crítico** | S (0,5-1 d) |
| P-01/R-2 | N+1 import empleados | **Crítico** | M (1-2 d) |
| P-02 | `DATE(timestamp)` no sargable + índices | **Crítico** | S (1 d) |
| D-04 | Secretos/IPs/api_key hardcodeados | **Alto** | S (0,5 d) |
| P-09/R-4 | Search sin debounce + limit 500 | **Alto** | M (1 d) |
| D-03/R-5 | DTOs joi en escritura | **Alto** | M (1-2 d) |
| P-04 | Webhook bridge secuencial | **Alto** | M (1-2 d) |
| D-02 | 235 fugas de `err.message` | **Alto** | S (con R-1) |
| P-06/R-3 | Loops INSERT | **Medio** | S (0,5 d) |
| P-03 | Subquery correlacionada supervisor | **Medio** | S (0,5 d) |
| P-10 | Migrar 22 páginas a React Query | **Medio** | L (3-5 d) |
| P-05 | `Promise.all` en queries independientes | **Medio** | S (1 d) |
| P-07 | Paginación en `/me/*` e historial | **Medio** | S (1 d) |
| P-11 | Partir `configuracion/page.tsx` | **Medio** | M (1-2 d) |
| D-05/D-06 | Capa de servicios / helpers | **Medio** | L (1 sem) |
| D-07/D-08 | Constantes + tipos compartidos | **Bajo** | M (2-3 d) |
| D-09/D-10 | Toasts, dead code, CVE xlsx | **Bajo** | S-M |

**Ruta sugerida (2 sprints):** Sprint 1 → R-1 + P-02 + D-04 + R-3. Sprint 2 → R-2 + R-4 + R-5 + P-04.
