# Reparación histórica de `attendance_logs`

Procedimiento para corregir los timestamps del flujo histórico
`source='device'`. **Nada de esto se ejecuta solo**: el script es dry-run por
defecto y aplicar requiere un flag explícito más un manifest previamente
revisado.

---

## Qué se repara y por qué

El flujo `source='device'` guardó **el instante UTC** en una columna `DATETIME`
que el resto del sistema trata como hora de pared. Verificado contra
`att2000.CHECKINOUT` sobre el empleado 3091:

| Período | Paraguay | MySQL guardó | ATT2000 (verdad) | Corrección |
|---|---|---|---|---|
| Invierno 2024 | UTC-4 | `2024-04-29 02:42:29` | `2024-04-29 06:42:29` | **+240** |
| Ene–feb 2025 | UTC-3 | `2025-01-02 03:50:41` | `2025-01-02 06:50:41` | **+180** |
| Junio 2026 | UTC-3 | `2026-06-01 03:44:26` | `2026-06-01 06:44:26` | **+180** |

`source='zkteco_direct'` guarda correctamente (shift 0 verificado sobre los 9
registros presentes en ambos lados) y **no se toca**.

> El desplazamiento **no se infiere por la fecha**. Se busca el marcaje en
> ATT2000 y se exige un único candidato inequívoco. Un registro sin respaldo, o
> con más de un candidato compatible, **no se actualiza nunca**.

---

## Alcance

| Se repara | No se toca |
|---|---|
| `source = 'device'` | `zkteco_direct`, `att2000`, `push`, `manual`, cualquier otro |

El bloqueo es de tres capas, no una convención:

1. `--apply` con cualquier `--source` distinto de `device` **falla**.
2. Un `--source` distinto en dry-run exige `--diagnostic`, y ese manifest queda
   marcado `aplicable: false` — el `--apply` lo rechaza.
3. Al aplicar se valida el origen **fila por fila**, por si un archivo mezcla
   orígenes.

---

## Paso 0 — Entorno

El script carga **`api/.env` con `override: true`** antes de abrir cualquier
conexión. Importa: en producción el shell tiene un `DB_PASSWORD` distinto al del
archivo, y sin `override` gana el del shell y la conexión falla con un error de
autenticación desconcertante.

```bash
cd api
node scripts/historical-attendance-repair.js --help     # usa api/.env
node scripts/historical-attendance-repair.js --env /ruta/otro.env ...
node scripts/historical-attendance-repair.js --no-env ...   # sólo el shell
```

El script informa **qué archivo cargó** y **qué variables están definidas, por
nombre**. Nunca imprime valores: su salida termina pegada en tickets.

> **Ojo con los nombres de ATT2000.** El conector (`api/src/config/att2000.js`)
> lee `ATT_HOST`, `ATT_PORT`, `ATT_USER`, `ATT_PASSWORD` y `ATT_DATABASE` — **no**
> `ATT2000_*`, que es lo que documenta `CLAUDE.md`. Quien siga la documentación
> configura variables que el conector nunca mira. El script detecta ese caso y
> lo avisa explícitamente.

---

## Paso 1 — Dry-run

No escribe absolutamente nada en `attendance_logs`.

```bash
node scripts/historical-attendance-repair.js \
     --from 2024-01-01 --to 2026-07-31 \
     --out ./reparacion-2026-08
```

`--from` y `--to` son **inclusivos**: el rango es `[from 00:00:00,
díaSiguiente(to) 00:00:00)`, así que un marcaje a las `23:59:59` del último día
entra. La versión anterior usaba `< 'to 23:59:59'` y excluía exactamente ese
segundo.

Las fechas se validan **estrictamente**: una que no exista —`2025-02-29`,
`2024-04-31`, `2024-13-01`— aborta. Sin eso, `Date.UTC` las normalizaba en
silencio y el rango "inclusive" abarcaba días de más.

### Acotá siempre el rango

Con `--from`/`--to` las consultas se limitan a la **ventana de candidatos**:

```
[from 00:00:00 , díaSiguiente(to) 04:00:00]
```

Esas 4 horas de margen son el mayor desplazamiento posible (+240 min). Un
marcaje a las `23:59:59` del último día tiene su candidato a las `03:59:59` del
siguiente, y la ventana lo cubre.

La misma ventana acota las claves `UNIQUE` que se traen para detectar
colisiones: una hora propuesta es la vieja + 180 o + 240, así que nunca cae
fuera de ahí.

