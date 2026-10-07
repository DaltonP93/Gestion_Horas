# Horas con marcaciones sin tipo entrada/salida — diagnóstico

Estado: **diagnóstico y pruebas de caracterización**. No cambia el cálculo,
no activa writers ni flags, no toca relojes físicos, att2000, producción ni
datos históricos. Las pruebas fijan el comportamiento **actual** para poder
discutirlo; no el deseado.

Evidencia reproducible en `docs/evidence/horas-sin-tipo/`:
`protocolo.txt` (código y referencias del protocolo) y `matriz.md` (resultados).

## 1. ¿Quién pierde el tipo: el reloj o la librería?

**La librería no expone el campo. El reloj sí lo transmite en el registro.**

| Formato | Disposición del registro (pyzk, `zk/base.py → get_attendance`) | Qué devuelve node-zklib 1.3.0 |
|---|---|---|
| TCP, 40 bytes | `uid H` · `user_id 24s` · `status B` (byte 26) · `timestamp` (27) · **`punch B` (byte 31)** · 8 reservados | `userSn`, `deviceUserId` (sólo 9 de 24 caracteres), `recordTime` |
| UDP, 16 bytes | `user_id I` · `timestamp` (4) · `status B` (8) · **`punch B` (9)** · 2 reservados · `workcode I` | `deviceUserId` (2 de 4 bytes), `recordTime` |
| UDP, 8 bytes | `uid H` · `status B` (2) · `timestamp` (3) · **`punch B` (7)** | usa el decodificador de 16 bytes: **lee la hora corrida un byte** |

- `punch` es el **estado de marcación** del terminal: 0 entrada, 1 salida,
  2/3 descanso, 4/5 horas extra. Es el mismo dato que el reloj envía como
  `Status` en cada línea `ATTLOG` por ADMS/PUSH; el bridge lo recibe y lo mapea
  (`bridge/src/attlog.js`, formato verificado con una captura de un reloj en
  producción; `bridge/src/index.js → mapZKState`).
- `node-zklib` (`utils.js → decodeRecordData40/16`) lee usuario y hora y
  **descarta** `status` y `punch`. SisHoras sólo ve el objeto decodificado, así
  que el dato se pierde antes del lector: `raw_json` tampoco lo conserva.
- `api/tests/zkRecordLayout.test.js` lo demuestra con el decodificador real: un
  registro de 40 bytes con `punch = 1` en el byte 31 se decodifica sin ningún
  campo de tipo, aunque el byte está en el buffer.
- **No verificado:** que los relojes de la institución carguen `punch` con un
  valor útil. Depende de su configuración (teclas de estado o cambio automático
  por horario); un equipo sin estados configurados puede enviar siempre 0. Eso
  sólo se confirma con una lectura de un reloj real, que este lote no hace.

Hallazgos laterales de la librería, fuera de este lote: el id de usuario TCP se
corta a 9 caracteres y el formato UDP de 8 bytes lee la hora desalineada.

## 2. Circuito reproducido

`api/tests/it/untypedPunchHours.it.test.js`: API real → cola en MySQL aislado →
worker real en otro proceso (recálculo legacy, el writer del motor apagado) →
lector → `attendance_logs`. El reloj simulado usa el decodificador real; los
casos sin tipo **no** agregan `inOutStatus`. Controles: tipo explícito aportado
por la fixture (como #250) y contexto confiable (una salida manual del día
anterior). Después se evalúa el **motor de jornada existente** con
`resolveSummaryBatchForDate(..., { apply: false })` —sin horario vigente y con
un `employee_schedule_history` de la fixture— y se comprueba que
`daily_summary` no cambia. Resultado idéntico con jest en UTC, America/Asuncion
y Asia/Tokyo.

Matriz completa: `docs/evidence/horas-sin-tipo/matriz.md`. Resumen:

