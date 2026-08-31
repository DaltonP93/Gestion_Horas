# Estado — Workday Engine / Configuración laboral

Última actualización: 2026-08-31, después de integrar FASE C/D en `main`.

## Estado GitHub confirmado

- `main`: `d6498cfcdec97263a756ae0a217d9f195b053ef5`.
- PR #149 (FASE C backend) integrado.
- PR #150 (FASE D UI, stacked) integrado.
- PR #151 aplicó el mismo árbol de FASE D sobre `main`.
- PR #152 fue un merge redundante posterior y **no cambió ningún archivo**.
- El árbol final de `main` es igual al árbol funcional validado de FASE C + FASE D.
- CI post-merge de `main`: API, Web y Bridge verdes.

## Fases

- [x] **FASE A — WorkdayEngine / Marcadas**
  - wall-clock;
  - pairing type-aware;
  - cross-midnight;
  - historical_fallback;
  - anomalías;
  - memoria/Marcadas;
  - tests golden.

- [x] **FASE B — daily_summary / ingesta**
  - dailySummaryEngine;
  - writer detrás de flag;
  - unknown fail-safe;
  - locks/reintentos;
  - ATT2000 read-only;
  - PR #147 + follow-up #148 integrados.

- [x] **FASE C — configuración laboral backend**
  - modelo histórico por vigencias;
  - snapshot autosuficiente;
  - perfil laboral y targets configurables;
  - effective-config;
  - Turnera sólo activa cálculo si existe snapshot histórico completo;
  - APIs + RBAC + auditoría;
  - preflight e impact-audit de sólo lectura;
  - migración 075 aditiva;
  - compatibilidad si 075 todavía no está aplicada.

- [x] **FASE D — UI RR.HH.**
  - índice por empleado;
  - consulta efectiva por fecha;
  - historial de vigencias;
  - crear/corregir/cerrar snapshot;
  - horario/días/tolerancias/descansos;
  - targets semanal/diario;
  - régimen/franja nocturna;
  - policies versionadas;
  - motivo obligatorio;
  - advertencia retroactiva;
  - permisos view/update;
  - sin resnapshot implícito del schedule vivo.

- [ ] **FASE E — auditoría / migraciones / rollout**
  - pendiente en producción;
  - primero sólo lectura;
  - no activar writers ni recalcular hasta cerrar los gates.

## Gates actuales

Hasta cerrar FASE E:

- NO ejecutar un `npm run migrate` ciego en producción.
- NO activar `WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED`.
- NO activar `WORKDAY_ENGINE_STATUS_074_ENABLED`.
- NO recalcular `daily_summary` de producción.
- NO continuar reparación histórica febrero 2025+ hasta cerrar el baseline/auditoría.
- NO modificar `attendance_logs` históricos fuera del procedimiento de reparación aprobado.
- ATT2000 estrictamente READ-ONLY.
- La existencia de Turnera/contrato/`employees.schedule_id` NO activa `configured` sin snapshot histórico completo.
- Empleados no configurados deben permanecer en `historical_fallback`.

## Próximo paso — FASE E, primero READ-ONLY

En el servidor, después de traer el código pero antes de aplicar migraciones o
recargar procesos, ejecutar:

```bash
cd /var/www/html/Gestion_Horas/api

npm run migrate:status
node scripts/workday-config-preflight.js --json

node scripts/workday-config-impact-audit.js \
  --from 2025-01-01 \
  --to 2025-12-31 \
  --require-no-impact
```

Resultado esperado antes de cargar configuración histórica:

- flags del motor en OFF;
- `configured = 0`;
- `changed_by_configuration = 0`;
- jornadas observadas en `historical_fallback`.

Si cualquiera de esos puntos no se cumple: **NO-GO** y se investiga antes de
migrar, recalcular o reanudar la reparación histórica.

## Secuencia posterior si el preflight es limpio

1. backup verificable de MySQL;
2. inventario exacto de migraciones pendientes;
3. revisar 072→075 una por una;
4. aplicar sólo con autorización explícita y flags en OFF;
5. repetir preflight + impact-audit;
6. validar Marcadas enero 2025 contra baseline conocido;
7. recién después preparar febrero 2025;
8. mantener `daily_summary` sin recálculo hasta que la reparación histórica y los dry-runs cierren.
