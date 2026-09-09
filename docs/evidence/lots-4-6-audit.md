# Auditoría read-only — lotes 4 (módulos/export), 5 (FASE E) y 6 (FASE F, congelado)

> Continuación de lotes 0/1/2/3. **Read-only**, sin merges. Fecha: 2026-09-07.
> Conflictos por `git merge-tree --write-tree`. Nada de esto autoriza fusionar. FASE F **congelada** (sólo inspección).

## Lote 4 — Módulos / export CSV (base main; sin migraciones)
| PR | Rama | HEAD | Base | Archivos | Nota |
|---|---|---|---|---|---|
| #178 | `modulos-exports-revision` | `fff5ec2` | main | 4 | export CSV marcaciones (util compartido) |
| #179 | `modulos-vacaciones-export` | `21508ec` | #178 | 1 | vacaciones→CSV |
| #180 | `modulos-encuestas-export` | `004e699` | #179 | 1 | encuestas→CSV |
| #181 | `modulos-banco-horas-filtro-export` | `617baf4` | #180 | 1 | banco de horas: filtro+CSV |
| #187 | `modulos-horas-extra-export` | `2879fb8` | #181 | 3 | horas extra: CSV + decisión por lote |
| #177 | `modulos-capacitaciones-editar` | `adbfdb6` | main | 2 | editar curso (UI) |
| #188 | `modulos-reportes-semanal-export` | `cd5f27f` | main | 2 | reporte semanal→CSV (**toca `reports.js`**) |
| #162 | `admin-relojes-zkteco-config` | `4900953` | main | 2 | UI config relojes |
| #163 | `zkteco-read-hardening-tests` | `087f069` | main | 3 | endurecimiento lectura ZKTeco (offline) |

- **Migraciones:** ninguna en todo el lote 4.
- **Conflictos (merge-tree): todos limpios**, incluido el único hotspot `#188 ↔ nocturno` (`reports.js` vs #196/#204/#205) y `#188 ↔ #194`, y `#162 ↔ #163`.
- **GO candidato** (tras lotes 1-2): cadena `#178→#179→#180→#181→#187`, y sueltos `#177`, `#188` (rebasar tras la cadena nocturno; el solape en `reports.js` es limpio), `#162`, `#163`. Bajo riesgo: aditivos por módulo, sin writers/flags/migraciones. Requieren `web build` los que tocan `web/` (revisión por PR).

## Lote 5 — FASE E read-only (guards/gates/goldens; sin migraciones salvo #202)
| PR | Rama | HEAD | Base | Migración |
|---|---|---|---|---|
| #174 | `fase-e-scripts-readonly-guard` | `45ee02f` | main | — |
| #175 | `fase-e-preflight-partial-gate` | `81f8412` | #174 | — |
| #176 | `fase-e-summary-flags-matrix` | `1e85376` | #175 | — |
| #182 | `fase-e-drift-checker-fasec` | `a4b751f` | #176 | — |
| #183 | `fase-e-preflight-wrapper-runbook` | `20378e1` | #182 | — |
| #184 | `fase-e-engine-golden-nogo` | `3817dc8` | #183 | — |
| #186 | `fase-e-workdayconfig-degradation` | `31be2af` | main | — |
| #164 | `fase-e-impact-audit-signature` | `6ae6e87` | main | — |
| #202 | `fase4-consola-activacion` | `6254f77` | main | **083** |

- La cadena `#174→…→#184` y los sueltos `#186`, `#164` son **read-only** (guards estáticos, gates GO/NO-GO, goldens, tests): **no** activan writers ni flags, **sin migraciones**. Conflictos limpios entre sí y con lote 1 (`#184 ↔ #194`, `#164 ↔ #184`).
- **GO candidato** (read-only) para `#174→…→#184`, `#186`, `#164` — no cambian comportamiento en runtime; útiles como red de seguridad **antes** de cualquier activación FASE E (que **no** se autoriza aquí).
- **#202 — NO-GO (doble bloqueo):** (1) migración **083** vs orden FASE F 076-080 (ver `migration-order-sim.md`); (2) **conflicto real** con la cadena FASE E en `api/src/services/workdaySummaryService.js` (`#184 ↔ #202`). Debe integrarse **después** de la cadena FASE E y con el orden de migraciones resuelto, resolviendo ese conflicto.

## Lote 6 — FASE F núcleo + F+ (CONGELADO — sólo inspección, NO integrar/rebasar)
- Núcleo: `#158→#159→#160→#161` (`fase-f1..f4`) — migraciones **076-080** (multiempresa `companies`/`cost_centers` en 076). **Son las migraciones "menores" de las que depende el orden de 081/082/083.**
- F+ UI: `#167→…→#173→#185` (sobre `fase-f4`). CI FASE F: `#189` (sobre `fase-f4`).
- **Estado:** `OPEN_PR_BLOCKED`, congelado hasta auditoría Codex y autorización. **No** se corrió conflicto ni ensayo (sin tocar HEADs de FASE F).

## Conclusión de la auditoría de integración (lotes 0-6)
- **Sin migraciones y mergeables limpios:** lotes 0, 1, 2, 4 y la parte read-only de 5 (#174-#184, #186, #164).
- **NO-GO por orden de migraciones / dependencias:** #198/#201 (081/082), **#202/083** (además, conflicto con FASE E), y toda FASE F (076-080, congelada).
- **Orden global sugerido** (cada merge requiere OK del propietario, PR por PR): **0 → 1 → 2 → 4 → (5 read-only) →** *resolver orden de migraciones + auditoría Codex de FASE F* **→ 6 (076-080) → 3 (081/082) → #202 (083)**.

## Limitaciones
Conflictos por `merge-tree` (textual); no equivale a CI del stack completo. Los ensayos con suites cubrieron lotes 1 y 1+2 (API/Bridge/Web/Analytics/DB). Lotes 4/5 no se ensayaron con suites en este pase (footprints chicos, sin migraciones); su validación real es el CI por PR al integrar. FASE F no se tocó.
