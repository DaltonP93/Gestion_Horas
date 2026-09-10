# Runbook — activación de writers multiempresa (FASE F)

> **Estado:** procedimiento preparado 2026-09-09. **NO ejecutado.** Cada fase requiere
> autorización explícita del propietario y la corre **ops** en el servidor. Es el **paso 2**
> del rollout FASE F; el paso 1 (aplicar migraciones 072–080) está en
> `deploy/RUNBOOK-migraciones-076-080.md` y **debe completarse antes**.
> att2000 sigue READ-ONLY; no toca `attendance_logs`/`daily_summary`.

## 0. Precondición absoluta

- [ ] **Migraciones 076–080 aplicadas y verificadas en prod** (runbook de migraciones). Sin el
      esquema, los writers fallan. Confirmar con `cd api && npm run migrate:status` → 0 pendientes.
- [ ] **Backup fresco y verificado** antes de la primera activación (`scripts/backup-mysql.sh`).
- [ ] Autorización del propietario para la(s) fase(s) a activar.

## 1. Concepto — encender los flags **no** activa multiempresa por sí solo

Hay **dos** cosas distintas:

- **(A) Los flags** habilitan que los *writers* dejen de responder `503` y acepten escrituras.
- **(B) Los datos + permisos** hacen que la multiempresa sea **real**: crear `companies`, enlazar
  `branches.company_id` (y opcional `departments.cost_center_id`), y otorgar los permisos a los roles.

**Por qué importa:** el aislamiento por empresa se deriva de `empleado → branch → company_id`
(`orgScope.js`). Mientras `branches.company_id` esté en NULL, un usuario **no-global** tiene alcance
de empresa vacío (no ve nada empresa-específico y no puede crearlo); y los roles **globales**
(`super_admin`/`admin`/`gth`/`hr`) ven todo igual que hoy. O sea: encender los flags **sin sembrar
datos** deja el sistema funcionalmente como antes, sólo que ya se puede empezar a cargar la estructura.

> Por eso el orden correcto es: **encender gobierno → sembrar empresas/enlaces → verificar aislamiento
> → recién después activar los demás módulos.**

## 2. Los 4 flags (fail-closed, sólo el string exacto `"true"` habilita)

| Flag | Habilita escrituras de | Ruta / servicio |
|---|---|---|
| `GOVERNANCE_WRITE_ENABLED` | empresas, centros de costo | `governance.js` · `/api/companies`, `/api/cost-centers` |
| `PEOPLE_WRITE_ENABLED` | candidatos, asignaciones | `people.js` · `/api/candidates`, `/api/assignments` |
| `CALENDAR_WRITE_ENABLED` | calendarios laborales, excepciones | `calendarService.js` · `/api/labor-calendars` |
| `PAYROLL_WRITE_ENABLED` | nómina sandbox (períodos, conceptos) | `payrollBase.js` · `/api/payroll-base` |

- Se leen **por request** (`process.env.X === 'true'`), pero `process.env` se fija al **arrancar** el
  proceso → cambiar el flag exige `pm2 reload ... --update-env` (§5). No hay activación "en caliente".
- **Lecturas y autorización siempre están activas**, con o sin flag. El flag sólo gatea *escritura*.
- Son **independientes** de los flags de jornada (`WORKDAY_CONFIG_WRITE_ENABLED`,
  `WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED`): activar multiempresa **no** activa el motor de jornada.

## 3. Permisos (además del flag)

Cada módulo exige, en la API, un permiso granular (además del flag y del alcance):
`empresas`, `centros_costo`, `candidatos`, `asignaciones`, `calendario`, `nomina`
(acciones `view`/`create`/`update`). La nómina F4 además exige **rol global de RR.HH.**
(`requireGlobalHR` → `super_admin`/`admin`/`gth`/`hr`); un override de permiso **no** la habilita a
un manager.

- [ ] Antes de cada fase, confirmar que los roles que van a operar el módulo **tienen** el permiso
      correspondiente (en `/usuarios` / la matriz de permisos). Un rol sin el permiso recibirá `403`
      aunque el flag esté en `true`.

## 4. Orden recomendado — activación por etapas

> Recomendado activar **una fase a la vez**, verificar, y recién pasar a la siguiente. Se puede
> activar todo junto, pero sin datos sembrados (Fase 1) los módulos no tienen contexto útil.

### Fase 1 — Gobierno (bootstrap organizativo) — PRIMERO
1. `GOVERNANCE_WRITE_ENABLED=true` → reload (§5).
2. Con un usuario **global-HR**, en `/configuracion/empresas` y `/configuracion/centros-costo`:
   crear la(s) **empresa(s)** y **centros de costo** reales (RUC/razón social, etc.).
