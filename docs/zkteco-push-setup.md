# Configuración PUSH ADMS de los relojes ZKTeco

Los relojes envían los marcajes directamente al Bridge vía HTTP (modo ADMS).
Esto evita el límite de **una sola conexión TCP simultánea** del protocolo
ZKTeco binario y elimina el conflicto con el Attendance Management Program.

> ### ⚠️ Antes de configurar un reloj para ADMS
>
> Configurar un reloj para PUSH lo convierte en **productor de asistencia**: sus marcajes entran por `publishAttendance()`, que hace `XADD stream:attendance` y `PUBLISH attendance:new`.
>
> Si el polling sigue siendo el camino autoritativo para ese reloj, habrá **dos productores** para la misma marcación.
>
> **Encender la sombra no evita esto.** `BRIDGE_SHADOW_ENABLED=true` sólo guarda una copia para comparar; no suprime nada. La sombra es pasiva, pero el servidor sobre el que cuelga no lo es.
>
> Para recibir PUSH de un reloj **sin** que publique asistencia, nombralo en `BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST` — ver [modo observe-only](bridge-shadow-mode.md#push-en-modo-observe-only).

## Datos del servidor SisHoras

| Campo | Valor |
|---|---|
| Server Address | `10.0.0.20` (IP interna del servidor del bridge — usar IP, no nombre: abajo se deja *Domain Name* en OFF) |
| Server Port | `8080` |
| HTTPS | OFF |
| Proxy | OFF |
| Domain Name | OFF |

## Pasos en cada reloj

Repetir en los 3 relojes:

| Reloj | IP |
|---|---|
| Comedor | 10.0.0.160 |
| Lavadero | 10.0.0.161 |
| Gerencia | 10.0.0.162 |

1. En el teclado del reloj: **Menú → Comm (Comunicación) → Cloud Server Setting**
   (en firmwares viejos aparece como **ADMS** o **WebServer**).
2. Configurar:
   - **Server Address:** `10.0.0.20`
   - **Server Port:** `8080`
   - **Enable Domain Name:** OFF
   - **Enable Proxy Server:** OFF
   - **HTTPS:** OFF
3. Guardar (ESC → Save) y volver al menú principal.
4. **Menú → System → Reset / Reboot** — reiniciar el reloj.

## Verificación

Una vez reiniciado:

1. En el servidor: `pm2 logs sishoras-bridge --lines 50`
   - Debe aparecer: `🔌 Reloj ZKTeco registrado vía PUSH — SN: XXXXXX (10.0.0.xxx)`
2. Marcar huella o tarjeta en el reloj.
3. `pm2 logs sishoras-bridge`
   - Debe aparecer: `📥 PUSH de SN=XXXXXX (10.0.0.xxx): 1/1 marcaje(s) procesados`
4. `pm2 logs sishoras-api`
   - Debe aparecer: `Marcaje: <NOMBRE> - in/out - <TIMESTAMP>`
5. En la UI web: `/configuracion → Relojes → expandir reloj → Verificar PUSH`
   - Debe mostrar "✅ PUSH ADMS activo" con el último heartbeat.

## Replicación a att2000

Para que los marcajes recibidos por PUSH se escriban también en
`att2000.CHECKINOUT` (SQL Server), activar en `api/.env`:

```
ATT2000_WRITE_ENABLED=true
ATT_HOST=sqlserver.example.internal
ATT_PORT=1433
ATT_USER=sishoras_integration
ATT_PASSWORD=<CONFIGURAR_SOLO_EN_API_ENV>
ATT_DATABASE=att2000
```

Luego `pm2 reload sishoras-api`.

## Cron respaldo (opcional)

Si un reloj queda un rato sin red y pierde algunos PUSH, un cron puede traer
los datos desde `att2000.CHECKINOUT` periódicamente. En `api/.env`:

```
ATT2000_PULL_CRON=*/10 * * * *
```

(sintaxis node-cron — cada 10 minutos).

## Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| No aparece el registro PUSH tras reboot | `Server Address/Port` mal configurado | Revisar y volver a reiniciar |
| Registra pero no llegan marcajes | `Realtime=0` o `TransFlag` sin `AttLog` | El Bridge ya envía la config correcta — reiniciar el reloj para re-leerla |
| `lastSeen` actualiza pero `lastPunch` no | El reloj manda heartbeat pero no envía marcajes | Verificar que el usuario existe en el reloj y marca correctamente |
| Error en attendanceController "empleado desconocido" | `employees.code` no coincide con `USERID` del reloj | Correr `POST /api/sync/employees` o crear manualmente |
