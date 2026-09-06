# Estado de implementación — SisHoras

> **Actualizado:** 2026-09-06 · Consolidado por Agente 0 desde auditoría multiagente read-only.
> **Baseline:** `main @ 078cd67`. Complementa `AI_HANDOFF.md`.

## Vocabulario de estado (obligatorio)

Canónico (D2/Bloque 1): `MERGED_VERIFIED` · `OPEN_PR_UNAUDITED` · `OPEN_PR_TESTED` (pruebas
locales del autor, **sin** CI remoto ni revisión humana) · `OPEN_PR_BLOCKED` · `SIMULATED_ONLY` ·
`NOT_PRESENT` · `PRODUCTION_UNVERIFIED`. Secundarios usados en la matriz de requisitos:
`PARTIAL`, `SUPERSEDED`, `REJECTED`, `PLANNED`, `NOT_PRESENT_ON_MAIN`.

Nunca decir "completo" sin indicar archivo + evidencia. Nada en un PR abierto está "resuelto en el
proyecto" hasta llegar a `main`. Cada `#NNN` = `https://github.com/DaltonP93/Gestion_Horas/pull/NNN`.

## Mapa de PRs abiertos (50, todos Draft, ninguno fusionado)

Checkpoint 2026-09-06, `main @ 078cd67` (#157). Nada de lo de abajo está en `main`.
Plan de integración bottom-up + solapes/duplicados: ver `INTEGRATION_PLAN.md`.

**Multiempresa (D1 = requisito SÍ):** `NOT_PRESENT_ON_MAIN`; en desarrollo en FASE F congelada
(#158 migración `076_governance_companies_cost_centers.sql`) → `OPEN_PR_BLOCKED`. No es `NOT_PRESENT` de proyecto.

| PR | Tema | Base | Estado funcional |
|---|---|---|---|
| #158→#161 | FASE F núcleo (gobierno/personas/calendario/nómina F1-F4) | apilada s/main | OPEN_PR_UNAUDITED |
| #162 | Admin ve/opera Relojes ZKTeco (UI) | main | OPEN_PR_UNAUDITED |
| #163 | ZKTeco read hardening offline + harness | main | OPEN_PR_UNAUDITED |
| #164 | Gate impacto FASE E + tests sintéticos | main | OPEN_PR_UNAUDITED |
| #165 | Fix insertId INSERT crudo | main | OPEN_PR_UNAUDITED |
| #166 | Auditoría egreso sin PII/texto libre | main | OPEN_PR_UNAUDITED |
| #167→#173 | FASE F+ UI (asignaciones, nómina, calendario, jornada, headcount) | s/fase-f4 | OPEN_PR_UNAUDITED |
| #174,#175,#176,#182,#183,#184,#186 | FASE E read-only (guards/gates/goldens/drift) | cadenas | OPEN_PR_UNAUDITED |
| #177 | Capacitaciones: editar curso | main | OPEN_PR_UNAUDITED |
| #178→#181,#187,#188 | Export CSV (marcaciones/vacaciones/encuestas/banco/horas-extra/semanal) | cadenas | OPEN_PR_UNAUDITED |
| #189 | Idempotencia migraciones 072-075 (CI) | s/fase-f4 | OPEN_PR_UNAUDITED |
| #190 | CI: disparar en ramas/PR claude/** | main | OPEN_PR_UNAUDITED |
| #191 | Documentación integral | main | OPEN_PR_UNAUDITED |
| #192 | Authz por alcance + auditoría sin PII + fix inyección att2000 | main | OPEN_PR_TESTED (local) |
| #193 | Fix web build (tipo workdayConfig) | main | OPEN_PR_UNAUDITED |
| #194 | Ops: migración 020 autocontenida + saneo + CI migraciones MySQL | main | OPEN_PR_TESTED (CI en rama) |
| #195 | Saneo de dominio restante | main | OPEN_PR_UNAUDITED |
| #196 | Fase 0: total mensual por el motor (nocturno) | main | OPEN_PR_TESTED (local) |
| #197 | Recibo self-service del empleado | main | OPEN_PR_UNAUDITED |
| #198→#199 | Aprobación multinivel + firma con hash del reporte | main | OPEN_PR_UNAUDITED |
| #200 | Export planilla horas CSV/XLSX/JSON + API | s/#196 | OPEN_PR_UNAUDITED |
| #201 | Firma PAdES local (html2pdf+pades-signer) | s/#198 | OPEN_PR_TESTED (local) |
| #202 | Consola de activación FASE E (doble compuerta) | main | OPEN_PR_UNAUDITED |
| #203 | Deploy scaffolding firma PAdES + smoke-test + runbook | main | OPEN_PR_UNAUDITED |
| #204 | Nocturno en semanal/diario/analítica (motor) | s/#196 | OPEN_PR_TESTED (local) |
| #205 | Nocturno en self-service (me.js) + helper compartido | s/#204 | OPEN_PR_TESTED (local) |
| #206 | Snapshot documental consolidado (este doc + hermanos + plan) | main | OPEN_PR (docs) |
| #207 | Higiene seguridad backend (JWT algs + 5xx; logs→recortar, duplica #194) | main | OPEN_PR_TESTED (local) |

> `OPEN_PR_TESTED` = pruebas locales del autor ejecutadas; **no** implica CI remoto, revisión humana ni merge.
> Los OPEN_PR_TESTED previos (#192/#194/#196/#201) mantienen ese estado: sus pruebas fueron locales/CI-en-rama, no sobre `main`.
> **#207 solapa con #194** en la redacción de token en logs (duplicado) → #207 se recorta a JWT-algs + 5xx (ver `INTEGRATION_PLAN.md`).

## Backlog priorizado

Marca de seguridad para desarrollo autónomo: **SAFE** = sin decisión de negocio, sin secreto,
sin hardware, no destructivo, criterio de aceptación claro y test reproducible.

### P0 — vulnerabilidad/pérdida de datos/irreversible
| ID | Ítem | SAFE? | Nota |
|---|---|---|---|
| P0-1 | H3: `access_token` en URL y en logs morgan | Parcial | Redacción de logs ya en **#194** (no en main); quitar auth-por-query rompe descargas → coordinar (etapa de D3) |
| P0-2 | H1: credencial demo `admin/Admin1234!` en init.sql | Sí (mitigado en PR) | **#208**: preflight fail-closed en prod (no arranca con la demo ni si no puede verificar) + rechazo de la demo en alta/cambio/reset. Evidencia sobre MySQL 8 descartable. **NO totalmente cerrado a nivel proyecto hasta `main`**; `init.sql` sigue trayendo la demo (decisión de bootstrap) y falta política general de contraseñas débiles |

### P1 — bloqueador de producción / seguridad
| ID | Ítem | SAFE? | Nota |
|---|---|---|---|
| P1-1 | H7 (5xx genérico) + H10 (fijar `algorithms`) | **SÍ** | #207 (Dev A, revisado por líder). **RESUELTO el recorte: HEAD de #207 ya NO trae redacción de logs (es de #194)** |
| P1-1b | H1: preflight fail-closed + prevención de reintroducción de credencial demo | **SÍ** | **#208**. Evidencia sobre MySQL 8 descartable (ESC1 bloquea, ESC2 ok, ESC3 check-unavailable). No cierra H1 a nivel proyecto hasta `main` |
| P1-2 | H4/H5: revocación de sesión (jti/session + revalidación WS) | Sí (diseño medio) | Requiere tabla de sesiones + denylist Redis. **ADR en #209** |
| P1-3 | H2: token en `localStorage` → cookie HttpOnly | No | **ADR #209** (dirección HttpOnly aceptada; diseño técnico pendiente de auditoría; implementación NO autorizada) |
| P1-4 | Autorizar orden de merge de la deuda de **52 PRs** (#158–#209) | No | **Decisión del propietario.** Incluye NO-GO de migraciones 081/082/083 vs FASE F (ver INTEGRATION_PLAN §Orden de migraciones) |
| P1-5 | Completar CI (merge #194/#190; job Analytics; escaneo deps) | Sí | Varias piezas ya en PRs |
| P1-6 | Multiempresa (D1=SÍ): auditar/integrar FASE F (`companies` mig 076) | No | Bloqueado por congelamiento FASE F (auditoría Codex) |

### P2 — funciones incompletas / asistencia / reportes / i18n
| ID | Ítem | SAFE? |
|---|---|---|
| P2-1 | Nocturno en superficies restantes (PDF daily-detail, dashboard, supervisor/executive) | Sí (solo lectura, patrón #204) |
| P2-2 | Niveles de config de horario (departamento/general) | No (writer gateado + decisión) |
| P2-3 | Adopción i18n en páginas de alto tráfico | Sí |
| P2-4 | Recibo/aprobación/firma (ya en PRs #197/#198/#201) | — (revisar y encadenar) |

### P3 — mantenimiento / rendimiento / refactor
| ID | Ítem | SAFE? |
|---|---|---|
| P3-1 | Bumps deps con CVE (multer 2.x, axios≥1.7.4, python-jose) | Sí con tests |
| P3-2 | Corregir `docker-compose.yml` prod (nginx path) | Sí |
| P3-3 | Código muerto / drift sequelize↔mysql2 | Sí con pruebas |

## Definición de terminado (por tarea)
Código + tests (unit/integración/negativos) + migración si aplica (up/down) + doc actualizada +
evidencia de CI/local + revisión del líder + PR Draft pequeño. Sin secretos en el diff (`git diff --check`, búsqueda de secretos).
