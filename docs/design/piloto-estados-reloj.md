# Piloto aislado de estados por reloj

> **Estado:** herramienta en PR Draft, apilada sobre #252 (`251d5dd`). **No ejecutada contra relojes
> reales.** Ejecutarla requiere una autorización separada (ver §8). Este documento no autoriza nada.

## 1. Qué hace y qué no hace

`api/scripts/zk-raw-state-pilot.js` lee **una vez** el buffer de marcaciones de **un** reloj ZKTeco y
escribe un JSON con **conteos**: formato del registro, distribución de los bytes crudos
`zkPunchState` / `zkVerify` (#252), capturas ausentes o inválidas, truncamiento e intentos realmente
ejecutados.

**No hace:**
- importar marcaciones, escribir staging (`raw_device_punches`) ni `attendance_logs`;
- recalcular `daily_summary`;
- actualizar `devices` (`last_sync`), ni `device_sync_runs` ni `audit_events`;
- configurar el reloj: sólo envía conectar, liberar buffer, pedir marcaciones y salir;
- interpretar estados como entrada o salida.

**Tener el byte no demuestra qué significa** ni cómo está configurado el equipo (ver
`horas-marcas-sin-tipo.md` §5.1).

## 2. Componentes

| Archivo | Rol |
|---|---|
| `api/scripts/zk-raw-state-pilot.js` | CLI: argumentos, configuración mínima, JSON de salida, código de salida |
| `api/src/services/zkPilot/runPilot.js` | Orquestación: MySQL de solo lectura, lock, intentos, señales, límites |
| `api/src/services/zkPilot/readChild.js` | **Un proceso por intento**: captura, conexión, lectura y agregado |
| `api/src/services/zkPilot/lock.js` | Lock sólo por Redis con la clave compartida, y consulta del lock MySQL |
| `api/src/services/zkPilot/aggregate.js` | Agregado saneado y códigos de error |
| `api/src/services/zkPilot/args.js` | Argumentos, `--env-file` y `.release-commit` |
| `api/src/services/deviceLockKeys.js` | Clave `zk:lock:dev:<id>` y Lua, **compartidos** con `deviceLock.js` |
| `api/src/services/zkRecordShape.js`, `zkClient.js` | Funciones puras y `openZK`, movidas **sin cambios** desde `zktecoReader.js` |

`zktecoReader.js` y `deviceLock.js` reutilizan esos módulos y su comportamiento no cambia: el worker
sigue auditando el lock y cayendo a MySQL si no hay Redis.

## 3. Garantías

**Exclusión con las demás lecturas:**
- Toma `zk:lock:dev:<id>` en Redis (`SET NX PX`); es la misma clave que el worker, las rutas y los
  scripts.
- No usa el helper habitual: **sin** `INSERT` en `audit_events`, **sin** fallback a `device_locks`,
  **sin** `CREATE TABLE`.
- Si Redis no responde, **no lee**.
- Redis libre no prueba que no haya un lock MySQL: un proceso que no alcanzó Redis toma el fallback
  `device_locks`. Por eso el piloto **consulta** (sólo `SELECT`) esa tabla:
  - al tomar el lock;
  - antes de cada intento;
  - en cada renovación.
- Ante un lock vigente o una consulta fallida, aborta.

**Sin escrituras en la base:**
- Usa una conexión propia con `SET SESSION TRANSACTION READ ONLY`.
- Sólo ejecuta `SELECT`: el reloj en `devices` y el lock en `information_schema` / `device_locks`.
- No carga el ORM, `audit.js` ni `zktecoReader.js`; una prueba lo verifica sobre el grafo de módulos.

**Cierre real:**
- Cada intento corre en un **proceso hijo**.
- Si el intento vence, se pierde el lock, llega una señal o se agota la duración total, el hijo se mata
  con `SIGKILL`. El piloto espera su `exit` y el cierre del canal **antes** de reintentar o liberar el
  lock.
- Matar el proceso cierra el socket; un `Promise.race` sólo deja de esperar.
- Si la terminación no se confirma en 10 s, el lock **no** se libera y vence por TTL
  (`cierre_no_confirmado`).

**TTL sin solapamiento:**
- TTL = timeout del intento + 1 s (vida máxima del hijo) + 5 s (margen) + intervalo de renovación.
- El hijo se termina solo al vencer el intento + 1 s.
- Si el proceso principal muere, el hijo detecta el cierre del canal IPC y sale.
- Así el reloj nunca queda en uso cuando el lock vence.

**Captura:**
- El hijo instala `zkRawCapture` **antes** de cargar `node-zklib`.
- Si `node-zklib` ya estaba cargado (captura tardía) o la instalación falló, el hijo responde y termina
  **sin conectar**.

**Salida saneada:**
- Sólo conteos: nada de usuarios, IP, puertos, registros individuales, horas individuales ni mensajes
  de error crudos.
- Por hora del día y por patrón de usuario-día, las celdas con menos de 5 casos salen como `"<5"`.
- Los bytes se declaran **estimados** (`registros × tamaño del formato`), no medidos en la red.

**Riesgos residuales (documentados, no cubiertos):**
- Si Redis queda inaccesible **sólo** para el worker y no para el piloto, el worker podría tomar el
  fallback MySQL entre dos verificaciones del piloto. La ventana de detección es el intervalo de
  renovación.
- El agregado depende de la disposición de pyzk para los formatos (#252). UDP sólo está probado con
  transporte simulado en proceso, no por la red.

## 4. Salida

**Formato:** `sishoras.zk-raw-state-pilot/1`. Campos principales:
- `resultado`, `codigo_salida`, `senal`.
- `herramienta`: `commit`, `origen_commit` (`release-commit`, `git`, `desconocido`), versión de
  `node-zklib` y de Node.
- `reloj.id` y `reloj.modo_conexion`. No se informan IP ni puerto.
- `limites` (con `ttl_lock_s`) y `exclusion`: clave y estado del lock MySQL, con `auditoria_mysql: false`
  y `fallback_mysql: false`.
- `intentos[]`, uno por intento **realmente ejecutado**:
  - `estado`: `completa`, `truncada`, `timeout`, `cancelado`, `error` o `captura_no_garantizada`;
  - `codigo`: código corto, nunca el mensaje;
  - registros, válidos, basura, captura, bytes estimados y `cierre`.
- `lectura`: agregado de la primera lectura completa, o `null`:
  - formatos y distribuciones;
  - fechas primera/última (sin hora), futuras, duplicados y usuarios distintos (sólo el número);
  - `por_hora` y `patrones_dia`, con supresión.

| Código | Resultado |
|---|---|
| 0 | `ok` |
| 1 | `error_interno`, `cierre_no_confirmado` |
| 2 | `id_invalido`, `argumentos_invalidos`, `salida_existente`, `configuracion_invalida` |
| 3 | `captura_no_garantizada`, `captura_incompleta` |
| 4 | `reloj_ocupado`, `lock_mysql_vigente`, `exclusion_no_garantizada` |
| 5 | `redis_no_disponible` |
| 6 | `sin_lectura_completa`, `limite_total` |
| 7 | `lock_perdido` |
| 8 | `reloj_inexistente`, `reloj_sin_direccion`, `base_no_disponible` |
| 128+n | `interrumpido` (130 SIGINT, 143 SIGTERM, 129 SIGHUP) |

## 5. Preparar una copia aislada (sin tocar la release activa)

El runbook de releases usa `git archive`, así que puede no existir `.git`. La herramienta identifica su
versión por `.release-commit` (40 hex). Si ese archivo existe pero es inválido, informa
`release-commit-invalido` y **no** busca otra fuente.

```bash
umask 077
SHA=<SHA_REVISADO_DEL_PILOTO>
DIR=/var/tmp/zk-pilot/$SHA
mkdir -p "$DIR"
git -C <checkout operativo> archive "$SHA" | tar -x -C "$DIR"
printf '%s\n' "$SHA" > "$DIR/.release-commit"
cd "$DIR/api" && npm ci --omit=dev
```

**Configuración mínima.** No copiar el `.env` de producción. Crear `pilot.env` con modo `0600` y sólo
estas claves; el resto se ignora y sólo se cuenta:

```
DB_HOST=
DB_PORT=
DB_NAME=
DB_USER=        # preferible un usuario con sólo SELECT en devices y device_locks
DB_PASSWORD=
REDIS_URL=      # el mismo Redis que usa el worker (la clave del lock es compartida)
```

`--env-file` rechaza el archivo si es legible por grupo u otros, si es un enlace o si no existe.

## 6. Comandos (sólo con autorización)

```bash
# Preflight de solo lectura: devices.id, perfil y lecturas recientes del reloj elegido
# (consultas P1–P3 del procedimiento del piloto).

cd "$DIR/api"
node scripts/zk-raw-state-pilot.js --device-id <ID> \
  --attempts 3 --attempt-timeout 600 --max-duration 1900 --cooldown 4 --renew-seconds 5 \
  --env-file /ruta/segura/pilot.env --out /ruta/segura/piloto-<ID>-1.json
echo "código=$?"
# Segunda ejecución al menos 15 min después → piloto-<ID>-2.json
# Al terminar: borrar $DIR y pilot.env.
```

- Los límites del ejemplo replican el perfil documentado del worker para Gerencia (3 intentos, 600 s,
  4 s de espera).
- La duración total cubre 3 × 600 + 2 × 4 s más margen.
- `--out` nunca sobrescribe: si el archivo existe, termina con código 2 sin conectar.

## 7. Criterios de detención

- **Antes de conectar** (el piloto ya corta solo):
  - código 2 (entrada), 3 (captura), 4 (exclusión), 5 (Redis) u 8 (reloj o base);
  - **no** reintentar con otros parámetros sin revisar la causa.
- **Durante:**
  - código 6 (sin lectura completa o límite), 7 (lock perdido) o 128+n (señal);
  - el hijo ya se cerró: registrar y detener;
  - **no** encadenar otra ejecución inmediata.
- **Después:**
  - si `lectura.captura` no es 100 % `ok`, si aparece `udp8` o `longitud_inesperada`, o si
    `validos_sin_captura > 0`, la lectura no sirve para semántica;
  - si las dos ejecuciones difieren en registros anteriores a la primera, detener e investigar la
    estabilidad.

## 8. Qué falta para autorizar la ejecución

1. El SHA desplegado (`.release-commit` de la release activa) y `migrate:status`.
2. El `devices.id` del reloj candidato y su historial de lecturas completas, con consultas de solo
   lectura.
3. Que Redis esté disponible y sea el mismo que usa el worker.
4. El estado de `ZKTECO_AUTO_POLL`, el interruptor global y la ventana, sólo leídos.
5. Un horario de poco uso, quién ejecuta y quién supervisa.
6. Un usuario MySQL de solo lectura, que es opcional y requiere su propia autorización.
7. Modelo, firmware y modo de estado del reloj, leídos sin modificarlos.
8. Umbrales de aceptación y dónde se guarda la evidencia.

## 9. Pruebas

**Unitarias** (`tests/zkPilot*.test.js`, CI en 3 zonas):
- agregado exacto con valores calculados a mano (`tests/it/fixtures/pilotRecords.js`), decodificadores
  reales y transporte simulado;
- argumentos y límites, `--env-file` y `.release-commit`;
- grafo de módulos sin caminos de importación ni ORM;
- ningún literal SQL de escritura;
- clave compartida, y el helper habitual sin cambios.

**Integración** (`tests/it/zkStatePilot.it.test.js`, CI en 3 zonas):
- **Reloj:** reloj simulado por **TCP real** (`fakeZkTcpServer.js`), con node-zklib completo; registra
  comandos y cierre de cada conexión.
- **Redis aislado:** notificaciones de keyspace, para ver que no quedan conexiones abiertas al liberar.
- **MySQL:** `general_log`, para comprobar cero intentos de `INSERT/UPDATE/DELETE/DDL`, incluida la
  auditoría asíncrona.
- **Casos cubiertos:**
  - lectura completa;
  - lectura truncada y luego completa;
  - captura tardía;
  - ID inválido;
  - reloj inexistente;
  - lock Redis ocupado;
  - lock MySQL previo;
  - Redis caído;
  - lectura colgada;
  - límite total;
  - pérdida del lock;
  - SIGTERM, SIGINT y SIGHUP;
  - SIGKILL del proceso principal.
- **Controles negativos:**
  - el helper habitual sí intenta escribir en `audit_events`;
  - `Promise.race` deja la conexión abierta tras el timeout.

```bash
cd api
TZ=America/Asuncion IT_DB=1 DB_HOST=127.0.0.1 DB_PORT=<puerto> DB_USER=<usuario> DB_PASSWORD=<clave> \
  DB_NAME=asistencia IT_REDIS_URL=redis://127.0.0.1:<puerto_redis> \
  IT_DB_ADMIN_USER=<admin> IT_DB_ADMIN_PASSWORD=<clave_admin> \
  npx jest tests/it/zkStatePilot.it.test.js --runInBand
```
