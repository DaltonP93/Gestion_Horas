# AI handoff — Gestion_Horas (SisHoras)

> **Actualizado:** 2026-09-06 · **Autor:** Agente 0 (líder técnico) tras auditoría multiagente read-only.
> **Baseline real:** `main @ 078cd67bb5241de0b962afa2b1e0b87358607478` (merge PR #157).
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

- `main` = `078cd67` (merge #157). Última doc previa fijaba `53fee69`/#155: **desactualizada**, corregido aquí.
- **`main` permanece en #157. Ninguna rama/PR abierto equivale a producción.**
- **52 PRs Draft abiertos (#158–#209), NINGUNO fusionado** (checkpoint 2026-09-06, `main` `078cd67`).
  `main` no avanza desde 2026-09-02. Hay **deuda de integración**: casi toda la funcionalidad nueva vive sólo en ramas.
  Nuevos vs. el checkpoint de 50: **#208** (H1 preflight fail-closed de credencial demo + prevención de
  reintroducción) y **#209** (ADR: cookies HttpOnly, sólo documento; implementación NO autorizada).
- Regla vigente del propietario: **no fusionar ni desplegar sin autorización explícita.**
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

> **Orden de migraciones (P1-C):** las migraciones **081/082/083** (firma/consola, lotes 3/5) se integrarían
> **antes** que las **menores 076–080** (FASE F, lote 6). `migrate.js` no tiene guardia de monotonicidad.
> Simulación sobre MySQL 8 descartable (aserciones mecánicas, `docs/evidence/migration-order-sim.{sh,md}`):
> SQL-safe **sólo para 076–082** (FK cruzado íntegro; idempotente), **contingente**. **083 NO probada
> SQL-safe** (falla por `system_settings`, tabla del ORM) → **#202/083 NO-GO**. `migrate.js` **no es
> autosuficiente desde `init.sql`**: la estrategia es *migración autocontenida* (#194 ya lo hizo con la 020).
> **NO-GO** para 081/082/083 hasta ordenar vs 076–080. Detalle en `INTEGRATION_PLAN.md` §Orden de migraciones.

> **CI observada (base `main`):** runs #654–#658 en verde para los HEAD verificados, pero **sólo** cubren
> los jobs **API / Web / Bridge**; **no** hay job de **MySQL efímero** (vive en #194, sin fusionar) ni de
> **Analytics/Python**. "CI verde" aquí = esos 3 jobs, no la cadena completa.

### CI (mecánica "opción B")
`.github/workflows/ci.yml` en `main` dispara sólo con base `main` (jobs: API, Web, Bridge en 3 TZ UTC/Asunción/Tokyo). Los PR encadenados sobre ramas `claude/*` **no** reciben CI de GitHub hasta que su base se mergee. El job de **migraciones MySQL efímero** y el trigger `claude/**` viven en PRs (#194, #190) **no fusionados**. No hay job de Analytics/Python ni build de imágenes.

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
  (tablas `companies`/`cost_centers`); #159–#161 construyen encima. Estado: `OPEN_PR_BLOCKED` (pendiente de auditoría
  Codex y merge). **No** clasificar como `NOT_PRESENT` a nivel proyecto; a nivel `main` es `NOT_PRESENT_ON_MAIN`.
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

P1 abiertos en `main`: credencial demo `admin/Admin1234!` en `init.sql` (H1); `access_token`
en URL de descargas y logueado por morgan (H3); JWT+refresh en `localStorage` (H2);
revocación inefectiva (access token stateless 1h no revalida `active`/empresa; WebSocket sin
re-auth) (H4/H5). La auditoría de PII en logs (H6) está **mitigada sólo en el PR #192** (aún NO en `main`).
La redacción de token en logs (H3) está **en dos PRs que se solapan: #194 y #207** (ver `INTEGRATION_PLAN.md`;
#207 se recorta para no duplicar #194). Ningún hallazgo se considera resuelto en el proyecto hasta llegar a `main`.

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

`database/init.sql` (bootstrap ~001) + `database/migrations/002…075`. Faltan `001` y `058`
(hueco de numeración; init.sql cubre 001). 072–075 (FASE C/E) **no aplicadas en prod**:
gate NO-GO hasta backup + auditoría + autorización.

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
