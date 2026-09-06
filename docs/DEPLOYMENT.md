# Despliegue e infraestructura — SisHoras

> **Actualizado:** 2026-09-06 · Fuente: auditoría DevOps (Agente 2) sobre `main @ 078cd67`, read-only.
> Estados: {Configurado, Probado local, Probado en CI, Simulado, No probado, Bloqueado, NOT_PRESENT}.

## Componentes e infraestructura

| Ítem | Estado | Evidencia / Observación |
|---|---|---|
| Dockerfiles (api/web/bridge/analytics) | Configurado, no probado en CI | existen los 4; web multi-stage `output: standalone` |
| `docker-compose.yml` (prod) | **Configurado (roto)** | monta `./nginx/` inexistente (nginx real en `deploy/nginx-sishoras.conf`) → nginx fallaría |
| `docker-compose.dev.yml` | Configurado | MySQL+Redis dev; passwords dev en claro; MySQL en 0.0.0.0 |
| BD | MySQL 8 (confirmado) | `mysql2`, `pymysql`; **no hay PostgreSQL**; `mssql` solo att2000 RO |
| Redis | Configurado / probado local | pub/sub (`attendance:new`, `device:status`…), cache, streams opcionales (`ATTENDANCE_STREAM_ENABLED` off) |
| Migraciones runner | Configurado | `api/scripts/migrate.js`, tabla `schema_migrations`, `--status` read-only, **sin down**, no transaccional |
| Migraciones cadena | Configurado (huecos) | `002`→`075`; faltan `001` (lo cubre `init.sql`) y `058` (hueco) |
| Migraciones en prod | Bloqueado / no verificable | 072–075 (FASE C/E) NO-GO hasta backup+auditoría |
| `.env.example` (4 comp.) | Configurado | placeholders; `${VAR:?}` fail-closed en compose |
| Secretos | Configurado | 0 `.env` reales en git; validación prod (JWT ≥32); secreto histórico de analytics ya removido |
| Menor: IPs LAN / dominio en repo | Observación | `.env.example` (IPs), `deploy/nginx-sishoras.conf` (dominio) |
| Reverse proxy / TLS | Configurado / no probado | nginx TLS1.2/1.3, HSTS; Let's Encrypt manual (arranca autofirmado) |
| Health checks | Configurado / probado local | `/api/health`, `/health`, bridge `/push-state`; **compose solo MySQL tiene healthcheck** |
| CI jobs | Probado en CI | `ci.yml`: bridge/api/web en 3 TZ; **sin Analytics, sin migraciones MySQL, sin build Docker** |
| CI triggers | Configurado (limitado) | solo base `main`; PR claude/** contra main sí; push a claude/** no. #190 (trigger) no en main |
| Job migraciones MySQL efímero | En PR #194 (no en main) | agrega `log_bin_trust_function_creators=1` + apply |
| Logs | Configurado | PM2 error/out por proceso; logrotate manual (`scripts/setup-logrotate.sh`) |
| Métricas/alertas | No probado / manual | sin Prometheus/Grafana; umbrales sólo documentados |
| Escalamiento | NOT_PRESENT (single-instance) | PM2 `fork`, `instances:1`; sync-worker único (`ZKTECO_AUTO_POLL=false`) |
| Colas | Parcial | Redis Streams + `sync_locks_jobs` + outbox SQLite (bridge) |
| Bridge/gateway ZKTeco | Configurado / documentado | `docs/zkteco-push-setup.md`, `start-system.bat` (Win), PM2 (Linux); PUSH/ADMS |
| Recuperación bridge | Configurado / probado local | outbox + streams + shadow/observe mode; recovery = `pm2 restart` |

## Riesgos DevOps priorizados
1. CI no cubre migraciones ni Analytics (regresiones de esquema/Python llegan a main).
2. `docker-compose.yml` prod roto (nginx); camino Docker no probado end-to-end.
3. Migraciones no transaccionales, sin rollback; estado parcial posible.
4. Imagen API no puede migrar (no copia `scripts/`/`migrations/`, sin cliente `mysql`).
5. TLS/backups/logrotate manuales; restore no probado; RPO/RTO indefinidos.
6. Sin observabilidad/alertas activas.
7. Single-instance en todos los procesos (SPOF).
8. Dependencias con CVEs (`multer 1.x`, `axios 1.6.5`, `python-jose 3.3.0`); sin escaneo automatizado.

## Listo vs no listo para producción
- **Razonablemente listo:** stack de app (PM2) con fail-closed de secretos; CI verde API/Web/Bridge en 3 TZ; gestión de secretos; MySQL+Redis; nginx con buenos headers; runbook del bridge.
- **No listo:** migraciones FASE E (NO-GO); camino Docker; CI incompleto; backups/restore; observabilidad; redundancia; deps con CVE.
- **No comprobable desde el repo:** capacidad real del servidor, estado de migraciones en la BD real, relojes físicos operando. No se afirma nada de eso.
