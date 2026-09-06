# Estado de implementación — SisHoras

> **Actualizado:** 2026-09-06 · Consolidado por Agente 0 desde auditoría multiagente read-only.
> **Baseline:** `main @ 078cd67`. Complementa `AI_HANDOFF.md`.

## Vocabulario de estado (obligatorio)

`MERGED_VERIFIED` · `MERGED_UNVERIFIED` · `OPEN_PR_VERIFIED` · `OPEN_PR_UNVERIFIED` ·
`PARTIAL` · `SIMULATED_ONLY` · `BLOCKED_HARDWARE` · `BLOCKED_SPEC` · `PLANNED` ·
`SUPERSEDED` · `REJECTED` · `NOT_PRESENT`.

Nunca decir "completo" sin indicar archivo + evidencia.

## Mapa de PRs abiertos (48, todos Draft, ninguno fusionado)

`main` está en #157. Nada de lo de abajo está en `main` salvo lo indicado como fusionado.

| PR | Tema | Base | Estado funcional |
|---|---|---|---|
| #158→#161 | FASE F núcleo (gobierno/personas/calendario/nómina F1-F4) | apilada s/main | OPEN_PR_UNVERIFIED |
| #162 | Admin ve/opera Relojes ZKTeco (UI) | main | OPEN_PR_UNVERIFIED |
| #163 | ZKTeco read hardening offline + harness | main | OPEN_PR_UNVERIFIED |
| #164 | Gate impacto FASE E + tests sintéticos | main | OPEN_PR_UNVERIFIED |
| #165 | Fix insertId INSERT crudo | main | OPEN_PR_UNVERIFIED |
| #166 | Auditoría egreso sin PII/texto libre | main | OPEN_PR_UNVERIFIED |
| #167→#173 | FASE F+ UI (asignaciones, nómina, calendario, jornada, headcount) | s/fase-f4 | OPEN_PR_UNVERIFIED |
| #174,#175,#176,#182,#183,#184,#186 | FASE E read-only (guards/gates/goldens/drift) | cadenas | OPEN_PR_UNVERIFIED |
| #177 | Capacitaciones: editar curso | main | OPEN_PR_UNVERIFIED |
| #178→#181,#187,#188 | Export CSV (marcaciones/vacaciones/encuestas/banco/horas-extra/semanal) | cadenas | OPEN_PR_UNVERIFIED |
| #189 | Idempotencia migraciones 072-075 (CI) | s/fase-f4 | OPEN_PR_UNVERIFIED |
| #190 | CI: disparar en ramas/PR claude/** | main | OPEN_PR_UNVERIFIED |
| #191 | Documentación integral | main | OPEN_PR_UNVERIFIED |
| #192 | Authz por alcance + auditoría sin PII + fix inyección att2000 | main | OPEN_PR_VERIFIED (tests locales) |
| #193 | Fix web build (tipo workdayConfig) | main | OPEN_PR_UNVERIFIED |
| #194 | Ops: migración 020 autocontenida + saneo + CI migraciones MySQL | main | OPEN_PR_VERIFIED (CI verde) |
| #195 | Saneo de dominio restante | main | OPEN_PR_UNVERIFIED |
| #196 | Fase 0: total mensual por el motor (nocturno) | main | OPEN_PR_VERIFIED (tests locales) |
| #197 | Recibo self-service del empleado | main | OPEN_PR_UNVERIFIED |
| #198→#199 | Aprobación multinivel + firma con hash del reporte | main | OPEN_PR_UNVERIFIED |
| #200 | Export planilla horas CSV/XLSX/JSON + API | s/#196 | OPEN_PR_UNVERIFIED |
| #201 | Firma PAdES local (html2pdf+pades-signer) | s/#198 | OPEN_PR_VERIFIED (tests locales) |
| #202 | Consola de activación FASE E (doble compuerta) | main | OPEN_PR_UNVERIFIED |
| #203 | Deploy scaffolding firma PAdES + smoke-test + runbook | main | OPEN_PR_UNVERIFIED |
| #204 | Nocturno en semanal/diario/analítica (motor) | s/#196 | OPEN_PR_VERIFIED (tests locales) |
| #205 | Nocturno en self-service (me.js) + helper compartido | s/#204 | OPEN_PR_VERIFIED (tests locales) |

> "VERIFIED" aquí = con pruebas locales/CI reales ejecutadas por el autor; **no** implica revisión humana ni merge.

## Backlog priorizado

Marca de seguridad para desarrollo autónomo: **SAFE** = sin decisión de negocio, sin secreto,
sin hardware, no destructivo, criterio de aceptación claro y test reproducible.

### P0 — vulnerabilidad/pérdida de datos/irreversible
| ID | Ítem | SAFE? | Nota |
|---|---|---|---|
| P0-1 | H3: `access_token` en URL y en logs morgan | Parcial | Redacción de logs = SAFE; quitar auth-por-query rompe descargas → coordinar |
| P0-2 | H1: credencial demo `admin/Admin1234!` en init.sql | No (operativo) | Rotación en go-live; requiere decisión de bootstrap |

### P1 — bloqueador de producción / seguridad
| ID | Ítem | SAFE? | Nota |
|---|---|---|---|
| P1-1 | H7 (5xx genérico) + H10 (fijar `algorithms`) + H3-logs | **SÍ** | Higiene de seguridad backend — **asignado Dev A** |
| P1-2 | H4/H5: revocación de sesión (jti/session + revalidación WS) | Sí (diseño medio) | Requiere tabla de sesiones + denylist Redis |
| P1-3 | H2: token en `localStorage` → cookie HttpOnly | No | Decisión de estrategia de auth (cookies vs bearer) |
| P1-4 | Autorizar orden de merge de la deuda de 48 PRs | No | **Decisión del propietario** |
| P1-5 | Completar CI (merge #194/#190; job Analytics; escaneo deps) | Sí | Varias piezas ya en PRs |
| P1-6 | ¿Multiempresa es requisito? (hoy NOT_PRESENT) | No | **Decisión de negocio** |

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
