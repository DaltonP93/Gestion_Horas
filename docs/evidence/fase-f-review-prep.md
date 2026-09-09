# FASE F (Ola 5) — Preparación para revisión (rebase sobre `main` actual)

> **Fecha:** 2026-09-09 · **Autor:** Agente 0 (líder técnico).
> **Alcance:** dejar toda la cadena FASE F (multiempresa) revisable sobre el `main`
> integrado (`be7139b`), **sin fusionar**. FASE F sigue **CONGELADA**: cada merge
> requiere OK expreso del propietario, PR por PR, en orden base-first.
> **Complementa** `docs/evidence/fase-f-codex-audit.md` (GO condicional del código).

## 1. Problema que resuelve esta preparación
Las ramas FASE F se crearon sobre `main@078cd67`. Desde entonces `main` avanzó **108
commits** (Olas 1–4 + deps + docs + DevOps → `be7139b`). Los PRs quedaron desfasados y
con conflictos latentes. Se trajo `main` a cada rama (merge, no rebase: preserva historia
y no reescribe ramas apiladas de terceros) y se resolvieron los conflictos, para que la
revisión ocurra sobre el estado real del repo.

## 2. Conflictos reales encontrados y cómo se resolvieron
Sólo **2 ramas** tuvieron conflictos; el resto entró limpio.

### F1 (#158) — 3 conflictos
- **`.github/workflows/ci.yml`** → se tomó la cadena de `main` (superset). El job
  `migrations-mysql` propio de F1 quedó cubierto por el job `migrations` (MySQL 8 efímero)
  ya en `main`.
- **`api/src/index.js`** → se conservaron **ambos**: `app.use(requestId)` (correlation id
  de F1) **y** el bloque `CORS_ORIGINS` de `main`. `requestId` va primero para correlacionar
  todo, incluida la auth.
- **`api/src/services/audit.js`** (el crítico) → se **combinaron** las dos capacidades:
  (a) degradación por `correlation_id` de F1 (`insertWithCorrelation`/`insertLegacy` con
  detección de columna 077 faltante) y (b) `sanitizeDetails`/ALLOWLIST anti-PII de #192.
  El array `base` ahora persiste `sanitizeDetails(details)`, así la PII se poda **con o sin**
  correlation_id. Exports unificados. Verificado con `auditCorrelationId.test.js` **y**
  `auditSanitize.test.js` verdes **juntos**.

### #189 (CI idempotencia 072→075) — 1 conflicto
- **`.github/workflows/ci.yml`** → base = cadena de `main`; se **conservó** el job único de
  #189 (`migrations-072-075-idempotency`: baseline sólo hasta 071, aplica 072→ de verdad,
  reaplica y compara el esquema columna a columna). `migrate.js` de `main` ya soporta
  `--baseline`/`--allow-out-of-order`, así que el job es viable tal cual. Se descartaron las
  modificaciones de #189 al job compartido (ya cubiertas por `main`). YAML válido (6 jobs).

El resto (F2, F3, F4, y toda la cadena F+ #167→#185) mergeó **sin conflictos**.

## 3. Evidencia local (antes de push)
- **API (TZ=America/Asuncion):** F1 1600/1609 · F2 1649/1677 · F3 1698/1748 · F4 1730/1787
  (suites skip = integración MySQL/otras TZ). Sin fallos.
- **Web:** `next build` **verde** en el tip F+ (`fase-fplus-ayuda-i18n`), con las páginas
  nuevas presentes: `/candidatos`, `/configuracion/empresas`, `/configuracion/centros-costo`,
  `/configuracion/calendario-laboral`, `/configuracion/nomina-base`, etc.

## 4. Estado de CI remoto (trigger `claude/**`, base = `main` integrado)
| PR | Rama | HEAD | CI |
|---|---|---|---|
| #158 F1 | fase-f1-gobierno-permisos-auditoria | `cf5a294` | ✅ verde |
| #159 F2 | fase-f2-personas-contratos | `b1a150b` | ✅ verde |
| #160 F3 | fase-f3-calendario-jornada | `9c04518` | ✅ verde |
| #161 F4 | fase-f4-nomina-base | `84a1173` | ✅ verde |
| #167 F+ asignaciones | fase-fplus-asignaciones-timeline | `e8d1de2` | ✅ verde |
| #168–#173, #185 F+ | (cadena F+ UI) | (ver PRs) | ⏳ en cola/curso (web build local ✅) |
| #189 CI idempotencia | fase-f-migrations-072-075-idempotency | `914e57a` | ⏳ en cola (YAML válido; job con flags soportados) |

## 5. Gate de orden de migraciones (aclaración importante)
FASE F aporta migraciones **076–080**. La cadena `072→…→080` es **monótona** (sin números
fuera de orden ni duplicados), así que la guardia de `migrate.js` (#212) **no** la bloquea y
076–080 aplican limpio tras 075. El conflicto de orden **081/082/083 antes de 076–080** es de
la firma/consola (**#198–#203 / #202**), que **no** forman parte de FASE F: no bloquean esta
cadena.

## 6. GO / NO-GO (recomendación para el propietario)
**GO condicional a tu OK expreso.** Código listo, conflictos resueltos, invariantes intactas
(sin activar flags/writers, att2000 READ-ONLY, `daily_summary` sin recalcular, migraciones
076–080 **sin aplicar** — sólo validadas en CI efímero). El **único gate pendiente es la
autorización del propietario**, dado que FASE F sigue congelada.

**Orden de merge sugerido (base-first), cuando autorices:**
`#158 → #159 → #160 → #161` (núcleo), luego `#167 → #168 → #169 → #170 → #171 → #172 → #173 → #185`
(F+ UI), y `#189` (CI) en cualquier momento tras #161. Retarget de cada apilado a `main`
tras fusionar su base; método `merge`; verificar CI verde entre pasos.

> Nada de esto autoriza aplicar migraciones en prod ni activar multiempresa: es sólo la
> preparación de los PRs para revisión y un eventual merge autorizado.
