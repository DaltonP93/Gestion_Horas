# Motor de jornada (`workdayEngine`)

Este documento explica qué hace el motor, qué números cambia respecto del
armado anterior y cómo verificarlo contra datos reales **sin tocar nada**.

> **Estado.** El motor está integrado en el reporte de Marcadas. Las migraciones
> `072` y `073` **no fueron ejecutadas en producción** y `daily_summary` **no fue
> recalculado**. Habilitar cualquiera de las dos cosas es una decisión aparte,
> posterior a la validación descrita más abajo.

---

## 1. Por qué existe

El armado de jornada vivía duplicado en dos lugares que no se hablaban entre
sí:

| | dónde | qué hacía |
|---|---|---|
| Marcadas | `scheduler.generateMarcadasReport()` | agrupaba por "fecha laboral" con corte fijo a las 05:00 y emparejaba por posición |
| Resumen diario | `attendanceController.recalcDailySummary()` | tomaba los marcajes de una fecha civil y calculaba primera entrada / última salida |

Los dos daban resultados distintos para la misma persona y el mismo día, y los
dos se equivocaban en turno nocturno.

---

## 2. Defectos corregidos, con evidencia

### 2.1 Reinterpretación horaria del histórico

`scheduler.toDate()` fijaba `-03:00` sobre el `DATETIME` guardado y después
formateaba con `Intl` y `America/Asuncion`, que **sí** aplica la tzdata
histórica. Paraguay estuvo en UTC-4 hasta el **2024-10-06**.

```
guardado 2024-08-01 08:00:00  →  se imprimía 07:00 del 01/08/2024
guardado 2024-06-15 00:30:00  →  se imprimía 23:30 del 14/06/2024
```

El segundo caso **cambia de día**: la marca se contabilizaba en otra jornada.

Un detalle que explica por qué esto convivió tanto tiempo con reportes que
"cerraban": en un día diurno normal **el total no cambia**. El desfase es el
mismo en la entrada y en la salida, y se cancela al restar. El defecto se veía
en las columnas de hora, no en la de total.

### 2.2 Corte fijo a las 05:00

La regla "las marcas antes de las 05:00 pertenecen al día anterior" es una
heurística sobre el reloj, no sobre la jornada. Falla en los dos sentidos:

- una salida a las **07:04** del día siguiente quedaba asignada al día
  siguiente, partiendo en dos una jornada que empezó a las 18:30;
- una salida a las **05:29** quedaba en su propio día por 29 minutos.

### 2.3 Emparejamiento posicional

Emparejar por índice (par = entrada, impar = salida) ignora
`attendance_logs.type`: un marcaje espurio corre **todos** los pares del día.

La deduplicación tenía el mismo problema: colapsaba cualquier par de marcajes
dentro de 60 segundos **sin mirar el tipo**. Una entrada a las 08:00:00 y una
salida a las 08:00:30 se convertían en una sola marca, el tramo quedaba abierto
y la jornada perdía todos sus minutos. Ahora se colapsa sólo cuando los tipos
son compatibles — iguales, o alguno todavía sin determinar.

### 2.4 El bug `24:xx`

Con `hour12: false`, algunas combinaciones de locale e ICU resuelven a
`hourCycle: 'h24'` —que es lo que hace el runtime de producción— y entonces la
medianoche se numera 24 en vez de 0:

```
00:05 → 24:05      00:58 → 24:58      01:02 → 01:02
```

Y el corte por hora se rompe: `pyHour(00:05)` da **24**, así que `24 < 5` es
falso y la marca de la madrugada **no** se asigna al día anterior — mientras
que `pyHour(01:02)` da 1 y sí se asigna.

Es un defecto **dependiente del entorno**: en un contenedor con ICU completo,
`es-PY` resuelve a `h23` y el bug **no se reproduce**. Eso significa que el
reporte venía dando resultados distintos en el servidor y en CI. El test que lo
cubre fuerza el `hourCycle` en lugar de confiar en el entorno.

El motor es inmune por construcción: **no invoca `Intl`**, y hay un test que lo
verifica sobre el fuente. Si nadie llama a `Intl`, ningún `hourCycle` puede
afectar el resultado.

---

## 3. El modelo

```
marcaje  →  segmento (entrada→salida)  →  jornada (1..n segmentos)
```

