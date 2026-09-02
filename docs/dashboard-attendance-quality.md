# Calidad de métricas de asistencia — diagnóstico read-only

> Actualizado: 2026-09-02. Diagnóstico sobre `main` (HEAD `078cd67`).
> Documento de estado; no habilita writers, sync ni cambios de datos.

## Bloque C — semántica del dashboard (`getDashboardStats`)

Revisión de sólo lectura de `api/src/controllers/attendanceController.js`
(`getDashboardStats`). **La semántica ya es correcta** y NO se cambió código:

- `present` / `late` / `absent` / `on_permission` se cuentan como
  `COUNT(DISTINCT ds.employee_id)` sobre `daily_summary` unido a empleados
  activos: sólo entran empleados **vinculados**.
- `present_today` = `COUNT(DISTINCT al.employee_id)` sobre `attendance_logs`
  (empleados vinculados con marca hoy); `live_punches` = `COUNT(*)` de
  `attendance_logs`.
- `raw_today` / `mapped_today` / `unmapped_pending` / `unmapped_today` salen de
  `raw_device_punches` en un bloque `try/catch` best-effort: si esa tabla o sus
  columnas faltan, el dashboard sigue sirviéndose sin romperse.
- `coverage_pct` = `present_today / activos`.

Conclusiones verificadas:

1. **Una marca sin vincular NUNCA cuenta como "presente".** Las marcas crudas y
   las no mapeadas viven en contadores separados (`raw_*`, `unmapped_*`), nunca
   en `present`/`present_today`.
2. **Un 401 de PUSH/ADMS no bloquea el dashboard ni una lectura pull.** El
   dashboard no llama a PUSH/ADMS en ningún punto; se arma sólo con lecturas de
   MySQL. La disponibilidad de los relojes es independiente.

### Test fiel: diferido por falta de arnés

Un test fiel de esta semántica SQL (presente-vinculado vs. cruda vs. no-mapeada
vs. cobertura parcial, sobre fixtures sintéticos) requiere un arnés de **MySQL
efímero** que hoy NO existe en `main` (el `ci.yml` de `main` corre sólo API/Web/
Bridge; el job de MySQL efímero vive en la cadena FASE F, congelada). Agregar
ese arnés a `main` se solaparía con el `ci.yml` de FASE F pendiente de auditoría,
así que **se difiere** hasta resolver esa cadena. La semántica queda documentada
como correcta por inspección; no hay cambio de producto pendiente.

## Bloque D — gate de impacto FASE E (`workday-config-impact-audit`)

Ver `docs/workday-engine-rollout-status.md` (FASE E) para el procedimiento. El
auditor de impacto compara, sobre el mismo rango, la resolución `fallback` pura
contra la resolución con configuración, y con `--require-no-impact` frena
(exit 1) si alguna jornada cambia.

Corrección aplicada (sólo el diagnóstico read-only, sin writers ni datos):

- La huella `signature()` leía `s.in_ts`/`s.out_ts`, campos que el motor **no
  produce**: quedaban `undefined` en las dos ramas, de modo que la comparación
  sólo miraba `work_date` + `segment_minutes` + cantidad de segmentos. Una
  configuración con descanso descontado (misma suma cruda entrada→salida, menos
  minutos trabajados) se reportaba como "sin cambio" y el gate podía dar **GO
  con impacto real** sobre `daily_summary`.
- Ahora la huella usa los campos reales de segmento (`in`/`out` de pared,
  `minutes`) e incluye `worked_minutes`, `break_minutes`, `calculation_mode` y
  `non_working_kind`. El gate se vuelve **más estricto** (falla hacia NO-GO), que
  es la dirección segura.
- Cobertura: `api/tests/workdayConfigImpactAudit.test.js`, sobre datos
  sintéticos y con el motor real, corrida además bajo UTC / America/Asuncion /
  Asia/Tokyo. Verifica el invariante "sin configuración → `historical_fallback` y
  sin cambio", que un cambio real se detecta, la regresión de la huella vieja, y
  `validDate` sobre fechas civiles existentes.

Sin cambios en `attendance_logs`, `daily_summary`, migraciones ni flags. FASE E
sigue con sus gates abiertos.
