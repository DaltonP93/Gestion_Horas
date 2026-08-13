# Auditoría de reportes — hallazgos

Fase de sólo lectura. No se modificó ningún dato histórico ni se ejecutó
ningún `UPDATE`. Las consultas para producción están en
[`sql/auditoria-reportes-readonly.sql`](sql/auditoria-reportes-readonly.sql)
y son todas `SELECT`/`EXPLAIN`.

Cada hallazgo dice si está **demostrado en el código** (se puede verificar sin
tocar producción) o si es una **hipótesis** que requiere las consultas.

---

## Resumen

| # | Defecto reportado | Causa | Estado |
|---|---|---|---|
| 6 | PDF mensual imprime `2025` en Entrada/Salida | `String(Date).slice(11,16)` cae sobre el año | **Demostrado** |
| 7 | Segunda página sólo para la firma | `sigY` siempre supera el umbral con un mes completo | **Demostrado** |
| 4 | 502 en períodos grandes | `Math.max(...)` revienta > ~125.000 elementos | **Demostrado** |
| 4 | 502 en períodos grandes | El filtro por departamento se ignora → siempre consulta toda la empresa | **Demostrado** |
| 4 | 502 en períodos grandes | Doble request en `handleGenerar` | **Demostrado** |
| 5 | Selector de empleado incómodo | `<select>` plano, y tope de 500 empleados | **Demostrado** |
| 2, 3 | Horas históricas incorrectas | Desfase de **1 hora estacional**, no de 3 | **Hipótesis fuerte** — requiere Q1–Q4 |

---

## A. Horas históricas

### El corte real es 2024-10-06, no 2023

`api/src/config/database.js:12` declara:

```js
timezone: '-03:00', // Paraguay UTC-3 permanente (eliminó DST en 2023, America/Asuncion)
```

El comentario es incorrecto. Según la tzdata (fuente autoritativa, verificable
con `Intl`), las transiciones de `America/Asuncion` fueron:

```
2023-03-26   -3 → -4
2023-10-01   -4 → -3
2024-03-24   -3 → -4
2024-10-06   -4 → -3     ← última transición; desde acá es permanente
```

Paraguay siguió aplicando horario de verano **hasta 2024**. El invierno de 2024
todavía fue **UTC-4**. La zona quedó fija en UTC-3 recién el **2024-10-06**.

### Por qué el desfase es de 1 hora y no de 3

La cadena tiene dos conversiones que no coinciden:

1. **Lectura.** `sequelize` está configurado con `timezone: '-03:00'` fijo, así
   que mysql2 interpreta todo `DATETIME` como si fuera UTC-3, sin importar la
   fecha.
2. **Presentación.** `fmtTime` (`scheduler.js:171`) formatea con
   `Intl.DateTimeFormat('es-PY', { timeZone: 'America/Asuncion' })`, que **sí**
   respeta la tzdata histórica y aplica UTC-4 donde corresponde.

Para una marca de invierno de 2024 guardada como hora de pared `08:00`:

```
lectura     08:00 interpretado como -03:00  →  instante 11:00Z
presentación 11:00Z formateado en America/Asuncion (-04:00 ese día)  →  07:00
```

Se muestra **07:00 en vez de 08:00**: una hora menos, y sólo en los meses en que
Paraguay estaba en UTC-4. En verano las dos conversiones coinciden y el valor
sale bien. Después del 2024-10-06 también coinciden — por eso **las fechas
recientes son correctas**, exactamente como se observó.

> Esto confirma que **restar 3 horas en bloque rompería los datos**. El desfase
> es de 1 hora y es estacional: afecta aproximadamente de fines de marzo a
> principios de octubre, en los años ≤ 2024.

`toDate()` (`scheduler.js:33-41`) repite la misma suposición fija `-03:00` para
valores string. Hoy no se activa —mysql2 devuelve `Date`, no string— pero es la
misma clase de error esperando otro driver o configuración.

### ¿Datos o presentación?

**Todavía no se puede afirmar.** El código explica un error de *presentación*
consistente con lo observado, pero hay dos escenarios más y sólo los datos los
distinguen:

- Si `attendance_logs.timestamp` guarda hora de pared de Paraguay, el dato está
  bien y basta arreglar la conversión → **no hay que tocar históricos**.