Una jornada agrupa segmentos consecutivos separados por pausas cortas. Su
`work_date` es la **fecha civil de la primera entrada**, no la de cada marca.
Es la única definición que hace que un turno 18:30 → 07:04 sea una jornada del
día que empezó.

### Parámetros de forma

Ninguno codifica una regla legal. Todos son configurables por llamada.

| parámetro | por defecto | qué decide |
|---|---|---|
| `historicalMaxSessionSpanMinutes` | 16 h | por encima de esto, la salida nunca se marcó |
| `historicalMaxIntersegmentGapMinutes` | 4 h | pausa que todavía es la misma jornada |
| `historicalMaxWorkdaySpanMinutes` | 20 h | tope de duración total de una jornada |
| `duplicateWindowSeconds` | 60 s | ráfaga del reloj = un solo fichaje |
| `typeAware` | `true` | el `type` explícito manda; `unknown` cae en alternancia |
| `nightStartMinute` / `nightEndMinute` | `null` | franja nocturna; sin definir, `night_minutes` = 0 |

### Casos dorados

| caso | marcajes | resultado |
|---|---|---|
| nocturno simple | 01/12 18:30 → 02/12 07:04 | **12:34** en la jornada del **01/12** |
| nocturno partido | 21:32→00:05 y 01:02→05:29 | **2:33 + 4:27 = 7:00**, una sola jornada |
| diurno con almuerzo | 08:00-12:00, 13:00-17:00 | permanencia 9:00, trabajado 8:00, pausa 60 |

---

## 4. Tres totales que no son sinónimos

Confundirlos es por qué los dos reportes nunca cerraron entre sí.

| campo | qué es | quién lo usa |
|---|---|---|
| `presence_minutes` | primera entrada → última salida (el almuerzo adentro) | es lo que `daily_summary.worked_minutes` viene guardando |
| `segment_minutes` | suma de los tramos entrada→salida | es lo que la columna "Total" de Marcadas suma |
| `worked_minutes` | `segment_minutes` menos el descanso a descontar | depende del modo de descanso |
| `contract_excess_minutes` | lo trabajado por encima del objetivo | **no es hora extra legal** |

`contract_excess_minutes` mide un hecho: trabajar 9 h contra un objetivo de 6 da
3 h de exceso. Si esas horas se liquidan como extraordinarias, al 50 %, o se
compensan con descanso, es una decisión de convenio que el motor **no toma**.
Llamarlo `overtime` sería decidirla por omisión.

Lo mismo con `night_minutes` / `day_minutes`: el motor mide cuántos minutos
cayeron en la franja nocturna **configurada** y deja la valorización a quien
tenga la política. Sin franja definida, `night_minutes` es 0 — poner
20:00→06:00 "porque es lo usual" sería meter una regla laboral por la ventana.

En un día con almuerzo marcado de una hora: permanencia 540, tramos 480.
Comparar uno contra otro da una diferencia de 60 minutos que **no es un error**,
son dos números distintos.

---

## 5. Los dos modos

El modo se decide **por fecha**, nunca por empleado: la misma persona puede
estar en `historical_fallback` en 2024 y en `configured` en 2026.

### `historical_fallback`

No hay configuración vigente para esa fecha. Sólo se describe lo que los
marcajes dicen: segmentos, permanencia, tiempo trabajado. **No** se calcula
atraso ni horas extra, porque no hay contra qué compararlos.

Es el modo del histórico. `employees.schedule_id` guarda el horario de **hoy**
y no tiene fecha; aplicarlo a 2024 fabricaría atrasos que nunca existieron. Si
a alguien se le cambió el turno de 08:00 a 07:00 en 2026, todo 2024 aparecería
llegando una hora tarde.

### `configured`

Hay configuración que **cubre esa fecha**. Se agregan atraso, salida
anticipada, jornada esperada y el objetivo semanal.

**Precedencia**, resuelta por fecha:

1. `shift_assignments` de una turnera **publicada** para esa fecha exacta. Un
   borrador no se usa: calcular contra una propuesta que RRHH todavía está
   armando produciría atrasos por un turno que nunca se comunicó.
2. `employee_schedule_history` vigente para esa fecha.
3. `employee_contracts` vigente — sólo aporta carga horaria. Por sí solo **no**
   habilita el modo `configured`: sin hora de entrada no hay atraso que
   calcular.
4. Nada → `historical_fallback`.

