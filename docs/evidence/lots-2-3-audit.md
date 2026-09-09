# Auditoría read-only — lotes 2 (nocturno/nómina) y 3 (firma)

> Continuación de la auditoría de lotes 0/1. **Read-only**, sin merges. Fecha: 2026-09-07.
> Conflictos por `git merge-tree --write-tree` (base = merge-base automática). Nada de esto autoriza fusionar.

## SHAs (confirmados)
| PR | Rama | HEAD | Base | Migración |
|---|---|---|---|---|
| #196 | `fase0-mensual-motor-correcto` | `4fe8827` | main | — |
| #204 | `fase0-lecturas-motor-nocturno` | `71675a8` | #196 | — |
| #205 | `fase0-selfservice-motor-nocturno` | `f86b150` | #204 | — |
| #197 | `fase3-recibo-selfservice` | `6804f67` | main | — |
| #200 | `nomina-export-externo` | `129216d` | #196 | — |
| #198 | `fase2-aprobacion-firma` | `272a739` | main | **081** |
| #201 | `fase2-firma-pades` | `bf8b583` | #198 | **082** |
| #199 | `fase2-ui-aprobacion-reportes` | `f6df688` | main | — |
| #203 | `deploy-firma-pades-servicios` | `f9bc1f3` | main | — (sólo `deploy/signing/`) |

## Footprints (incremental vs base)
- **#196** `routes/reports.js`, `services/monthlyWorkedFromEngine.js` (+tests). **#204** `routes/reports.js` (+test). **#205** `routes/me.js`, `routes/reports.js`, `services/workedReads.js` (+test). Cadena secuencial.
- **#197** `index.js`, `routes/{legalPayslips,me,payslip}.js`, `services/payslip.js` (+tests) + `web/…/mis-documentos`.
- **#200** `routes/{integration,payroll}.js`, `services/payrollExport.js` (+tests) + doc.
- **#198** `index.js`, `routes/monthlyApprovals.js`, `services/monthlyReportApproval.js` (+tests) + **081**.
- **#201** `routes/monthlyApprovals.js`, `services/signing/padesSigner.js`, `.env.example` (+tests) + **082**.
- **#199** sólo `web/…/aprobacion-reportes` + i18n + navModules. **#203** sólo `deploy/signing/` (compose/README/runbook/smoke-test).

## Conflictos reales (merge-tree) — TODOS LIMPIOS
| Par | Archivo(s) | Resultado |
|---|---|---|
| #205 ↔ #197 | `me.js` | limpio |
| #197 ↔ #198 | `index.js` | limpio |
| #197 ↔ #194 / #208 (lote1) | `index.js` | limpio |
| #198 ↔ #194 / #208 (lote1) | `index.js` | limpio |
| nocturno #205 ↔ #192 / #194 (lote1) | — | limpio |
| firma #201(chain) ↔ #199 (UI) | — | limpio |
| #200 ↔ nocturno #205 | — | limpio |
| #203 ↔ #201 | — | limpio |

> El "solape reports/me" que el plan marcaba como riesgo **no** produce conflicto textual (regiones distintas);
> los múltiples escritores de `index.js` (#197/#198/#194/#208) tampoco chocan.

## Ensayo LOCAL lote1+lote2 (evidencia; no CI remoto del stack)
Worktree descartable desde `origin/main`, orden **#190→#194→#207→#192→#208 → #196→#204→#205→#197→#200**:
- **0 conflictos.** **TREE SHA `7032fafd1f0c6a2d0bb45cd6d11ec6d572a4129f`**.
- **API jest 91 suites / 1423 tests verde en UTC / America/Asuncion / Asia/Tokyo** (incluye los tests
  nocturnos, sensibles a TZ). No se pusheó ni rebaseó ninguna rama; worktree eliminado.

## GO/NO-GO (requiere OK del propietario, PR por PR)
- **Lote 2 — GO candidato** (tras lote 1): **#196→#204→#205** (nocturno, sólo lecturas, sin writers/flags/migraciones), luego **#197** (recibo self-service) y **#200** (export). Sin migraciones → sin riesgo de orden. Rebasar #197/#200 tras #196.
- **Lote 3:**
  - **#198 / #201 → NO-GO** hasta resolver el orden de migraciones **081/082 vs FASE F 076-080** (ver `INTEGRATION_PLAN.md` §Orden de migraciones; #202/083 también NO-GO).
  - **#199 (UI aprobación) — GO condicional:** sin migración; funcionalmente depende de #198 en runtime, así que integrarla **después** de que #198 deje de ser NO-GO (o como UI inerte si se decide antes). Requiere `web build` (no cubierto por este ensayo API).
  - **#203 (deploy/signing scaffolding) — GO de bajo riesgo:** sólo `deploy/signing/` (compose/README/runbook/smoke-test), sin código de la app ni migración. No activa nada.

## Limitaciones
- Ensayo **local**, no CI remoto del stack. Este ensayo cubrió **API** (lote 2 es API-only salvo `mis-documentos` de #197 y la UI de #199); `web build` de #199 y el job MySQL no se ejercen aquí.
- No se tocó FASE F (congelada). 081/082/083 siguen **NO-GO** por orden de migraciones.
