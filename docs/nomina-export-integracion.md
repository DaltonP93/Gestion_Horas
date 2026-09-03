# Export de nómina/asistencia para integración externa

Exporta la planilla mensual de horas/asistencia por empleado en **CSV, XLSX y
JSON**, con un **dataset canónico versionado** para integrar con CUALQUIER
sistema de nómina externo (ERP, Oracle APEX, contabilidad, etc.).

- Servicio: `api/src/services/payrollExport.js`
- Endpoints JWT (interfaz administrativa): `api/src/routes/payroll.js`
- Endpoints API Key (integración externa): `api/src/routes/integration.js`

> **SÓLO LECTURA.** El export no escribe `attendance_logs`, `daily_summary` ni
> ningún flag. `att2000` no interviene.

## Consistencia de las horas trabajadas (motor, nocturno correcto)

Las **horas trabajadas** se calculan con el MOTOR de jornada
(`monthlyWorkedByEmployee`), el mismo camino que usan Marcadas y el reporte
mensual, **no** con `SUM(daily_summary.worked_minutes)`. Por eso un turno
nocturno que cruza medianoche (entra 21:00, sale 06:00) cuenta como **un solo
jornal**, atribuido al día en que empezó, en vez de partirse en dos fechas
civiles.

Los conteos de estado (`dias_trabajados`, `ausencias`), el atraso (`atrasos_min`)
y las horas extra (`minutos_extra`/`horas_extra`) provienen de `daily_summary`,
igual que el reporte mensual.

## Esquema canónico — `schema_version` `"1.0"`

Un objeto por empleado. Orden de columnas estable (idéntico en CSV/XLSX/JSON):

| Campo | Tipo | Unidad | Origen |
| --- | --- | --- | --- |
| `codigo` | string | — | `employees.code` |
| `documento` | string | — | `employees.document_number` (`""` si no hay) |
| `nombre` | string | — | `first_name last_name` |
| `departamento` | string | — | `departments.name` (`""` si no hay) |
| `dias_trabajados` | integer | días | días con estado `present`/`late` |
| `minutos_trabajados` | integer | **minutos** | MOTOR (nocturno correcto) |
| `horas_trabajadas` | number (2 dec) | **horas** | `minutos_trabajados / 60` |
| `minutos_extra` | integer | **minutos** | `SUM(overtime_minutes)` |
| `horas_extra` | number (2 dec) | **horas** | `minutos_extra / 60` |
| `atrasos_min` | integer | **minutos** | `SUM(late_minutes)` |
| `ausencias` | integer | días | días con estado `absent` |
| `salario_base` | number | moneda local | `employees.salary_base` — **sólo con permiso de montos** |

**Unidades — importante para el consumidor:** los campos `minutos_*` y
`atrasos_min` están en **minutos**; los `horas_*` en **horas** (= minutos ÷ 60,
2 decimales). El metadato `units` del JSON describe cada campo presente.

### Metadatos (sólo JSON)

```json
{
  "schema_version": "1.0",
  "generated_at": "2026-04-30T12:00:00.000Z",
  "period": { "year": 2026, "month": 4, "from": "2026-04-01", "to": "2026-04-30" },
  "filters": { "department_id": null },
  "includes_amounts": true,
  "units": { "minutos_trabajados": "minutes", "horas_trabajadas": "hours (= minutos_trabajados / 60, 2 decimals)", "...": "..." },
  "columns": ["codigo", "documento", "nombre", "..."],
  "count": 1,
  "rows": [ { "codigo": "007", "...": "..." } ]
}
```

CSV/XLSX contienen sólo el encabezado y las filas (mismos `columns` y valores).
El CSV es **RFC-4180**: separador **coma**, terminador **CRLF**, con **BOM
UTF-8** al inicio. Todas las respuestas llevan el header `X-Schema-Version`.

## Endpoints

### Vía JWT (interfaz administrativa)

Requiere rol `admin` / `hr` / `gth` (`super_admin` bypass) **y** permiso
`nomina.view`. El token puede ir en `Authorization: Bearer <jwt>` o, para
descargas por `window.open`/`<a href>`, como `?access_token=<jwt>` (sólo GET).

```
GET /api/payroll/export.csv?year=&month=&department_id=
GET /api/payroll/export.xlsx?year=&month=&department_id=
GET /api/payroll/export.json?year=&month=&department_id=
```

Parámetros (todos opcionales; por defecto el mes actual):
`year`, `month` (1–12), `department_id`.

> No se agregó un alias `GET /api/payroll/export?format=…` porque `/export` ya
> está tomado por el export contable **SAA** existente. La negociación de formato
> se hace por extensión (`.csv` / `.xlsx` / `.json`).

### Vía API Key (integración con sistemas externos)

Para ERP/APEX/nómina sin usuario JWT. Header `X-API-Key: <INTEGRATION_API_KEY>`.

```
GET /api/integration/payroll/export.json?year=&month=&department_id=
GET /api/integration/payroll/export.csv?year=&month=&department_id=
GET /api/integration/payroll/export.xlsx?year=&month=&department_id=
```

> La vía API Key **nunca** incluye `salario_base` (`includes_amounts: false`):
> expone sólo identificadores + horas/asistencia, que es lo esencial para
> integrar nómina. Para montos, usar la vía JWT con un rol autorizado.

## RBAC de montos (`salario_base`)

- El **acceso** al export (horas/asistencia + identificadores) requiere rol
  `admin`/`hr`/`gth` (+`super_admin`) y `nomina.view`. Un rol fuera de ese
  conjunto recibe **403**.
- Los **montos** (`salario_base`) se acotan aún más: sólo `super_admin`,
  `admin` y `hr`. El rol `gth` obtiene la planilla de horas/asistencia pero
  **sin salarios**. Cuando no hay autorización de montos, la columna
  `salario_base` se omite en el dataset y por lo tanto en CSV, XLSX y JSON
  (`includes_amounts: false`).

## Ejemplos

```bash
# JSON con JWT (incluye montos si el rol está autorizado)
curl -H "Authorization: Bearer $JWT" \
  "https://<host>/api/payroll/export.json?year=2026&month=4"

# CSV con JWT
curl -OJ -H "Authorization: Bearer $JWT" \
  "https://<host>/api/payroll/export.csv?year=2026&month=4&department_id=3"

# JSON para un sistema externo con API Key (sin montos)
curl -H "X-API-Key: $INTEGRATION_API_KEY" \
  "https://<host>/api/integration/payroll/export.json?year=2026&month=4"
```

`INTEGRATION_API_KEY` es un secreto del entorno; no se versiona en el repo.