`employees.schedule_id` **no participa**, y hay un test que verifica que
ninguna de las consultas emitidas la lee.

Un día de turnera marcado `off`/`vacation`/`permiso` **no** devuelve horario:
devolverlo haría que quien está de vacaciones figure llegando tarde todos los
días. La jornada se describe sin horario y conserva el motivo en
`non_working_kind`.

`weekly_target_minutes` en `NULL` significa "no hay objetivo definido" y el
motor **no inventa uno**. Las 48 h paraguayas se cargan como `2880`, igual que
45, 42, 36, 32, 24 o 20 h, que son jornadas reales del padrón.

### Modos de descanso

| modo | qué hace |
|---|---|
| `none` | no descuenta nada |
| `fixed_unpaid` | descuenta un fijo, nunca más de lo trabajado, y sólo si la jornada supera `break_after_minutes` |
| `punched` | el descanso es el que se marcó entre tramos; **ya está fuera** de la suma de tramos y no se resta de nuevo |

---

## 6. Bordes del período

El recorte al período se hace por `work_date`, no por la fecha de cada marca.
Un turno que entra el **31/12 a las 22:00** y sale el **01/01 a las 06:00** es
una jornada de diciembre **completa**; cortarla por fecha de marca la partiría
al medio y perdería seis horas.

Para que eso funcione, la lectura de marcajes se extiende un día a cada lado
del período (`punchWindow`). El límite superior es exclusivo.

**Reporte de Marcadas — empleados vacíos.** Un empleado activo sin ninguna
jornada dentro del período **no aparece** en el reporte. Antes se incluía con
`rows: []` y total 0, lo que en el PDF generaba páginas en blanco. El filtro se
aplica **después** del recorte por `work_date`: puede haber marcajes en la
ventana ampliada que son sólo contexto del día anterior o siguiente y no una
jornada del período.

---

## 6 bis. El día sin marcaje — `expected_workday`

Un día sin fichajes **no es automáticamente una ausencia**. El sistema
distingue tres cosas, y la diferencia es la que evita fabricar miles de
ausencias falsas en el histórico 2022-2025:

| `expected_workday` | significado | estado del día vacío |
|---|---|---|
| `true` | la configuración dice que **debía** trabajar | `absent` |
| `false` | la configuración dice que era **libre** | `non_working` / `permission` |
| `null` | **no hay configuración**: no sabemos | `unconfigured` |

`expected_workday` sale de la **configuración efectiva**, nunca de que sea
sábado o domingo. SisHoras tiene gente que trabaja domingo, descansa un día de
semana o rota por Turnera; hardcodear el fin de semana contradiría esa
configuración. La convención de `schedules.work_days` es **DAYOFWEEK**
(`1=Domingo … 7=Sábado`, migración 046); el motor la compara sumando 1 al día
JS.

**Precedencia del estado en un día sin marcaje:**

1. Turnera `vacation` / `permiso` → `permission`.
2. Feriado → `holiday`. Se evalúa **antes** que la ausencia a propósito: un
   feriado nacional cae en día laborable, y marcar `absent` a todo el padrón
   cada feriado sería la ausencia masiva que se quiere evitar. `expected_workday`
   no se pierde: viaja aparte.
3. Turnera `off` o día excluido por `work_days` → `non_working`.
4. Día incluido por `work_days` (o turnera de trabajo) → `absent`.
5. Sin configuración → `unconfigured`.

Los estados `non_working` y `unconfigured` **no existen** en el ENUM actual de
`daily_summary.status`. Persistirlos requiere la migración **074** (propuesta,
aditiva, **no ejecutada**). Mientras tanto el motor los emite igual para el
dry-run y la auditoría; sólo falta poder guardarlos, y eso importa recién
cuando se habilite la escritura.

## 6 ter. Dos jornadas en la misma fecha

`daily_summary` es una fila por empleado y fecha, pero una persona puede tener
**dos jornadas reales el mismo día** (06:00-10:00 y 16:00-20:00, separadas por
más que la pausa máxima). Descartar una perdería sus horas, así que se
**agregan** de forma determinista:

- `first_in` = primera entrada de todas; `last_out` = última salida de todas.
- `presence_minutes` = span total (primera entrada → última salida).
- tramos, trabajado, descanso, diurno/nocturno = **suma**.
- `late_minutes` = de la primera jornada (el atraso es sobre la llegada del día).
- se marca la anomalía `multiple_workdays_same_date` para que el caso quede
  visible y revisable, no agregado en silencio.

