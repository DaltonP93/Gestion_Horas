# Evidencia de pruebas — SisHoras

> **Actualizado:** 2026-09-06 · Sólo resultados realmente observados. No se inventan resultados.

## CI en `main` (`.github/workflows/ci.yml`)
- Jobs: **API** (`node --check` + `npm test`), **Web** (`npm test` + `next build`), **Bridge**
  (`npm test`) — cada uno en **3 zonas horarias**: `UTC`, `America/Asuncion`, `Asia/Tokyo`.
- **No hay** job de Analytics (Python) ni de migraciones contra MySQL efímero ni build Docker en `main`.
- Dispara sólo con base `main` (los PR encadenados sobre `claude/*` no reciben CI hasta mergear su base).

## Cobertura de pruebas presente (unitaria/integración, jest / node:test)
- Bridge: tests de transporte/registro/shadow en 3 TZ (`shadow.test.js`, `deviceRegistry.test.js`, …).
- API: motor de jornada y helpers (`workdayEngine.test.js`, `dailySummaryEngine.test.js`,
  `monthlyWorkedFromEngine.test.js`, `bulkRecalcEngine.test.js`), scope de departamento,
  att2000 read-only (`att2000Readonly.test.js`).
- att2000: test estático de solo-lectura sobre el conector.

## Evidencia por PR abierto (pruebas locales del autor; no implican revisión/merge)
| PR | Evidencia declarada |
|---|---|
| #192 | tests de authz por alcance + auditoría sin PII + fix inyección (locales) |
| #194 | CI verde incl. job migraciones MySQL efímero (en la rama) |
| #196 | tests del motor mensual, 3 TZ (locales) |
| #201 | `padesSigner.test.js` + `monthlyApprovalsPades.test.js` (21 verdes locales) |
| #204 | `reportsWorkedEngine.test.js` (5) + suite motor (155 verdes locales) |
| #205 | `workedReads.test.js` (9) + suite (18 verdes locales) |

## Huecos de evidencia (a cerrar)
- Sin E2E de flujos críticos (login→reporte→export→firma).
- Sin pruebas negativas/adversariales de seguridad (ver `SECURITY.md` §pruebas recomendadas).
- Sin prueba de migraciones up/down (no hay `down`).
- Sin prueba de backup→restore.
- Sin job de CI para Analytics/Python.

> Regla: al agregar código, agregar sus tests y registrar aquí la evidencia real (no estimada).
