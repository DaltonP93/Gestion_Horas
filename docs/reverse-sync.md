# Sincronización inversa empleados → reloj

Objetivo: reflejar en los relojes ZKTeco los datos y el estado de los empleados
de SisHoras (crear, actualizar, deshabilitar por baja). Se divide en dos etapas:

1. **Datos básicos y estado del usuario** (este bloque).
2. **Biometría / huellas / fotos** (etapa posterior, más controlada).

## Esta entrega: VISTA PREVIA (dry-run)

Se implementa el **motor de plan** (solo lectura), que es el paso 1 mandatado por
el propio plan de trabajo:

- Lee los usuarios actuales del reloj (`getUsers`) y los compara con los empleados.
- Prioridad para el `device_user_id` de cada empleado:
  1. `employee_device_map` (vínculo explícito, del reloj o global),
  2. `employee_number` (legajo),
  3. `code` — sólo como sugerencia, marcada `needs_confirmation`.
- Calcula por empleado la acción: **crear / actualizar / deshabilitar / sin
  cambios / omitir**, respetando el estado (`status`, `device_disable_pending`).
- Informa los usuarios del reloj sin empleado asociado (no se tocan).
- **No escribe nada** en el equipo. Idempotente y auditado (`reverse_sync.preview`).

Endpoint: `POST /api/devices/:id/reverse-sync/preview` (admin/gestor).
UI: Configuración → Sincronización → "Sincronización inversa empleados → reloj"
(Super Admin), con selector de reloj, contadores y tabla del plan.

## Por qué la ESCRITURA no está en este PR

La librería actual (`node-zklib`) **no expone escritura de usuarios**: sólo
`getUsers`, `disableDevice`/`enableDevice` (a nivel de equipo, no por usuario) y
comandos crudos. Crear/actualizar/deshabilitar un usuario requiere el protocolo
de subida `USER_WRQ` + `CMD_REFRESHDATA`, cuyo formato de buffer varía por
firmware. Escribir a ciegas en relojes biométricos de producción, sin poder
validar contra un equipo real, es riesgoso e irreversible — por eso no se incluye.

## Plan para la ESCRITURA (etapa siguiente)

1. Extender el **bridge** con soporte de escritura de usuarios ZKTeco
   (`USER_WRQ`), o usar el SDK/PUSH del fabricante.
2. Validar contra **un solo reloj** en horario de bajo uso:
   - crear un usuario de prueba, actualizar nombre, deshabilitar/rehabilitar.
3. Reglas de seguridad (del plan):
   - **No borrar** usuarios ni huellas automáticamente.
   - **No reemplazar** biometría sin confirmación.
   - Procesamiento **por reloj** (un fallo no detiene a los demás).
   - **Idempotencia**: ejecutar dos veces no duplica.
   - Reporte final: creados / actualizados / deshabilitados / omitidos / errores.
   - Auditoría completa.
4. El motor de plan de este PR ya produce exactamente ese reporte como
   **intención**; la etapa de escritura sólo debe ejecutar el plan confirmado.

> Mientras tanto, la baja de empleados deja `device_disable_pending = 1`
> (migración 063) para que la futura escritura sepa qué usuarios deshabilitar.