El exceso contractual (`contract_excess_minutes`) queda en `null` al agregar:
depende del objetivo diario contra el total, y sumarlo por jornada arrastraría
el objetivo dos veces. La anomalía señala que hay que revisar cómo se valoriza.

---

## 7. Verificar contra datos reales — sin escribir nada

```bash
cd api

# Un mes, todos los empleados
node scripts/workday-engine-audit.js --from 2024-12-01 --to 2024-12-31

# Un empleado, un año, con detalle en archivo
node scripts/workday-engine-audit.js \
     --from 2025-01-01 --to 2025-12-31 --employee 3091 --out ./auditoria

# Además, contrastar contra las filas ya guardadas de daily_summary
node scripts/workday-engine-audit.js \
     --from 2025-01-01 --to 2025-01-31 --daily-summary
```

El script corre **los dos algoritmos** —el anterior, congelado en
`src/services/legacyWorkday.js`, y el motor— sobre los **mismos marcajes
reales**, y clasifica cada diferencia:

| causa | qué significa |
|---|---|
| `turno_nocturno` | el legacy partió la jornada por el corte de las 05:00 |
| `desfase_horario` | el legacy formateó con la tzdata histórica |
| `emparejamiento` | el tipo del marcaje contradice el orden posicional |
| `otro` | **no explicado por lo anterior — hay que mirarlo a mano** |

La categoría `otro` existe justamente para no dar por explicado lo que no lo
está. Si aparece con volumen, es señal de parar y revisar antes de seguir.

### Garantías del auditor

- No contiene **ninguna** sentencia `INSERT`, `UPDATE`, `DELETE`, `REPLACE`,
  `TRUNCATE`, `DROP` ni `ALTER`.
- No sabe conectarse a **ATT2000**: no requiere `mssql` ni lee `ATT_*`.
- `tests/workdayAuditReadonly.test.js` verifica todo eso **sobre el fuente**,
  para que la garantía no dependa de que nadie edite el encabezado.

`--daily-summary` compara contra `presence_minutes`, que es el concepto que
`daily_summary.worked_minutes` guarda. Es una **simulación**: dice qué
cambiaría un recálculo, sin recalcular.

---

## 8. Memoria y rendimiento

El reporte cargaba **todos** los marcajes del período en un array y recién
después agrupaba, así que el pico de memoria crecía con el largo del rango.
Contra un `max_memory_restart` de 512 MB, con RSS observado de hasta 1,28 GB,
eso es el reinicio del proceso y el 502 que lo acompaña.

Ahora la lectura es por lotes de empleados y el pico depende del **lote**, no
del período. El RSS casi no se mueve en el camino nuevo porque **nunca
materializa el dataset completo**: lo que crecía con el largo del período era
exactamente eso.

### Mock vs. servidor — qué demuestra cada uno

El test de memoria de CI (`marcadasMemory.test.js`) demuestra una **propiedad
estructural** con la base mockeada: que el reporte no retiene memoria entre
corridas. **No** mide el RSS real del API, porque no hay `mysql2`, ni
`sequelize`, ni `PDFKit`, ni el runtime productivo. Esa brecha se cierra
corriendo el benchmark **en el servidor**, en horario de baja carga:

```bash
node --expose-gc scripts/benchmark-marcadas-memory.js --iterations 5 --out ./bench
```

Escenarios: `json-mes`, `json-dos-meses`, `json-trimestre`, `pdf-mes` (y
`json-empleado` con `--employee`). El PDF se mide con el **mismo**
`renderMarcadasPdf` que sirve la ruta —extraído a `services/marcadasPdf.js`
justamente para eso—, no con una copia. Informa `rss`, `heapUsed`, `heapTotal`
y `external` —dicen cosas distintas: `rss` es lo que mira PM2 para reiniciar,
`external` cubre los `Buffer` donde vive el PDF— y sale con código 1 si algún
escenario supera los 512 MB o si crece de forma sostenida entre corridas.
**Nunca lo ejecuta Claude contra producción.**

Medición local (mock, sin driver; 300 empleados × 62 días × 4 marcajes =
74.400 marcajes, 4 iteraciones):

| | pico | tiempo |
|---|---|---|
| todo en un array (anterior) | +46,2 MB RSS / +35,8 MB heap | 1.209 ms |
| por lotes de 50 (motor) | **+0,3 MB RSS / +29,1 MB heap** | **250 ms** |

