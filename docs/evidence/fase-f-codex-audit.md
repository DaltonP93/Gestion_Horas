# Auditoría Codex (read-only) de FASE F — multiempresa

> **Rol:** Agente 0 en función de revisor Codex. **Read-only**, sin tocar HEADs de FASE F,
> sin fusionar, sin activar nada. Fecha: 2026-09-07.
> **Vista acumulada:** `origin/claude/fase-f4-nomina-base` (tip; contiene toda la cadena F1→F4 y las
> migraciones 076–080). **Footprint:** 64 archivos, +7562/−21 (`git diff origin/main...origin/claude/fase-f4-nomina-base --stat`).
> **Método:** inspección por `git show`/`git diff`/`grep`/lectura; cada afirmación con evidencia `archivo:línea`.
>
> **Aclaración de alcance:** esta auditoría **cierra la compuerta "auditoría Codex"** que mantenía a FASE F
> como `OPEN_PR_BLOCKED`. **NO autoriza fusión ni descongelamiento**: FASE F permanece congelada hasta el OK
> expreso del propietario, PR por PR, y hasta resolver el único ítem de proceso realmente bloqueante
> (orden de migraciones vs 081/082/083 — ver §7 y `INTEGRATION_PLAN.md §Orden de migraciones`).

## Veredicto general: **GO condicional** — código en calidad de fusión, sujeto a chequeos de proceso

La cadena es **fail-closed**, el **aislamiento por empresa se hace cumplir a nivel de query** (no es cosmético),
la excepción de nómina global está **gateada por rol y no es override-able**, **att2000 sigue READ-ONLY**, y
las migraciones son **autocontenidas** e **idempotentes probadas en CI**. **No se encontró BLOCKER a nivel de código.**

## Resumen por área

| # | Área | Veredicto | Evidencia clave |
|---|---|---|---|
| 1 | Esquema multiempresa (076–080) | **OK** | `companies`/`cost_centers` (076), FKs consistentes a `companies(id)`; ALTERs guardados por `information_schema`; sin dependencia de tablas del ORM (no repite trampa 020/083). |
| 2 | Aislamiento por empresa (enforcement) | **OK** | `orgScope.js` (`companyScope`, análogo a `departmentScope`); filtros en WHERE (SQL), no post-filtrado; 403 `OUT_OF_SCOPE` en escritura; IT real MySQL prueba que manager de A no ve B. |
| 3 | Excepción nómina global (F4) | **OK, gateada** (concern doc) | `router.use(requireGlobalHR)` por rol (payrollBase.js:33; auth.js:53–61), **no** consulta `user_permissions` (no override-able); todo `is_official=0`; adaptadores forzados `enabled:false`. |
| 4 | Writers / flags / efectos | **OK** | 4 kill-switches independientes fail-closed, `=== 'true'` exacto, default false; sin `INSERT/UPDATE/DELETE` sobre `CHECKINOUT`/`daily_summary`/`attendance_logs` (sólo aserciones de test). |
| 5 | Auditoría / PII | **OK** (1 concern menor) | `redact.js redactDetails` allowlist (salario, tax_id/ruc/ci, biometría, texto libre `reason/note`); candidatos auditan sólo nombres de campo + estado. Concern: `legal_name`/`trade_name` de empresa en claro (dato registral, no PII). |
| 6 | Cobertura de tests + CI | **OK** | suites unit/route con aserciones reales; IT `IT_DB=1` contra MySQL real; job `migrations-mysql` de `ci.yml` prueba 076→080 + idempotencia + `--status` read-only; #189 agrega su job de idempotencia (sólo `ci.yml`, +95). |
| 7 | Riesgos / bloqueos de integración | ver abajo | El único gating real es de **proceso** (orden de migraciones), no de código. |

## 1. Esquema multiempresa (076–080) — OK
- **Tablas/columnas nuevas:** 076 `companies`, `cost_centers`, + nuleables `branches.company_id`,
  `departments.cost_center_id` (proc guardado `mig_076_apply`, 076:66–147). 077 `audit_events.correlation_id`
  (077:14–32). 078 `candidates`, `employee_assignments`, + `employee_documents.access_level`. 079
  `labor_calendars`, `calendar_exceptions`. 080 `payroll_concepts`, `payroll_periods`, `payroll_period_snapshots`.
- **FKs a `companies(id)` consistentes:** `fk_cost_centers_company` (076:60), `fk_branches_company` (076:88–92),
  `fk_departments_cost_center` (076:135–142), `fk_candidates_company`/`_branch` (078:67–69),
  `fk_ea_branch`/`fk_ea_cc` (078:97–100), `fk_labor_cal_company`/`_branch` ON DELETE **RESTRICT** (079:73–74,
  correcto por ser columnas base del `scope_key` generado).
