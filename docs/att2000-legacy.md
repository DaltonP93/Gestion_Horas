# Integración LEGADA att2000 (pull automático opcional)

att2000 (SQL Server) deja de ser el flujo normal de marcaciones y pasa a ser una
**integración legada opcional**: contingencia, migración y recuperación
histórica. El pull automático queda detrás de un **kill switch** y, por defecto,
**deshabilitado**.

## Kill switch

```bash
ATT2000_AUTO_PULL_ENABLED=false   # por defecto: pull automático DESHABILITADO
ATT2000_PULL_CRON=                # expresión node-cron (sólo si el switch = true)
```

- El cron de marcaciones att2000 (`startAtt2000PullCron` en
  `api/src/services/scheduler.js`) **sólo se registra** cuando
  `ATT2000_AUTO_PULL_ENABLED=true` **y** existe `ATT2000_PULL_CRON`.
- Con el switch en `false`, el cron **no se programa** (se registra un log
  informativo). **No** se apaga el cron en caliente, **no** se eliminan
  endpoints, tablas ni migraciones, y **no** se toca el worker ZKTeco.

### Plan en producción

Tras validar 24 h con el pull automático activo, dejar el valor inicial en
**`false`** y operar att2000 sólo por acciones manuales (contingencia/histórico).

## Endpoints manuales (siguen operativos)

Bajo `/api/sync` (restringido a **super_admin**), independientes del kill switch:

- `GET  /test`, `POST /test-conn` — prueba de conexión.
- `POST /departments`, `POST /employees` — sincronizar departamentos/empleados.
- `POST /attendance` — marcaciones históricas de un período.
- `POST /full` — full sync.
- `POST /push-to-att2000` — enviar marcaciones locales → att2000 (recuperación).
- `GET  /checkinout`, `/users`, `/shifts`, `/machines-list`, `/diagnostics`,
  `/reconcile*` — lectura/diagnóstico.

**Auditoría:** cada ejecución manual que muta datos (`full`, `attendance`,
`departments`, `employees`, `push-to-att2000`) queda en el audit log
(`att2000.*`) con acción, rango y contadores. **Nunca** se registran credenciales
(host/usuario/password del `conn` dinámico).

## Estado en Salud del sistema

`GET /api/health/detailed` (admin) incluye `att2000_legacy`:

```json
"att2000_legacy": {
  "available": true,
  "auto_pull_enabled": false,
  "last_run": {
    "at": "2026-07-29T…Z",
    "source": "manual",          // "auto" | "manual"
    "ok": true,
    "imported": 60,
    "duplicate": 171,
    "unmapped": 5,
    "error": null
  }
}
```

`last_run` es en memoria (última corrida auto o manual desde el arranque); no
persiste secretos.

## No incluido en este PR

No apaga el cron en caliente, no elimina endpoints/tablas/migraciones, no modifica
auto-polling ZKTeco ni el worker, no inicia USER_WRQ, no toca datos de producción.

## Pruebas

`api/tests/att2000Legacy.test.js`: kill switch `false`/`true` (con y sin
expresión) sobre `startAtt2000PullCron`, `autoPullEnabled`, `available`, y
`recordRun`/`getStatus` (contadores/fuente, sin credenciales en el estado).
