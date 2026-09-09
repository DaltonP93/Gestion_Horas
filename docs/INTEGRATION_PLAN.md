# Plan de integración bottom-up — SisHoras

> **Actualizado:** 2026-09-07 · Autor: Agente 0 (líder). Autorizado por el propietario para
> **preparar** el plan (D2, opción A): **sin fusionar, sin auto-merge, sin Ready-for-review,
> sin cerrar, sin desplegar, sin rebasar FASE F**. Cada merge requiere autorización expresa posterior, PR por PR.
> **Snapshot (actualizado 2026-09-09):** `main @ 79c01d5` tras integrar **Olas 1–4 + deps + docs (34 PRs)** —
> ver `docs/evidence/main-integration-log.md`. Este plan describe el estado **previo** (baseline `078cd67`/#157)
> y el orden que se ejecutó; se conserva como registro. **Abiertas todavía:** la Ola 5 (FASE F, firma #198–#203,
> #202, #191, #209) + #213 (DevOps) — ninguna fusionada, todas con bloqueo real.
> (#208 = H1 preflight fail-closed de credencial demo; #209 = ADR cookies HttpOnly, sólo documento;
> #210 = bumps de dependencias con CVE — multer/axios/python-jose.)

## Decisión de avance (2026-09-07) — olas priorizadas por valor/riesgo

> Síntesis ejecutiva sobre la auditoría de integración (lotes 0-6, evidencia en `docs/evidence/`).
> **Ningún merge sin OK del propietario, PR por PR.** El detalle de orden vive en §Orden bottom-up.
> Principio rector: **primero lo que elimina riesgo (seguridad), luego lo que enciende el CI de datos
> (para no fusionar a ciegas), luego corrección de negocio, y al final lo grande con migraciones.**

**Resoluciones de estado (hechas hoy, sin fusionar):**
- **#193 CERRADO** como **subconjunto estricto de #194** (mismo fix de `web/src/lib/workdayConfig.ts`; #194
  lo incluye con un comentario extra). Ya no hay ambigüedad #193↔#194.
- **#194 listo para revisión (sigue Draft):** CI **9/9 en verde** sobre `e527506` (API×3 TZ, Bridge×3 TZ,
  Web build, **Analytics**, **DB — migraciones MySQL 8 efímero**); `mergeable_state: clean`; base `main@078cd67`.
  Es el **candidato #1** de la Ola 1.
- **#210 (CVE) CI en verde** sobre `1e2881d` (API/Web/Bridge). Bumps directos multer/axios/python-jose;
  api+bridge highs → 0. Web CVE queda ligado al fix de build (#194) — no se toca aquí.

**Ola 1 — Seguridad + encender CI de datos (bajo riesgo, máximo valor).** `→ Lote 1`
`#194` (H3 token en logs + migración 020 autocontenida + **job MySQL efímero** + fix build web) →
`#208` (H1 preflight fail-closed) → `#207` (JWT HS256 + 5xx sin fuga) → `#192` (authz por alcance + PII + inyección att2000).
Sueltos: `#190` (trigger CI `claude/**`), `#195` (saneo dominio restante), `#165`, `#166`, `#210` (CVE).

**Ola 2 — Corrección de negocio (nocturno), sin migraciones.** `→ Lote 2`
Cadena `#196 → #204 → #205` (lecturas por el motor correcto; **no** toca `daily_summary`, **no** activa flags).
Luego `#197` (recibo self-service), `#200` (export horas + API).

**Ola 3 — Módulos aditivos (export CSV/UI), bajo riesgo.** `→ Lote 4`
`#178→#179→#180→#181→#187`; sueltos `#177`, `#188`, `#162`, `#163`.

**Ola 4 — FASE E read-only (red de seguridad ANTES de cualquier activación).** `→ Lote 5 (parte read-only)`
`#174→…→#184`; sueltos `#186`, `#164`. Guards/gates/goldens: **no** cambian runtime.

**Ola 5 — BLOQUEADO hasta decisión del propietario + auditoría Codex.** `→ Lotes 3, 5(083), 6`
- **Orden de migraciones 081/082/083 vs 076–080** (§Orden de migraciones): NO-GO hasta guardia de
  monotonicidad en `migrate.js` **o** renumeración. **Recomendado:** guardia + rebase de 083 sobre 076–080.
- **FASE F** (#158–#161, F+ #167–#173, #185, #189): épica multiempresa, **congelada**. **Auditoría Codex
  read-only COMPLETADA (2026-09-07): veredicto GO condicional** (`docs/evidence/fase-f-codex-audit.md`) —
  aislamiento por empresa realmente enforced, fail-closed, att2000 READ-ONLY, migraciones autocontenidas e
  idempotentes en CI; **sin BLOCKER de código**. Cierra la compuerta "auditoría Codex" pero **NO** autoriza
  fusión: sigue gateada por el orden de migraciones (abajo) y el OK del propietario. Descongelar sólo tras olas 1–4.
- `#198/#199/#201/#203` (aprobación+firma, 081/082); **#202** (083, además choca con FASE E en
  `workdaySummaryService.js`); `#209` (cookies HttpOnly, **implementación no autorizada**).

**Primera acción recomendada:** preparar/fusionar **#194** (con OK), porque mata H3 y enciende el CI de
datos del que dependen todas las olas siguientes — mayor retorno por el menor riesgo.

## Estado de preparación de las olas (2026-09-08)

Olas 1–4 **preparadas y verificadas** (evidencia local + CI donde aplica; bodies review-ready; todo Draft, nada fusionado):

| Ola | PRs | Preparación | Evidencia |
|---|---|---|---|
| **1 — Seguridad + CI** | #194, #208, #207, #192, #190, #195, #165, #166, #210 | #194 review-ready (CI 9/9), #193 cerrado; resto documentado | #194 CI completa verde; #210 CI verde |
| **2 — Nocturno** | #196→#204→#205; #197; #200 | bodies review-ready; #200 gth resuelto | tip #205 **78/1310** ×3 TZ; #197 **77/1314**; #200 **78/1311** ×3 TZ |
| **3 — Módulos/export** | #178→#179→#180→#181→#187; #177; #188; #162; #163 | bodies review-ready | tip #187 api **76/1298** ×3 TZ + web **33/441** + `next build`; singletons verdes |
| **4 — FASE E read-only** | #174→…→#184; #186; #164 | bodies review-ready; read-only verificado por diff | tip #184 api **81/1355** ×3 TZ; #186 **76/1296**; #164 **76/1304** ×3 TZ |

Mergeabilidad entre olas 1–4: **sin conflictos** (`merge-tree` limpio; #192 no toca `reports.js`/`me.js`; #188↔nocturno limpio; #184↔#194/#164 limpio). Orden de integración: **1 → 2 → 3 → 4**, cada PR con OK del propietario, base-first en las cadenas.

## Hoja de ruta de la Ola 5 (BLOQUEADA) — qué decisión desbloquea cada PR

> La Ola 5 **no** se "prepara con evidencia" como las anteriores: su gate es una **decisión del propietario**
> (orden de migraciones + descongelar FASE F), no una prueba. Nada de esto se toca sin autorización expresa.
> Cada `#NNN` refiere a `https://github.com/DaltonP93/Gestion_Horas/pull/NNN`.

### Gate raíz (desbloquea a todos los demás): **orden de migraciones 081/082/083 vs 076–080**

> **Actualización 2026-09-08 — trabajo seguro del gate raíz HECHO (Draft #212), y corrección de un bloqueo fantasma:**
> - **Guardia de monotonicidad + unicidad de número:** implementada en `migrate.js` en **#212** (`claude/migrate-monotonicity-guard`, base main). `migrate`/`baseline` **abortan** si hay números duplicados (sin override) o pendientes fuera de secuencia (override explícito `--allow-out-of-order`); `--status` sólo reporta. 10 tests puros (incl. el caso 081/082/083 vs 076–080) verdes en 3 TZ; suite api 76/1302. El replay a nivel BD lo cubre el job de #194 al integrarse.
> - **083 SÍ es SQL-safe en un replay completo (corrección):** `system_settings` la crea la **migración SQL 033** (`033_audit_fulltext.sql`, `CREATE TABLE IF NOT EXISTS system_settings (key_name PK, value TEXT, …)`), **no** el ORM. La falla "083 por `system_settings`" del sim anterior fue un **artefacto de correr 081/082/083 en aislamiento** (sin 033), no un defecto: en `init.sql→002→…→033→…→083` la tabla existe cuando 083 inserta. Por eso **NO** se agregó un `CREATE TABLE system_settings` redundante a 083 (033 ya es la fuente de verdad). El caso 020→`webhooks` era distinto (ninguna migración SQL creaba `webhooks`; sólo el ORM → #194 lo arregló). El único gate real de 083 pasa a ser el **orden** (ya cubierto por #212) + el **conflicto con FASE E** (#184↔#202).

- **Problema (original):** el plan integraría 081 (#198), 082 (#201) y 083 (#202) **antes** que las menores 076–080 (FASE F), y `migrate.js` no tenía guardia de monotonicidad. **#212 cierra esa guardia.**
- **Decisión del propietario (elegir una):**
  - **(A) Preferida:** integrar **076–080 (FASE F) primero** → orden numérico = orden temporal; se preserva el invariante "menores primero". Depende de descongelar FASE F.
  - **(B) Alternativa:** **renumerar** 081/082/083 (unmerged) por encima del número final de FASE F, **o** —ya disponible— apoyarse en la **guardia de #212** y pasar `--allow-out-of-order` sólo tras verificar el orden.
- **Recomendado:** (A) si se descongela FASE F ahora. Con #212 en `main`, cualquier intento de aplicar 081/082/083 antes que 076–080 queda **bloqueado por el runner**, no sólo por convención.

### PRs de la Ola 5 y su desbloqueo

| PR(s) | Qué aporta | Migración | Bloqueo | Qué lo desbloquea |
|---|---|---|---|---|
| **FASE F** #158→#159→#160→#161 (+ F+ #167–#173, #185; CI #189) | Multiempresa (`companies`/`cost_centers`), gobierno, personas, calendario, nómina-base | **076–080** | Congelada; **auditoría Codex COMPLETADA = GO condicional** (`docs/evidence/fase-f-codex-audit.md`) | Decisión del propietario de **descongelar** + gate raíz (migraciones) resuelto + merge **base-first f1→f2→f3→f4** con OK PR por PR. Abrir además los 3 tickets de deuda del audit (nómina global, redacción `legal_name`, enlace org del onboarding). |
| **#198 → #199 → #201 → #203** | Aprobación multinivel + firma con hash + firma **PAdES** local + deploy de firma | **081, 082** | Gate raíz (081/082 fuera de secuencia vs 076–080) | Gate raíz resuelto (081/082 quedan **después** de 076–080). Sim. sobre MySQL 8: 081/082 **SQL-safe** (no dependen de FASE F); una vez fijado el orden, van tras FASE F. Merge base-first. |
| **#202** | Consola de activación FASE E (doble compuerta, no activa nada) | **083** | **Bloqueo restante:** el **conflicto real con la cadena FASE E** en `api/src/services/workdaySummaryService.js` (`#184 ↔ #202`, confirmado por `merge-tree` el 2026-09-08). El orden de 083 lo cubre la guardia de #212; 083 ya es SQL-safe (033 crea `system_settings`) | Integrar **después** de la Ola 4 (FASE E read-only) y **resolver** el conflicto en `workdaySummaryService.js`. El orden queda garantizado por #212. Sigue **sin activar** ningún flag. |
| **#209** | ADR: auth web a cookies HttpOnly (dirección aceptada) | — | **Sólo documento; implementación NO autorizada** | Es un ADR, no código. Se integra como doc cuando quieras; la **implementación** (Etapa 1 cookies) requiere una autorización aparte y explícita. |
| **#191** | Documentación integral (previa a #206) | — | Duplica a #206 (canónico) | Recortar a lo que #206 no cubra, o cerrar; ante divergencia gana #206. |

### Orden global sugerido (recordatorio, cada merge con OK)
`0 → 1 → 2 → 4 → (5 read-only ya cubierto por Ola 4) →` **[resolver gate raíz de migraciones + descongelar/auditar FASE F]** `→ 6 (FASE F 076–080) → 3 (firma 081/082) → #202 (083)`.

### Lo que NO se hace sin autorización explícita (recordatorio)
Descongelar FASE F, activar flags/writers, recalcular `daily_summary`, tocar producción/PM2/`git pull`/migraciones remotas, escribir en att2000, implementar cookies HttpOnly, fusionar/Ready-for-review cualquier PR.

## Vocabulario de estado

`MERGED_VERIFIED` · `OPEN_PR_UNAUDITED` · `OPEN_PR_TESTED` (pruebas locales del autor, sin CI remoto/rev humana) ·
`OPEN_PR_BLOCKED` · `SIMULATED_ONLY` · `NOT_PRESENT` · `PRODUCTION_UNVERIFIED`.

> **CI:** en `main` el workflow dispara sólo con base `main`. Al momento del snapshot **no se observaron
> workflow runs ni commit statuses** para los HEAD actuales de la mayoría de los PRs (incluidos #206/#207);
> por lo tanto **no se declara "CI verde"** para ninguno salvo que un run remoto exista y finalice OK sobre el HEAD exacto. "TESTED" = pruebas locales, no CI remoto.

## Método de la auditoría (nivel git, read-only)
Por cada rama se computó: base real, cadena de ancestría, archivos incrementales vs su base, migraciones
aportadas, y conflicto de árbol al mezclar la rama completa sobre `main` (`git merge-tree`). Resultado:
**0 conflictos de árbol detectados** al mezclar **cada rama por separado** sobre el `main` actual.
> ⚠️ **Esto NO prueba que la secuencia de 52 PRs no vaya a chocar.** `merge-tree` de cada rama vs
> `main` ignora los solapes entre ramas: al integrarse en orden, cada merge cambia el árbol base del
> siguiente. Los apilados deben integrarse bottom-up y hay **solapes de archivos** que sí producirán
> conflictos en secuencia (ver §Solapes). El único uso legítimo de "0 conflictos vs main" es descartar
> un choque directo con `main` hoy, no certificar la secuencia.

## Grupos y cadenas de dependencia

- **G1 · FASE F núcleo (CONGELADO hasta auditoría Codex):** #158→#159→#160→#161. Migraciones **076–080**.
  Aquí vive **multiempresa** (`076_governance_companies_cost_centers.sql`, tablas `companies`/`cost_centers`).
- **G2 · FASE F+ UI (depende de G1):** #167→#168→#169→#170→#171→#172→#173→#185 (base en `fase-f4`). web/src.
- **G3 · FASE F CI (depende de G1):** #189 (base `fase-f4`, `.github/workflows`).
- **G4 · FASE E read-only:** cadena #174→#175→#176→#182→#183→#184; sueltos #186, #164 (base main). api/scripts+tests.
- **G5 · ZKTeco:** #162 (web), #163 (api). Independientes sobre main.
- **G6 · Módulos/export:** cadena #178→#179→#180→#181→#187; sueltos #177, #188. web/api.
- **G7 · Nocturno/nómina/firma:** #196→#200; #196→#204→#205; #197; #198→#201; #199 (base main, pareja UI de #198); #202; #203.
- **G8 · Infra/CI/seguridad (base main):** #190, #194, #195, #192, #193, #165, #166, #207, **#208 (H1 preflight)**.
- **G9 · Docs/ADR (base main):** #191, #206, **#209 (ADR cookies HttpOnly, sólo documento)**.

### Grafo (resumido)
```
main
├─ G1 158→159→160→161  (FROZEN)     ├─ G3 189 (s/161)
│                                    └─ G2 167→168→169→170→171→172→173→185 (s/161)
├─ G4 174→175→176→182→183→184 ; 186 ; 164
├─ G5 162 ; 163
├─ G6 178→179→180→181→187 ; 177 ; 188
├─ G7 196→(200 ; 204→205) ; 198→201 ; 199 ; 197 ; 202 ; 203
├─ G8 190 ; 194 ; 195 ; 192 ; 193 ; 165 ; 166 ; 207 ; 208
└─ G9 191 ; 206 ; 209 (ADR)
```

## Solapes, duplicados y supersedidos (requieren atención antes de integrar)

| Conflicto potencial | PRs | Detalle | Acción del líder |
|---|---|---|---|
| **Redacción de token en logs = DUPLICADO** | **#194 vs #207** | #194 trae `api/src/utils/logRedaction.js` (`urlToken`+`redactSensitiveLogLine`) sobre morgan. | **RESUELTO:** #207 quedó recortado a H10 (algoritmos JWT) + H7 (5xx genérico); su HEAD **ya NO** contiene `redactUrl.js` ni el cambio de morgan. La redacción de logs es responsabilidad única de #194. |
| `web/src/lib/workdayConfig.ts` | **#193 vs #194** | Ambos tocan el mismo archivo (fix de tipo de `workdayConfigPayloadForSave`). | **RESUELTO (2026-09-07):** #194 incluye el fix íntegro (mismo diff + comentario extra). **#193 cerrado** como subconjunto estricto. El fix de build web es responsabilidad única de #194. |
| `.github/workflows/ci.yml` | #158, #189, #190, #194 | #190 agrega trigger `claude/**`; #194 agrega job Analytics/Python + concurrency; #158/#189 tocan CI de FASE F. **No son duplicados** pero colisionan en secuencia. | Integrar CI en un orden único (ver batches); rebasar los siguientes tras cada merge. |
| `api/.env.example` | #158–#161, #195, #201, #202 | Varias adiciones de variables. | Conflictos de merge menores; resolver por rebase incremental. |
| `database/migrations/` **orden fuera de secuencia** | 076–080 (F, lote 6), 081–082 (firma, lote 3), 083 (consola, lote 5) | Números únicos (sin choque), **pero el plan mergea 081–083 ANTES que las MENORES 076–080**. ~~`migrate.js` no tiene guardia~~ → **guardia en #212**. | **Ver §Orden de migraciones (P1-C).** Con #212, aplicar 081/082/083 antes que 076–080 queda **bloqueado por el runner**; el orden se decide por FASE F-primero o `--allow-out-of-order` verificado. |
| `api/src/routes/reports.js`, `me.js` | #196/#204/#205 vs #192 vs #197 vs #198 | El motor nocturno, el authz por alcance, el recibo y la aprobación tocan reports/me. | Orden recomendado: authz (#192) → nocturno (#196→204→205) → recibo/aprobación; rebasar entre medio. |

## Orden bottom-up recomendado (propuesta; NINGÚN merge sin tu OK por PR)

**Lote 0 — Documentación/ADR (sin riesgo):** #206 (este snapshot, **fuente canónica** de estado/plan),
luego #191 (recortar a lo que NO duplique #206) y #209 (ADR cookies; sólo documento, sin código).

**Lote 1 — Infra/seguridad base sobre main (habilita CI real para el resto):**
1. #190 (trigger CI `claude/**`) — habilita CI en las ramas encadenadas.
2. #194 (CI Analytics + concurrency + **logRedaction** + migración 020 + saneo) — rebasar sobre #190.
3. ~~#193 (fix build web)~~ — **RESUELTO:** incluido en #194; #193 cerrado (subconjunto estricto).
4. #207 (recortado: algoritmos JWT + 5xx genérico) — tras #194.
5. #192 (authz por alcance + auditoría sin PII + fix inyección att2000).
6. #165 (insertId), #166 (auditoría egreso sin PII), #195 (saneo dominio restante).
7. #208 (H1: preflight fail-closed de credencial demo + prevención de reintroducción). Independiente;
   solapa `authController.js` con #207 en funciones distintas (regiones no adyacentes).

> **Auditoría read-only lotes 2/3:** footprints, matriz de conflictos (todos limpios) y GO/NO-GO por PR
> en `docs/evidence/lots-2-3-audit.md`. Ensayo local lote1+lote2 = 0 conflictos, API 91 suites/1423 tests
> verde en 3 TZ (nocturno sensible a TZ), tree `7032fafd`.

**Lote 2 — Nocturno/lecturas (solo lectura, reversible):**
7. #196 → #204 → #205 (motor en mensual/semanal/diario/analítica/self-service). Rebasar sobre #192.
8. #197 (recibo self-service), #200 (export horas+API, s/#196).

**Lote 3 — Aprobación/firma:**
9. #198 → #199 (UI) → #201 (PAdES) → #203 (deploy firma). Migraciones 081/082.
   **NO-GO hasta resolver el orden de migraciones vs FASE F 076–080** (ver §Orden de migraciones).

> **Auditoría read-only lotes 4/5/6:** `docs/evidence/lots-4-6-audit.md` — lote 4 sin migraciones y
> mergeable limpio (incl. #188 `reports.js` vs nocturno); FASE E #174-#184/#186/#164 read-only GO;
> **#202 NO-GO doble** (083 + conflicto con FASE E en `workdaySummaryService.js`); FASE F congelada.
> Orden global sugerido: 0→1→2→4→(5 read-only)→[orden migraciones + Codex FASE F]→6(076-080)→3(081/082)→#202(083).

**Lote 4 — Módulos/export:** #178→#179→#180→#181→#187; #177; #188; #162; #163.

**Lote 5 — FASE E read-only:** #174→#175→#176→#182→#183→#184; #186; #164; #202 (consola, no activa nada;
migración **083**, **NO-GO hasta resolver orden vs 076–080**).

**Lote 6 — FASE F núcleo + F+ (auditoría Codex COMPLETADA = GO condicional; sigue congelado hasta OK del propietario):**
#158→#159→#160→#161 (incluye **multiempresa** 076), luego #167→…→#173→#185 y #189. Auditoría read-only en
`docs/evidence/fase-f-codex-audit.md`: sin BLOCKER de código; gate real = orden de migraciones (§abajo) + fusión
base-first f1→f2→f3→f4 con OK PR por PR. **No integrar ni rebasar sin autorización expresa.**

## Orden de migraciones (P1-C — evidencia sobre MySQL 8 descartable)

**Problema:** el plan integra 081 (#198), 082 (#201) y 083 (#202) en lotes 3/5, **antes** que
las migraciones **menores** 076–080 (FASE F, lote 6). Numéricamente 076 < 081, pero temporalmente
se aplicarían después. Riesgo: un despliegue con 081–083 ya aplicadas que luego recibe 076–080.

**Cómo se comporta `migrate.js`** (lectura del código + simulación real, ver abajo):
- Registra lo aplicado por **nombre de archivo** en `schema_migrations`; `pending` = **cualquier**
  archivo en disco que no esté registrado; los aplica en **orden lexicográfico (numérico) ascendente**.
- ~~**No hay guardia de monotonicidad**~~ → **RESUELTO en #212 (2026-09-08):** `migrate.js` ahora **aborta**
  (`migrate`/`baseline`) si hay una migración pendiente de número menor que el máximo aplicado, o números
  duplicados; `--status` sólo reporta. Override explícito `--allow-out-of-order` para el desorden decidido.
- Idempotente: lo ya aplicado nunca se reaplica.

**Simulación (contenedor `mysql:8.0` efímero, runner real, sin base remota):**
1. **Fase 1** — presentes sólo 081/082/083 (SIN 076–080): 081 y 082 aplican **OK**; **083 falla en este
   escenario AISLADO** porque falta `system_settings`. **⚠️ Corrección 2026-09-08:** esto **no** es un defecto
   de 083 — `system_settings` la crea la **migración SQL 033** (`033_audit_fulltext.sql`), no el ORM; en un
   replay completo `init.sql→002→…→033→…→083` la tabla existe y 083 aplica. La falla del sim era artefacto
   de omitir 033. → 081/082/083 **no dependen** de 076–080.
2. **Fase 2** — se añaden 076–080 (menores): el runner las toma como pendientes y las aplica
   **temporalmente después** de 081/082 (set aplicado = `076,077,078,079,080,081,082`). El FK que cruza
   el límite (`branches.company_id → companies(id)`) queda **íntegro**. 083 sigue fallando.
3. **Fase 3** — idempotencia: 076–082 **no** se reaplican (sólo se reintenta 083).

Evidencia reproducible y aserciones mecánicas: `docs/evidence/migration-order-sim.{sh,md}`.

**Conclusión (actualizada 2026-09-08):** el orden fuera de secuencia es **SQL-safe para 076–083**: no hay
dependencia cruzada (081/082 no referencian objetos de FASE F; 076–080 no referencian 081+; acoplación
intra-grupo 082→081, 076→080) y **083 sólo depende de `system_settings`, que crea la migración SQL 033** —
presente en cualquier replay completo. El bloqueo de #202 **ya no es la migración 083** sino su **conflicto
con la cadena FASE E** (#184↔#202 en `workdaySummaryService.js`). Los stubs no equivalen a un replay integral
de 002–083 (eso lo cubre el job DB de #194 al extenderlo a 076–083).

**Pero la seguridad es CONTINGENTE y frágil** (por eso NO-GO hasta resolver, no "OK"):
- `migrate.js` no garantiza nada: si cualquier PR de lote temprano introdujera una migración que
  referencie un objeto de FASE F, fallaría al aplicar (fail-loud, pero **bloquea** el despliegue).
- **Colisión de números entre PRs abiertos:** el runner llavea por nombre; dos PRs con el mismo
  `NNN_*.sql` divergente harían que el segundo se considere "ya aplicado" y se **saltee** silenciosamente.
  **RESUELTO en #212:** `findDuplicateNumbers` aborta el runner si hay números repetidos en disco.
- **`migrate.js` no es autosuficiente desde `init.sql`:** algunas migraciones asumían tablas creadas
  por el **sync del ORM**, no por SQL. El caso confirmado era **020→`webhooks`** (ninguna migración SQL
  creaba `webhooks`) → **#194 lo arregló** (le agrega `CREATE TABLE IF NOT EXISTS webhooks`) y su job
  **DB — migraciones (MySQL 8 efímero)** corre `init.sql`→`migrate` (002–075) **en verde**. **083→`system_settings`
  NO era uno de esos casos** (lo crea la migración SQL 033; ver corrección arriba). Requisito vigente para
  lotes con migraciones: verificar autocontención por replay completo en el job de BD y **extenderlo a 076–083**
  cuando esos lotes se integren.

**Decisión (requiere OK del propietario, PR por PR):**
- **Preferido:** integrar **076–080 (FASE F) ANTES** de cualquier lote que traiga 081–083 → orden
  numérico = orden temporal, se preserva el invariante "menores primero". (Depende de la auditoría Codex
  de FASE F, hoy congelada.)
- **Alternativa** (si FASE F no puede ir primero): **renumerar** 081–083 (unmerged) para quedar por
  encima del número final de FASE F, **o** certificar explícitamente (como aquí) que no hay dependencia
  cruzada **y** hacer cumplir unicidad de número.
- Hasta resolver, **081/082/083 quedan NO-GO** y sus PRs (#198/#201/#202) no se integran.
- **Añadir un guard/lint de CI:** rechazar (o al menos advertir) un set donde exista una migración
  de número menor sin aplicar mientras una mayor ya lo está; y validar unicidad de número entre PRs.

## Qué rebasar tras cada merge
Al fusionar un PR base, rebasar (o mergear main hacia) sus dependientes directos **manteniendo el orden de la
cadena** y sin tocar FASE F. Ej.: tras #196, rebasar #204/#205/#200; tras #198, rebasar #201/#199.
Para ramas ajenas a FASE F creadas por sesiones previas, usar merge de main hacia la rama (no rebase destructivo).

## Suite y migraciones por lote
- **Cada lote:** `api` jest (TZ UTC/Asunción/Tokyo), `bridge` jest, `web build` si toca web.
- **Lotes con migraciones:** lote 3 (081/082 firma), lote 5 (083 consola FASE E), lote 6 (076–080 FASE F).
  Correr sobre **MySQL efímero** (job de #194) `init.sql`→`002…0NN` **sembrando primero las tablas del ORM**
  (ver §Orden de migraciones) y validar cadena. **NO-GO** para 081/082/083 hasta resolver el orden vs 076–080.
  FASE F: además el gate NO-GO por auditoría Codex.
- **Auditoría de dependencias** (P3) antes de tocar deps con CVE (`multer`, `axios`, `python-jose`).

## Punto de rollback por lote
`main` es el punto de rollback (nada se fusiona sin OK). Por lote, el rollback es no-mergear o revertir el/los
merge(s) de ese lote (merge commits), ya que se integran en orden y cada uno es un merge atómico revertible.
No hay estado destructivo: migraciones sólo forward, pero **no** se aplican en prod en esta fase.

## PRs que requieren auditoría previa a integrar
- **#191 (docs) vs #206:** **#206 es la fuente canónica** de estado/plan/trazabilidad (AI_HANDOFF,
  IMPLEMENTATION_STATUS, INTEGRATION_PLAN, REQUIREMENTS_TRACEABILITY). #191 debe **recortarse** a lo que
  no dupliquen esos archivos; ante divergencia gana #206.
- ~~#193 vs #194 (`workdayConfig.ts`)~~ — **RESUELTO** (2026-09-07): #194 incluye el fix; #193 cerrado.
- #207 (recorte por duplicado con #194) — **RESUELTO** (HEAD sin `redactUrl.js` ni cambio de morgan).
- **081/082/083 (#198/#201/#202): NO-GO** hasta resolver el orden de migraciones vs FASE F (§Orden de migraciones).
- Toda la cadena G7 nocturno/firma: revisar orden reports/me vs #192.
- FASE F (G1/G2/G3): **congelada**; auditoría Codex read-only **completada** (GO condicional,
  `docs/evidence/fase-f-codex-audit.md`); sin cambios de HEAD. Descongelar sólo con OK del propietario y orden de migraciones resuelto.

## Restricciones vigentes
Cero merge/auto-merge/Ready/close/deploy. att2000 READ-ONLY. Sin activar flags/writers. Sin tocar
`daily_summary`/`attendance_logs` salvo fixtures sintéticos en BD descartable. FASE F congelada.
