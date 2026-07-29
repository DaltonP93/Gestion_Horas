# Estabilidad de memoria del worker de sincronización

## Incidente

Tras un ciclo largo de Comedor (~82.000 registros en el buffer del reloj, lectura
con varios intentos), PM2 reinició el worker por exceder el límite de memoria:

```
[PM2][WORKER] Process restarted because it exceeds --max-memory-restart value
current_memory=269832192  max_memory_limit=268435456   (≈ 257 MB > 256 MB)
```

No fue OOM del kernel (`journalctl` no mostró `Out of memory` ni `Killed process`).
Fue el `max_memory_restart: '256M'` de `sishoras-sync-worker`. El worker se
reinició limpio: sin jobs ni `device_locks` huérfanos, idempotencia intacta.

## Causa

Dos factores sumaban RSS durante la lectura:

1. **Retención de TODOS los intentos.** `readAttendancesStable` guardaba el
   arreglo completo de marcas (`logs`) de **cada** intento en `reads[]` y recién
   al final elegía el mejor. Con ~82k registros × varios intentos, se mantenían
   varias copias completas vivas a la vez.
2. **Copias grandes simultáneas** en `_backupDeviceDirectImpl`: `rawLogs`
   (crudo), `logs` (filtrado) y `norm` (normalizado) coexistían aunque, una vez
   armado `punches` (sólo las marcas EN RANGO), los arreglos completos ya no se
   necesitaban.

## Cambios

- **Retener sólo la mejor lectura.** `readAttendancesStable` compara cada intento
  contra el mejor hasta el momento y **descarta el perdedor** (su `logs` queda
  fuera de alcance al terminar la iteración). Se conserva sólo metadata liviana
  por intento (`detail`, `valids`). Resultado funcional idéntico.
- **Liberar copias grandes en cuanto no se usan:** se sueltan `rawLogs`/`logs`/
  `norm` (y `stable.logs`) una vez armado `punches`.
- **Instrumentación de memoria por fase** (`[sync] mem=…`): `read_physical:start`,
  `read_attempt` (por intento), `decode`, `persist_raw`, `in_range_ready`,
  `release_device_lock`, `finish`. Registra `rss/heapUsed/heapTotal/external/
  arrayBuffers` + `device`/`run`/`records`/`attempt`. Sólo números — nunca datos
  biométricos ni credenciales.
- **`ecosystem.config.js`:** `sishoras-sync-worker` sube `max_memory_restart` de
  `256M` a **`512M`** (sólo ese proceso). No se cambia ningún otro límite.
  `max_memory_restart` es un **umbral de reinicio de PM2, no memoria reservada**:
  el proceso usa lo que necesita (normalmente ~110–160 MiB) y PM2 lo reinicia
  sólo si el RSS supera ese valor. No preasigna 512 MiB.
- **No** se usa `global.gc` ni `--expose-gc` como solución; el arreglo es reducir
  el pico real de retención.

Se mantiene: un solo worker, locks por reloj, idempotencia, retry de deadlock, y
la configuración actual de Gerencia/Comedor. **Lavadero sigue desactivado.**

## Antes de aplicar en producción

Verificar que haya memoria disponible suficiente para el nuevo límite:

```bash
free -h
```

Debe haber holgura para que `sishoras-sync-worker` pueda usar hasta ~512 MB sin
presionar al resto de los procesos (API, web, bridge, analytics).

## Despliegue — subir el límite sin perder `ZKTECO_AUTO_POLL=true`

`max_memory_restart` es config de PM2: para que tome efecto hay que **recrear**
el proceso (un `reload` normal no cambia los límites del runtime). Preservando el
kill switch en producción:

```bash
git pull origin main

# Recrear SOLO el worker con el nuevo límite, manteniendo el entorno actual
# (incluye ZKTECO_AUTO_POLL=true si ya está exportado en el entorno).
cd /var/www/html/Gestion_Horas
ZKTECO_AUTO_POLL=true pm2 startOrReload ecosystem.config.js --only sishoras-sync-worker --update-env

# Verificar que el límite y el kill switch quedaron bien:
pm2 describe sishoras-sync-worker | grep -E "max_memory_restart|ZKTECO_AUTO_POLL"
```

> Si `ZKTECO_AUTO_POLL` ya está definido en el entorno del shell/servicio, basta
> `pm2 startOrReload ecosystem.config.js --only sishoras-sync-worker --update-env`.
> El `startOrReload` recrea el proceso (aplica el nuevo `max_memory_restart`) sin
> tocar los demás. **No** usar `pm2 delete` + `start` para no perder historial;
> `startOrReload` es suficiente.

Alternativa equivalente si se prefiere reinicio explícito del worker:

```bash
pm2 reload ecosystem.config.js --only sishoras-sync-worker --update-env
# y si el límite no se actualizó (PM2 lo cachea), recrear ese proceso:
pm2 startOrReload ecosystem.config.js --only sishoras-sync-worker --update-env
```

No requiere migraciones. No reinicia API, web, bridge ni analytics.

## Validación posterior

- Observar en los logs del worker las líneas `[sync] mem=…` durante un ciclo de
  Comedor: el `rss` debe mantenerse por debajo de 512 MB y **bajar** tras
  `in_range_ready`/`finish` (se liberaron los buffers).
- Confirmar que ya no aparece el reinicio por `max_memory_restart`.
- Comedor y Gerencia siguen avanzando `next_auto_sync_at`; sin jobs
  `queued/running` colgados ni `device_locks` huérfanos.
