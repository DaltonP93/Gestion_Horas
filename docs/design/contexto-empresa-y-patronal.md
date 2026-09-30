# Contexto de empresa, configuración patronal y datos sensibles

> Estado: **diseño**. Nada de lo descrito en §3–§5 está implementado. El selector de
> empresa, la configuración patronal por empresa y cualquier cambio de onboarding
> requieren su propio lote y autorización.

## 1. Lote previo: datos sensibles por empleado (implementado en esta rama)

Antes de introducir cualquier contexto de empresa se cerró el acceso por empleado en
los módulos que exponían datos sensibles sin alcance:

| Módulo | Regla |
|---|---|
| `contracts.js` | Alertas, historial, alta, edición y borrado filtrados por `departmentScope`. En edición/borrado el empleado sale del contrato **guardado**; el body no puede cambiarlo. El empleado debe existir también para roles globales. |
| `employeeNotes.js` | `employee`: sólo sus notas con visibilidad `employee`. Roles por sede: empleados de su alcance y visibilidades `managers`/`employee`; crean `managers` por defecto y no pueden crear ni cambiar a `hr_only` (403). Roles globales: sin cambio (`hr_only` por defecto). Edición y borrado validan empleado y visibilidad de la nota guardada. |
| `legal.js`, `legalData.js` | **Transitorio:** sólo roles globales de RR.HH. (`requireGlobalHR`) hasta que exista la configuración patronal por empresa (§4). |

Rechazos: 404 (ajeno e inexistente indistinguibles) o 403 por rol, sin datos en el
cuerpo, sin escritura y sin auditoría de éxito.

**Consistencia transaccional (contratos y notas):** en alta, edición y borrado, la
lectura del recurso, la autorización y la mutación ocurren en una sola transacción:
contrato/nota y empleado con `SELECT … FOR UPDATE`, alcance del actor (cuenta, sede,
departamentos) con `FOR SHARE`. Un cambio concurrente de departamento o un borrado
concurrente se resuelve sobre el valor vigente: rechazo o `affectedRows = 0` →
rollback y 404; la auditoría se registra sólo después del commit.

## 2. Relevamiento: `PATCH /api/onboarding/tasks/:taskId` (sin cambios de código)

**Quién lo llama hoy.** Un único consumidor: la vista de detalle del proceso en
`web/src/app/(app)/onboarding/page.tsx` (`ProcessDetail.updateTask`).

- Envía sólo `{ status: 'in_progress' | 'done' | 'skipped' }` (botones rápidos) y
  `{ assignee_id }` (selector de responsable, alimentado por `/api/users/lookup`).
- **Nunca envía `notes` ni `due_date`**: el API los acepta, pero no hay UI que los use.
- Para llegar a esa vista hay que abrir `GET /api/onboarding/:id`, que exige
  `MGR_ROLES` (`admin`, `gth`, `hr`, `super_admin`, `manager`, `coordinator`, `gestor`).
  El menú web tampoco muestra el módulo a otros roles (`supervisor` y `employee` no
  están).

**Qué permite hoy el API.** Cualquier usuario autenticado, sin rol ni alcance, puede
cambiar estado, responsable, fecha y notas de cualquier tarea de un proceso activo.
Reproducido sobre MySQL aislado (datos sintéticos, dos empresas):

| Caso | Resultado |
|---|---|
| `employee` sin relación con el proceso: `GET /onboarding/:id` | 403 |
| `supervisor` responsable de una tarea: `GET /onboarding/:id` | 403 |
| `employee` sin relación: `PATCH` responsable + fecha + notas | **200, la tarea cambia** |
| `manager` de la sede A: `GET /onboarding` y `GET /onboarding/:id` de un proceso de la empresa B | **200 (sin alcance)** |
| `manager` de la sede A: `PATCH` estado de una tarea de la empresa B | **200, la tarea cambia** |

**Compatibilidad con la política propuesta para el próximo lote.**

1. *Roles de gestión: estado, responsable, fecha y notas si el empleado del proceso
   está en su alcance.* Compatible con el flujo web actual (sólo usa estado y
   responsable). Requiere, para ser coherente, filtrar también `GET /onboarding` y
   `GET /onboarding/:id` por alcance; si no, un gerente vería tareas que después no
   puede tocar. Queda por decidir si el **responsable asignado** debe pertenecer al
   alcance del gerente (hoy el selector lista todos los usuarios).
2. *Responsable asignado: sólo estado y notas de su tarea.* **No existe hoy un flujo
   web para esto**: un responsable que no sea rol de gestión no puede abrir el detalle
   (403) aunque el correo de asignación le pide "marcarlas como completadas". La regla
   es implementable en el API, pero sin una vista "mis tareas" sólo sería usable por
   API. No se inventa esa vista en este lote.
3. *Nadie más.* Hoy cualquier autenticado pasa: el cambio cierra ese acceso. Ningún
   consumidor web conocido depende de él.
4. Observaciones: `supervisor` no está en `MGR_ROLES` de onboarding (a confirmar si
   debe contar como rol de gestión); `status` no se valida contra el ENUM en el API
   (queda librado a MySQL y el `catch` devuelve `err.message`); no hay auditoría de cambios de
   tarea; el auto-cierre del proceso depende del `PATCH`.

Para medir el uso real en producción, sin escribir: `onboarding_tasks.completed_by`
(quién marcó `done`) comparado con `assignee_id` y con `users.role`. Sólo cubre las
tareas completadas; no hay auditoría de los demás cambios.