- **Nómina (080) NO tiene `company_id`** en ninguna tabla → confirma que F4 es global por esquema, no sólo por política.
- **Autocontención (trampa ORM):** PASS. Cada `ALTER` guardado por `information_schema`; toda tabla previa
  referenciada la crea una migración/`init.sql` **SQL** (audit_events=012, branches=015, employee_documents=067,
  departments/employees=init). **No** referencia `system_settings`/`webhooks` → no reaparecen las trampas de 083/020.
- **Acoplamiento forward** (mitigado por orden numérico del runner): 078/079 requieren 076; el runner ordenado es seguro.

## 2. Aislamiento por empresa — OK (realmente enforced)
- `api/src/services/orgScope.js`: roles `super_admin/admin/gth/hr` → `{unrestricted:true}`; `manager/coordinator/
  supervisor/gestor` → derivan company/branch/dept del empleado del actor (orgScope.js:47–83); el resto → sets vacíos (fail-closed).
- **Lectura filtrada en SQL:** companies `companyFilter(scope,'id')` (governance.js:49–50; `getCompany` fuera de
  scope → 404, governance.js:66); cost centers (governance.js:105); candidatos `candidateScopeFilter` regla
  jerárquica branch>company, NULL excluido para roles scoped (people.js:57–62; orgScope.js:186–210); calendarios
  incluyen globales + scoped (calendarService.js:81; orgScope.js:230–250).
- **Rechazo en escritura (403 OUT_OF_SCOPE):** `assertCompany/Branch/DepartmentInScope` (orgScope.js:112–142);
  candidatos `validateCandidateRefs` (people.js:88–108; candidates.js:83,118–124); asignaciones
  `validateAssignmentRefs` **dentro de la tx tras `FOR UPDATE`** (anti-TOCTOU), rechaza referencias mixtas con
  `INCOHERENT_SCOPE` (people.js:180–214,262–266; assignments.js:70–79); calendarios: rol scoped no puede crear/mutar
  calendario GLOBAL (calendarService.js:110–111; laborCalendars.js:181–184) y `/effective` rechaza company/branch ajenos (laborCalendars.js:145–151).
- **Prueba de que aísla de verdad:** `orgScope.it.test.js` inserta empresas A/B en MySQL real y afirma que un
  manager de A ve A pero **no** B en `listCompanies` y `listCostCenters`, y que `assertCompanyInScope(B)` lanza (orgScope.it.test.js:69–90).
- GET-by-id fuera de scope devuelve **404** (no 403) para no filtrar existencia (candidates.js:73–75; laborCalendars.js:159–162).

## 3. Excepción nómina global (F4) — OK, gateada (concern de documentación)
- **Qué es global:** todo el módulo payroll-base. `headcount()` cuenta TODOS los empleados sin filtro de empresa
  (payrollBase.js:141–148); `listConcepts`/`listPeriods` sin scope (payrollBase.js:82–89,118–124); tablas sin `company_id`.
- **Gating por rol duro, no flag, no override-able:** `router.use(requireGlobalHR)` sobre todas las rutas
  (payrollBase.js:33); `requireGlobalHR` sólo permite `super_admin/admin/gth/hr` y **no** consulta `user_permissions`,
  así un permiso granular no puede dar acceso a un manager (auth.js:53–61, comentario 47–52).
- Todo queda `is_official=0` (createPeriod fuerza `is_official,0`, payrollBase.js:132) y los 6 adaptadores de
  integración forzados `enabled:false` sin importar env (payrollBase.js:75–83).
- **CONCERN (no bloqueante):** la "excepción temporal" está afirmada en docs/comentarios pero no hay marcador de
  código (TODO/guard) que fuerce el futuro modelo por-empresa → tratar como deuda con ticket.

## 4. Writers / flags / efectos colaterales — OK
- **4 kill-switches independientes, fail-closed, `=== 'true'` exacto, default false:** `GOVERNANCE_WRITE_ENABLED`
  (governance.js:24), `PEOPLE_WRITE_ENABLED` (people.js:24), `CALENDAR_WRITE_ENABLED` (calendarService.js),
  `PAYROLL_WRITE_ENABLED` (payrollBase.js:44). Deshabilitado → 503 vía `assertWriteEnabled` al tope de cada POST/PATCH.
  `.env.example` los envía todos en `false` + 6 flags de integración comentados.
- **Sin escritura a tablas protegidas:** grep del diff por `INSERT/UPDATE/DELETE` contra `CHECKINOUT`,
  `daily_summary`, `attendance_logs` → **cero** en producción (sólo aserciones `expect(sql).not.toMatch(/CHECKINOUT/i)`). att2000 READ-ONLY intacto.
- Ningún flag se pone default-on; integraciones no se pueden encender ni con env.

