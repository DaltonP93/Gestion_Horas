# Motor de jornada (`workdayEngine`)

Este documento explica qué hace el motor, qué números cambia respecto del
armado anterior y cómo verificarlo contra datos reales **sin tocar nada**.

> **Estado.** El motor está integrado en el reporte de Marcadas. La migración
> `072_employee_schedule_history.sql` **no fue ejecutada en producción** y
> `daily_summary` **no fue recalculado**. Habilitar cualquiera de las dos cosas
> es una decisión aparte, posterior a la validación descrita más abajo.

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
| `maxSegmentMinutes` | 16 h | por encima de esto, la salida nunca se marcó |
| `maxGapMinutes` | 4 h | pausa que todavía es la misma jornada |
| `maxSpanMinutes` | 20 h | tope de duración total de una jornada |
| `dedupeSeconds` | 60 s | ráfaga del reloj = un solo fichaje |
| `typeAware` | `true` | el `type` explícito manda; `unknown` cae en alternancia |

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

Hay un tramo de `employee_schedule_history` que **cubre esa fecha**. Se agregan
atraso, salida anticipada, jornada esperada y el objetivo semanal.

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
del período. Medición sobre 300 empleados × 365 días × 4 marcajes (438.000
marcajes, sólo el trabajo en proceso, sin contar el result-set del driver):

| | pico de heap | tiempo | filas |
|---|---|---|---|
| todo en un array (anterior) | +165,7 MB | 7.220 ms | 109.500 |
| por lotes de 50 (motor) | **+43,1 MB** | **1.618 ms** | 109.500 |

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

## 10. Qué queda pendiente

- `daily_summary` **no** fue recalculado. El código del resumen diario sigue
  siendo el de antes; el motor todavía no lo alimenta.
- La migración 072 **no** fue ejecutada en producción.
- No hay UI para cargar tramos de vigencia todavía.
- `legacyWorkday.js` es código muerto por diseño: existe sólo como referencia
  de auditoría. Cuando el motor esté validado y ya no haga falta comparar, se
  borra entero.