**Estado (PR de onboarding administrativo):** implementado el flujo administrativo
con el alcance de abajo — roles de gestión global/con alcance, mismo alcance en
listado, detalle, candidatos (`GET /api/onboarding/:id/assignee-candidates`) y
`PATCH`, validación estricta, responsables activos y dentro del alcance, y
transacciones con bloqueo. **Sigue pendiente** la vista "Mis tareas" para
responsables sin rol de gestión (no implementada). `GET /api/users/lookup` sigue
siendo global para Departamentos y Evaluaciones: fuera de este lote.

**Decisiones adoptadas para el próximo lote (base del lote de onboarding):**

- `supervisor` no es administrador general de onboarding.
- Un `supervisor` o cualquier responsable que no sea rol de gestión sólo opera sus
  propias tareas asignadas (estado y notas), mediante una futura vista "Mis tareas".
- `manager`/`coordinator`/`gestor` gestionan procesos sólo dentro de su alcance.
- `super_admin`/`admin`/`gth`/`hr` mantienen alcance global.
- Un `manager` sólo asigna responsables activos del mismo alcance que el proceso; los
  roles globales asignan globalmente.
- `assignee_id`, proceso y empleado se validan en el servidor.
- Listado, detalle y `PATCH` aplican exactamente el mismo alcance.

## 3. Contrato del futuro selector de empresa (obligatorio)

1. **Sólo reduce.** El contexto se intersecta con el alcance emitido por el servidor
   (`departmentScope`/`orgScope`); nunca lo amplía. Un rol por sede no gana nada con
   el selector.
2. **Valores aceptados:** el literal `all` o un entero positivo canónico
   (`/^[1-9][0-9]*$/`, `utils/strictId`). Se rechazan `1e2`, hexadecimales, negativos,
   ceros a la izquierda, decimales y valores repetidos/duplicados en el header o en la
   query (400).
3. **Header y parámetro de exportación** presentes y distintos → 400.
4. **Empresa inexistente, inactiva o fuera de alcance → 403**, sin fallback silencioso
   a `all` ni a otra empresa.
5. **Sin `_context` en el JSON** (rompería respuestas que hoy son arrays). La
   resolución viaja en `X-Company-Context-Resolved` y toda respuesta dependiente lleva
   `Vary: X-Company-Context`.
6. **`all` nunca es destino de escritura.** Toda escritura exige una empresa concreta
   (o el recurso ya la determina).
7. **No se amplía `?access_token=`.** Las futuras exportaciones web usan descarga
   autenticada por `fetch` + `Blob`, o un token efímero de un solo uso ligado a
   usuario, recurso y contexto, con vencimiento corto.
8. **Documentos legales:** una empresa por documento; `all` no aplica (§4).

## 4. Configuración patronal por empresa (prerrequisito de informes legales por empresa)

Hoy el encabezado patronal es **único** (`notification_settings`: `employer_*`,
`system_signer_*`, `system_signature_url`, `system_seal_url`) y lo consumen
`legal.js` (MTESS, IPS, comunicación, aguinaldo), `services/payslip.js` (recibos),
`payroll.js` (planilla IPS) y la configuración web. Filtrar empleados por empresa sin
cambiar ese encabezado produciría documentos de una empresa con datos patronales de
otra.

Diseño propuesto (no implementado):

- Perfil patronal **por empresa y versionado por vigencia** (`valid_from`/`valid_to`):
  razón social, RUC, N° patronal IPS, registro MTESS, actividad, domicilio, ciudad,
  teléfono, representante legal (nombre, documento, cargo), firma y sello.
- Firma y sello como archivos **privados** con autorización (no en `uploads/`
  público), referenciados por el perfil.
- Resolución: documento del período P para la empresa C → perfil de C vigente en P.
  Sin perfil → **409 explícito**, nunca el encabezado global como respaldo.
- Empleados de sedes sin empresa no entran en ningún documento por empresa; primero
  se corrigen los datos (ver diagnóstico, §6).
- Transición: mientras no haya perfiles, los informes legales siguen siendo globales y
  exclusivos de roles globales de RR.HH. (§1). La migración de los datos globales a un
  perfil es una decisión del dueño de los datos, no un backfill automático.

## 5. Decisión transitoria: una instalación por institución

Por ahora se opera como **una instalación por institución** (una base, un conjunto de
empresas de la misma institución). Es una **decisión transitoria, no la arquitectura
definitiva** de un SaaS: no se agrega entidad de tenant ni tabla de asignación
usuario↔empresas. Si el producto pasa a multi-institución, el aislamiento por tenant
se diseña aparte (identidad, datos, archivos, colas y reportes), no se deriva del
selector de empresa.

## 6. Diagnóstico de vínculos (solo lectura)

`api/scripts/diagnose-company-links.js` lista sedes sin empresa, departamentos cuyo
centro de costo pertenece a otra empresa (y los indeterminados), empleados en sedes
sin empresa y empleados con sede inexistente. Transacción `READ ONLY` con `ROLLBACK`,
sin backfill ni asociaciones fabricadas. De los empleados sólo emite conteos agregados
por sede y estado (ni ids, ni códigos, ni nombres), en la salida normal y en `--json`.

## 7. Orden sugerido

1. Revisar/aceptar el lote de datos sensibles (§1).
2. Onboarding con la política de §2 (y alcance en sus lecturas).
3. Perfil patronal por empresa (§4).
4. Contexto de empresa en el API con el contrato de §3; luego el selector web.