3. **Enlazar la estructura:** asignar `branches.company_id` a cada sucursal y (opcional)
   `departments.cost_center_id`. *Si no hay UI para el enlace, ops lo hace por UPDATE puntual y
   auditado; es aditivo sobre columnas nuleables.*
4. **Verificar aislamiento (§6):** un usuario **no-global** de la sucursal de la empresa A **no** debe
   ver datos de la empresa B.

### Fase 2 — Personas
5. `PEOPLE_WRITE_ENABLED=true` → reload. Alta de candidatos y asignaciones con vigencia. Verificar
   que el alcance por empresa/sucursal se respeta (candidato de otra sucursal → 404/403).

### Fase 3 — Calendario laboral
6. `CALENDAR_WRITE_ENABLED=true` → reload. Autoría de calendarios y excepciones por alcance.
   (Sigue siendo **coexistencia read-only** con la jornada: no recalcula `daily_summary`.)

### Fase 4 — Nómina sandbox (NO oficial)
7. `PAYROLL_WRITE_ENABLED=true` → reload. Recordar: **sandbox global, NO oficial** — no calcula
   liquidación legal, no paga, integraciones apagadas; sólo roles global-HR. Es una excepción
   temporal explícita al aislamiento por empresa (ver `AI_HANDOFF.md` §4).

## 5. Cómo setear un flag y recargar (PM2)

Los flags viven en el entorno del proceso `api` (p. ej. `ecosystem.config.js` → `env`, o el `.env`
del servidor — **nunca** commitear valores). Para el servicio `api`:

```bash
# 1. Editar el valor del flag en la config de entorno de `api` (ecosystem.config.js o .env del server).
#    Ej.: GOVERNANCE_WRITE_ENABLED: 'true'
# 2. Recargar SÓLO api con el entorno actualizado (sin downtime perceptible, PM2 fork):
pm2 reload ecosystem.config.js --update-env --only api
#    (o `pm2 restart api --update-env` según cómo esté declarado el proceso)
# 3. Confirmar que el proceso levantó y el flag quedó:
pm2 status
pm2 logs api --lines 50   # sin errores de arranque
```

> `--update-env` es **obligatorio**: sin él, PM2 reusa el entorno viejo y el flag no cambia.

## 6. Verificación por fase

Tras cada `reload`, con la fase recién encendida:

1. **El 503 desaparece:** intentar la escritura del módulo (crear una entidad de prueba) → ya **no**
   responde `503 *_WRITES_DISABLED`; crea (o devuelve un error de negocio legítimo: 400/403/409).
2. **Aislamiento (Fase 1, el más importante):** con un usuario **no-global** de la empresa A,
   confirmar que **no** ve ni puede crear entidades de la empresa B (404/`403 OUT_OF_SCOPE`), y que
   la coherencia sucursal→empresa rechaza mezclas (`400 INCOHERENT_SCOPE`).
3. **Auditoría:** los writes quedan en `audit_events` **sin PII** (sólo ids/acciones), con
   `correlation_id`.
4. **Nada colateral:** asistencia, reportes y `daily_summary` siguen igual (FASE F no los toca).

Registrar qué se activó, quién y cuándo.

## 7. Rollback (inmediato y limpio)

- **Apagar un writer:** poner su flag en `false` y `pm2 reload ... --update-env`. Vuelve a
  **fail-closed** (`503`) al instante. **Los datos ya creados NO se borran** — quedan; sólo se
  bloquean escrituras nuevas. Lecturas siguen.
- **Revertir datos** (si algo se cargó mal y hay que deshacerlo): restore del backup del Paso 0
  (`scripts/restore-mysql.sh`, DESTRUCTIVO — ver `deploy/DEPLOY-RUNBOOK.md` §5). Preferible corregir
  puntualmente antes que restaurar, salvo incidente serio.

## 8. Invariantes que se preservan

- att2000 **READ-ONLY**; sin fabricar marcas/ausencias/horas.
- No se toca `attendance_logs`/`daily_summary`; no se activa el motor de jornada (`WORKDAY_*` aparte).
- Nómina F4 = **sandbox NO oficial** (sin liquidación legal, sin pagos, integraciones off).
- Writers siguen fail-closed salvo el string exacto `"true"`; se pueden apagar en segundos.

## 9. Checklist de cierre (por fase)

- [ ] Precondición: 076–080 aplicadas; backup fresco verificado.
- [ ] Permisos del módulo otorgados a los roles operadores.
- [ ] Flag de la fase = `true`; `pm2 reload --update-env`; `pm2 status` OK.
- [ ] Escritura de prueba: 503 desaparece; entidad creada.
- [ ] Aislamiento verificado (no-global de empresa A no ve empresa B).
- [ ] Auditoría sin PII con correlation_id.
- [ ] Asistencia/reportes sin cambios.
- [ ] Registrado (qué, quién, cuándo). Rollback (flag→false) probado mentalmente/documentado.
