# Auditoría por roles — SisHoras

Análisis del repositorio realizado por cuatro agentes especializados. Cada uno
entregó su reporte independiente; este índice consolida los hallazgos y el orden
de trabajo sugerido.

| Rol | Reporte | Foco |
|-----|---------|------|
| Arquitecto de Software | [`reporte-arquitecto.md`](./reporte-arquitecto.md) | Capas, acoplamiento, patrones de diseño, resiliencia |
| DBA (MySQL 8) | [`reporte-dba.md`](./reporte-dba.md) | Normalización, índices, planes de ejecución, caché |
| Desarrollador Full Stack | [`reporte-dev.md`](./reporte-dev.md) | Cuellos de botella, refactors antes/después |
| Ciberseguridad (OWASP) | [`reporte-ciberseguridad.md`](./reporte-ciberseguridad.md) | Inyección, control de acceso, fugas, config |

## Hallazgos convergentes (los cuatro roles coinciden)

1. **Rutas async sin `try/catch` en Express 4** → un error de BD queda como
   `unhandledRejection` y puede tumbar el proceso. *(Arquitecto §2.1, Dev D-01)*
2. **`DATE(timestamp)` no sargable** en la tabla más caliente (`attendance_logs`),
   presente en ~16 consultas → índices inutilizables. *(DBA §3.1, Dev P-02, Arq §2.7)*
3. **Secretos con defaults inseguros** en `docker-compose.yml` y `analytics/main.py`;
   `JWT_SECRET` conocido = forjar cualquier token. *(Ciber A02, Arq §2.4, Dev D-04)*
4. **API key de Analytics hardcodeada en el bundle del browser** y viajando por
   query string. *(Arq §2.3, Dev D-04, Ciber A02)*
5. **Bridge ZKTeco sin autenticación** con `network_mode: host`. *(Ciber A01, Arq §2.5)*
6. **N+1 severos**: import de empleados, `syncAttendance`, `recomputeRange`. *(DBA §3.2, Dev P-01/P-04)*

## Cambios ya aplicados en esta rama

- **DB — migración `038_performance_indexes.sql`**: 4 índices idempotentes
  (`idx_al_emp_day`, `idx_ds_date_cover`, `idx_ds_date_status`, `idx_perm_status_created`)
  para acelerar cargas de horas, agregaciones mensuales y bandeja de aprobaciones.
- **Seguridad — inyección SQL en att2000**: `zkAdapter.fetchCheckInOut` ahora
  parametriza fechas y sanea `limit` (`TOP (@limit)`) en vez de interpolar.
- **Seguridad — secretos**: `docker-compose.yml` elimina todos los defaults
  inseguros (fail-fast `:?`), publica MySQL/Redis/Analytics/API solo en loopback,
  y exige contraseña en Redis (`--requirepass`).
- **Seguridad — Analytics**: `verify_key` admite header `X-API-Key`, compara en
  tiempo constante y falla cerrado si `API_KEY` no está configurada (sin default).
- **Robustez — manejo de errores**: nueva utilidad `api/src/utils/asyncHandler.js`;
  el error handler global deja de filtrar detalles internos en respuestas 5xx;
  se agregan guardas `unhandledRejection`/`uncaughtException`. Aplicado a las
  rutas críticas de `reports.js` (`/monthly`, `/weekly`).
- **Docs**: `.env.example` documenta `REDIS_PASSWORD` y las claves de servicio.

## Pendiente de mayor esfuerzo (recomendado, no aplicado aquí)

Refactors estructurales sin big-bang, en orden sugerido: proxy BFF para Analytics
(sacar la key del browser), Redis Streams para no perder marcajes, autenticación
`x-api-key` en la API del bridge, consolidación del cliente ZKTeco (hoy triplicado),
capa service/repository, validación con Joi, y los N+1 de importación/recálculo con
operaciones set-based. El detalle y el esfuerzo estimado están en cada reporte.