**Sin `--from`/`--to` se consulta la historia completa.** Medido en producción,
analizar los 10.849 registros de enero 2025 sin acotar cargaba 346.134 claves de
MySQL y 331.270 `CHECKINOUT`, ~378 MiB de RSS y 44 s. El histórico total son
400.031 registros de 542 empleados: sin ventana no escala.

El `--apply` deriva su propia ventana de las horas viejas del manifest, así que
no necesita que le repitas el rango. Su límite superior lleva **un segundo
extra**: `CHECKTIME` es un `datetime` de SQL Server con precisión de ~3 ms, y el
filtro compara la columna cruda mientras la clasificación compara el valor
truncado a segundos por `CONVERT`. Sin ese segundo, un candidato en
`06:42:29.003` quedaba fuera del filtro aunque la clasificación lo aceptaba, y
la reparación se perdía en silencio.

Conviene empezar acotado, con un empleado del que ya haya evidencia:

```bash
node scripts/historical-attendance-repair.js --employee 3091 --limit 500 --out ./prueba-3091
```

### Qué informa

```
total device      N
MATCH_180         N     ← corregible: +3 h
MATCH_240         N     ← corregible: +4 h
ALREADY_CORRECT   N     ← la guardada es la ÚNICA coincidencia; no se toca
NO_MATCH          N     ← sin respaldo en ATT2000; NO se actualiza
AMBIGUOUS         N     ← coincide con más de un desplazamiento; NO se actualiza
                          (incluye los casos donde también coincide el 0)
COLLISION         N     ← la hora corregida chocaría con el UNIQUE; NO se actualiza
APLICABLES        N
cambian de día    N     ← requieren recalcular DOS resúmenes
```

Desglosado por mes, por dispositivo y por origen.

### Archivos generados

| Archivo | Contenido |
|---|---|
| `manifest.json` | una fila por registro, con estado y propuesta |
| `manifest.csv` | lo mismo, para revisar en planilla |
| `recalcular.json` | pares `employee_id` / `date` a recalcular después |

El manifest incluye sólo lo necesario para decidir y auditar
(`attendance_log_id`, `employee_id`, `employee_code`, `device_id`, `source`,
`old_timestamp`, `proposed_timestamp`, `delta_minutes`, `status`,
`date_changes`, `reason`). **No lleva nombres ni documentos.**

---

## Paso 2 — Revisar

Antes de aplicar, mirar como mínimo:

1. **`NO_MATCH` alto en un mes o dispositivo concreto.** Puede indicar que
   ATT2000 no tiene ese período cargado — no que los datos estén bien.
2. **`AMBIGUOUS`.** Marcajes en los que más de un desplazamiento cae sobre un
   registro real — incluido el caso en que la hora guardada ya coincide y
   además hay otro candidato. El `reason` lista los `CHECKTYPE` vistos en cada
   desplazamiento, que suele alcanzar para resolverlo a mano.
3. **`COLLISION`.** La corrección chocaría con el índice único
   `(employee_id, timestamp, IFNULL(device_id,0))`. Suele significar que el
   registro correcto ya fue insertado por otro flujo y este es un duplicado
   desplazado. **El script no borra nada**: la decisión es humana.
4. **`cambian de día`.** Esos registros mueven el marcaje de fecha, así que
   afectan dos resúmenes diarios.

---

## Paso 3 — Respaldo

**Obligatorio antes de aplicar.** Sin esto no hay rollback.

```bash
mysqldump -h "$DB_HOST" -u "$DB_USER" -p \
  --single-transaction --no-create-info \
  "$DB_NAME" attendance_logs > attendance_logs_backup_$(date +%F).sql
```

Para un respaldo acotado al rango reparado, alcanza con exportar las filas
cuyos `id` figuran en el manifest.

---

## Paso 4 — Aplicar

```bash
node scripts/historical-attendance-repair.js \
     --apply --manifest ./reparacion-2026-08/manifest.json
```

Garantías del modo `--apply`:

- **Sólo consume un manifest previamente generado.** No re-analiza ni re-decide.
- **Sólo escribe filas `MATCH_180` / `MATCH_240`.** El resto se ignora.
- **Guard optimista sobre todos los campos que decidieron la propuesta**: el
  `UPDATE` exige `id`, `timestamp` original, `source`, `employee_id`,
  `device_id` (con `IFNULL(...,0)`) y `type`. Una reasignación de empleado
  aplicaría una hora deducida del USERID anterior, así que no alcanza con el
  timestamp.