## 5. Auditoría / PII — OK (1 concern menor, no-PII)
- correlation id vía `requestId` (index.js:102) → `audit.log` persiste `req.correlationId` (audit.js:88–105), con
  degradación deliberada a insert legacy si 077 no aplicada (audit.js:96–103).
- **Allowlist/redacción:** `redact.js redactDetails` reemplaza por nombre de clave: passwords/tokens,
  `salary/remuneration/sueldo`, `tax_id/ruc/ci/cedula`, `ips`, biometría, texto libre `reason/note/notes/observacion` (redact.js:31–48).
- Candidatos auditan sólo nombres de campo + estado, nunca nombre/email/teléfono/notas (candidates.js:99–103,132–135);
  asignaciones envuelven detalles en `redactDetails` → `reason` y `reference_salary` quedan `[REDACTED]` (assignments.js:96–110).
- **CONCERN menor:** `company.create/update` auditan con `tax_id`/`ruc` redactados pero `legal_name`/`trade_name`/`code`
  en claro (companies.js:82,118) — dato registral público, no PII personal; requiere sign-off consciente o extender redacción.

## 6. Cobertura de tests + CI — OK
- Suites unit/route con aserciones reales: scope (orgScope/peopleScope[196 l]/calendarScope), forma de migración
  (governance/people/laborCalendar/payrollBase Migration.test.js), fail-closed (payrollGlobalHr/redact/requestId).
- IT (MySQL real, `IT_DB=1`) en `api/tests/it/`: orgScope/people[256 l]/calendar[290 l]/payroll + migrations[127 l].
- CI `ci.yml` job `migrations-mysql`: mysql:8.0 efímero, baseline (init.sql+012/015/067) → baseline a 075 → aplica
  076→080 → re-aplica y afirma "Nada por aplicar" (idempotencia) → `--status` read-only byte-a-byte → `IT_DB=1 npm test`.
  `scripts/migrate.js` soporta `--baseline=`/`--status` (migrate.js:16–17,61–125). #189 agrega su job (sólo `ci.yml`, +95).

## 7. Riesgos / bloqueos de integración — ranking
1. **Orden de migraciones vs 081/082/083 (proceso).** La cadena es interna y autocontenida, pero el repo tiene
   enlaces rotos conocidos (020→`webhooks`, 083→`system_settings`) → un replay `002→` completo NO es viable; el CI
   lo evita con baseline manual. Un revisor debe confirmar que ninguna migración 081+ se renumeró/colisiona y que
   producción aplica por **runner ordenado**, no replay completo. **BLOCKER-a-despejar (proceso), no defecto de código.**
2. **Excepción nómina global sin fecha.** Gateada por rol (no override-able) pero sin marcador que fuerce el modelo
   por-empresa. **CONCERN — aceptar con ticket.**
3. **Tamaño de cadena / carga de revisión.** 4 PRs apilados, +7.5k líneas, merge base-first f1→f2→f3→f4. **CONCERN.**
4. **Nombres de registro de empresa en claro en auditoría** (§5). **CONCERN menor.**
5. **El aislamiento depende de que el actor tenga `employee_id` + branch enlazados.** Un usuario scoped sin
   empleado/branch obtiene sets vacíos (ve nada; fail-closed correcto) → verificar el enlace org en el onboarding. **CONCERN menor.**

Sin brecha de aislamiento abierta, sin writer default-on, sin mutación de att2000, sin fuga de PII.

## Debe despejarse antes de fusionar (top 5)
1. Confirmar continuidad de número de migración con 081/082/083 y que prod aplica por runner ordenado (no replay) —
   **único ítem realmente gating** (ver `INTEGRATION_PLAN.md §Orden de migraciones`).
2. Fusionar estrictamente base-first f1→f2→f3→f4; conservar el job de CI de #189 para que la idempotencia corra sobre el HEAD integrado.
3. Ticket para la excepción "temporal" de nómina global (modelo por-empresa + plan de de-gating).
4. Sign-off (o extender redacción) de `legal_name`/`trade_name` en la auditoría de empresa.
5. Verificar que el enlace org del usuario scoped (`employee_id` + branch) exista en el onboarding, o los roles scoped no verán nada.

## Recomendación para el propietario
FASE F es la única épica grande pendiente y su implementación **está en calidad de fusión**. No la descongelaría
todavía: va **después** de las olas 1–4 (seguridad, nocturno, módulos, FASE E read-only), y su gate real es el
**orden de migraciones**. Cuando quieras avanzarla, el camino es: resolver orden de migraciones (guardia de
monotonicidad en `migrate.js` **o** renumeración) → fusionar f1→f2→f3→f4 base-first con OK PR por PR → abrir los 3
tickets de deuda de arriba. Nada de esto se hace sin tu autorización expresa.
