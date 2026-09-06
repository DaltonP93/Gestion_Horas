# Evidencia — orden de migraciones 081-083 antes de 076-080 (P1-C, #206)

> Artefacto de auditoría (Rule 5): simulación con el runner REAL `api/scripts/migrate.js`
> sobre un **MySQL 8 DESCARTABLE**, demostrando qué pasa si un despliegue aplica 081-083
> (lotes 3/5) **antes** que las **menores** 076-080 (FASE F, lote 6). Nunca producción/att2000.

## Cómo reproducir

Requisitos: Docker + Node (con `api/node_modules`) + cliente `mysql` + acceso de fetch al repo.

```bash
DB_PORT=3307 DB_PASSWORD=disposable_ci_pw bash docs/evidence/migration-order-sim.sh
```

El harness (`docs/evidence/migration-order-sim.sh`) hace fetch de las migraciones 076-083 por
SHA de HEAD de sus PR (documentados dentro del script), carga `init.sql` + stubs mínimos, y corre
el runner real en dos fases + idempotencia.

SHAs usados: 076-080 = #161 `807f82a`; 081 = #198 `272a739`; 082 = #201 `bf8b583`; 083 = #202 `6254f77`.

## Resultado (log sanitizado, 2026-09-06)

```
== FASE 1: migrate con 081-083 presentes, SIN 076-080 ==
Migraciones: 3 totales, 0 aplicadas, 3 pendientes.
→ Aplicando 081_monthly_report_approvals.sql ... OK
→ Aplicando 082_monthly_report_pades_metadata.sql ... OK
→ Aplicando 083_fase_e_activation_console.sql ... ❌ ERROR 1146: Table 'asistencia.system_settings' doesn't exist

== FASE 2: se AÑADEN 076-080 (menores) y se corre migrate de nuevo ==
Migraciones: 8 totales, 2 aplicadas, 6 pendientes.
→ Aplicando 076_governance_companies_cost_centers.sql ... OK
→ Aplicando 077_audit_correlation_id.sql ... OK
→ Aplicando 078_people_candidates_assignments.sql ... OK
→ Aplicando 079_labor_calendars.sql ... OK
→ Aplicando 080_payroll_base.sql ... OK
→ Aplicando 083_fase_e_activation_console.sql ... ❌ ERROR 1146: Table 'asistencia.system_settings' doesn't exist
-- orden temporal (applied_at) de 076-083:
081_monthly_report_approvals.sql        2026-09-06 15:48:24
082_monthly_report_pades_metadata.sql   2026-09-06 15:48:24
076_governance_companies_cost_centers.sql  2026-09-06 15:48:25   <- MENOR, aplicada DESPUÉS
077_audit_correlation_id.sql            2026-09-06 15:48:25
078_people_candidates_assignments.sql   2026-09-06 15:48:25
079_labor_calendars.sql                 2026-09-06 15:48:25
080_payroll_base.sql                    2026-09-06 15:48:25

== FASE 3: idempotencia — migrate otra vez ==
Migraciones: 8 totales, 7 aplicadas, 1 pendientes.   <- sólo 083 queda pendiente; NO reaplica 076-082

== VERIFICACIÓN (companies cost_centers labor_calendars mra branches.company_id fk_branches_company) ==
1  1  1  1  1  1
```

## Qué prueba

1. **`migrate.js` no tiene guardia de monotonicidad:** aplica una migración de número **menor**
   (076-080) añadida después, **temporalmente después** de las mayores ya aplicadas (081/082) —
   ver `applied_at` (081/082 @ :24, 076-080 @ :25) — en orden ascendente entre ellas, sin advertir.
2. **SQL-safe para el conjunto actual:** 081/082 aplican **sin** 076-080 (no dependen de FASE F);
   076-080 aplican **después** sin romper nada. El FK que cruza el límite
   (`branches.company_id → companies(id)`) queda **íntegro** (verificación = `1`).
3. **Idempotente:** en la 3ª corrida no se reaplica nada ya aplicado (sólo 083 sigue pendiente).

## Caveat independiente (no es el problema de orden)

`083` falla por `Table 'system_settings' doesn't exist`: `migrate.js` **no es autosuficiente desde
`init.sql`** — algunas migraciones asumen tablas creadas por el **sync del ORM** (`system_settings`,
`webhooks`). La estrategia del proyecto es **migración autocontenida**: **#194 ya lo arregla para la
020** (`CREATE TABLE IF NOT EXISTS webhooks`) y su job DB corre en verde. Pendiente: **083** (#202)
debe recibir el mismo trato y el job de BD extenderse a 076-083 cuando esos lotes se integren.

## Conclusión / decisión

Orden fuera de secuencia = **SQL-safe pero CONTINGENTE** (depende de que no haya dependencia cruzada,
hoy verificado). Por eso **NO-GO** para 081/082/083 hasta ordenar vs 076-080 (preferido: FASE F primero;
alternativa: renumerar y exigir unicidad global). Detalle en `INTEGRATION_PLAN.md` §Orden de migraciones.

## Limitaciones / no verificado

- Evidencia **local reproducible**, no un job de CI de #206 (el job de BD vive en #194).
- Los stubs (`branches`/`audit_events`/`employee_documents`/`payroll_periods`) sustituyen migraciones
  002-075 que no se corren aquí; el objetivo es aislar la **mecánica de orden** de 076-083, no un
  replay completo. El replay completo 002-075 se cubre en el job DB de #194 (verde).
