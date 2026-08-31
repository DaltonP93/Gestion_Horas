# Readiness histórico 2025 — Marcadas antes de configuración completa

## Objetivo

Poder consultar y procesar correctamente Marcadas 2025 aunque RR.HH. todavía
no haya configurado a todos los empleados.

La configuración laboral nueva es opt-in por empleado y vigencia. La ausencia
de snapshot NO impide reconstruir jornadas observadas desde attendance_logs.

## Invariante

Sin snapshot histórico completo y vigente para employee + fecha:

- calculation_mode = historical_fallback;
- Turnera/contrato/schedule actual NO activan configured;
- no se calcula atraso esperado;
- no se inventa ausencia;
- no se inventa objetivo semanal;
- no se cambia attendance_logs.

## Capas independientes

### A. Motor

WorkdayEngine reconstruye:

- IN/OUT;
- cruces de medianoche;
- múltiples segmentos;
- jornadas abiertas;
- huérfanos/anomalías;
- wall-clock.

### B. Datos históricos

Un motor correcto no puede corregir una hora que todavía esté desplazada en
attendance_logs. La reparación de source=device sigue siendo otro procedimiento
contra ATT2000 READ-ONLY.

Estado operativo conocido al cierre de FASE A/B:

- 2022-06 → 2024: reparación histórica completada;
- enero 2025: completado;
- febrero 2025 en adelante: pendiente de reanudación controlada.

## Gate 1 — impacto de configuración (READ-ONLY)

Antes de tocar configuraciones:

```bash
cd /var/www/html/Gestion_Horas/api

node scripts/workday-config-impact-audit.js \
  --from 2025-01-01 \
  --to 2025-12-31 \
  --require-no-impact
```

En una instalación todavía no parametrizada el resultado esperado es:

- configured = 0;
- changed_by_configuration = 0;
- historical_fallback para las jornadas observadas.

Si cambia algo, detener y revisar qué snapshot/Turnera está activando cálculo.

## Gate 2 — motor vs legacy (READ-ONLY)

```bash
node scripts/workday-engine-audit.js \
  --from 2025-01-01 \
  --to 2025-01-31 \
  --out /tmp/workday-audit-2025-01
```

Enero 2025 es el baseline preferido porque sus timestamps source=device ya
fueron reparados.

Revisar especialmente:

- turno_nocturno;
- emparejamiento;
- boundary de mes;
- categoría otro.

La categoría otro con volumen significativo es NO-GO.

## Gate 3 — febrero 2025

Sólo después de que enero cierre:

1. ejecutar dry-run de la reparación histórica para febrero;
2. MATCH_180/MATCH_240 son los únicos candidatos aplicables;
3. NO_MATCH/AMBIGUOUS/COLLISION quedan sin tocar;
4. verificar manifiesto e idempotencia;
5. recién con autorización explícita ejecutar apply del mes;
6. volver a correr Marcadas/auditor de febrero.

No mezclar este apply con migraciones de configuración laboral.

## Progresión sugerida

- febrero 2025;
- marzo 2025;
- abril 2025;
- continuar por lotes controlados hasta diciembre 2025;
- luego 2026 hasta la última fecha histórica pendiente.

Cada lote debe conservar:

- backup/manifiesto;
- dry-run previo;
- conteos;
- apply controlado;
- dry-run posterior;
- anomalías intactas;
- ATT2000 sin escrituras.

## Configuración progresiva futura

Ejemplo:

- empleado sin snapshot 2025 → historical_fallback;
- snapshot desde 2026-09-01 → 2025 sigue fallback;
- si RR.HH. luego carga una vigencia confiable 2025-01-01..2025-06-30,
  solamente ese rango pasa a configured.

No existe backfill automático de employees.schedule_id.

## daily_summary

No recalcular producción todavía.

Marcadas puede validarse directamente desde attendance_logs + WorkdayEngine.
El recálculo derivado se prepara después de:

1. timestamps históricos reparados;
2. motor validado;
3. configuración histórica cargada sólo donde exista evidencia;
4. dry-run de daily_summary explicado.

## GO para avanzar al recálculo derivado

Se requiere:

- Marcadas 2025 consistente;
- 0 impacto accidental de configuración;
- categoría otro explicada;
- reparación histórica completada en el rango;
- no anomalías nuevas por el proceso;
- plan de rollback.
