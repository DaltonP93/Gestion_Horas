# Checklist de puesta en producción — v1.0.0

Orden recomendado y verificaciones antes de etiquetar `v1.0.0`.

## 0. Pre-requisitos
- [ ] `main` desplegado y sincronizado con el servidor.
- [ ] Migraciones al día: `cd api && npm run migrate:status` → 0 pendientes.
- [ ] `.env` con todos los secretos; **sin** credenciales en el repo.
- [ ] `api/backups/` y demás artefactos excluidos por `.gitignore`.
- [ ] `npm audit` en API y web → 0 vulnerabilidades.

## 1. Pruebas funcionales
- [ ] Login, logout y recuperación de contraseña.
- [ ] Perfil, cambio de contraseña, sesiones activas y 2FA.
- [ ] Alta, edición, baja y reactivación de empleados.
- [ ] Empleado inactivo que sigue marcando → aparece la alerta, la marca no cuenta.
- [ ] Lectura de los tres relojes (Gerencia, Comedor, Lavadero).
- [ ] Marcaciones pendientes y vinculación.
- [ ] Recálculo diario correcto.
- [ ] Permisos, vacaciones, horas extra y reportes principales.
- [ ] Roles y restricciones de acceso (backend, no solo UI).

## 2. Pruebas operativas
- [ ] `pm2 reload` de cada proceso (api, web, bridge, analytics, sync-worker).
- [ ] Reinicio completo del servidor: todos los procesos vuelven.
- [ ] Reloj desconectado: la lectura reporta error sin tumbar el worker.
- [ ] Lectura parcial (buffer truncado): se reintenta / queda `partial`.
- [ ] Kill switch: `ZKTECO_AUTO_POLL=false` detiene el auto-polling al instante.
- [ ] Sin trabajos superpuestos: dos lecturas del mismo reloj → una espera/queda 409.
- [ ] Consumo de memoria estable 24–48 h (`pm2 monit`).
- [ ] Rotación de logs configurada.
- [ ] Restauración de una copia de la base probada.

## 3. Auto-polling — activación progresiva (cuando se decida)
> Requiere `ZKTECO_AUTO_POLL=true` + activar desde Configuración → Relojes.
- [ ] Etapa 1 — **Gerencia** (15 min, tcp/auto, 3 intentos, cooldown 4, timeout 600). Validar una jornada.
- [ ] Etapa 2 — **Comedor** (30 min). Validar reintentos de truncadas y pendientes.
- [ ] Etapa 3 — **Lavadero** (60 min, tcp, 5 intentos, timeout_ms 300000).
- [ ] Etapa 4 — los tres juntos, dos jornadas. Criterios: sin solapamientos, sin
      duplicados, auditados, recuperación tras reinicio, kill switch corta todo.

## 4. Sincronización inversa
- [ ] Etapa 1 (este release): **vista previa** validada por reloj.
- [ ] Etapa 2 (posterior): integración de escritura validada en UN reloj
      (crear/actualizar/deshabilitar) antes de habilitarla.

## 5. Entrega
- [ ] Documentar rollback (ver docs de cada bloque).
- [ ] Release notes revisadas (`docs/RELEASE_NOTES-v1.0.0.md`).
- [ ] Etiquetar el commit aprobado:

```bash
git tag -a v1.0.0 -m "SisHoras v1.0.0"
git push origin v1.0.0
```

> El tag se crea **después** de pasar las pruebas funcionales y operativas.
