# Plan de integración bottom-up — SisHoras

> **Actualizado:** 2026-09-06 · Autor: Agente 0 (líder). Autorizado por el propietario para
> **preparar** el plan (D2, opción A): **sin fusionar, sin auto-merge, sin Ready-for-review,
> sin cerrar, sin desplegar, sin rebasar FASE F**. Cada merge requiere autorización expresa posterior, PR por PR.
> **Snapshot:** `main @ 078cd67` (#157). **50 PRs abiertos** (#158–#207), todos Draft, ninguno fusionado.
> Ninguna rama abierta equivale a producción. `main` permanece en #157.

## Vocabulario de estado

`MERGED_VERIFIED` · `OPEN_PR_UNAUDITED` · `OPEN_PR_TESTED` (pruebas locales del autor, sin CI remoto/rev humana) ·
`OPEN_PR_BLOCKED` · `SIMULATED_ONLY` · `NOT_PRESENT` · `PRODUCTION_UNVERIFIED`.

> **CI:** en `main` el workflow dispara sólo con base `main`. Al momento del snapshot **no se observaron
> workflow runs ni commit statuses** para los HEAD actuales de la mayoría de los PRs (incluidos #206/#207);
> por lo tanto **no se declara "CI verde"** para ninguno salvo que un run remoto exista y finalice OK sobre el HEAD exacto. "TESTED" = pruebas locales, no CI remoto.

## Método de la auditoría (nivel git, read-only)
Por cada rama se computó: base real, cadena de ancestría, archivos incrementales vs su base, migraciones
aportadas, y conflicto de árbol al mezclar la rama completa sobre `main` (`git merge-tree`). Resultado:
**0 conflictos de árbol detectados** al mezclar cada rama sobre el `main` actual — pero los apilados deben
integrarse bottom-up y hay **solapes de archivos** que sí producirán conflictos en secuencia (ver §Solapes).

## Grupos y cadenas de dependencia

- **G1 · FASE F núcleo (CONGELADO hasta auditoría Codex):** #158→#159→#160→#161. Migraciones **076–080**.
  Aquí vive **multiempresa** (`076_governance_companies_cost_centers.sql`, tablas `companies`/`cost_centers`).
- **G2 · FASE F+ UI (depende de G1):** #167→#168→#169→#170→#171→#172→#173→#185 (base en `fase-f4`). web/src.
- **G3 · FASE F CI (depende de G1):** #189 (base `fase-f4`, `.github/workflows`).
- **G4 · FASE E read-only:** cadena #174→#175→#176→#182→#183→#184; sueltos #186, #164 (base main). api/scripts+tests.
- **G5 · ZKTeco:** #162 (web), #163 (api). Independientes sobre main.
- **G6 · Módulos/export:** cadena #178→#179→#180→#181→#187; sueltos #177, #188. web/api.
- **G7 · Nocturno/nómina/firma:** #196→#200; #196→#204→#205; #197; #198→#201; #199 (base main, pareja UI de #198); #202; #203.
- **G8 · Infra/CI/seguridad (base main):** #190, #194, #195, #192, #193, #165, #166, #207.
- **G9 · Docs (base main):** #191, #206.

### Grafo (resumido)
```
main
├─ G1 158→159→160→161  (FROZEN)     ├─ G3 189 (s/161)
│                                    └─ G2 167→168→169→170→171→172→173→185 (s/161)
├─ G4 174→175→176→182→183→184 ; 186 ; 164
├─ G5 162 ; 163
├─ G6 178→179→180→181→187 ; 177 ; 188
├─ G7 196→(200 ; 204→205) ; 198→201 ; 199 ; 197 ; 202 ; 203
├─ G8 190 ; 194 ; 195 ; 192 ; 193 ; 165 ; 166 ; 207
└─ G9 191 ; 206
```

## Solapes, duplicados y supersedidos (requieren atención antes de integrar)

| Conflicto potencial | PRs | Detalle | Acción del líder |
|---|---|---|---|
| **Redacción de token en logs = DUPLICADO** | **#194 vs #207** | #194 ya trae `api/src/utils/logRedaction.js` (`urlToken`+`redactSensitiveLogLine`) sobre morgan; #207 (Dev A) reimplementó lo mismo con `redactUrl.js`. | **#207 se recorta** a H10 (algoritmos JWT) + H7 (5xx genérico); la redacción de logs queda como responsabilidad de #194. (En curso.) |
| `web/src/lib/workdayConfig.ts` | **#193 vs #194** | Ambos tocan el mismo archivo (fix de tipo). Posible solape/duplicado parcial. | Auditar cuál corrige el build; el otro se recorta o se marca SUPERSEDED. |
| `.github/workflows/ci.yml` | #158, #189, #190, #194 | #190 agrega trigger `claude/**`; #194 agrega job Analytics/Python + concurrency; #158/#189 tocan CI de FASE F. **No son duplicados** pero colisionan en secuencia. | Integrar CI en un orden único (ver batches); rebasar los siguientes tras cada merge. |
| `api/.env.example` | #158–#161, #195, #201, #202 | Varias adiciones de variables. | Conflictos de merge menores; resolver por rebase incremental. |
| `database/migrations/` numeración | 076–080 (F), 081–082 (firma), 083 (consola) | **Sin choque de numeración** (verificado). | OK; validar cadena al integrar cada grupo. |
| `api/src/routes/reports.js`, `me.js` | #196/#204/#205 vs #192 vs #197 vs #198 | El motor nocturno, el authz por alcance, el recibo y la aprobación tocan reports/me. | Orden recomendado: authz (#192) → nocturno (#196→204→205) → recibo/aprobación; rebasar entre medio. |

## Orden bottom-up recomendado (propuesta; NINGÚN merge sin tu OK por PR)

**Lote 0 — Documentación (sin riesgo):** #206 (este snapshot), luego #191 (revisar solape de contenido con #206; posible recorte).

**Lote 1 — Infra/seguridad base sobre main (habilita CI real para el resto):**
1. #190 (trigger CI `claude/**`) — habilita CI en las ramas encadenadas.
2. #194 (CI Analytics + concurrency + **logRedaction** + migración 020 + saneo) — rebasar sobre #190.
3. #193 (fix build web) **o** reconciliar con #194 (`workdayConfig.ts`).
4. #207 (recortado: algoritmos JWT + 5xx genérico) — tras #194.
5. #192 (authz por alcance + auditoría sin PII + fix inyección att2000).
6. #165 (insertId), #166 (auditoría egreso sin PII), #195 (saneo dominio restante).

**Lote 2 — Nocturno/lecturas (solo lectura, reversible):**
7. #196 → #204 → #205 (motor en mensual/semanal/diario/analítica/self-service). Rebasar sobre #192.
8. #197 (recibo self-service), #200 (export horas+API, s/#196).

**Lote 3 — Aprobación/firma:**
9. #198 → #199 (UI) → #201 (PAdES) → #203 (deploy firma). Migraciones 081/082.

**Lote 4 — Módulos/export:** #178→#179→#180→#181→#187; #177; #188; #162; #163.

**Lote 5 — FASE E read-only:** #174→#175→#176→#182→#183→#184; #186; #164; #202 (consola, no activa nada).

**Lote 6 — FASE F núcleo + F+ (BLOQUEADO hasta auditoría Codex):** #158→#159→#160→#161 (incluye **multiempresa** 076), luego #167→…→#173→#185 y #189. **No integrar ni rebasar hasta que Codex termine.**

## Qué rebasar tras cada merge
Al fusionar un PR base, rebasar (o mergear main hacia) sus dependientes directos **manteniendo el orden de la
cadena** y sin tocar FASE F. Ej.: tras #196, rebasar #204/#205/#200; tras #198, rebasar #201/#199.
Para ramas ajenas a FASE F creadas por sesiones previas, usar merge de main hacia la rama (no rebase destructivo).

## Suite y migraciones por lote
- **Cada lote:** `api` jest (TZ UTC/Asunción/Tokyo), `bridge` jest, `web build` si toca web.
- **Lotes con migraciones (2? no; 3 firma 081/082; 6 FASE F 076–080):** correr migraciones sobre **MySQL efímero**
  (job de #194) `init.sql`→`002…0NN` y validar cadena. FASE F: además el gate NO-GO documentado.
- **Auditoría de dependencias** (P3) antes de tocar deps con CVE (`multer`, `axios`, `python-jose`).

## Punto de rollback por lote
`main` es el punto de rollback (nada se fusiona sin OK). Por lote, el rollback es no-mergear o revertir el/los
merge(s) de ese lote (merge commits), ya que se integran en orden y cada uno es un merge atómico revertible.
No hay estado destructivo: migraciones sólo forward, pero **no** se aplican en prod en esta fase.

## PRs que requieren auditoría previa a integrar
- #191 (docs) vs #206 (posible solape/duplicado de documentación).
- #193 vs #194 (`workdayConfig.ts`).
- #207 (recorte por duplicado con #194) — en curso.
- Toda la cadena G7 nocturno/firma: revisar orden reports/me vs #192.
- FASE F (G1/G2/G3): **congelada**; sólo inspección/documentación, sin cambios de HEAD.

## Restricciones vigentes
Cero merge/auto-merge/Ready/close/deploy. att2000 READ-ONLY. Sin activar flags/writers. Sin tocar
`daily_summary`/`attendance_logs` salvo fixtures sintéticos en BD descartable. FASE F congelada.