- Si algún import histórico grabó el instante ya convertido, el dato está mal
  en origen → hay que corregirlo, pero con un factor **por fecha**, no global.
- Si `daily_summary` congeló valores calculados con la conversión vieja, el
  resumen tiene error propio y hay que recalcularlo aunque los logs estén bien.

Las consultas **Q1** (deduce el offset aplicado comparando `timestamp` contra
`created_at`), **Q3** (mismo empleado en cuatro ventanas) y **Q4**
(`daily_summary` vs. logs) responden exactamente esto. **Q4 es la que decide si
hace falta recálculo.**

### Un síntoma cruzado que sirve de confirmación

`/api/reports/daily-detail` (`reports.js:133`) formatea con
`DATE_FORMAT(al.timestamp,'%H:%i')` **en SQL**, sin pasar por JS. Ese camino
muestra la hora de pared cruda, sin conversión.

Por lo tanto, para una fecha histórica de invierno, **la misma marca debería
verse una hora distinta** en el detalle diario que en el reporte de marcadas.
Si eso se reproduce en producción, el error es de presentación y los datos
están intactos.

---

## B. El 502 de `/api/reports/marcadas`

Tres causas independientes, todas demostrables sin tocar producción.

### B1. `Math.max(...)` revienta el stack — la más severa

`reports.js:187` y `web/.../reportes/page.tsx:88`:

```js
const maxPairs = Math.max(...employees.flatMap(e => e.rows).map(r => r.pairs.length), 1)
```

El array tiene un elemento por combinación (empleado × día con marcajes). El
spread de V8 lanza `RangeError: Maximum call stack size exceeded` a partir de
**~125.000 elementos** (medido). 400 empleados por un año de marcajes ya está en
ese orden.

No es lentitud: es una **excepción**, y explica por qué falla en períodos
históricos/grandes y nunca en un día suelto. La consulta **Q6** devuelve ese
número exacto para cada rango.

### B2. El filtro por departamento nunca llega

La web manda `departmentId` (`page.tsx:64`) y la API lee `deptId`
(`reports.js:100`). El parámetro se descarta en silencio: **elegir un
departamento consulta igual a toda la empresa.**

Es un bug por sí solo y además multiplica el volumen que dispara B1.

### B3. Doble request por cada click

```js
function handleGenerar() { setQueried(true); refetch() }
```

Con `queried` en `false`, la query está deshabilitada (`enabled: queried`).
`setQueried(true)` ya dispara el fetch; el `refetch()` explícito dispara un
**segundo request idéntico** en paralelo. Se duplica el trabajo del servidor en
la consulta más cara del sistema.

Tampoco hay `AbortController`: cambiar el rango mientras corre una consulta
pesada deja la anterior corriendo en el servidor.

### Sobre los índices

`attendance_logs` **sí** tiene índice funcional `idx_date ((DATE(timestamp)))`,
así que `DATE(al.timestamp) BETWEEN ? AND ?` no es necesariamente un full scan
—al contrario de lo que sugiere la forma de la consulta—. **Q7** compara el plan
real contra la variante por rango medio-abierto; sólo con esa salida se puede
decidir si vale la pena cambiar la cláusula. No conviene "optimizar" a ciegas.

**Subir el timeout de Nginx no corresponde**: B1 es una excepción inmediata, no
un timeout, y B2/B3 son trabajo evitable.

### Mediciones reproducibles propuestas

1. Ejecutar **Q5** y **Q6**: dan filas y `pares_emp_dia` por rango. Si Q6 supera
   125.000, el 502 queda explicado sin más.
2. Ejecutar **Q7** y guardar ambos planes.
3. Reproducir en un entorno de prueba con el rango que falla y confirmar en el
   log de la API que el error es `RangeError`, no un timeout.
4. Medir con y sin el arreglo de `deptId`, para cuantificar B2 por separado.

---

## C. PDF

### C1. El `2025` — demostrado

`reports.js:565-566` (PDF) y `652-653` (Excel):

```js
rec.first_in ? String(rec.first_in).slice(11,16) : ''
```

El corte 11..16 asume el formato MySQL `"YYYY-MM-DD HH:mm:ss"`. Pero mysql2
devuelve `DATETIME` como objeto `Date`, y `String(date)` produce el formato de
JS:

```
"Tue Aug 12 2025 08:15:00 GMT+0000 (...)"
            ↑↑↑↑
  slice(11,16) → "2025 "
```

