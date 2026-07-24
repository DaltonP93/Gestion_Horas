# SisHoras v1.0.0 — Notas de versión

Sistema de gestión de asistencia que reemplaza al ZKTeco/att2000 legacy.
Lectura directa de relojes biométricos, reportes, planillas legales (MTESS/IPS),
permisos, vacaciones, horas extra y portal del empleado.

## Novedades del ciclo hacia v1.0.0

### Lectura de relojes ZKTeco
- Lectura directa estable (reintentos + cooldown; detección de buffers truncados
  del GT200). Staging `raw_device_punches` (nunca se pierden marcas), mapeo
  `employee_device_map`, auditoría por corrida `device_sync_runs`.
- Gestión de marcaciones pendientes: vincular usuario del reloj ↔ empleado,
  crear-y-vincular, búsqueda por `device_user_id`.

### Auto-polling (worker) — construido, **arranca desactivado**
- Worker PM2 `sishoras-sync-worker` separado de la API.
- Kill switch `ZKTECO_AUTO_POLL` (default `false` = auto-polling bloqueado).
- Configuración global y por reloj (intervalo, offset, intentos, cooldown,
  timeout, ventana horaria) con horarios escalonados.
- **Endurecimiento**: lock distribuido por reloj (Redis + fallback MySQL) usado
  por todos los caminos de lectura; cola de trabajos manuales asíncronos
  (`sync_jobs`, 202 + job_id, progreso/cancelación); scheduling inmediato;
  estados claros en la UI; heartbeat siempre activo.

### Cuenta / perfil / seguridad personal
- Menú de cuenta compartido (avatar + tarjeta del sidebar): Mi perfil, Editar,
  Cambiar contraseña, Preferencias, Seguridad de mi cuenta, Cerrar sesión.
- Perfil editable (datos autorizados; nunca rol/permisos/estado/sucursal/grupos).
- Cambio de contraseña con requisitos visibles, "cerrar otras sesiones" y rate
  limit. Seguridad de mi cuenta: último acceso, sesiones activas (IP/dispositivo),
  2FA. "Seguridad" se separó de administración.

### Inactivación robusta de empleados
- Baja conservando histórico, exclusión de vistas operativas, alerta si un
  inactivo sigue marcando, reactivación con auditoría. Deshabilitación en el
  reloj queda pendiente (`device_disable_pending`) para la sync inversa.

### Sincronización inversa empleados → reloj (etapa 1)
- Motor de **vista previa (dry-run)**: plan crear/actualizar/deshabilitar por
  reloj, prioridad `employee_device_map → employee_number → code`. La escritura
  real es una etapa posterior (requiere integración validada en campo).

### Seguridad / dependencias
- `npm audit`: **0 vulnerabilidades** en API y web (sin `--force`).
- `engines.node = ">=20"`. Plan de subida a Node 22 documentado.

## Migraciones incluidas
Aditivas e idempotentes: `061` (auto-sync por reloj), `062` (perfil + sesiones),
`063` (inactivación), `064` (device_locks + sync_jobs).

## Estado de activación
- `ZKTECO_AUTO_POLL=false` y `auto_sync_enabled=0` — el auto-polling **no** está
  activo. Se habilita por etapas desde Configuración → Relojes cuando se decida.
- Sincronización inversa: sólo vista previa; la escritura no está habilitada.

Ver `docs/go-live-checklist-v1.0.0.md` para el checklist de puesta en producción.
