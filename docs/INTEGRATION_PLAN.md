# Plan de integración bottom-up — SisHoras

> **Actualizado:** 2026-09-06 · Autor: Agente 0 (líder). Autorizado por el propietario para
> **preparar** el plan (D2, opción A): **sin fusionar, sin auto-merge, sin Ready-for-review,
> sin cerrar, sin desplegar, sin rebasar FASE F**. Cada merge requiere autorización expresa posterior, PR por PR.
> **Snapshot:** `main @ 078cd67` (#157). **52 PRs abiertos** (#158–#209), todos Draft, ninguno fusionado.
> Ninguna rama abierta equivale a producción. `main` permanece en #157.
> (#208 = H1 preflight fail-closed de credencial demo; #209 = ADR cookies HttpOnly, sólo documento.)

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
| `web/src/lib/workdayConfig.ts` | **#193 vs #194** | Ambos tocan el mismo archivo (fix de tipo). Posible solape/duplicado parcial. | Auditar cuál corrige el build; el otro se recorta o se marca SUPERSEDED. |
| `.github/workflows/ci.yml` | #158, #189, #190, #194 | #190 agrega trigger `claude/**`; #194 agrega job Analytics/Python + concurrency; #158/#189 tocan CI de FASE F. **No son duplicados** pero colisionan en secuencia. | Integrar CI en un orden único (ver batches); rebasar los siguientes tras cada merge. |
| `api/.env.example` | #158–#161, #195, #201, #202 | Varias adiciones de variables. | Conflictos de merge menores; resolver por rebase incremental. |
| `database/migrations/` **orden fuera de secuencia** | 076–080 (F, lote 6), 081–082 (firma, lote 3), 083 (consola, lote 5) | Números únicos (sin choque), **pero el plan mergea 081–083 ANTES que las MENORES 076–080**. `migrate.js` no tiene guardia de monotonicidad. | **Ver §Orden de migraciones (P1-C).** Marcado **NO-GO** para 081/082/083 hasta resolver FASE F (076–080). |
| `api/src/routes/reports.js`, `me.js` | #196/#204/#205 vs #192 vs #197 vs #198 | El motor nocturno, el authz por alcance, el recibo y la aprobación tocan reports/me. | Orden recomendado: authz (#192) → nocturno (#196→204→205) → recibo/aprobación; rebasar entre medio. |

## Orden bottom-up recomendado (propuesta; NINGÚN merge sin tu OK por PR)

**Lote 0 — Documentación/ADR (sin riesgo):** #206 (este snapshot, **fuente canónica** de estado/plan),
luego #191 (recortar a lo que NO duplique #206) y #209 (ADR cookies; sólo documento, sin código).

**Lote 1 — Infra/seguridad base sobre main (habilita CI real para el resto):**
1. #190 (trigger CI `claude/**`) — habilita CI en las ramas encadenadas.
2. #194 (CI Analytics + concurrency + **logRedaction** + migración 020 + saneo) — rebasar sobre #190.
3. #193 (fix build web) **o** reconciliar con #194 (`workdayConfig.ts`).
4. #207 (recortado: algoritmos JWT + 5xx genérico) — tras #194.
5. #192 (authz por alcance + auditoría sin PII + fix inyección att2000).
6. #165 (insertId), #166 (auditoría egreso sin PII), #195 (saneo dominio restante).
7. #208 (H1: preflight fail-closed de credencial demo + prevención de reintroducción). Independiente;
   solapa `authController.js` con #207 en funciones distintas (regiones no adyacentes).

**Lote 2 — Nocturno/lecturas (solo lectura, reversible):**
7. #196 → #204 → #205 (motor en mensual/semanal/diario/analítica/self-service). Rebasar sobre #192.
8. #197 (recibo self-service), #200 (export horas+API, s/#196).

**Lote 3 — Aprobación/firma:**
9. #198 → #199 (UI) → #201 (PAdES) → #203 (deploy firma). Migraciones 081/082.
   **NO-GO hasta resolver el orden de migraciones vs FASE F 076–080** (ver §Orden de migraciones).

**Lote 4 — Módulos/export:** #178→#179→#180→#181→#187; #177; #188; #162; #163.

**Lote 5 — FASE E read-only:** #174→#175→#176→#182→#183→#184; #186; #164; #202 (consola, no activa nada;
migración **083**, **NO-GO hasta resolver orden vs 076–080**).

**Lote 6 — FASE F núcleo + F+ (BLOQUEADO hasta auditoría Codex):** #158→#159→#160→#161 (incluye **multiempresa** 076), luego #167→…→#173→#185 y #189. **No integrar ni rebasar hasta que Codex termine.**

## Orden de migraciones (P1-C — evidencia sobre MySQL 8 descartable)

**Problema:** el plan integra 081 (#198), 082 (#201) y 083 (#202) en lotes 3/5, **antes** que
las migraciones **menores** 076–080 (FASE F, lote 6). Numéricamente 076 < 081, pero temporalmente
se aplicarían después. Riesgo: un despliegue con 081–083 ya aplicadas que luego recibe 076–080.

**Cómo se comporta `migrate.js`** (lectura del código + simulación real, ver abajo):
- Registra lo aplicado por **nombre de archivo** en `schema_migrations`; `pending` = **cualquier**
  archivo en disco que no esté registrado; los aplica en **orden lexicográfico (numérico) ascendente**.
- **No hay guardia de monotonicidad:** una migración de número **menor** añadida después se toma como
  pendiente y se aplica **después** de las mayores ya aplicadas, sin advertir.
- Idempotente: lo ya aplicado nunca se reaplica.

**Simulación (contenedor `mysql:8.0` efímero, runner real, sin base remota):**
1. **Fase 1** — presentes sólo 081/082/083 (SIN 076–080): 081 y 082 aplican **OK** (083 falla sólo por
   `system_settings`, tabla del ORM, no por FASE F). → 081/082 **no dependen** de 076–080.
2. **Fase 2** — se añaden 076–080 (menores): el runner las toma como pendientes y aplica
   **076→077→078→079→080** en orden, **temporalmente después** de 081/082. **Todas OK.** El FK que cruza
   el límite (`branches.company_id → companies(id)`) queda **íntegro**.
3. **Fase 3** — idempotencia: no reaplica nada ya aplicado.

**Conclusión (estática + empírica):** para el conjunto **actual** 076–083 el orden fuera de secuencia
es **SQL-safe**, porque **no hay dependencia cruzada**: 081–083 no referencian objetos de FASE F
(`companies`/`cost_centers`/`company_id`/`candidates`/`assignments`/`labor_calendars`/`payroll`) y
076–080 no referencian 081+. La única acoplación es intra-grupo ascendente (082→081; 076→080).

**Pero la seguridad es CONTINGENTE y frágil** (por eso NO-GO hasta resolver, no "OK"):
- `migrate.js` no garantiza nada: si cualquier PR de lote temprano introdujera una migración que
  referencie un objeto de FASE F, fallaría al aplicar (fail-loud, pero **bloquea** el despliegue).
- **Colisión de números entre PRs abiertos:** el runner llavea por nombre; dos PRs con el mismo
  `NNN_*.sql` divergente harían que el segundo se considere "ya aplicado" y se **saltee** silenciosamente.
  Con 52 PRs abiertos hay que **garantizar unicidad global de número** antes de integrar.
- **`migrate.js` no es autosuficiente desde `init.sql`:** varias migraciones asumen tablas creadas
  por el **sync del ORM (sequelize)**, no por SQL (p. ej. 020→`webhooks`, 083→`system_settings`).
  La estrategia del proyecto es **migración autocontenida**: **#194 ya arregla la 020** (le agrega
  `CREATE TABLE IF NOT EXISTS webhooks`) y su job **DB — migraciones (MySQL 8 efímero)** corre
  `init.sql`→`migrate` (002–075) **en verde**. Requisito para los lotes siguientes: **cada migración
  que entre a un lote con el job de BD debe ser autocontenida** (patrón 020) — pendiente verificar
  **083** (`system_settings`, #202) y extender el job de BD a **076–083** cuando esos lotes se integren.

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
- #193 vs #194 (`workdayConfig.ts`).
- #207 (recorte por duplicado con #194) — **RESUELTO** (HEAD sin `redactUrl.js` ni cambio de morgan).
- **081/082/083 (#198/#201/#202): NO-GO** hasta resolver el orden de migraciones vs FASE F (§Orden de migraciones).
- Toda la cadena G7 nocturno/firma: revisar orden reports/me vs #192.
- FASE F (G1/G2/G3): **congelada**; sólo inspección/documentación, sin cambios de HEAD.

## Restricciones vigentes
Cero merge/auto-merge/Ready/close/deploy. att2000 READ-ONLY. Sin activar flags/writers. Sin tocar
`daily_summary`/`attendance_logs` salvo fixtures sintéticos en BD descartable. FASE F congelada.