Comprobado ejecutando ambos casos: sobre el string MySQL da `08:15`; sobre el
`Date` da `2025`. Es determinista, no depende de los datos.

Corresponde un helper de formateo con zona explícita, en vez de cortar strings.
**Nota:** ese helper hereda la discusión de la sección A — debe usar la zona
real por fecha, no un offset fijo.

### C2. La página extra de firma — demostrado

Con A4 apaisado (595 pt de alto) y un mes de 31 filas de 12 pt:

```
y tras 31 filas          = 502
umbral de corte de fila  = 535   → la tabla entra
sigY = y + 6 + 40        = 548
umbral de firma          = 465   → NO entra → addPage()
```

La condición `if (sigY < doc.page.height - 130)` (`reports.js:586`) **nunca** se
cumple con un mes completo. La segunda página no es un caso borde: es el
comportamiento normal.

El PDF mensual **ya es** `layout: 'landscape'` (`reports.js:494`); lo que falta
es presupuestar el alto: reservar el bloque de firma antes de dibujar las filas,
compactar la altura de fila y romper página sólo cuando de verdad no entre.

---

## D. Selector de empleado

Hoy es un `<select>` plano (`page.tsx:118`) alimentado con `limit: 500`
(`page.tsx:51`). Además de incómodo, tiene un límite real: **con más de 500
empleados activos, los restantes no aparecen en la lista.**

Buena noticia: `/api/employees` **ya soporta búsqueda server-side**. El
controlador (`employeeController.js:63-81`) filtra por nombre, apellido, código,
legajo, documento y nombre completo concatenado. El combobox no necesita API
nueva: alcanza con consumir `?search=`.

El componente debe ser reutilizable, con navegación por teclado y semántica
accesible (`role="combobox"`, `aria-expanded`, `aria-activedescendant`).

---

## E. Propuesta de PRs pequeños

En orden de riesgo creciente. Cada uno es independiente y verificable.

| PR | Alcance | Riesgo |
|---|---|---|
| 1 | Esta auditoría + SQL read-only | Ninguno (sólo documentos) |
| 2 | Formato `HH:mm` en PDF y Excel mensual (C1) | Bajo — corrige salida rota |
| 3 | Alinear `deptId`/`departmentId` (B2) | Bajo — restaura un filtro |
| 4 | Quitar el doble request (B3) | Bajo — sólo frontend |
| 5 | Reemplazar `Math.max(...)` por reduce (B1) | Bajo — quita un crash |
| 6 | Rediseño del layout mensual (C2) | Medio — cambia la salida impresa |
| 7 | Combobox buscable + usarlo en Reportes (D) | Medio — componente nuevo |
| 8 | Corrección de zona histórica | **Alto — no abrir hasta tener Q1–Q4** |

Sobre el punto E del pedido (arquitectura frontend): `reportes/page.tsx` tiene
807 líneas y contiene tres pantallas. El combobox sale naturalmente como
componente propio; extraer más sólo se justifica si el PR lo necesita. No se
propone reescribir la pantalla.

---

## Riesgos

- **El de mayor consecuencia es corregir históricos con un factor único.** El
  desfase es estacional. Un `UPDATE` de ±3 h, o incluso de ±1 h aplicado a todo
  el histórico, dañaría los períodos que hoy están bien. Cualquier corrección de
  datos tiene que ser por rango de fechas y validada contra Q1/Q3 antes.
- **`daily_summary` puede tener error propio.** Si Q4 muestra deltas, arreglar
  la presentación no alcanza y hará falta recalcular. Eso es otra fase.
- **Cambiar el formato del PDF afecta documentos que pueden usarse como
  respaldo legal.** Conviene comparar un PDF antes/después del mismo período
  antes de desplegar.
- **`fmtTime` y el helper nuevo deben compartir una única fuente de verdad de
  zona horaria.** Hoy hay tres criterios conviviendo: el offset fijo de
  sequelize, el `-03:00` hardcodeado de `toDate`, y la tzdata real de `Intl`.
  Mientras sigan diferentes, cualquier arreglo puntual reabre el problema en
  otro lado.
- **Los planes de Q7 dependen de las estadísticas del servidor.** Un `EXPLAIN`
  en una base de prueba pequeña no representa producción.
