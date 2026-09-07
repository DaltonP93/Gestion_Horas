# Historia de desarrollo — SisHoras

> **Actualizado:** 2026-09-06 · Resumen de continuidad (no es transcripción de chats).
> Para el detalle por PR ver `IMPLEMENTATION_STATUS.md`.

## Hitos en `main`
- Hasta `main @ 078cd67` (merge #157): base de asistencia, motor de jornada presente (activo solo
  en Marcadas), RBAC por departamento, 2FA, nómina base (liquidación + planilla IPS), att2000
  read-only, kill-switches fail-closed de writers (FASE E pendiente).

## Líneas de trabajo abiertas (en PRs Draft, no fusionadas)
1. **FASE F / F+ (#158–#173):** gobierno, personas/candidatos/contratos, calendario versionado,
   nómina sandbox, y UIs asociadas. Cadena apilada; congelada esperando auditoría externa (Codex).
2. **FASE E read-only (#174–#186 selectos):** guards estáticos, gates de preflight, goldens del
   motor y de degradación, drift-checker. Preparan una activación segura, sin activar nada.
3. **Módulos / export CSV (#177–#188):** ediciones y exportaciones (marcaciones, vacaciones,
   encuestas, banco de horas, horas extra, reporte semanal).
4. **Infra/seguridad (#189–#195):** CI para ramas claude/**, job de migraciones MySQL efímero,
   endurecimiento authz + auditoría sin PII + fix de inyección att2000, fix de build web, saneo de dominio.
5. **Funcional nocturno/nómina/firma (#196–#205):**
   - Nocturno por el motor en lecturas: mensual (#196), semanal/diario/analítica (#204), self-service (#205).
   - Aprobación multinivel + firma con hash (#198/#199); firma PAdES local (#201) + scaffolding de despliegue (#203).
   - Recibo self-service (#197); export de planilla de horas + API (#200).
   - Consola de activación FASE E con doble compuerta (#202).

## Decisiones de continuidad tomadas por el líder (2026-09-06)
- Cancelado el trigger de heartbeat recurrente (no se programan chequeos horarios).
- Estrategia nocturna: corregir **lecturas** por el motor sin tocar `daily_summary` (reversible,
  sin FASE E); la reescritura de `daily_summary` queda gateada y pendiente de autorización.
- Reconciliado el alcance: el producto es asistencia/RR.HH.; el control de acceso físico es NOT_PRESENT.

## Qué debe hacer el próximo agente
Ver `AI_HANDOFF.md` §13 (primera tarea recomendada) y `IMPLEMENTATION_STATUS.md` (backlog).
No fusionar ni desplegar sin autorización.
