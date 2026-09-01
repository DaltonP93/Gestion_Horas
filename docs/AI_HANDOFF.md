# AI handoff — Gestion_Horas

> **Actualizado:** 2026-09-01  
> **Baseline confirmado:** `main@53fee693e46b9a5b2a27de848fa2e3974bac55d5`  
> **Regla de lectura:** leer primero `CLAUDE.md` y el código de los módulos afectados. Este documento reúne contexto operativo sin sustituir la verificación del estado actual.

## Propósito del producto

Gestion_Horas (SisHoras) es el reemplazo web del sistema legado de asistencia. Integra relojes biométricos ZKTeco, asistencia, turnos, permisos, vacaciones, horas extra, reportes, analítica y configuraciones de recursos humanos.

La fuente SQL Server `att2000` es un origen de marcaciones: el sistema puede leerla y sincronizar hacia su propia base de asistencia, pero no debe escribir en ella.

## Arquitectura confirmada

| Componente | Responsabilidad |
| --- | --- |
| `api/` | Node.js + Express, API REST, JWT y Socket.io |
| `web/` | Next.js 14, interfaz administrativa |
| `analytics/` | FastAPI/Python para analítica y reportes |
| `bridge/` | Integración ZKTeco / recepción de marcaciones |
| MySQL | Base principal de `asistencia` |
| SQL Server `att2000` | Fuente externa, **estrictamente de solo lectura** |
| Redis | Cache y tiempo real |
| PM2 | Gestión de procesos fuera de este repositorio |

## Reglas no negociables de datos

- Nunca ejecutar `INSERT`, `UPDATE`, `DELETE`, migraciones ni operaciones administrativas sobre `att2000`.
- Usar las variables `ATT_*` documentadas para la fuente read-only; no reintroducir el antiguo mecanismo de escritura.
- No fabricar entradas, salidas, ausencias, horas trabajadas ni estados de asistencia.
- Conservar las marcaciones crudas y aplicar correcciones o interpretaciones solamente con evidencia, trazabilidad y una regla aprobada.
- Los cambios de configuración de jornada deben respetar el histórico: no recalcular ni sobrescribir períodos cerrados sin aprobación explícita.
- No afirmar cumplimiento legal/laboral sin una fuente normativa oficial, revisión humana y pruebas específicas.
- Nunca exponer credenciales, hosts, IPs, datos de empleados, biometría, marcaciones ni otra PII en commits, documentación, logs o conversaciones.

## Estado confirmado al 2026-09-01

- `main` está en `53fee693e46b9a5b2a27de848fa2e3974bac55d5`, merge del PR #155 (kill switch fail-closed de escritura de configuración laboral).
- Orden de merges posterior a #152, todos ya fusionados en `main`: #156 (este AI handoff), #153 (runbook post-merge), #154 (`migrate --status` estrictamente read-only) y #155 (kill switch de escritura).
- No hay PR abiertos al momento de esta actualización.
- CI de `main` sobre el HEAD actual (workflow `CI`, run #548): API, Web y Bridge en verde (`success`).
- Un CI verde y estos merges NO autorizan por sí solos un despliegue, una migración ni la activación de writers: FASE E sigue pendiente y con gates abiertos (ver `docs/workday-engine-rollout-status.md`).

## Operación y límites

- No ejecutar `git pull`, `pm2 reload`, reinicios, migraciones, cambios de servicio, despliegues ni cambios en producción sin autorización expresa.
- No ejecutar scripts de sincronización ni procesos que afecten datos reales fuera de un entorno autorizado.
- Si una tarea requiere una revisión de datos reales, solicitar un alcance acotado y trabajar con la menor información necesaria.
- Mantener el nombre y formato de variables de entorno fuera de git; no agregar secretos a ejemplos ni documentación.

## Flujo de trabajo recomendado

1. Confirmar objetivo, entorno y rama; revisar `git status`, HEAD, PR asociado y archivos afectados.
2. Leer las rutas relevantes y tests existentes antes de editar.
3. Hacer cambios mínimos, reversibles y con trazabilidad.
4. Para cambios de asistencia, sincronización o jornada, identificar explícitamente: fuente de datos, transformación, período afectado, invariantes y estrategia de rollback.
5. Ejecutar pruebas locales y checks del componente afectado; registrar solo resultados realmente obtenidos.
6. Actualizar este handoff en el mismo PR cuando cambie el alcance, riesgo operativo, pruebas o estado de GO/NO-GO.
7. Escalar en lugar de adivinar cuando falte evidencia de reglas de negocio, datos históricos o autorización operativa.

## Inicio seguro para una conversación de desarrollo

> “Lee `CLAUDE.md` y `docs/AI_HANDOFF.md`; confirma el SHA actual y los PR abiertos. Resume riesgos para datos de asistencia y `att2000`, y propone un plan y pruebas antes de cambiar archivos.”

## Referencias

- `CLAUDE.md`: arquitectura, módulos y comandos de desarrollo.
- `README.md`: arranque local y composición general.
- Código y tests de cada módulo: fuente de verdad para comportamiento actual.
