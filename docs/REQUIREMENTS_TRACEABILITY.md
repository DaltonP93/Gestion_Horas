# Matriz de trazabilidad de requisitos — SisHoras

> **Actualizado:** 2026-09-06 · Fuente: auditoría funcional (Agente 1) sobre `main @ 078cd67`.
> Formato: `Requisito | Estado | Evidencia | Faltante | Criterio de aceptación`.
> Estados: ver `IMPLEMENTATION_STATUS.md`.

## Asistencia y motor de jornada

| Requisito | Estado | Evidencia | Faltante | Criterio de aceptación |
|---|---|---|---|---|
| Marcaciones entrada/salida | MERGED_VERIFIED | `api/src/routes/me.js`, `attendanceController.js` | — | Marcaciones I/O persistidas |
| Jornal diario (`daily_summary`) | MERGED_VERIFIED | escrito por `legacyRecalcDailySummary`; leído en `reports.js`, `me.js` | — | Escritor legacy; motor OFF |
| Total mensual correcto (nocturno) | PARTIAL → **OPEN_PR** #196 | `reports.js` `SUM(daily_summary)` legacy | Motor no alimenta mensual en main | Mensual coincide con Marcadas |
| Nocturno cruza medianoche | PARTIAL (solo Marcadas OK) → #196/#204/#205 | `workdayEngine` vía `scheduler.js`; resto lee legacy | Motor no conectado a lecturas en main | Jornada nocturna atribuida a un solo día en todas las pantallas |
| Zonas horarias (Asunción) | MERGED_VERIFIED | motor sin `Intl`; `docs/motor-jornada.md` | — | Inmune a `hourCycle` |
| Historial de asistencia | MERGED_VERIFIED | `me.js`, `mi-asistencia/page.tsx` | — | Historial por empleado |

## Configuración de horarios (3 niveles pedidos)

| Requisito | Estado | Evidencia | Faltante | Criterio |
|---|---|---|---|---|
| Por empleado (turnera + vigencias) | PARTIAL (gateado) | `routes/workdayConfiguration.js`, `services/workdayConfig.js` | Migraciones 072/073/075 no aplicadas; writer OFF | Config por empleado con efecto real |
| Por departamento | **NOT_PRESENT** | sin ruta/columna | Todo el nivel | Default de jornada por depto |
| General (jerárquico) | PARTIAL | `settings.js`, catálogo `schedules.js` | Nivel "general" jerárquico | Fallback general de jornada |
| Gate de escritura de config | MERGED_VERIFIED | `workdayConfigurationService.js` `WORKDAY_CONFIG_WRITE_ENABLED` | — | Fail-closed OFF |

## Reportes y firma

| Requisito | Estado | Evidencia | Faltante | Criterio |
|---|---|---|---|---|
| Marcadas (PDF ZKTeco) | MERGED_VERIFIED | `reports.js`, `marcadasPdf.js`, `scheduler.js` | — | PDF con motor correcto |
| Mensual export xlsx/pdf | MERGED_VERIFIED | `reports.js` planilla | — | Export operativo (datos legacy) |
| Semanal | PARTIAL → #188 | `reports.js` JSON | Export CSV en PR | Paridad con mensual |
| Aprobación multinivel del reporte | **OPEN_PR** #198/#199 | ausente en main | Workflow coord→gerente→RR.HH. | Estados y firma por nivel |
| Firma del reporte | SIMULATED_ONLY → #198/#201/#203 | `reports.js` firma=imagen+nombre | Hash de integridad / PAdES | Firma verificable |

## Nómina / recibo

| Requisito | Estado | Evidencia | Faltante | Criterio |
|---|---|---|---|---|
| Sueldo base + tipo | MERGED_VERIFIED | `employees.salary_base`, `pay_type`, `payroll.js` | — | Carga de sueldo |
| Liquidación | MERGED_VERIFIED | `services/liquidacion.js` | — | Cálculo con extras/nocturno/aguinaldo |
| Export planilla IPS/aportes | MERGED_VERIFIED | `payroll.js /export`, `/ips-aportes` | — | Planilla IPS xlsx |
| Export planilla de horas + API | **OPEN_PR** #200 | no en main | CSV/XLSX/JSON + API | Export multi-formato + API |
| Recibo self-service | **OPEN_PR** #197 | no en main | Recibo individual | Empleado ve su recibo |
| Integración externa | PARTIAL | `webhooks.js`, `integration.js`, `docs/ORACLE-APEX-INTEGRATION.md` | Nómina externa (#200) | Webhooks genéricos OK |

## Multiempresa / RBAC / usuarios

| Requisito | Estado | Evidencia | Faltante | Criterio |
|---|---|---|---|---|
| Multiempresa (company_id) | **NOT_PRESENT** | sin `company_id` en DB/api | Aislamiento por empresa | **Decisión: ¿es requisito?** |
| Multi-sede (branches) | MERGED_VERIFIED (dato) / PARTIAL (aislamiento) | `routes/branches.js`, `employees.branch_id` | Scope no aísla por sede | Sedes como dato; scope por depto |
| RBAC por departamento | MERGED_VERIFIED | `services/departmentScope.js` (CTE recursiva) | Cobertura no universal | Rol scoped ve su depto+descendientes, fail-closed |
| Endurecimiento por-empleado | **OPEN_PR** #192 | `canSeeEmployee`; `enforceEmployeeScope` en PR | Middleware transversal | Out-of-scope → 404/403 |
| Roles + permisos granulares | MERGED_VERIFIED | `middleware/auth.js` `requirePermission` | — | view/create/update/delete por módulo |
| Usuarios + 2FA | MERGED_VERIFIED | `routes/users.js`, `twofaController.js`, `totp.js` | — | CRUD + TOTP + refresh |

## Otros

| Requisito | Estado | Evidencia | Faltante | Criterio |
|---|---|---|---|---|
| att2000 read-only | MERGED_VERIFIED | `config/att2000.js`, `att2000Readonly.test.js` | — | Sin writers |
| i18n (es/en/pt) | PARTIAL | `web/src/i18n/` adoptado en ~7/72 páginas | Adopción masiva | Páginas clave traducidas |
| Consistencia front/back | PARTIAL | mayoría consistente | Features Draft agregan UI faltante | Sin botones sin backend en main |
| **Control de acceso físico** | **NOT_PRESENT** | ver `HARDWARE_STATUS.md` | Todo el dominio | Fuera de alcance del producto |