- **Revalidación del UNIQUE dentro de la transacción**: el conjunto de claves
  del dry-run refleja ese momento. Si una ingesta posterior insertó la hora
  propuesta, se rechaza esa fila en vez de voltear el lote. Un duplicado en
  carrera también se aísla por fila.
- **El valor se escribe como string de hora de pared**, nunca como objeto
  `Date` — pasar un `Date` haría que el driver lo convierta otra vez y
  reintroduciría el mismo defecto.
- **Transacción por lote** (`--batch-size`, default 500). Un error revierte el
  lote completo y aborta.
- **No borra registros** en ningún caso.
- **No recalcula resúmenes.**

### Por qué un manifest editado a mano no sirve

Promover una fila de `AMBIGUOUS` a `MATCH_240` en el archivo **no alcanza** para
que se escriba. Hay tres barreras, y la tercera es la que importa:

1. **Versión del algoritmo.** El manifest lleva `repair_algorithm_version`; el
   apply rechaza cualquier otra. La regla de clasificación cambió durante el
   desarrollo, así que un manifest viejo propondría correcciones que el criterio
   vigente no aprueba.
2. **Huellas.** Cada fila lleva un `digest` sobre sus campos decisivos, y el
   manifest una huella global **obligatoria** — borrarla no saltea la
   verificación, la hace fallar. Editar, agregar, duplicar o quitar una fila las
   invalida. Esto ataja el **error humano**: quien conozca el algoritmo puede
   recalcularlas, no es una firma.
3. **Revalidación contra ATT2000.** El apply **no cree el `status` del
   archivo**: vuelve a clasificar cada fila contra la fuente de verdad con el
   algoritmo vigente y exige el mismo veredicto y la misma hora propuesta. Una
   fila ambigua sigue siendo ambigua por más que el archivo diga otra cosa.

Como consecuencia, **el apply también necesita ATT2000**. Si no responde,
aborta sin escribir.

> No existe una vía de promoción manual de ambiguos. Resolverlos es una decisión
> humana que, por ahora, no tiene camino automatizado — y eso es deliberado.

---

## Paso 5 — Recálculo (aparte, y no automático)

`recalcular.json` trae los pares `employee_id` / `date` afectados, **incluyendo
el día viejo y el nuevo** de cada registro que cambió de fecha: mover un
marcaje de día deja mal los dos resúmenes.

Ese recálculo es un paso separado y deliberadamente manual. Conviene hacerlo
recién cuando la corrección de `late_minutes` en hora de pared esté desplegada;
si no, se regeneran resúmenes con la aritmética vieja.

---

## Rollback

### Opción A — restaurar desde el respaldo

```bash
mysql -h "$DB_HOST" -u "$DB_USER" -p "$DB_NAME" < attendance_logs_backup_YYYY-MM-DD.sql
```

### Opción B — revertir con el manifest

El manifest guarda `old_timestamp` y `proposed_timestamp` de cada fila, así que
la reversión es exacta. Con el mismo guard optimista, invertido:

```sql
-- Por cada fila con status MATCH_180 o MATCH_240 que se haya aplicado:
UPDATE attendance_logs
   SET timestamp = '<old_timestamp>'
 WHERE id = <attendance_log_id>
   AND timestamp = '<proposed_timestamp>'
   AND source = '<source>';
```

Ese `AND timestamp = '<proposed_timestamp>'` es lo que hace segura la
reversión: si el registro volvió a cambiar, no se pisa.

### Qué NO revierte el rollback

Los resúmenes diarios que se hayan recalculado después de aplicar. Si ya se
corrió el recálculo, hay que volver a correrlo tras el rollback usando la misma
lista de `recalcular.json`.

---

## Idempotencia

Correr el dry-run una segunda vez sobre datos ya corregidos devuelve
`ALREADY_CORRECT`, no `MATCH_*`: tras la corrección la hora guardada coincide
con ATT2000 y pasa a ser la única coincidencia.

Si además apareciera una coincidencia en +180 o +240 —porque la persona marcó
también a esa hora—, la fila queda `AMBIGUOUS` y no se toca. Es el
comportamiento buscado: ante duda, no escribir.

Reaplicar el mismo manifest no vuelve a escribir: el guard exige el
`old_timestamp` original, que ya no está.

---

## Si ATT2000 no está disponible

El script **aborta sin generar manifest** y sale con código 1. Sin la fuente de
verdad no se propone ninguna corrección — el desplazamiento no se adivina por
la fecha.