| Caso | Tipos (procedencia) | Legacy (lo que se escribe hoy) | Motor en evaluación | Emparejamiento del motor |
|---|---|---|---|---|
| dos marcas 08:00 / 17:00 | unknown, unknown (sin tipo) | `absent`, 0 min | 08:00→17:00, permanencia 540, neto 480 con horario; **sin anomalía** | **por posición** |
| una marca 08:00 | unknown | `absent`, 0 min | 08:00→abierto, 0 min, `entrada_sin_salida` | por posición |
| duplicados (08:00, 08:00:40, 17:00, 17:00:20) | 4 × unknown | `absent`, 0 min | 08:00→17:00, `marcaje_duplicado` | por posición |
| varias (08:00, 12:00, 13:00, 17:00) | 4 × unknown | `absent`, 0 min | 08:00–12:00 + 13:00–17:00, neto 480; **sin anomalía** | **por posición** |
| nocturna 22:00 → 06:00 | unknown, unknown | `absent` en ambas fechas | 22:00→06:00 del 05, 480 min; **sin anomalía** | **por posición** |
| CONTROL explícito 08:00 in / 17:00 out | explícito | 08:00→17:00, 480 | 08:00→17:00, neto 480 con horario | por tipos |
| CONTROL explícito nocturna | explícito | partida por fecha civil: 05 IN sin OUT, 06 OUT sin IN, 0 min | 22:00→06:00, 480 | por tipos |
| CONTROL contexto confiable | in/out **contextual** | 08:00→17:00, 480 | 08:00→17:00 | por tipos |

## 3. Qué muestran las pruebas

1. **Legacy con marcas sin tipo no produce horas** y además marca `absent` a
   quien sí fichó: no distingue «no vino» de «fichó sin tipo». Con tipos
   explícitos funciona en el día, pero parte la jornada nocturna por fecha civil
   (problema ya conocido).
2. **El motor existente produce horas «plausibles» emparejando por posición**
   (`DEFAULTS.typeAware`: «`unknown` cae en alternancia») y **no deja ninguna
   anomalía** que lo distinga de un emparejamiento por tipos: para dos marcas
   sin tipo devuelve exactamente lo mismo que con tipos explícitos. Activar hoy
   el writer del motor (FASE E) llevaría a `daily_summary` justamente la
   alternancia que no queremos introducir, sin rastro de incertidumbre. Las
   anomalías sí aparecen en los casos degenerados (una marca, duplicados).
3. **Sin horario con vigencia el motor no calcula tardanza ni descanso fijo**
   (`historical_fallback`): no usa `employees.schedule_id` a propósito y
   requiere `employee_schedule_history` (migraciones 072/073, no aplicadas en
   producción). Con la fila de la fixture pasa a `configured` y descuenta los
   60′ de descanso. En la nocturna, el horario diurno de la fixture produce
   835′ de «tardanza»: el horario tiene que corresponder al turno.
4. **El contexto confiable funciona**: una salida manual previa basta para
   inferir IN y después OUT con procedencia `contextual`. Pero el reloj por sí
   solo no genera contexto: si todas las marcas de un empleado vienen del
   reloj sin tipo, no hay anclas.

## 4. Qué falta para que las horas sean utilizables

| Necesidad | Estado | Quién la resuelve |
|---|---|---|
| **Tipo desde el dispositivo** | El reloj lo transmite; node-zklib lo descarta | Código (decodificar el byte) **y** verificación en un reloj real de que el valor es significativo |
| Contexto confiable | Sólo existe con marcas manuales, móviles, bridge o raw explícito | Operación; no alcanza para relojes sin tipo |
| Configuración con vigencia | `employee_schedule_history` sin aplicar ni cargar en producción | Ops (migraciones 072–080 autorizadas, pendientes) + carga de horarios |
| Motor | Empareja `unknown` por posición sin señalarlo | Cambio pequeño de trazabilidad antes de cualquier activación; activación gateada aparte |

## 5. Siguiente cambio propuesto (mínimo, sin política de inferencia)

> Actualización: el paso 1 (conservar el byte como dato crudo) y el reporte de
> solo lectura están implementados; ver §5.1.

**Conservar el estado de marcación que el reloj ya envía, como dato crudo de
diagnóstico, sin usarlo todavía como tipo.**

1. En `zktecoReader`, envolver `decodeRecordData40` / `decodeRecordData16` de
   `node-zklib/utils` (los módulos `zklibtcp`/`zklibudp` lo toman al cargarse, y
   `openZK` los carga después del lector) para agregar al registro
   `zkPunchState` (byte 31 / byte 9) y `zkVerify` (byte 26 / byte 8). El nombre
   **no** está en `INOUT_FIELDS`: el resolver, el legacy y el motor siguen
   ignorándolo, así que **no cambia ninguna hora**. Queda en `raw_json`.
2. Un reporte de solo lectura por reloj: distribución de `zkPunchState` en lo
   leído (cuántos 0, 1, 2–5), para decidir con datos si cada equipo lo carga.
3. Pruebas: el decodificador real con el byte cargado → el campo aparece en
   `raw_json`; el tipo guardado y `daily_summary` no cambian; prueba que falla si
   una actualización de node-zklib deja de pasar por el envoltorio.

