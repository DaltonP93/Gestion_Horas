# Piloto aislado de estados por reloj

> **Estado:** herramienta en PR Draft, apilada sobre #252 (`251d5dd`). **No ejecutada contra relojes
> reales.** Ejecutarla requiere una autorización separada (ver §8). Este documento no autoriza nada.
>
> **Ronda sobre `b21e08e`** (formato de salida `/2`): exclusión real con el fallback MySQL del worker
> (lock dual), operaciones de MySQL/Redis y cierres acotados y cancelables, y corte temporal común
> (`--cutoff`, huella con clave y CLI de comparación). Reproducciones y evidencia en
> `docs/evidence/piloto-estados/`.

## 1. Qué hace y qué no hace

`api/scripts/zk-raw-state-pilot.js` lee **una vez** el buffer de marcaciones de **un** reloj ZKTeco y
escribe un JSON con **conteos**: formato del registro, distribución de los bytes crudos
`zkPunchState` / `zkVerify` (#252), capturas ausentes o inválidas, truncamiento e intentos realmente
ejecutados. Con `--cutoff`, además, el resumen comparable del conjunto histórico anterior al corte (§4).

**No hace:**
- importar marcaciones, escribir staging (`raw_device_punches`) ni `attendance_logs`;
- recalcular `daily_summary`;
- actualizar `devices` (`last_sync`), ni `device_sync_runs` ni `audit_events`;
- configurar el reloj: sólo envía conectar, liberar buffer, pedir marcaciones y salir;
- interpretar estados como entrada o salida.

**Única escritura en la base:** su propia fila de lock en `device_locks` (tomar, renovar y liberar por
token, más la limpieza de la fila **vencida** de ese reloj), con las mismas sentencias que el fallback del
helper habitual. Es lo que hace falta para excluir de verdad a un proceso habitual en fallback (§3).
Para anular una toma propia con resultado incierto puede, además, cerrar en el servidor **su propia**
conexión anterior del lock (`KILL CONNECTION`, y en Redis `CLIENT KILL ID … ADDR …`), sólo si comprueba
que sigue siendo ella: mismo servidor (arranque / `run_id`) y misma dirección del cliente. Nunca una ajena.

**Tener el byte no demuestra qué significa** ni cómo está configurado el equipo (ver
`horas-marcas-sin-tipo.md` §5.1).

## 2. Componentes

| Archivo | Rol |
|---|---|
| `api/scripts/zk-raw-state-pilot.js` | CLI: argumentos, configuración mínima, JSON de salida, código de salida |
| `api/src/services/zkPilot/runPilot.js` | Orquestación: MySQL de solo lectura, lock dual, intentos, señales, límites, cierre |
| `api/src/services/zkPilot/readChild.js` | **Un proceso por intento**: captura, conexión, lectura, agregado y bloque del corte |
| `api/src/services/zkPilot/lock.js` | Lock dual: clave Redis compartida + fila propia en `device_locks` (sesión fijada y verificada) |
| `api/src/services/zkPilot/bounded.js` | Operaciones externas acotadas: tope propio (cancela) y corte (deja de esperar) |
| `api/src/services/zkPilot/aggregate.js` | Agregado saneado, bloque del corte común y códigos de error |
| `api/src/services/zkPilot/corte.js` | Piezas **puras** del corte: canon, identificador de la clave, comparación de dos salidas |
| `api/scripts/zk-raw-state-pilot-compare.js` | CLI: compara el corte de dos salidas (sólo lee los dos JSON) |
| `api/src/services/zkPilot/args.js` | Argumentos (incluido `--cutoff`), `--env-file` y `.release-commit` |
| `api/src/services/deviceLockKeys.js` | Clave `zk:lock:dev:<id>` y Lua, **compartidos** con `deviceLock.js` |
| `api/src/services/zkRecordShape.js`, `zkClient.js` | Funciones puras y `openZK`, movidas **sin cambios** desde `zktecoReader.js` |

`zktecoReader.js` y `deviceLock.js` reutilizan esos módulos y su comportamiento no cambia: el worker
sigue auditando el lock y cayendo a MySQL si no hay Redis.

## 3. Garantías

**Exclusión con las demás lecturas (lock dual):**
- El helper habitual (`deviceLock.js`) usa Redis si **ese** proceso lo alcanza y, si no, la tabla
  `device_locks`; su fallback **nunca** mira Redis. Por eso consultar la tabla de vez en cuando (como
  hacía `b21e08e`) no impide que un proceso habitual en fallback la tome entre dos consultas: sólo lo
  detecta después. Peor aún: con la base en otra zona horaria (UTC en CI y en el docker-compose), la
  consulta ni siquiera veía la fila viva del worker (reproducido en `b565bd6`).
- El piloto toma los **dos** backends del mismo protocolo y sólo lee con ambos:
  - Redis: `zk:lock:dev:<id>` (`SET NX PX`), la misma clave que el worker, las rutas y los scripts;
  - MySQL: **su propia fila** de `device_locks` (PK `device_id`): limpieza de la fila **vencida** de ese
    reloj, `INSERT` (duplicado ⇒ ocupado), renovación y liberación por token. Son las sentencias del
    fallback habitual, sólo para ese `device_id`; nunca `CREATE TABLE` ni auditoría.
- Un proceso habitual por Redis choca con la clave; uno en fallback, con la fila. No hace falta cambiar
  el worker.
- **Sesión de la conexión del lock** (fijada y **verificada** antes de cualquier escritura; si no queda
  así, `exclusion_no_garantizada` sin leer):
  - `time_zone` = la de la app (`DB_TIMEZONE` de `config/database.js`, `-03:00`): `expires_at` es un
    `DATETIME` sin zona que el helper habitual escribe y compara con `NOW()` en esa zona;
  - `autocommit = 1`: cada sentencia es su transacción; nunca retiene bloqueos de hueco sobre otros
    relojes;
  - `innodb_lock_wait_timeout` y `lock_wait_timeout` = 2 s, por debajo del tope del cliente: el
    servidor abandona una espera antes que el piloto y no quedan escrituras fantasma;
  - base escribible (`read_only = 0` y `super_read_only = 0`): una réplica no excluiría a nadie.
- Renovación: la clave y la fila, **en paralelo**, antes de cada intento y cada `--renew-seconds`;
  cualquiera que falle o ya no sea propia ⇒ se mata la lectura (`lock_perdido`,
  `redis_no_disponible` o `exclusion_no_garantizada`).
- Si Redis no responde, el piloto **no lee** (no es un fallback: la fila sola no excluye a un worker por
  Redis).

**Escrituras en la base: sólo la fila propia del lock.**
- La conexión de **lectura** fija `SET SESSION TRANSACTION READ ONLY`, sólo hace el `SELECT` del reloj en
  `devices` y se cierra antes de abrir la del lock: nunca hay dos conexiones a la vez.
- La conexión del **lock** sólo ejecuta su sesión y las cuatro sentencias de `device_locks`. Una prueba
  de integración las verifica por conexión en el `general_log`, con el `device_id` y el token del piloto.
  Además lee su propia identidad (`HOST` en `information_schema.PROCESSLIST` y `SHOW GLOBAL STATUS LIKE
  'Uptime'`). Una conexión **nueva** de liberación ejecuta su sesión, la liberación por token y, sólo ante
  una toma incierta, comprueba la identidad de la sesión vieja, `KILL CONNECTION <hilo propio anterior>` y
  su sondeo en `PROCESSLIST`.
- No carga el ORM, `audit.js` ni `zktecoReader.js`; una prueba lo verifica sobre el grafo de módulos.

**Operaciones acotadas y cancelables (el límite total se cumple aunque algo quede pendiente):**
- Toda consulta, comando, conexión, liberación y cierre pasa por `bounded.js`:
  - un tope propio (5 s por operación): al vencer se **cancela el cliente** y la operación se rechaza;
  - un corte (límite total, señal o lock perdido): se deja de esperar **sin** cancelar el cliente, que
    puede hacer falta para liberar el lock. Abortar no destruye clientes; con el corte ya disparado,
    una operación nueva ni siquiera se lanza.
- **Cancelar** es, en mysql2, `conn.connection.stream.destroy(err)` (`destroy()` sólo cierra a medias:
  la consulta puede resolverse tarde o quedar pendiente para siempre con el socket abierto) y, en
  node-redis, `disconnect()` (nunca `quit()`: si no responde deja el socket abierto y una respuesta
  tardía tira el proceso; nunca AbortSignal: no retira un comando ya enviado y corrompe la cola).
  **Cancelar el cliente no retira del servidor lo que ya salió**: los bytes en vuelo llegan igual.
- El cliente Redis conecta sin `CLIENT SETINFO` (su `connectTimeout` sólo cubre el TCP; el saludo
  quedaría sin tope) y sin cola offline (un comando con el socket no listo falla al instante).
- **Al cerrar**, todo comparte **un** presupuesto (`CLOSE_BUDGET_MS` = 6 s), sin topes que se sumen
  paso a paso:
  1. lo que siga en vuelo (p. ej. una renovación sobre una conexión colgada) tiene una **gracia** de
     400 ms; si no termina, ese cliente se cancela;
  2. la clave y la fila se liberan, en paralelo, por el **mismo** cliente si sigue vivo (queda en orden
     detrás de lo enviado antes) y, si no responde (tope de 2 s por paso), por un cliente **nuevo**;
  3. Redis se cierra con `disconnect()` y MySQL con `end()` acotado y, siempre después, el socket
     destruido.
- **Qué es incierto.** Sólo una respuesta de error del **servidor** prueba que una sentencia o un comando
  no se aplicó: en MySQL, errno positivo con SQLSTATE; en Redis, `ErrorReply`. Un error de **red** (RST:
  `ECONNRESET`, errno -104; `EPIPE`; conexión perdida), un tope o un corte no prueban nada: la toma es
  incierta y una liberación fallida pasa a un cliente nuevo.
- **Tomas inciertas.** La clave (`SET NX PX`) y la fila (`INSERT`) nacen con un **TTL provisional** de
  30 s (`limites.ttl_provisional_s`); la verificación previa a cada intento las lleva al TTL completo
  justo antes de lanzar la lectura (si el provisional venció, la renovación ve el token ajeno y no se
  lee). Una toma con resultado **incierto** se compensa por token: por el mismo cliente, en orden; o, si
  ese cliente se canceló, por uno nuevo que **antes mata la sesión vieja en el servidor**. Así una toma
  demorada en la red ya no puede aplicarse después de la compensación. Si no se puede matar la sesión
  ni hay nada que borrar, se informa `incierto`: lo huérfano vence en ≤ 30 s, nunca en el TTL completo.
- **Matar sólo lo propio.** Un número de sesión identifica una conexión dentro de **una** vida del
  servidor: tras un reinicio o un cambio de servidor detrás de la misma dirección, el mismo número puede
  ser de otro proceso. Al abrir la conexión del lock se guarda su identidad y antes de matar se vuelve a
  comprobar; si algo no coincide no se mata nada (`incierto`):
  - Redis: `CLIENT INFO` (id y dirección del cliente vista por el servidor) e `INFO server` (`run_id`,
    nuevo en cada arranque); se mata con `CLIENT KILL ID <id> ADDR <addr>` (filtros en AND) sólo con el
    mismo `run_id`. Sin `CLIENT INFO`/`INFO` (ACL o Redis < 6.2), no hay identidad: nunca se mata.
  - MySQL: hilo, `HOST` (ip:puerto del cliente) y arranque del servidor (`Uptime`, con 2 s de
    tolerancia; `server_uuid` no cambia al reiniciar). Se mata sólo con el mismo arranque y el mismo
    `HOST` en ese hilo; si el hilo ya no existe, la sesión vieja ya no ejecuta nada.
- Una renovación o liberación vieja que llegue tarde no resucita ni borra nada ajeno: el Lua compara
  el token y el `UPDATE`/`DELETE` filtran por token.
- Si ya no cabe un intento (`--max-duration` debe ser **mayor** que `--attempt-timeout`), no se toman
  los locks para nada (`limite_total`); se vuelve a comprobar antes de cada intento y otra vez **después**
  de la renovación previa (que puede tardar hasta 4 s), para no tocar el reloj con un intento que ya no
  cabe. `git rev-parse` (versión de la herramienta) también tiene tope (2 s).
- Garantía: el piloto termina dentro de `--max-duration` más una holgura fija
  (`limites.cierre_max_s` = 17 s = terminación del hijo ≤ 10 s + presupuesto de cierre 6 s + 1 s).

**Cierre real:**
- Cada intento corre en un **proceso hijo**.
- Si el intento vence, se pierde el lock, llega una señal o se agota la duración total, el hijo se mata
  con `SIGKILL`. El piloto espera su `exit` y el cierre del canal **antes** de reintentar o liberar el
  lock.
- Matar el proceso cierra el socket; un `Promise.race` sólo deja de esperar.
- Si la terminación no se confirma en 10 s, el lock **no** se libera y vence por TTL
  (`cierre_no_confirmado`).

**TTL sin solapamiento:**
- TTL = timeout del intento + 1 s (vida máxima del hijo) + 5 s (margen) + intervalo de renovación; el
  mismo para la clave y para la fila.
- El hijo se termina solo al vencer el intento + 1 s.
- La renovación previa a cada intento se mide desde **antes de enviarla**: si tarda más de 4 s, el hijo no
  se lanza (`exclusion_no_garantizada`). Así, al lanzarlo, a la clave y a la fila les queda más vida que
  al hijo.
- Si el proceso principal muere, el hijo detecta el cierre del canal IPC y sale.
- **Ctrl+Z** (`SIGTSTP` al grupo) **interrumpe** (código 148): el piloto no se suspende y el hijo sale; un
  piloto suspendido no renovaría y el lock vencería con la sesión del hijo con el reloj abierta.
- **Lectura válida sólo con exclusión confirmada después:** una lectura completa se acepta recién con una
  verificación de la clave y la fila **enviada después** de que el hijo terminó. Si la exclusión se
  perdió durante la lectura sin desconexión (clave borrada desde afuera, otro dueño), el resultado es
  `lock_perdido` (7) sin `lectura` ni `corte`, aunque la lectura haya terminado antes de la renovación.
- Así, mientras los procesos corren, el reloj nunca queda en uso cuando el lock vence (ver los riesgos
  residuales para lo que no se puede atrapar).

**Captura:**
- El hijo instala `zkRawCapture` **antes** de cargar `node-zklib`.
- Si `node-zklib` ya estaba cargado (captura tardía) o la instalación falló, el hijo responde y termina
  **sin conectar**.

**Salida saneada:**
- Sólo conteos: nada de usuarios, IP, puertos, registros individuales, horas individuales ni mensajes
  de error crudos.
- Por hora del día y por patrón de usuario-día, las celdas con menos de 5 casos salen como `"<5"`.
- Los bytes se declaran **estimados** (`registros × tamaño del formato`), no medidos en la red.

**Corte temporal común (`--cutoff`):**
- `--cutoff "AAAA-MM-DD HH:MM:SS"` (o `AAAA-MM-DD`, que significa `23:59:59` de ese día): hora de pared
  de Paraguay, la misma representación que la hora de cada marca. Fecha de calendario real y años
  2010–2100. Debe ser **anterior a ahora menos 120 min**: en el futuro, `corte_futuro`; dentro del
  margen, `corte_reciente` (los dos con código 2 y sin conectar a nada). El margen evita que una marca
  nueva con el reloj algo atrasado caiga dentro del conjunto.
- De los registros **válidos** de la lectura completa, el **conjunto** son los de hora de pared ≤ corte
  (inclusivo). Los posteriores, futuros y basura quedan **fuera** y sólo se cuentan.
- El hijo de lectura **decodifica en UTC** (no hereda `TZ`) y lo verifica antes de conectar: en la zona
  `America/Asuncion` las horas que Paraguay se saltaba al adelantar el reloj (p. ej. 1/10/2023
  00:30) saldrían corridas una hora y dos corridas en zonas distintas no darían el mismo conjunto.
- `corte.conjunto`: sólo **conteos** (registros; usuarios y días con supresión `"<5"`), formato,
  `captura_completa` y una **huella**. **Sin** agregado del conjunto: restado del agregado completo
  revelaría las marcas posteriores.
- **Huella con clave**: HMAC-SHA256 con `PILOT_CORTE_CLAVE` (64 hex, la custodia el operador y nunca se
  publica) sobre el canon `sishoras.zk-raw-state-pilot.corte/2`, la cantidad y la lista **ordenada**
  (multiconjunto) de `[usuario, hora de pared, byte de estado, byte de verificación]`. Sin clave, un
  hash del conjunto se rompe por fuerza bruta conociendo las demás marcas. `clave_id` (12 hex, HMAC de
  un dominio fijo) sólo dice si dos salidas usaron la misma clave. La clave viaja al hijo por el canal
  IPC, nunca por argumentos ni variables de entorno.
- `huella: null` con `huella_motivo` si falta la clave (`sin_clave`), hay menos de 5 marcas o usuarios
  (`pocos_registros`, `pocos_usuarios`), la captura no es completa (`captura_incompleta`) o se mezclan
  formatos (`formatos_mixtos`: el mismo historial por TCP y por UDP no da la misma lista).
- Dos corridas con el mismo corte y la misma clave dan la **misma** huella si el reloj conserva esas
  marcas; las nuevas caen en `fuera.posteriores`. Cualquier cambio en una marca anterior al corte cambia
  la huella. `scripts/zk-raw-state-pilot-compare.js a.json b.json` lo decide sin abrir conexiones:
  `igual` (código 0), `distinto` (1, con `delta_registros`), `no_comparable` (3: resultado no `ok`,
  otro reloj, la misma corrida dos veces —`corrida_id`— o sin identificador de corrida, otro corte,
  canon, zona de decodificación, formato o clave, o sin huella) o entrada inválida (2: no es un objeto
  JSON). No comprueba el tiempo entre corridas: eso lo controla el operador (§6).

**Riesgos residuales (documentados, no cubiertos):**
- **Entre procesos habituales**: uno por Redis y otro en fallback no se excluyen, porque el helper
  habitual decide el backend por proceso (con un reintento de Redis cada 15 s). El lock dual del piloto
  no lo resuelve; requiere cambiar el worker (§3.1).
- **Residuos del worker** que permiten un solape aun con el lock dual (requieren cambiar el worker, §3.1):
  - `zktecoReader` ignora una renovación fallida y sigue leyendo: si la clave de Redis vence con el
    worker leyendo (Redis inaccesible sólo para él más que su TTL), el piloto la toma legítimamente;
  - un reinicio de Redis sin persistencia borra la clave del worker en plena lectura (la del piloto
    también: el piloto lo detecta y corta);
  - con `Promise.race`, el worker libera el lock con la sesión del reloj todavía abierta (control
    negativo de la prueba de integración).
- Si MySQL o Redis dejan de responder **también para una conexión nueva** con el lock tomado, su fila o
  su clave quedan hasta el TTL (`por_ttl`: el worker ve el reloj ocupado ese tiempo, hasta 936 s con los
  máximos). Una toma incierta que no se pudo anular (`incierto`) queda ≤ 30 s.
- Matar la sesión vieja necesita `CLIENT INFO`, `INFO` y `CLIENT KILL` en el ACL de Redis, y que el
  usuario MySQL sea el mismo de la sesión (KILL de una conexión propia no requiere privilegios globales).
  Sin eso, una toma incierta se informa `incierto`; el piloto sigue igual.
- Una señal durante el cierre no lo acorta (el cierre ya tiene su presupuesto de 6 s) ni cambia el
  resultado ya obtenido: se registra en `senal`.
- **Suspensión que no se puede atrapar** (`SIGSTOP`, congelar el cgroup —`docker pause`—, pausar la VM)
  por más que el TTL: el lock vence con la sesión del hijo con el reloj todavía abierta. Un lock con TTL
  sin "fencing" en el reloj no lo puede cubrir; no pausar el proceso ni el contenedor durante el piloto.
- **Archivos en el directorio de trabajo** (previo a esta ronda): el hijo carga `config/logger.js`
  (crea `logs/` vacío en el directorio actual) y node-zklib puede escribir `*.err.log` con bytes crudos
  ante errores de decodificación. Por eso el piloto se corre desde la copia aislada `$DIR/api`, que se
  borra al terminar (§5, §6).
- El agregado depende de la disposición de pyzk para los formatos (#252). UDP sólo está probado con
  transporte simulado en proceso, no por la red.
- El corte compara la hora **del reloj**: si el reloj atrasa, una marca nueva puede quedar con hora
  anterior al corte. Elegir un corte anterior a la primera corrida con margen mayor que el desfase.

### 3.1 Propuesta para el helper habitual (NO aplicada)

Cambiaría el comportamiento del worker; queda para una autorización separada:
1. Lock dual también en el helper habitual: tomar siempre la fila de `device_locks` además de la clave
   (cuando Redis esté), y liberar ambas. Elimina la exclusión parcial entre procesos habituales.
2. Abortar la lectura si `renew()` devuelve `false` (hoy se ignora).
3. Mantener el lock hasta que la sesión con el reloj esté realmente cerrada (o leer en un proceso hijo,
   como el piloto), en lugar de liberarlo cuando `Promise.race` vence.
4. Renovar por "filas encontradas" (`info`) y no por `affectedRows`: Sequelize conecta sin `FOUND_ROWS`
   y dos renovaciones en el mismo segundo darían un falso "lock perdido".
5. Poner tope a `getRedis()`: node-redis espera sin límite la respuesta de `CLIENT SETINFO` al conectar
   (`connectTimeout` sólo cubre el TCP); un Redis que acepta TCP y no responde cuelga al worker.

## 4. Salida

**Formato:** `sishoras.zk-raw-state-pilot/2` (antes `/1`: cambia `exclusion` y se agregan `corte`,
`liberacion`, `cierre_clientes` y límites nuevos). Campos principales:
- `resultado`, `codigo_salida`, `senal`.
- `herramienta`: `commit`, `origen_commit` (`release-commit`, `git`, `desconocido`), versión de
  `node-zklib` y de Node.
- `reloj.id` y `reloj.modo_conexion`. No se informan IP ni puerto.
- `limites`: intentos, tiempos, `ttl_lock_s`, `ttl_provisional_s` (30), `operacion_max_s` (tope por
  operación) y `cierre_max_s` (holgura fija sobre la duración total).
- `corte`: `null` sin `--cutoff`. Con `--cutoff`: `{ hasta, canon, decodificacion: { zona },
  conjunto: { registros, usuarios, dias_con_marcas, formato, captura_completa, huella, huella_tipo:
  'hmac-sha256', clave_id, huella_motivo }, fuera: { posteriores, futuras, basura } }` (`futuras` es
  parte de `posteriores`) de la lectura
  elegida; sin lectura completa, `{ hasta, canon, conjunto: null, huella_motivo: 'sin_lectura' }` (§3).
- `exclusion`: `backend: 'redis+mysql'`, la clave, `mysql: { tabla, origen: 'piloto_estados', estado }`
  (`tomado`, `ocupado`, `sesion_invalida`, `sin_conexion`, `sin_acceso`, `espera_de_bloqueo`,
  `sin_respuesta`, `detenido` o `error`) y `auditoria_mysql: false`.
- `corrida_id`: identificador aleatorio de la corrida (la comparación rechaza la misma corrida dos veces).
- `liberacion`: por backend, `liberado`, `perdido` (ya no era nuestro al liberar: venció y otro lo tomó,
  o nuestra propia liberación anterior llegó tarde; una lectura con la exclusión perdida no vale:
  `lock_perdido`), `por_ttl` (no se pudo confirmar: vence solo en
  `ttl_lock_s`), `compensado` (toma incierta: confirmado que no queda nada nuestro, porque se borró o
  porque su sesión se mató antes de mirar), `incierto` (toma incierta sin confirmar: vence en
  `ttl_provisional_s`) o `no_tomado` (nunca se tomó, con certeza).
- `cierre_clientes`: `normal`, `forzado` (socket destruido: tope vencido, gracia vencida, conexión rota
  o sin presupuesto de cierre), `no_conectado`, o `null` si ese cliente no llegó a crearse (lo mismo
  `exclusion.mysql.estado`).
- `herramienta.origen_commit`: `release-commit`, `release-commit-invalido`, `git` o `desconocido`.
- `intentos[]`, uno por intento **realmente ejecutado**:
  - `estado`: `completa`, `truncada`, `timeout`, `cancelado`, `error` o `captura_no_garantizada`;
  - `codigo`: código corto, nunca el mensaje;
  - registros, válidos, basura, captura, bytes estimados y `cierre`.
- `lectura`: agregado de la primera lectura completa **con exclusión confirmada después**, o `null`:
  - `intento` (cuál de los intentos), formatos y distribuciones;
  - fechas primera/última (sin hora), futuras, duplicados y usuarios distintos (sólo el número);
  - `por_hora` y `patrones_dia`, con supresión;
  - el bloque del corte va arriba, en `corte` (no dentro de `lectura`).

| Código | Resultado |
|---|---|
| 0 | `ok` |
| 1 | `error_interno`, `cierre_no_confirmado` |
| 2 | `id_invalido`, `argumentos_invalidos`, `salida_existente`, `configuracion_invalida`, `corte_futuro`, `corte_reciente` |
| 3 | `captura_no_garantizada`, `captura_incompleta` |
| 4 | `reloj_ocupado`, `lock_mysql_vigente`, `exclusion_no_garantizada` |
| 5 | `redis_no_disponible` |
| 6 | `sin_lectura_completa`, `limite_total` |
| 7 | `lock_perdido` |
| 8 | `reloj_inexistente`, `reloj_sin_direccion`, `base_no_disponible` |
| 128+n | `interrumpido` (130 SIGINT, 143 SIGTERM, 129 SIGHUP, 148 SIGTSTP) |

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
DB_USER=        # SELECT en devices; SELECT, INSERT, UPDATE y DELETE en device_locks; nada más
DB_PASSWORD=
REDIS_URL=      # el mismo Redis que usa el worker (la clave del lock es compartida)
PILOT_CORTE_CLAVE=  # 64 hex (p. ej. `openssl rand -hex 32`), la MISMA en las corridas que se comparan
```

Una `PILOT_CORTE_CLAVE` que no sea de 64 hex termina con `configuracion_invalida` (código 2) sin
conectar. Sin clave —la línea ausente o **vacía**— el corte sólo da conteos (`huella_motivo:
'sin_clave'`).

`--env-file` rechaza el archivo si es legible por grupo u otros, si es un enlace o si no existe.

**Base:** `DB_HOST` debe ser la MySQL **primaria** que usa el worker (en una réplica la fila no excluiría
a nadie: el piloto lo exige con `read_only = 0`). Piloto y worker deben ser de la misma release, para que
la zona de sesión del lock (`DB_TIMEZONE`) coincida. Mientras corre, su fila aparece en las métricas de
locks (`netMetrics`).

## 6. Comandos (sólo con autorización)

```bash
# Preflight de solo lectura: devices.id, perfil y lecturas recientes del reloj elegido
# (consultas P1–P3 del procedimiento del piloto).

cd "$DIR/api"
# Corte común, ANTERIOR a la primera corrida (hora de pared de Paraguay), con margen mayor que el
# desfase del reloj. Se usa el MISMO en las dos corridas.
CORTE="AAAA-MM-DD HH:MM:SS"
node scripts/zk-raw-state-pilot.js --device-id <ID> \
  --attempts 3 --attempt-timeout 600 --max-duration 1900 --cooldown 4 --renew-seconds 5 \
  --cutoff "$CORTE" --env-file /ruta/segura/pilot.env --out /ruta/segura/piloto-<ID>-1.json
echo "código=$?"
# Segunda ejecución al menos 15 min después, con el mismo --cutoff y la misma clave → piloto-<ID>-2.json
node scripts/zk-raw-state-pilot-compare.js /ruta/segura/piloto-<ID>-1.json /ruta/segura/piloto-<ID>-2.json
echo "comparación=$?"   # 0 igual · 1 distinto · 3 no comparable · 2 entrada inválida
# Al terminar: borrar $DIR y pilot.env (la clave no se guarda con las salidas).
```

- Los límites del ejemplo replican el perfil documentado del worker para Gerencia (3 intentos, 600 s,
  4 s de espera).
- La duración total cubre 3 × 600 + 2 × 4 s más margen; el proceso termina, como mucho,
  `cierre_max_s` (17 s) después de `--max-duration`.
- `--out` nunca sobrescribe: si el archivo existe, termina con código 2 sin conectar.

## 7. Criterios de detención

- **Antes de conectar** (el piloto ya corta solo):
  - código 2 (entrada), 3 (`captura_no_garantizada`), 4 (exclusión), 5 (Redis) u 8 (reloj o base);
  - **no** reintentar con otros parámetros sin revisar la causa.
- **Durante:**
  - código 4 o 5 (la base o Redis dejaron de responder con la lectura en curso), 6 (sin lectura completa
    o límite), 7 (lock perdido, también si se perdió durante una lectura que terminó) o 128+n (señal);
  - el hijo ya se cerró: registrar y detener;
  - **no** encadenar otra ejecución inmediata.
- **Al terminar la lectura:** código 3 (`captura_incompleta`): la lectura terminó, pero la captura no es
  completa.
- **Después:**
  - si `lectura.captura` no es 100 % `ok`, si aparece `udp8` o `longitud_inesperada`, o si
    `validos_sin_captura > 0`, la lectura no sirve para semántica;
  - comparar el corte de las dos ejecuciones con `zk-raw-state-pilot-compare.js` (mismo `--cutoff` y
    misma clave): `distinto` significa que el conjunto anterior al corte cambió (una marca alterada,
    borrada, o nueva con el reloj atrasado más que el margen): detener e investigar la estabilidad.
    `no_comparable` no es un resultado: revisar el motivo. Las marcas nuevas sólo cambian
    `fuera.posteriores`;
  - si `liberacion` no es `liberado` en los dos backends, avisar que el reloj puede verse ocupado hasta
    `ttl_lock_s` (`por_ttl`) o `ttl_provisional_s` (`incierto`).

## 8. Qué falta para autorizar la ejecución

1. El SHA desplegado (`.release-commit` de la release activa) y `migrate:status`.
2. El `devices.id` del reloj candidato y su historial de lecturas completas, con consultas de solo
   lectura.
3. Que Redis esté disponible, sea el mismo que usa el worker y lleve en marcha más que la vida máxima de
   un lock habitual (`INFO server`, `uptime_in_seconds`): un reinicio sin persistencia borra la clave de
   un worker que todavía lee (§3).
4. El estado de `ZKTECO_AUTO_POLL`, el interruptor global y la ventana, sólo leídos.
5. Un horario de poco uso, quién ejecuta y quién supervisa.
6. Un usuario MySQL con SELECT en `devices` y SELECT/INSERT/UPDATE/DELETE sólo en `device_locks`
   (requiere su propia autorización), contra la MySQL primaria del worker. Si Redis usa ACL, que el
   usuario permita `CLIENT ID` y `CLIENT KILL` (sólo para anular una toma propia incierta).
7. Modelo, firmware y modo de estado del reloj, leídos sin modificarlos.
8. Umbrales de aceptación y dónde se guarda la evidencia.
9. Quién genera y custodia `PILOT_CORTE_CLAVE` para las dos corridas.

## 9. Pruebas

**Unitarias** (`tests/zkPilot*.test.js`, CI en 3 zonas):
- agregado exacto con valores calculados a mano (`tests/it/fixtures/pilotRecords.js`), decodificadores
  reales y transporte simulado;
- argumentos y límites (incluido `--cutoff`), `--env-file` y `.release-commit`;
- bloque del corte: conjunto, posteriores, límite inclusivo, supresión y huella calculada a mano desde la
  definición de las marcas (igual en las 3 zonas);
- grafo de módulos sin caminos de importación ni ORM; el CLI de comparación sólo carga `corte.js`; el
  hijo no recibe la clave del corte, ni credenciales, ni `REDIS_URL` (lista blanca exacta);
- en **todo** lo que cargan el principal, el hijo y el CLI de comparación (con un tokenizador: comillas
  mezcladas, plantillas, varias líneas y piezas sueltas; sin comentarios): los únicos literales SQL de
  escritura son las cuatro sentencias de la fila propia del lock (las mismas del fallback habitual), el
  único KILL es el de la sesión propia atado a su identidad, y por `sendCommand` sólo `CLIENT INFO`,
  `INFO server` y ese `CLIENT KILL`;
- lock dual: clave compartida, fila propia, clasificación por `errno`, renovación por filas encontradas,
  cancelación real del socket y sesión del lock (zona igual a la de la app, autocommit, base escribible);
- orden de las conexiones con dobles de mysql2/redis: la de lectura se cierra antes de la del lock, la
  sesión del lock se fija y verifica ANTES de escribir (sesión inválida ⇒ ninguna escritura), la toma
  usa el TTL provisional y Redis se cierra sin `QUIT`; cliente Redis sin reconexión, cola offline ni
  `CLIENT SETINFO`;
- toma incierta con el cliente roto (error de red con la forma REAL: errno -104): la sesión vieja se mata
  (`KILL CONNECTION` / `CLIENT KILL ID … ADDR …`) ANTES de compensar; sin permiso para matarla y sin nada
  que borrar ⇒ `incierto`; otro servidor (otro arranque u otro `run_id`) u otra conexión con ese número
  (otro `HOST`) ⇒ no se mata nada, `incierto`;
- ya no cabe un intento después de leer el reloj ⇒ ningún lock; renovación previa de más de 4 s ⇒ no se
  lanza la lectura; renovación lenta que se come el tiempo ⇒ el intento que ya no cabe no se lanza;
- operaciones acotadas (`bounded.js`): tope que cancela, corte que no cancela, con el corte disparado la
  operación no se lanza, resultados tardíos; `git rev-parse` con tope; `--max-duration` > timeout;
- comparación: otro reloj, la misma corrida dos veces, sin `corrida_id`, otro canon, JSON que no es un
  objeto; clave vacía = sin clave;
- el helper habitual sin cambios.

**Integración** (`tests/it/zkStatePilot.it.test.js`, CI en 3 zonas):
- **Reloj:** reloj simulado por **TCP real** (`fakeZkTcpServer.js`), con node-zklib completo; registra
  comandos y cierre de cada conexión.
- **Redis aislado:** notificaciones de keyspace, para ver que no quedan conexiones abiertas al liberar.
- **MySQL** (en UTC, como CI): `general_log` por conexión: la de lectura sólo su sesión READ ONLY y
  `SELECT`; la del lock sólo su sesión y las sentencias de su fila (este `device_id`, token del piloto).
  Ninguna otra escritura, DDL ni auditoría, tampoco asíncrona.
- **Proxy TCP** delante de MySQL/Redis (`freezableTcpProxy.js`): deja de reenviar sin cerrar (todo, o
  sólo las conexiones abiertas: una nueva funciona), a mano o al pasar un comando; **demora** un comando
  y todo lo que le sigue en esa conexión, cierre incluido, como un segmento TCP en vuelo; o corta al
  cliente con **RST** antes o después de entregar un comando al servidor.
- Sólo cuentan los procesos de lectura de los pilotos de la suite (cada piloto en su propio grupo de
  procesos): otro piloto en el mismo equipo no hace fallar la prueba.
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
  - SIGTERM, SIGINT y SIGHUP; **Ctrl+Z** (SIGTSTP al grupo) ⇒ interrumpe (148) y libera; una señal
    **durante el cierre** de una lectura completa ⇒ `ok` (0) con la señal en `senal`;
  - **exclusión perdida a mitad de la lectura** sin desconexión (clave borrada y tomada por otro) ⇒
    `lock_perdido` (7) sin `lectura`, aunque la lectura termine antes de la renovación;
  - SIGKILL del proceso principal (la clave y la fila vencen por TTL);
  - **exclusión real**: con el piloto leyendo, el helper habitual REAL en fallback (Redis inaccesible
    para él) no obtiene el lock; el helper en fallback que toma y retiene el lock con su sesión `-03:00`
    deja al piloto sin leer (código 4) en la MySQL en UTC; control por Redis;
  - **operaciones pendientes**: Redis o MySQL sin respuesta mientras el piloto lee, la consulta inicial
    colgada, el límite total con una consulta pendiente y `COM_QUIT` sin confirmar: el proceso termina
    dentro del tope; Redis nunca envía `QUIT`;
  - **cancelación**: señal con renovaciones en vuelo sobre conexiones colgadas (una nueva responde) ⇒
    `liberado` en los dos por clientes nuevos, en menos de gracia + 1 s; liberación de Redis lenta por el
    mismo cliente ⇒ liberada por uno nuevo, y el `EVAL` viejo, que llega después de que el piloto
    terminó, no toca la clave de otro dueño; toma de Redis o MySQL demorada 7 s en la red ⇒ la sesión
    vieja se mata, `compensado`, y ni clave ni fila 8 s después (en MySQL, el `general_log` muestra que el
    `INSERT` viejo nunca se ejecutó y que la identidad se comprobó antes del KILL);
  - **errores de red (RST)**: `INSERT` aplicado y respuesta perdida ⇒ toma incierta, `compensado`, sin
    fila (el `general_log` muestra el `INSERT` y la compensación por token); liberación cortada ⇒
    `liberado` por una conexión nueva, sin fila hasta el TTL;
  - la clave del corte nunca aparece en el entorno ni en los argumentos del proceso de lectura
    (`/proc/<pid>/environ` y `cmdline` durante la lectura);
  - **corte común**: dos corridas con marcas nuevas entre medio dan la misma huella y el CLI las da por
    `igual`; una marca anterior alterada ⇒ `distinto`; horas inexistentes del cambio de hora de Paraguay
    exactas; sin clave ⇒ sólo conteos; corte dentro del margen o en el futuro (código 2 sin conexiones);
    control sin corte.
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