Además, el rango pasó a ser sargable: `al.timestamp >= ? AND < ?` en lugar de
`DATE(al.timestamp) BETWEEN ? AND ?`, que obligaba a evaluar la función sobre
cada fila y no podía usar `idx_emp_ts`.

Hay también un **tope duro** de marcajes por lote: si el rango es desmesurado,
el reporte falla con un mensaje que dice qué achicar, en vez de morir por OOM y
llevarse puestas las peticiones en vuelo. Un 502 sin explicación es peor que un
error explícito.

> **No** se subió `max_memory_restart`. Subir el tope esconde el síntoma y deja
> el crecimiento sin acotar; el problema era la forma de leer.

---

## 9. Habilitar la configuración por vigencia

La migración 072 crea `employee_schedule_history` **vacía a propósito**.
Llenarla con la asignación actual y una fecha inventada sería exactamente el
error que viene a evitar.

Mientras la tabla no exista o esté vacía, `workdayConfig.loadScheduleHistory()`
devuelve historial vacío y todas las jornadas quedan en `historical_fallback`
— que es el comportamiento correcto. La degradación es ante *"la tabla no
existe"* (`42S02`) específicamente: una caída de MySQL sigue propagándose,
porque devolver "sin configuración" ante una base caída convertiría una falla
de infraestructura en números silenciosamente distintos.

**Rollback de la migración:**

```sql
DROP TABLE IF EXISTS employee_schedule_history;
DELETE FROM schema_migrations
 WHERE filename = '072_employee_schedule_history.sql';
```

Al ser aditiva y nacer vacía, revertirla no puede perder datos previos.

---

## 9 bis. `daily_summary` como materialización del motor

`dailySummaryEngine.js` convierte la salida del motor en la fila de
`daily_summary`. A partir de ahí el resumen diario es una **caché consultable**
del motor, no un segundo algoritmo.

**La decisión que el código no toma solo:** `daily_summary.worked_minutes` viene
guardando *permanencia* (primera entrada → última salida). El motor llama a eso
`presence_minutes`. El modo por defecto es `presence`, que **conserva la
semántica histórica**; pasar la columna a tiempo neto es opt-in explícito,
porque hacerlo en silencio movería todos los números históricos de RRHH.

Para medir el impacto antes de habilitar nada:

```bash
node scripts/daily-summary-dryrun.js --from 2025-01-01 --to 2025-01-31
```

Contrasta fila por fila contra lo guardado y clasifica cada diferencia **por
campo**. Cuenta aparte:

- **las filas guardadas que el motor ya no produce** —el turno nocturno que el
  algoritmo anterior partía en dos días—, que no es una diferencia de minutos
  sino de estructura;
- **`unconfigured_no_punches`** —días sin configuración histórica y sin
  marcajes—, que **no se cuentan como diferencia funcional**: sin horario
  cargado no sabemos si hubo ausencia, y contarlos convertiría la falta de
  configuración de 2022-2025 en miles de ausencias falsas.

**No escribe nada.**

---

## 10. Qué queda pendiente

- `daily_summary` **no** fue recalculado y el camino de escritura sigue siendo
  el anterior: `dailySummaryEngine` está listo pero nadie lo invoca todavía.
- Las migraciones 072, 073 y 074 **no** fueron ejecutadas en producción. La
  074 (ENUM `non_working`/`unconfigured`) es requisito para PERSISTIR esos
  estados; hasta entonces el motor los emite pero no se pueden guardar.
- `employee_contracts` todavía **no** tiene carga horaria: hoy el contrato
  aporta identidad y vigencia, no objetivo semanal. Esa carga es FASE C.
- No hay UI ni escritor para cargar tramos de vigencia todavía (FASE C). Cuando
  se construya, **debe snapshotear `work_days`** (y los demás campos derivados
  del horario) en cada tramo: la columna `employee_schedule_history.work_days`
  existe para eso, pero mientras quede `NULL` la consulta cae al `schedules`
  vivo y editar un horario volvería a reescribir la expectativa histórica. Hoy
  el hueco es latente porque no hay ningún tramo cargado.
- `legacyWorkday.js` es código muerto por diseño: existe sólo como referencia
  de auditoría. Cuando el motor esté validado y ya no haga falta comparar, se
  borra entero.
