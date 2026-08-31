# Runbook Operativo — SisHoras

Guía para el equipo de operación. Cubre incidentes comunes, diagnóstico y recovery.

## 🚦 Comandos de diagnóstico rápido

```bash
# Estado de todos los servicios
pm2 status

# Logs en vivo
pm2 logs sishoras-bridge --lines 100
pm2 logs sishoras-api --lines 100
pm2 logs sishoras-web --lines 100

# Estado de relojes (endpoint público del Bridge)
curl http://localhost:8081/push-state | jq

# Último marcaje en MySQL
sudo mysql asistencia -e "SELECT id, employee_id, timestamp, type, source FROM attendance_logs ORDER BY id DESC LIMIT 5"

# Recursos del servidor
df -h /
free -m
```

---

## 🔥 Incidente: el Bridge se cae

**Síntoma:** `pm2 status` muestra `sishoras-bridge errored` o `stopped`.

**Diagnóstico:**
```bash
pm2 logs sishoras-bridge --err --lines 50
```

**Causas comunes:**
| Log | Causa | Solución |
|---|---|---|
| `EADDRINUSE :::8080` | Otro proceso toma el puerto | `sudo lsof -i :8080` → matar proceso duplicado |
| `Redis: ECONNREFUSED` | Redis caído | `systemctl restart redis` |
| `null.subarray is not a function` | node-zklib viejo | Actualizar con `cd bridge && npm install node-zklib@^1.3.0` |

**Recovery:**
```bash
pm2 restart sishoras-bridge
pm2 logs sishoras-bridge --lines 20   # confirmar arranque OK
```

---

## 🔥 Incidente: no llegan marcajes de un reloj

**Diagnóstico en orden:**

### 1. ¿El reloj tiene red?

Tomar la IP del dispositivo desde la configuración local/BD; no mantener IPs
internas en el repositorio.

```bash
ping -c 3 <DEVICE_IP>
```

### 2. ¿Está enviando heartbeat PUSH?
En la UI: `/configuracion → Relojes → expandir → Verificar PUSH`.
O por API:
```bash
curl http://localhost:8081/push-state | jq
```
Si `lastSeen` es > 15 min atrás o null → el reloj perdió la conexión ADMS.

### 3. ¿Está configurado ADMS?
Ir al reloj: Menú → Comm → Cloud Server → confirmar IP/puerto (ver `docs/zkteco-push-setup.md`).

### 4. Como fallback, forzar una lectura/descarga controlada

Usar sólo los caminos que terminan en MySQL local. att2000 es fuente de lectura:
ningún procedimiento de recovery debe escribir en SQL Server.

### 5. Si ningún flujo funciona
Verificar que el **servicio Windows Attendance Management** en ADVENTISTA esté detenido:
```powershell
Get-Service | Where-Object { $_.Name -like "*Attendance*" -or $_.Name -like "*ZKTeco*" }
Stop-Service -Name "<nombre>"
Set-Service -Name "<nombre>" -StartupType Disabled
```

---

## 🔥 Incidente: marcajes duplicados en BD

**Diagnóstico:**
```sql
SELECT employee_id, timestamp, COUNT(*) AS c
FROM attendance_logs
GROUP BY employee_id, timestamp
HAVING c > 1;
```

**Causa:** la migración 005 no fue aplicada.

**Solución:**
```bash
sudo mysql asistencia < database/migrations/005_attendance_logs_unique.sql
```

---

## 🔥 Incidente: no se puede LEER att2000

att2000 es **estrictamente READ-ONLY**. SisHoras no replica marcajes hacia
`CHECKINOUT` y no existe `ATT2000_WRITE_ENABLED` en el código actual.

**Diagnóstico:**
- verificar conectividad de red al SQL Server;
- verificar que el usuario configurado tenga permisos de sólo lectura;
- ejecutar el test de conexión/introspección disponible en el sistema;
- revisar logs por errores de conexión o timeout.

**Nunca** resolver este incidente agregando INSERT/UPDATE/DELETE sobre att2000.

---

## 🔧 Procedimiento: agregar un nuevo reloj

1. Dar de alta en UI: `/configuracion → Relojes → + Nuevo`
   - Nombre, IP, puerto 4370
2. Configurar ADMS apuntando a la IP/puerto local del Bridge definidos en el entorno (no documentarlos en el repositorio público).
3. (Opcional) agregar el serial a la whitelist local de `api/.env`.
4. `pm2 reload sishoras-api sishoras-bridge`
5. Verificar con `curl http://localhost:8081/push-state`

---

## 🔧 Procedimiento: cambiar el código de un empleado

Los cambios administrativos de identificación se hacen únicamente en la base
propia de SisHoras y mediante las pantallas/procedimientos soportados.

att2000 no se modifica desde Gestion_Horas. Si la fuente externa requiere una
corrección de USERID, debe realizarla el administrador del sistema fuente con su
propio procedimiento, fuera de SisHoras y con trazabilidad independiente.

Los marcajes históricos ya persistidos en `attendance_logs` usan
`employee_id` interno y no deben reescribirse por este motivo.

---

## 🔧 Procedimiento: restaurar backup MySQL

```bash
# Ver backups disponibles
ls -lh /var/backups/sishoras/

# Restaurar (reemplaza BD existente)
gunzip -c /var/backups/sishoras/asistencia_2026-04-17.sql.gz | sudo mysql asistencia
```

---

## 📊 Métricas a vigilar

| Métrica | Umbral OK | Alerta |
|---|---|---|
| Bridge heartbeat SN | < 5 min | > 15 min |
| Marcajes MySQL hoy | > 0 después de 08:00 | = 0 a las 10:00 |
| pm2 restart count | < 5 / día | > 20 / día |
| Disco / | < 80% | > 90% |
| Reconciliation `missing_in_mysql` | 0 | > 10 |

---

## 🆘 Contactos de escalación

- Dev principal: dalton9302@gmail.com
- Servidor: `ssh user@bridge.example.internal` (antigravity)
- Repo: https://github.com/DaltonP93/Gestion_Horas