Recién con esa distribución, y con autorización, el paso siguiente sería
habilitar **por reloj** el mapeo `zkPunchState` 0/1 → `in`/`out` por el camino
de tipo explícito que ya existe (`classifyExplicit`), sin alternancia. En
paralelo, y antes de cualquier activación del writer del motor, conviene que el
motor marque como anomalía los tramos emparejados por posición, para que la
consola de FASE E y los reportes muestren la incertidumbre que hoy es invisible.

## 5.1 Estado crudo conservado (implementado)

El paso 1 de la propuesta ya está en el código (`api/src/services/zkRawCapture.js`).
Cada registro leído por `node-zklib` lleva en `raw_device_punches.raw_json`:

| Campo | Contenido |
|---|---|
| `zkCapture` | `ok` · `longitud_inesperada` · `no_disponible` |
| `zkRecordFormat` | `tcp40` · `udp16` · `udp8` (sólo con `ok`) |
| `zkPunchState` | byte de estado de marcación, 0–255, sin interpretar (sólo con `ok`) |
| `zkVerify` | byte de modo de verificación, 0–255, sin interpretar (sólo con `ok`) |
| `zkRecordLength` | longitud recibida (sólo con `longitud_inesperada`) |

- **Crudos, no tipo.** Los nombres no coinciden con los campos que reconoce el
  resolvedor (`inOutStatus`, `state`, `status`, `type`, `inout`); no cambian
  tipos, horas, deduplicación, vínculos ni recálculo. Las pruebas lo verifican:
  la matriz de §2 es idéntica antes y después, y la IT `zkRawState` compara
  asistencia, tipos, staging y `daily_summary` con y sin captura.
- **Captura omitida, explícita.** Los decodificadores se envuelven al cargarse el
  lector, antes de que `openZK` cargue `node-zklib` (los módulos `zklibtcp` y
  `zklibudp` toman el decodificador al cargarse). Si `node-zklib` se cargó antes,
  la captura no ocurre: el registro queda `zkCapture: 'no_disponible'`, **sin
  inventar un 0**; la lectura informa la cantidad (`raw_state_missing` en
  `device_sync_runs.attempts_detail`) y, en Node, se avisa en el log. Lo mismo
  vale para lecturas inyectadas sin decodificador. Verificado: en la API y en el
  worker el lector se carga antes que `node-zklib`.
- **Formatos.** TCP de 40 bytes (byte 31 / 26), UDP de 16 (9 / 8) y UDP de 8
  (7 / 2). El formato de 8 bytes conserva los bytes, pero su **hora sigue
  desalineada**: ese defecto, y el corte del id TCP a 9 caracteres, quedan
  separados y sin corregir.
- **Reporte de solo lectura.** `GET /api/devices/:id/raw-state-report?from&to`
  (admin/gestor; rango obligatorio de hasta 92 días; marcas `zkteco_direct`):
  conteos por estado de captura, por formato y por cada valor observado de cada
  byte, más `invalido` y `ausente`. Sin nombres, ids de usuario o empleado ni
  marcaciones individuales. `sin_registro` cuenta marcas guardadas antes de este
  cambio; `sin_raw_json`, marcas sin crudo.

**Qué no demuestra.** Disponer del byte **no** prueba qué significa en cada
reloj ni cómo está configurado el equipo: 0/1 sólo indica entrada/salida si el
terminal tiene teclas de estado o cambio automático configurados. Todo lo
anterior está verificado con **fixtures** (bytes sintéticos con la disposición
de pyzk, pasados por las clases reales de `node-zklib`). El estado de
**producción no está verificado**: qué formato usan los relojes, si el byte
varía y con qué valores sólo se sabrá con el reporte sobre lecturas reales,
cuando se autorice. Habilitar un mapeo a tipo es una decisión posterior.

## 6. Relación con #250

Las pruebas de #250 (`zkWallClock.it.test.js`) validan el **recálculo con tipos
explícitos aportados por la fixture** (`inOutStatus` agregado al registro
decodificado), no con marcas sin tipo. Este documento cubre ese otro caso.

## Reproducción

```bash
cd api
# MySQL 8 aislado con init.sql + migraciones; variables DB_* hacia esa base.
IT_DB=1 TZ=UTC UNTYPED_HOURS_EVIDENCE_OUT=/tmp/matriz.json \
  npx jest tests/it/untypedPunchHours.it.test.js --runInBand
node ../docs/evidence/horas-sin-tipo/matriz.js /tmp/matriz.json
npx jest tests/zkRecordLayout.test.js tests/zkRawCapture.test.js
IT_DB=1 npx jest tests/it/zkRawState.it.test.js --runInBand
```
