# Runbook — aplicar migraciones FASE F (076→080) en producción

> **Estado:** procedimiento preparado 2026-09-09. **NO ejecutado.** Requiere
> autorización explícita del propietario **por acción** y lo corre **ops** en la
> ventana acordada. Complementa `deploy/DEPLOY-RUNBOOK.md` (§3 migraciones, §4
> backup, §5 restore); acá se acota a las migraciones **076–080**.
>
> **Qué NO hace este runbook:** no activa multiempresa. Los writers quedan
> **fail-closed** (`GOVERNANCE_WRITE_ENABLED`, `PEOPLE_WRITE_ENABLED`,
> `CALENDAR_WRITE_ENABLED`, `PAYROLL_WRITE_ENABLED` = `false`). Aplicar el esquema
> y activar los writers son **dos decisiones separadas**. att2000 sigue READ-ONLY.

## 0. Qué son 076–080 (todas aditivas, nuleables, SIN backfill, sin `DROP`/`DELETE`)

| Mig | FASE | Qué crea/altera |
|---|---|---|
| **076** | F1 | `CREATE TABLE companies`, `cost_centers`; `ALTER branches ADD company_id NULL`, `ALTER departments ADD cost_center_id NULL` (FKs `ON DELETE SET NULL`) + índices |
| **077** | F1 | `ALTER audit_events ADD correlation_id VARCHAR(64) NULL` + índice |
| **078** | F2 | `CREATE TABLE candidates`, `employee_assignments` (FKs a `employees`/`branches`/`departments`/`cost_centers`) |
| **079** | F3 | `CREATE TABLE labor_calendars`, `calendar_exceptions` |
| **080** | F4 | `CREATE TABLE payroll_concepts`, `payroll_periods`, `payroll_period_snapshots` |

- **No tocan** `employees`, `attendance_logs`, `daily_summary` ni att2000; no recalculan histórico.
- **Independientes de 072–075** (FASE C jornada): sus FKs sólo apuntan a `branches`, `companies`,
  `cost_centers`, `departments`, `employees`, `labor_calendars`, `payroll_periods` — nada de
  `employee_schedule_history`/`workday_configuration`. Verificado en el diff.
