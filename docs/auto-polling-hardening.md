# Endurecimiento del auto-polling — despliegue y rollback

Este documento cubre el PR de endurecimiento del worker de sincronización de
relojes ZKTeco: lock distribuido por reloj, cola de trabajos manuales asíncronos,
scheduling inmediato, estados de UI y kill switch.

> **No activa nada.** `ZKTECO_AUTO_POLL` sigue en `false` y `auto_sync_enabled`
> sigue en `0`. Este PR sólo endurece; la activación es un paso posterior manual.

## Qué cambia

- **Lock por reloj** (`device_locks` / Redis): ninguna lectura de un mismo reloj
  puede superponerse, sin importar el origen (worker, "sincronizar ahora",
  lectura por rango, endpoint individual, `backup-all`, scripts). Todos pasan por
  `backupDeviceDirect`, que adquiere/renueva/libera el lock. Si el reloj está
  ocupado, la respuesta es `409 { busy: true }`.
- **Cola de trabajos** (`sync_jobs`): las lecturas manuales se **encolan** (la API
  responde `202` + `job_id`) y las procesa el worker sin mantener la petición HTTP
  abierta. Estados: `queued → running → success | partial | error | cancelled`.
- **Worker**: drena la cola SIEMPRE (los trabajos manuales son acciones humanas,
  no dependen del kill switch) y ejecuta el auto-polling sólo si el kill switch lo
  permite. Escribe heartbeat y estado del kill switch en cada tick.
- **Scheduling inmediato**: al activar el master o un reloj, `next_auto_sync_at` se
  calcula de una vez (sin quedar en `NULL`), respetando el offset.
- **Estados de UI**: worker sin señal / bloqueado por entorno / master apagado /
  fuera de horario / habilitado; trabajo en curso y cancelación por reloj.

## Semántica del kill switch

- `ZKTECO_AUTO_POLL=false` → **bloquea el auto-polling** de forma absoluta (aunque
  la base diga activado). Los **trabajos manuales** SÍ se procesan.
- `ZKTECO_AUTO_POLL=true` → la base decide (master global + ventana + config por
  reloj).
- El heartbeat se actualiza SIEMPRE, incluso con el kill switch en `false`.

## Despliegue

```bash
# 1) Traer el código
git pull origin main

# 2) Migración (idempotente y aditiva): crea device_locks + sync_jobs
cd api && npm run migrate && cd ..

# 3) Build del front
cd web && npm run build && cd ..

# 4) Recargar procesos. El worker sigue BLOQUEADO (ZKTECO_AUTO_POLL=false).
pm2 reload ecosystem.config.js --update-env
pm2 status
```

Verificaciones post-deploy (sin activar nada):
- `sishoras-sync-worker` en `online`.
- En Configuración → Relojes, el panel muestra el worker vivo pero **bloqueado
  por entorno** (kill switch) y el master apagado.
- "Sincronizar ahora" de un reloj encola un trabajo y muestra progreso; una
  segunda lectura concurrente del mismo reloj queda bloqueada por el lock.

## Rollback

El PR es aditivo (columnas/tablas nuevas + código nuevo); no altera datos
existentes. Para revertir:

```bash
# Revertir el código al commit anterior al merge de este PR
git revert <merge_commit>            # o git checkout <commit_previo>
cd web && npm run build && cd ..
pm2 reload ecosystem.config.js --update-env
```

Las tablas `device_locks` y `sync_jobs` pueden quedar sin uso sin efectos
secundarios. Si se desea limpiarlas (opcional, no requerido):

```sql
DROP TABLE IF EXISTS sync_jobs;
DROP TABLE IF EXISTS device_locks;
```

No hay cambios destructivos que deshacer: ninguna columna existente se modificó ni
se borró.

## Activación posterior (fuera de este PR)

Cuando se decida activar el auto-polling, hacerlo por etapas
(Gerencia → Comedor → Lavadero), poniendo `ZKTECO_AUTO_POLL=true` y activando el
master + relojes desde Configuración → Relojes, validando cada etapa durante una
jornada. Ver el plan de activación progresiva acordado con el equipo.
