# Deriva de esquema: `external_hr_sources` y las migraciones "baselined"

Diagnóstico del error de producción, y por qué el arreglo no es simplemente correr las migraciones.

```
ER_NO_SUCH_TABLE
stage: load_schedules
sqlState: 42S02
```

---

## 1 · La tabla exacta

`api/src/services/hrSourceSync.js`, en `loadHrSchedules()`:

```sql
SELECT id, name, schedule_cron FROM external_hr_sources
 WHERE enabled=1 AND schedule_cron IS NOT NULL
```

La tabla es **`external_hr_sources`**.

## 2 · Verificación antes de tocar nada

| Qué | Resultado |
|---|---|
| Modelo Sequelize | **No existe.** Todo el módulo usa `sequelize.query()` con SQL crudo. |
| Migración | **Existe**: `007_external_hr_sources.sql`, con `CREATE TABLE IF NOT EXISTS`. |
| Rutas que la administran | `api/src/routes/hrSources.js`, montada en `/api/hr-sources`. |
| Consumidores | `loadHrSchedules()` al arrancar, `runSync()`, `reloadSchedule()`, y el CRUD de la ruta. |
| ¿Obligatorio? | **No.** Es opcional: integra ERP/HR externos (SAP, Bejerman, Meta4, Workday, Odoo, CSV). La instalación base no lo usa. |

**No se inventó ninguna estructura.** La tabla ya estaba definida en 007; el problema nunca fue no saber cómo era.

## 3 · Por qué falta si la migración existe

Ésta es la parte que importa, porque cambia cuál es el arreglo.

1. `database/init.sql` es un **baseline** de 10 tablas — deliberadamente **no** incluye las que crean las migraciones. La base de producción se construyó desde ahí.
2. El runner de migraciones se adoptó **después**, con `--baseline=<archivo>`. Esa opción **marca las migraciones como aplicadas sin ejecutarlas**, para adoptar el runner en una base que ya las tenía a mano.
3. Si el baseline se puso en un archivo posterior a `007`, entonces `schema_migrations` afirma que 007 corrió — y la tabla nunca se creó.

**Consecuencia:** correr `npm run migrate` **no lo arregla**. El runner ve 007 como aplicada y no la vuelve a ejecutar. Por eso hace falta una migración **nueva**: es la única que va a ejecutarse.

### Esto no afecta a una sola tabla

Comparando `init.sql` contra las migraciones, **36 tablas** caen en el rango típicamente "baselined" (migraciones ≤ 039) y no están en `init.sql`. Entre ellas:

| Migración | Tabla | Síntoma observado |
|---|---|---|
| 007 | `external_hr_sources` | `ER_NO_SUCH_TABLE` en `load_schedules` |
| 028 | `courses`, `course_assignments` | `Error cron courses due` |
| 011 | `permission_approval_rules` | — |
| 034 | `appraisals`, `appraisal_templates` | — |
| 035 | `onboarding_processes`, `onboarding_tasks` | — |

Los dos errores que aparecieron en producción son de tablas de ese rango, lo cual es coherente con el diagnóstico y sugiere que hay más esperando a que alguien use el módulo correspondiente.

**Este PR repara sólo `external_hr_sources`.** Reparar las 36 a ciegas sería crear tablas por intuición en producción, que es justo lo que hay que evitar. Para saber cuáles faltan de verdad está el script de abajo.

## 4 · Detectar la deriva completa

```bash
cd api && npm run schema:drift
```

**Sólo lectura** — no crea, no altera, no borra. Compara las tablas declaradas en `init.sql` + migraciones contra `information_schema`, y marca especialmente las que están **registradas como aplicadas pero ausentes**, que son las que el runner nunca reejecutará.

```
❌ Faltan 2 tabla(s):

   external_hr_sources                007_external_hr_sources.sql
                                      ⚠️  migración MARCADA como aplicada — el runner no la reejecutará
   courses                            028_training.sql
                                      ⚠️  migración MARCADA como aplicada — el runner no la reejecutará
```

Sale con código 1 si hay deriva, 0 si no — usable en un check de despliegue.

## 5 · La reparación

`database/migrations/071_repair_external_hr_sources.sql`

- Estructura **idéntica a 007** — no se inventó nada.
- `CREATE TABLE IF NOT EXISTS`: en una base que sí tiene la tabla no hace nada ni toca ninguna fila.
- Agrega `idx_enabled_schedule (enabled, schedule_cron)`, derivado del consumidor real: la consulta de arranque filtra por ambas columnas y con `idx_enabled` sola había que descartar `schedule_cron` fila por fila. Se agrega con un procedimiento que comprueba `information_schema`, para que una base que ya tenía la tabla termine con el mismo esquema.

### Rollback

```sql
DROP TABLE IF EXISTS external_hr_sources;
DELETE FROM schema_migrations WHERE filename = '071_repair_external_hr_sources.sql';
```

El `DROP` borra la configuración de las fuentes HR. Si el módulo está en uso, exportar antes. Si nunca se usó —el caso que motiva esto— no hay datos que perder.

## 6 · Comportamiento cuando la tabla no está

El módulo es **opcional y su configuración vive en esa misma tabla**. De ahí se sigue la regla:

> Si la tabla no existe, **no puede haber ninguna integración activa**. No hay nada que ocultar, porque no hay nada configurado.

Por eso `loadHrSchedules()` registra la tabla ausente como `skipped`, no como error:

```json
{ "job": "hr_schedules_load", "result": "skipped", "reason": "table_missing",
  "missing_table": "external_hr_sources",
  "hint": "aplicar migraciones: npm run migrate (ver docs/hr-sources-schema.md)" }
```

**Sólo ese caso.** Cualquier otro fallo de base —permisos, conexión caída, deadlock, columna ausente— sigue siendo un error con su stack. Tratarlos a todos como "módulo no instalado" escondería una caída real detrás de un mensaje tranquilizador, que es peor que el ruido original.

La detección mira `code === 'ER_NO_SUCH_TABLE'` o `sqlState === '42S02'`, recorriendo `parent`/`original`/`cause` porque Sequelize envuelve el error del driver y según el camino aparece en uno u otro.

### Estados devueltos

| Estado | Cuándo | Nivel |
|---|---|---|
| `loaded` | tabla presente, hay fuentes activas | info |
| `no_active_sources` | tabla presente, ninguna fuente activa | info / `skipped` |
| `table_missing` | módulo no instalado | warn / `skipped` |
| `error` | cualquier otro fallo de base | error |

En los cuatro casos la función **resuelve** — nunca lanza. El arranque de la API no depende de un módulo opcional.

## 7 · Fuera de alcance

No se modifican ZKTeco, Bridge, backup, `USER_WRQ` ni el scheduling general.