- **SQL-safe e idempotentes** validadas en CI (MySQL 8 efímero, run #773 sobre `main d88fe09`).

## 1. ⚠️ La decisión previa: 072–075 (FASE C jornada)

El runner `migrate.js` es **forward-only y aplica TODO lo pendiente en orden**; **no** tiene
un modo "aplicar sólo 076–080". Las migraciones **072–075** están **antes** de 076 y (según la
doc histórica) **no estaban aplicadas en prod**. Por lo tanto, antes de aplicar hay que resolver:

**Paso 3 (preflight `--status`) dirá cuál de estos dos casos es el real:**

- **Caso A — 072–075 ya aplicadas en prod:** `migrate` aplicará **sólo 076–080**. Camino limpio,
  sin decisión adicional. Ir directo al Paso 4.
- **Caso B — 072–075 pendientes:** hay que elegir, **y esto lo decide el propietario:**
  1. **Aplicar 072–080 juntas (recomendado).** 072–075 son **aditivas e inertes**: crean tablas
     de jornada y amplían el ENUM `daily_summary.status`, pero **no activan nada** (los writers de
     jornada siguen gateados por `WORKDAY_*_ENABLED` en OFF). Son las mismas que valida el job de
     idempotencia de CI. Deja el esquema **coherente** (sin drift).
  2. **Mantener 072–075 fuera:** **NO** usar `--baseline` para saltarlas. Baseline las marca como
     aplicadas **sin** crear su esquema → **drift** (schema_migrations dice "aplicada" pero las
     columnas/tablas no existen), justo lo que el drift-checker de FASE E previene. Si 072–075 no
     pueden entrar todavía, **posponer 076–080** hasta resolver ese gate; no hay forma limpia de
     aplicar 076–080 solas con este runner.

> Recomendación técnica: si 072–075 no tienen un impedimento específico, tomar el **Caso B.1**
> (aplicar 072–080 juntas). Es aditivo, inerte y sin drift. Pero es **tu** decisión, no la mía.

## 2. Precondiciones (checklist antes de tocar prod)

- [ ] **Autorización explícita del propietario** para esta corrida (y, si aplica el Caso B, la
      decisión 072–075 tomada por escrito).
- [ ] **Ventana de mantenimiento** acordada (el `ALTER` de `audit_events`/`branches`/`departments`
      es rápido en tablas de este tamaño, pero planificarla igual).
- [ ] **Backup fresco y verificado** (Paso 4) — es el único rollback (migraciones sin `down`).
- [ ] **Kill-switches en OFF** (no se tocan en este paso):
      `ATT2000_AUTO_PULL_ENABLED=false`, `ZKTECO_AUTO_POLL=false`,
      `WORKDAY_CONFIG_WRITE_ENABLED=false`, y los `*_WRITE_ENABLED` de FASE F en `false`.
- [ ] Código de `main` (`d88fe09`+) desplegado en el servidor (las migraciones viven en el repo desplegado).
- [ ] Acceso a la BD `asistencia` con un usuario que pueda `CREATE TABLE`/`ALTER TABLE` (DDL).

## 3. Preflight — READ-ONLY (no aplica nada)

Correr en el servidor, con las variables de entorno de prod ya cargadas (`DB_HOST`, `DB_PORT`,
`DB_NAME`, `DB_USER`, `DB_PASSWORD`). **No** hardcodear la clave.

```bash
# Opción host (PM2/servidor):
cd /ruta/Gestion_Horas/api && npm run migrate:status

# Opción imagen one-shot (docker compose):
docker compose --profile tools run --rm migrate node scripts/migrate.js --status
```

**Leer la salida y confirmar:**
1. La lista de **pendientes**. Deben aparecer 076,077,078,079,080. Anotar si 072,073,074,075
   también aparecen → determina Caso A vs Caso B (§1).
2. Que **no** hay pendientes de número **mayor** que 080 (081/082/083 NO están en `main`; si
   aparecieran, PARAR — algo no cuadra con el despliegue).
3. Que la **guardia de monotonicidad** no reporta desorden ni duplicados. Si reporta, **PARAR**
   y escalar (no usar `--allow-out-of-order` sin entender por qué).

## 4. Backup obligatorio (antes de aplicar)

```bash
DB_NAME=asistencia BACKUP_DIR=/var/backups/sishoras \
  DB_PASSWORD=... /ruta/Gestion_Horas/scripts/backup-mysql.sh
# Verificar que el .sql.gz quedó bien (el script hace gzip -t) y anotar la ruta.
ls -lh /var/backups/sishoras/asistencia_*.sql.gz | tail -1
```

> Sin backup verificado, **no** continuar. El rollback de datos es el restore (§6).

## 5. Aplicar

Con `--status` revisado (§3) y backup hecho (§4):

```bash
# Opción host:
cd /ruta/Gestion_Horas/api && npm run migrate

# Opción imagen one-shot:
docker compose --profile tools run --rm migrate
```

- **Caso A** (072–075 ya aplicadas): esto aplica **sólo 076–080**.
- **Caso B.1** (aplicar 072–080 juntas, autorizado): esto aplica 072→080 en orden.
- El runner es idempotente: si algo ya estaba, no lo repite. Migraciones **forward-only** (sin `down`).

La corrida imprime cada archivo aplicado. Guardar el log completo de la salida como evidencia.

## 6. Verificación post-aplicación

```bash
# 6.1 Estado: 0 pendientes (o sólo las intencionalmente fuera, p.ej. 081-083 que no existen en main)
cd /ruta/Gestion_Horas/api && npm run migrate:status   # debe decir "0 pendientes" para 076-080

# 6.2 Reaplicar = no-op (idempotencia): NO debe volver a aplicar nada
npm run migrate                                         # espera "✅ Nada por aplicar."

# 6.3 Objetos creados (ejemplos representativos, ajustar credenciales por entorno):
mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" -e "
  SELECT COUNT(*) AS companies_ok        FROM information_schema.tables
   WHERE table_schema='asistencia' AND table_name='companies';
  SELECT COUNT(*) AS branches_company_id FROM information_schema.columns
   WHERE table_schema='asistencia' AND table_name='branches' AND column_name='company_id';
  SELECT COUNT(*) AS audit_correlation   FROM information_schema.columns
   WHERE table_schema='asistencia' AND table_name='audit_events' AND column_name='correlation_id';
  SELECT COUNT(*) AS payroll_periods_ok  FROM information_schema.tables
   WHERE table_schema='asistencia' AND table_name='payroll_periods';
"
```

- **Smoke funcional** (sin activar writers): entrar a la app y abrir las páginas nuevas
  (`/configuracion/empresas`, `/configuracion/centros-costo`, `/candidatos`,
  `/configuracion/calendario-laboral`, `/configuracion/nomina-base`). Deben **cargar** (listas vacías)
  y, al intentar crear algo, devolver **503 `*_WRITES_DISABLED`** (writers OFF, esperado).
- Confirmar que asistencia/reportes existentes siguen funcionando igual (076–080 no los tocan).

## 7. Rollback (si algo sale mal)

- **Datos/esquema:** restaurar el backup del Paso 4 con `scripts/restore-mysql.sh` (DESTRUCTIVO,
  ver `deploy/DEPLOY-RUNBOOK.md` §5). No hay `down` de migraciones.
  ```bash
  DB_PASSWORD=... /ruta/Gestion_Horas/scripts/restore-mysql.sh \
    /var/backups/sishoras/asistencia_<fecha>.sql.gz
  ```
- Como 076–080 son **puramente aditivas** (tablas nuevas + columnas nuleables), el impacto de un
  fallo parcial es acotado; aun así, el restore del backup previo es el rollback canónico.

## 8. Después de aplicar — multiempresa NO queda activa

Aplicar 076–080 sólo crea el **esquema**. La funcionalidad de multiempresa/nómina **sigue apagada**:
los writers responden 503 hasta que se pongan los flags `*_WRITE_ENABLED` en `"true"`. **Activarlos
es un paso aparte**, con su propia autorización y su propio plan (poblar `companies`, asignar
`branches.company_id`, etc.). Este runbook termina con el esquema aplicado y los writers en OFF.

## 9. Checklist de cierre

- [ ] `--status` preflight revisado; caso A/B determinado.
- [ ] Backup fresco verificado y su ruta anotada.
- [ ] `migrate` corrido; log guardado como evidencia.
- [ ] `--status` post = 0 pendientes (076–080); reaplicar = "Nada por aplicar".
- [ ] Objetos verificados (companies, branches.company_id, audit correlation_id, payroll_periods).
- [ ] Smoke OK: páginas cargan; writers responden 503 (OFF).
- [ ] Writers `*_WRITE_ENABLED` siguen en `false` (multiempresa NO activada).
- [ ] Resultado registrado (fecha, migraciones aplicadas, RPO/RTO si hubo incidente).
