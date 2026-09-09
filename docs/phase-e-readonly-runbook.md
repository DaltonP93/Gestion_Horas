# FASE E — Runbook de preflight READ-ONLY (GO/NO-GO)

> **Estado:** preparación de rollout. Nada de esto activa flags/writers, corre
> migraciones en producción, recalcula `daily_summary`, repara histórico ni
> toca `att2000`. Es todo diagnóstico de solo lectura.

Este runbook consolida en un solo lugar la correspondencia **gate → herramienta
→ salida esperada → acción si falla**, y cómo correrla de una sola vez.

## Comando único

```bash
cd api
npm run phase-e:preflight -- --from 2025-01-01 --to 2025-12-31
```

`scripts/phase-e-preflight.js` encadena los lectores read-only y emite **un
veredicto**: `GO`, `NO_GO` o `INCOMPLETE`. Falla-cerrado: exit `0` sólo con
`GO`; `1` con `NO_GO` o `INCOMPLETE`. Con `--json` emite el detalle por paso.
Sin `--from`/`--to` el gate de impacto se **omite** y el veredicto es
`INCOMPLETE` (nunca `GO`), porque el impacto es un gate obligatorio.

## Mapa de gates

| # | Gate | Herramienta | Salida esperada (GO) | Si falla |
|---|------|-------------|----------------------|----------|
| 1 | **Esquema no-parcial** | `workday-config-preflight --require-safe` | `gate: GO` o `SAFE_DEGRADED` (exit 0) | `NO_GO_PARTIAL` (exit 1): la tabla de historial existe pero el esquema está a medias. **No** habilitar nada; completar la migración del set 072→075 en un entorno autorizado y volver a correr. |
| 2 | **Migraciones** | `migrate --status` | Lista read-only del estado; sin pendientes que bloqueen | Estrictamente read-only (`--status` no crea `schema_migrations`). Si faltan migraciones, aplicarlas en el orden y entorno autorizados — nunca desde este runbook. |
| 3 | **Deriva de esquema** | `check-schema-drift` | Sin columnas críticas faltantes (incl. perfil 073 de `employee_schedule_history`) | Una columna 073 ausente con la tabla presente = 073 parcial peligroso → mismo tratamiento que gate 1. |
| 4 | **Impacto sobre `daily_summary`** | `workday-config-impact-audit --require-no-impact --from --to` | `0` jornadas cambian entre resolución fallback vs. configurada (exit 0) | Impacto detectado (exit 1): hay diferencias reales; revisar el detalle antes de habilitar el writer. NO es GO. |

### Estados degradados: seguro vs. peligroso

- **SAFE_DEGRADED** — `employee_schedule_history` **ausente por completo**: el
  motor cae a `historical_fallback` **por diseño**. Es seguro; no bloquea.
- **NO_GO_PARTIAL** — la tabla **existe** pero el esquema está a medias (falta
  alguna columna 072/073/075, o el ENUM 074). **No** degrada: propaga error en
  runtime. Es el estado peligroso que el gate 1 y el gate 3 atrapan.

## Qué NO hace este runbook (gates que siguen cerrados)

- No activa `WORKDAY_CONFIG_WRITE_ENABLED`, `WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED`
  ni `WORKDAY_ENGINE_STATUS_074_ENABLED` (todos fail-closed: sólo el string
  exacto `"true"` habilita; ver `summaryWriteFlagFailClosed.test.js`).
- No corre migraciones en producción, no recalcula `daily_summary`, no repara
  histórico, no escribe en `att2000` (READ-ONLY).

Un veredicto `GO` **habilita la decisión** de avanzar bajo autorización humana;
no ejecuta ninguna de esas acciones por sí mismo.

## Referencias

- `docs/workday-engine-rollout-status.md` — estado del rollout y gates.
- `docs/deployment-checklist.md`, `docs/historical-2025-readiness.md`,
  `docs/daily-summary-writers.md` — contexto de cada gate.
- Tests: `workdayConfigPreflight.test.js` (gate tri-estado),
  `phaseEPreflightWrapper.test.js` (veredicto), `phaseEScriptsReadonly.test.js`
  (guard read-only), `summaryWriteFlagFailClosed.test.js` (flags fail-closed),
  `checkSchemaDriftFaseC.test.js` (deriva FASE C).
