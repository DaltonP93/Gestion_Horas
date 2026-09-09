# Backup y restauración — SisHoras

> **Actualizado:** 2026-09-06 · Estado real sobre `main @ 078cd67`. Read-only audit.

## Estado

| Ítem | Estado | Evidencia |
|---|---|---|
| Script de backup MySQL | Configurado / **no probado end-to-end** | `scripts/backup-mysql.sh` (mysqldump `--single-transaction` + gzip + retención + `gzip -t`) |
| Programación (cron) | Manual (documentado) | instalación de cron es paso manual |
| Restore | **No probado** (procedimiento documentado) | `docs/runbook.md` (`gunzip \| mysql`) |
| RPO / RTO | **No definidos** | — |
| Backup de Redis | NOT_PRESENT | Redis es cache/streams; no hay política de persistencia documentada |
| Backup del outbox del bridge (SQLite) | NOT_PRESENT (durable en disco) | `better-sqlite3` local; sin política de respaldo |

## Riesgos
- Sin restauración probada ni RPO/RTO, no hay garantía de recuperación de la asistencia
  histórica ante una pérdida de la BD.
- El backup depende de cron manual; si no se instala, no hay respaldo.

## Pendiente (P1, requiere entorno real → coordinar con propietario)
- Probar un ciclo backup→restore en un entorno no productivo y registrar RPO/RTO reales.
- Automatizar e idempotentizar el cron de backup y la verificación de integridad.
- Definir política de retención fuera del host (off-site).

> No se ejecuta ni programa ningún backup/restore desde esta auditoría (requiere datos/infra reales y autorización).
