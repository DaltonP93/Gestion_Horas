# AI handoff — Gestion_Horas (SisHoras)

> **Actualizado:** 2026-09-09 · **Autor:** Agente 0 (líder técnico) tras la integración autorizada a `main`.
> **Baseline real:** `main @ 79c01d5` tras la **integración de Olas 1–4 + deps + docs (2026-09-09)**
> — 34 PRs fusionados (antes `078cd67`/#157). Detalle SHA-a-SHA en `docs/evidence/main-integration-log.md`.
> **Este documento es la ENTRADA CANÓNICA.** Un agente nuevo (incl. Codex) debe poder
> continuar leyendo sólo este archivo + la URL del repo, sin acceder a ninguna conversación.
> La fuente de verdad es el repositorio (código, commits, PRs, CI). Este doc resume estado, no lo sustituye.
> Documentos hermanos: `IMPLEMENTATION_STATUS.md`, `REQUIREMENTS_TRACEABILITY.md`,
> `SECURITY.md`, `DEPLOYMENT.md`, `BACKUP_RESTORE.md`, `HARDWARE_STATUS.md`,
> `DEVELOPMENT_HISTORY.md`, `TEST_EVIDENCE.md`.

## 1. Propósito del proyecto

SisHoras es el reemplazo web del sistema legado de asistencia ZKTeco. Es un sistema de
**asistencia y RR.HH.** (NO un control de acceso físico): lee marcaciones de relojes
biométricos ZKTeco (modo PUSH/ADMS) y de la fuente SQL Server `att2000` (solo lectura),
las interpreta con un motor de jornada, y genera asistencia, turnos, permisos, vacaciones,
horas extra, reportes, nómina y analítica.

> **Aclaración de alcance (importante para agentes nuevos):** este repo **no** implementa
> controladoras de puertas, apertura remota, PIN/tarjetas, anti-passback, interlock,
> multicard, gateway de acceso ni eventos físicos. Si un pliego menciona esos conceptos,
> están **fuera del dominio** de este producto. Ver `HARDWARE_STATUS.md`.

## 2. Arquitectura y tecnologías (versiones reales)

| Componente | Tecnología | Puerto |
|---|---|---|
| `api/` | Node.js + Express 4, JWT, Socket.io | 4000 |
| `web/` | Next.js 14 (App Router), Tailwind, Recharts | 3000 |
| `analytics/` | FastAPI (Python 3.12), SQLAlchemy 2 + PyMySQL | 5000 |
| `bridge/` | Node.js (ZKTeco PUSH + outbox SQLite `better-sqlite3`) | 8080 PUSH / 8081 API |
| BD principal | **MySQL 8** (base `asistencia`) — driver `mysql2` + `sequelize` | 3306 |
| Fuente externa | SQL Server `att2000` (driver `mssql`) — **estrictamente READ-ONLY** | 1433 |
| Cache/RT | Redis (pub/sub + streams opcionales) | 6379 |
| Procesos | PM2 (`ecosystem.config.js`), `instances:1`, `fork` |

**No hay PostgreSQL** en el proyecto (verificado). `mssql` existe sólo para leer `att2000`.

## 3. Estado de `main` y de los PRs

- `main` = `d88fe09` tras la **integración autorizada del 2026-09-09** (antes `078cd67`/#157).
  **Fusionado (MERGED_VERIFIED), 49 PRs — Olas 1–4 + deps + docs + DevOps + Ola 5 FASE F:**
  - **Ola 1 (seguridad+CI):** #190, #194, #212, #208, #207, #192, #165, #166, #195, #210. H1/H3/H7/H10/H6 ya en
    `main`; CI completo (API/Web/Bridge 3 TZ + **DB MySQL efímero** + **Analytics** + gate `npm audit` ALTO);
    guardia de monotonicidad de migraciones (`migrate.js`).
  - **Ola 2 (nocturno):** #196, #204, #205, #197, #200 — lecturas por el motor correcto (cross-midnight).
  - **Ola 3 (módulos/export):** #178–#181, #187, #177, #188, #162, #163.
  - **Ola 4 (FASE E read-only):** #174–#176, #182–#184, #186, #164 — guards/gates/goldens (no activan nada).
  - **Docs:** #206 (canónico) + #214 (baseline) + `docs/evidence/main-integration-log.md` (SHA por PR).
  - **DevOps:** **#213** — nginx del compose, imagen `Dockerfile.migrate` (profile `tools`),
    `scripts/restore-mysql.sh` + `deploy/DEPLOY-RUNBOOK.md`, healthcheck TCP autenticado de mysql. **Aditivo**:
    no toca prod. **Levantamiento real del stack + prueba de restore: pendientes de ops.**
  - **Ola 5 — FASE F multiempresa (`d88fe09`, autorizado por el propietario "Sí, fusionar todo"):** núcleo
    #158–#161 (migraciones **076–080**: `companies`/`cost_centers`, candidatos/asignaciones, calendario/jornada
    3-estados, nómina sandbox global) + F+ UI #167–#173/#185 + CI #189. Merge base-first, cadena completa verde
    en la cabeza (run #773, incluye DB efímero aplicando 076–080 idempotente). **Writers fail-closed**
    (`GOVERNANCE/PEOPLE/CALENDAR/PAYROLL_WRITE_ENABLED` = `false`): el código está en `main` pero multiempresa
    **no está activa**. **Migraciones 076–080 en el repo pero NO aplicadas en prod.** Detalle SHA-a-SHA en
    `main-integration-log.md`; preparación en `fase-f-review-prep.md`.
- **Rollout operativo de FASE F (2 pasos, los corre OPS en el servidor — este agente no toca prod):**
  1. **Aplicar migraciones `072–080`** (autorizado 2026-09-09, aplicar juntas) → runbook
     `deploy/RUNBOOK-migraciones-076-080.md` (preflight `--status`, backup obligatorio, `migrate`,
     verificación, rollback).
  2. **Activar los writers de multiempresa** (por fase, cada una con OK del propietario) → runbook
     `deploy/RUNBOOK-activacion-writers-multiempresa.md`. Clave: encender flags ≠ multiempresa activa;
     hay que **sembrar** `companies` + `branches.company_id` y otorgar permisos. Orden: gobierno →
     personas → calendario → nómina; `pm2 reload --update-env`; rollback = flag→`false`.
  **Ninguno de los dos pasos se ejecutó todavía.** Fusionar a `main` **no** aplicó migraciones ni activó
  writers (siguen fail-closed, `503`). Runbook DevOps general de apoyo: `deploy/DEPLOY-RUNBOOK.md`.
- **Abiertas todavía (NO fusionadas, bloqueo real):** firma #198/#199/#201/#203 (081/082); **#202** (083 +
  conflicto con FASE E); #191 (dup de #206); #209 (ADR cookies, implementación NO autorizada).
- Regla vigente del propietario: **no fusionar el resto ni desplegar sin autorización explícita.**
- **Plan de integración bottom-up:** ver `INTEGRATION_PLAN.md` (grupos, grafo, orden, solapes/duplicados, rebase/test/rollback por lote). Autorizado sólo para *preparar* el plan (D2); cada merge requiere OK expreso, PR por PR.
- **Convención:** cada `#NNN` refiere a `https://github.com/DaltonP93/Gestion_Horas/pull/NNN`.
- **Vocabulario de estado (canónico):** `MERGED_VERIFIED` · `OPEN_PR_UNAUDITED` · `OPEN_PR_TESTED` (pruebas locales del autor, sin CI remoto ni revisión humana) · `OPEN_PR_BLOCKED` · `SIMULATED_ONLY` · `NOT_PRESENT` · `PRODUCTION_UNVERIFIED`. Nada en un PR abierto está "resuelto en el proyecto" hasta llegar a `main`.

### Cadenas de PRs (dependencias) — detalle en `IMPLEMENTATION_STATUS.md`
- FASE F núcleo: #158→#159→#160→#161 (apilada).
- FASE F+ UI: #167→…→#173 (sobre `fase-f4`).
- FASE E read-only (guards/gates/goldens): #174,#175,#176,#182,#183,#184,#186.
- Módulos export CSV: #177; #178→#179→#180→#181→#187; #188.
- Infra/seguridad base: #189, #190 (CI claude/**), #192 (authz+audit), #193 (web build), #194 (ops+CI migraciones), #195, **#208 (H1 preflight)**.
- Docs/ADR: #191, #206 (**canónico** de estado/plan), **#209 (ADR cookies HttpOnly)**.
- Nocturno/nómina/firma: #196→#200; #196→#204→#205; #197; #198→#199→#201; #202; #203.
- ZKTeco/impacto: #162, #163, #164, #165, #166.

> **Orden de migraciones (P1-C) — actualizado 2026-09-08:** las migraciones **081/082/083** (firma/consola)
> se integrarían **antes** que las **menores 076–080** (FASE F). ~~`migrate.js` no tiene guardia de monotonicidad~~
> → **guardia implementada en #212** (`claude/migrate-monotonicity-guard`): aborta si hay pendientes fuera de
> secuencia o números duplicados; override explícito `--allow-out-of-order`. Simulación previa sobre MySQL 8
> descartable (`docs/evidence/migration-order-sim.{sh,md}`): 076–082 SQL-safe. **Corrección:** **083 SÍ es
> SQL-safe en un replay completo** — `system_settings` la crea la **migración SQL 033** (no el ORM); la falla del
> sim fue por correr 083 aislada sin 033. El bloqueo real de **#202/083 pasa a ser el conflicto con la cadena
> FASE E** (#184↔#202 en `workdaySummaryService.js`), no la migración. El caso ORM real era 020→`webhooks`
> (arreglado por #194). Detalle en `INTEGRATION_PLAN.md` §Orden de migraciones.

> **CI observada (base `main`, actualizado 2026-09-09):** tras integrar #194/#190, `main` corre la **cadena
> completa** — API/Web/Bridge en 3 TZ + **DB migraciones (MySQL 8 efímero)** + **Analytics** + gate
> `npm audit --audit-level=high`. Run #723 sobre `79c01d5` (cabeza integrada) en verde. El trigger `claude/**`
> ya está en `main`, así que los PR sobre ramas `claude/*` reciben CI de GitHub.

### CI (mecánica actual)
`.github/workflows/ci.yml` dispara con base `main` **y** en ramas/PR `claude/**` (trigger de #190, ya fusionado).
Jobs: API/Web/Bridge en 3 TZ (UTC/Asunción/Tokyo), **DB migraciones MySQL 8 efímero** (init.sql→migrate,
idempotencia, `--status` read-only), **Analytics** (py_compile+import) y gate `npm audit` nivel alto. Sin build de imágenes.

## 4. Funcionalidad: fusionado vs sólo-en-PR vs simulado

**Fusionado y operativo en `main` (MERGED_VERIFIED):**
- Asistencia (marcaciones I/O), `daily_summary` (escrito por el motor **legacy** por fecha civil), historial y self-service (`me.js`).
- Reporte **Marcadas** (PDF ZKTeco) — **único** que usa el motor de jornada correcto (cross-midnight OK).
- Motor de jornada (`workdayEngine.js`) presente; escritor legacy es el que alimenta `daily_summary` (flags de motor **OFF** por defecto).
- Nómina base: sueldo, liquidación (`liquidacion.js`), planilla IPS/aportes.
- RBAC por departamento (`departmentScope.js`, CTE recursiva) + permisos granulares + 2FA TOTP + rate limiting.
- att2000 READ-ONLY (sin `writeCheckinOut`, sin flag de escritura).
- i18n infra (es/en/pt) — adoptada sólo en ~7/72 páginas.

**Multiempresa (requisito confirmado por el propietario, D1 = SÍ):**
- **NO está en `main`** (no hay `company_id` en el esquema de `main`).
- **Se está implementando en la cadena FASE F (CONGELADA):** #158 aporta `076_governance_companies_cost_centers.sql`
  (tablas `companies`/`cost_centers`); #159–#161 construyen encima. Estado: `OPEN_PR_BLOCKED`. **Auditoría Codex
  read-only COMPLETADA (2026-09-07): GO condicional** (`docs/evidence/fase-f-codex-audit.md`) — aislamiento por
  empresa realmente enforced (`orgScope.js`), fail-closed, att2000 READ-ONLY, migraciones autocontenidas e
  idempotentes en CI; sin BLOCKER de código. Gate restante = orden de migraciones (081/082/083 vs 076–080) + OK del
  propietario + merge base-first f1→f2→f3→f4. **No** clasificar como `NOT_PRESENT` a nivel proyecto; a nivel `main` es `NOT_PRESENT_ON_MAIN`.
- La nómina global de F4 (#161) es una **excepción temporal explícita** al aislamiento por empresa; no invalida el requisito.
- No abrir una segunda épica de multiempresa: auditar y reutilizar la implementación de FASE F.

**Sólo en PR (OPEN_PR — NO en `main`):**
- Nocturno correcto en mensual/semanal/diario/analítica/self-service → #196, #204, #205.
- Aprobación multinivel del reporte + firma con hash de integridad → #198/#199; firma PAdES local → #201/#203.
- Recibo de sueldo self-service → #197. Export planilla de horas + API integración → #200.
- Consola de activación FASE E (doble compuerta) → #202.
- Endurecimiento authz por-empleado + auditoría con allowlist de PII + fix inyección att2000 → #192.
- CI: job migraciones MySQL efímero (#194), trigger `claude/**` (#190).

**Simulado / parcial (SIMULATED_ONLY / PARTIAL en `main`):**
- Firma de reportes en `main` = imagen + nombre desde settings (visual, **sin** integridad). La real está en #198/#201/#203.
- FASE C de configuración de jornada: código presente pero **inerte** (migraciones 072–075 no aplicadas → degrada a `historical_fallback`; writer OFF).

## 5. Hardware realmente soportado

Ver `HARDWARE_STATUS.md`. Resumen: relojes **ZKTeco** como **fuente de marcaciones** vía
bridge PUSH/ADMS (recepción, no comando). **No** hay control de cerraduras/puertas.
El driver/auto-polling att2000 y ZKTeco tiene kill-switch OFF por defecto
(`ATT2000_AUTO_PULL_ENABLED=false`, `ZKTECO_AUTO_POLL=false`).

## 6. Riesgos de seguridad (detalle en `SECURITY.md`)

**Mitigados en `main` (2026-09-09):** **H1** credencial demo → preflight fail-closed (#208); **H3** token en
logs → redacción morgan (#194); **H7** 5xx sin fuga + **H10** `algorithms:['HS256']` (#207); **H6** auditoría
sin PII con allowlist + fix inyección att2000 (#192).
**P1 aún abiertos en `main`:** **H2** JWT+refresh en `localStorage` (ADR #209 propone cookies HttpOnly, sin
implementar); **H4/H5** revocación inefectiva (access token stateless 1h no revalida `active`/empresa; WebSocket
sin re-auth). Ningún hallazgo se considera resuelto hasta llegar a `main`; H2/H4/H5 siguen pendientes.

## 7. Estado DevOps (detalle en `DEPLOYMENT.md`, `BACKUP_RESTORE.md`)

- Dockerfiles de los 4 componentes existen; `docker-compose.yml` de prod **roto** (monta `./nginx/` inexistente; el nginx real está en `deploy/`).
- Migraciones: runner idempotente por archivo (`api/scripts/migrate.js`), **sin `down`**, no transaccional. Imagen API no incluye `scripts/`/`migrations/` ni cliente `mysql`.
- Backups: `scripts/backup-mysql.sh` (mysqldump); **restore no probado**, RPO/RTO indefinidos.
- Sin observabilidad/alertas automáticas; single-instance.
- Dependencias con CVEs: `multer 1.x`, `axios 1.6.5` (bridge), `python-jose 3.3.0`.

## 8. Comandos

```bash
# Instalación / arranque local
cd api && npm ci && npm run dev            # API :4000
cd web && npm ci && npm run dev            # Web :3000
cd bridge && npm ci && npm start           # Bridge :8080/:8081
cd analytics && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt

# Pruebas
cd api && npm test                         # jest (correr con TZ=UTC / America/Asuncion / Asia/Tokyo)
cd bridge && npm test
cd web && npm run build                    # incluye typecheck de build

# Migraciones (contra MySQL; NO en prod sin autorización)
cd api && npm run migrate:status           # read-only
cd api && npm run migrate                   # forward-only, requiere binario mysql en el host
```

## 9. Variables de entorno (nombres, SIN valores) 

Ver `*/.env.example`. Claves: `DB_*` (MySQL), `ATT_*` (att2000 read-only), `JWT_SECRET`,
`JWT_REFRESH_SECRET`, `REDIS_*`, `BRIDGE_API_KEY`, `INTEGRATION_API_KEY`, `ANALYTICS_API_KEY`,
`SMTP_*`. Kill-switches fail-closed: `ATT2000_AUTO_PULL_ENABLED=false`,
`WORKDAY_CONFIG_WRITE_ENABLED=false`, `WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED` (OFF).
Firma PAdES (PR #203): `SIGNING_MODE`, `HTML2PDF_URL`, `PADES_SIGNER_URL`,
`HTML2PDF_SHARED_SECRET`, `PADES_SIGNER_SHARED_SECRET`. **Nunca** commitear valores.

## 10. Migraciones

`database/init.sql` (bootstrap ~001) + `database/migrations/002…080`. Faltan `001` y `058`
(hueco de numeración; init.sql cubre 001). **076–080 (FASE F) están en `main` desde `d88fe09`** pero
**NO aplicadas en prod**. 072–075 (FASE C/E) tampoco aplicadas en prod.

> **Autorización del propietario (2026-09-09): aplicar `072–080` juntas en prod.** Pendiente de
> ejecución por **ops** (no lo hace este agente: sin acceso a la BD de prod). Procedimiento en
> `deploy/RUNBOOK-migraciones-076-080.md` (preflight `--status`, backup obligatorio, `migrate`,
> verificación, rollback). El runner es forward-only y aplica todo lo pendiente en orden; 072–075
> son aditivas e inertes (writers de jornada en OFF), por eso van con 076–080 sin drift. **Aplicar
> el esquema NO activa multiempresa** (writers `*_WRITE_ENABLED` siguen en `false`; activarlos es
> otro paso con su propia autorización → `deploy/RUNBOOK-activacion-writers-multiempresa.md`).
> 081/082/083 (firma/consola) **no** están en `main`.
>
> **Runbooks operativos FASE F (en `main`, los ejecuta ops):** paso 1 migraciones →
> `deploy/RUNBOOK-migraciones-076-080.md`; paso 2 activación de writers →
> `deploy/RUNBOOK-activacion-writers-multiempresa.md`.

## 11. Decisiones arquitectónicas vigentes

- Dos motores de jornada coexisten: **legacy** (escribe `daily_summary` por fecha civil, tiene el bug nocturno) y **workdayEngine** (correcto, cross-midnight). El switch de escritura está detrás de flag OFF (FASE E). La estrategia elegida: **corregir las LECTURAS por el motor sin tocar `daily_summary`** (#196/#204/#205) y dejar la reescritura de `daily_summary` para una activación FASE E gateada y autorizada.
- att2000 estrictamente read-only; nunca se fabrican marcas/ausencias/horas.
- Escritores nuevos fail-closed (flag default false; sólo el string exacto `"true"` habilita).

## 12. Backlog priorizado (detalle y criterios en `IMPLEMENTATION_STATUS.md` §Backlog)

- **P0:** H3 (token en logs/URL), H1 (credencial demo) — ver SECURITY.
- **P1:** revocación de sesión (H4/H5); estrategia de token en cliente (H2); autorizar orden de merge de la deuda de PRs; completar CI (migraciones+deps scan); definir si multiempresa es requisito.
- **P2:** nocturno en superficies restantes (PDF/dashboard); niveles de config de horario (depto/general, gateado); i18n; recibo/aprobación/firma (ya en PRs).
- **P3:** bumps de dependencias con CVE; código muerto; refactors.

## 13. Primera tarea recomendada para el próximo agente

**Seguridad-higiene backend (SAFE, P1, sin decisión/secreto/hardware):** en `api/`
(a) excluir `access_token` de los logs de acceso (morgan), (b) fijar `algorithms:['HS256']`
en `jwt.verify` del socket (`api/src/socket/socketServer.js`) y del refresh
(`api/src/controllers/authController.js`), (c) devolver mensaje genérico en 5xx en las rutas
que filtran `err.message` (`selfCheckin.js`, `embed.js`, `reportsBuilder.js`). Con tests
negativos. PR Draft pequeño. (Asignada al Dev A en esta ronda.)

## 14. Reglas para el próximo agente

- No fusionar, no desplegar, no tocar producción, no activar flags/writers, no tocar hardware,
  no escribir en att2000, no recalcular `daily_summary`, no reparar histórico — sin autorización explícita del propietario.
- Trabajar en ramas/worktrees separados; PRs Draft pequeños; CI verde antes de encadenar.
- No fabricar datos ni resultados de test. Estados según vocabulario de `IMPLEMENTATION_STATUS.md`.
