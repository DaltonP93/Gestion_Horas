# Evidencia — orden de migraciones 081-083 vs 076-080 (P1-C, #206)

> Artefacto de auditoría (Rule 5): simulación con el runner REAL `api/scripts/migrate.js`
> sobre un **MySQL 8 DESCARTABLE Y AISLADO**. **Nunca** producción/att2000.

## Garantías de aislamiento del harness (`docs/evidence/migration-order-sim.sh`)

- `set -Eeuo pipefail` + `trap` de limpieza desde el inicio.
- **Ignora** `DB_*/CID` del entorno: contenedor, base, puerto (loopback `127.0.0.1:0`) y password
  **únicos y aleatorios** (nonce). Etiqueta `migordevidence=<nonce>`; la limpieza **sólo** elimina el
  contenedor cuya etiqueta coincide (nunca por nombre fijo/configurable).
- Consultas administrativas por `docker exec` (sin red). El runner Node usa el puerto loopback del
  propio contenedor (camino real de `migrate.js`, que abre cliente `mysql`/`mysql2` por TCP).
- Imagen pinneada `mysql:8.0.40`. Readiness por query **autenticada** a la base propia.
- **No** oculta el exit del runner con `| tail`: captura la salida completa y valida
  **mecánicamente** el set aplicado/pendiente, los conteos y la FK; cualquier diferencia aborta (exit≠0).

## Cómo reproducir

Requisitos: Docker + Node (`api/node_modules`) + cliente `mysql` + fetch al repo. **No** requiere variables.

```bash
bash docs/evidence/migration-order-sim.sh    # exit 0 = aserciones cumplidas
```

SHAs de las migraciones (fetch por HEAD de PR): 076-080 = #161 `807f82a`; 081 = #198 `272a739`;
082 = #201 `bf8b583`; 083 = #202 `6254f77`.

## Resultado (log sanitizado, 2026-09-06)

```
== FASE 1: migrate con 081-083 presentes, SIN 076-080 ==
→ Aplicando 081_monthly_report_approvals.sql ... OK
→ Aplicando 082_monthly_report_pades_metadata.sql ... OK
→ Aplicando 083_fase_e_activation_console.sql ... ❌ ERROR 1146: Table '<db>.system_settings' doesn't exist
   (migrate exit=1 — ESPERADO: 083 falla por system_settings)
   aplicadas 076-083 (FASE 1): [081,082]

== FASE 2: se AÑADEN 076-080 (menores) y se corre migrate de nuevo ==
→ Aplicando 076..080 ... OK (las 5)
→ Aplicando 083_...sql ... ❌ ERROR 1146: system_settings doesn't exist
   aplicadas 076-083 (FASE 2): [076,077,078,079,080,081,082]

== FASE 3: idempotencia — migrate otra vez ==
Migraciones: 8 totales, 7 aplicadas, 1 pendientes.   (sólo 083 se reintenta; 076-082 NO se reaplican)
   aplicadas 076-083 (FASE 3): [076,077,078,079,080,081,082]

== VERIFICACIÓN de objetos y FK cruzada ==
   companies cost_centers labor_calendars mra branches.company_id fk_branches_company = 1 1 1 1 1 1
```

## Conclusiones PROBADAS (y sólo estas)

1. **Comportamiento NO monotónico del runner:** `migrate.js` no tiene guardia de monotonicidad —
   toma las migraciones **menores** 076-080 añadidas *después* como pendientes y las aplica sin advertir,
   con 081/082 ya aplicadas de antes.
2. **081/082 antes de 076-080 (en el esquema SINTÉTICO):** 081 y 082 aplican sin que existan 076-080;
   luego 076-080 aplican sobre eso, con el FK cruzado `branches.company_id → companies(id)` **íntegro**
   (verificación = `1 1 1 1 1 1`).
3. **Idempotencia de 076-082:** una segunda corrida no reaplica ninguna de 076-082 (sólo se reintenta 083).

## Lo que esta evidencia NO prueba (honesto)

- **083 NO es SQL-safe:** falla en las 3 fases por `Table 'system_settings' doesn't exist`
  (`migrate.js` no es autosuficiente desde `init.sql`; 083 asume una tabla del ORM). **#202/083 sigue
  **NO-GO**** hasta una prueba independiente correcta (083 autocontenida o el job de BD sembrando/creando
  `system_settings`, como #194 hizo con `webhooks` para la 020).
- **Los stubs NO equivalen a un replay integral:** `branches`/`audit_events`/`employee_documents`/
  `payroll_periods` se crean como stubs mínimos en lugar de correr 002-075. El objetivo es aislar la
  **mecánica de orden** de 076-083, no validar el esquema completo. El replay 002-075 se cubre en el
  job DB de #194 (verde), no aquí.
- El `applied_at` puede empatar al segundo entre migraciones; la prueba se apoya en el **set aplicado**
  (aserción mecánica), no en el sub-orden temporal fino.

## Decisión

Orden fuera de secuencia = SQL-safe **sólo para 076-082 en este esquema sintético**, y **contingente**
(depende de que no haya dependencia cruzada). Por eso **NO-GO** para 081/082/083 hasta ordenar vs
076-080 (preferido: FASE F primero; alternativa: renumerar + unicidad global). Detalle en
`INTEGRATION_PLAN.md` §Orden de migraciones.

## Limitaciones de cobertura

Evidencia **local reproducible**, no un job de CI de #206 (el job de BD vive en #194). **El workflow no
ejecuta este harness**; no se afirma que el CI lo valide.
