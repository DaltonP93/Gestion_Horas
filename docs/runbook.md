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
```bash
ping -c 3 10.0.0.160   # Comedor
ping -c 3 10.0.0.161   # Lavadero
ping -c 3 10.0.0.162   # Gerencia
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

### 4. Como fallback, forzar descarga manual
```
/configuracion → Relojes → Conectar al reloj → Descargar → att2000 + MySQL local
```

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

## 🔥 Incidente: att2000 no recibe marcajes

**Diagnóstico:**
```bash
# Confirmar que el flag está activo
grep ATT2000_WRITE_ENABLED /var/www/html/Gestion_Horas/api/.env

# Probar conexión manual
curl -X POST http://localhost:4000/api/sync/test-conn \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"host":"sqlserver.example.internal","user":"sishoras_integration","password":"<CONFIGURAR_SOLO_EN_API_ENV>"}'
```

**Solución:**
1. `ATT2000_WRITE_ENABLED=true` en `api/.env`
2. `pm2 reload sishoras-api`
3. Verificar logs: `pm2 logs sishoras-api | grep writeCheckinOut`

---

## 🔧 Procedimiento: agregar un nuevo reloj

1. Dar de alta en UI: `/configuracion → Relojes → + Nuevo`
   - Nombre, IP, puerto 4370
2. Configurar ADMS en el reloj apuntando a `bridge.example.internal:8080`
3. (Opcional) agregar SN a whitelist: `api/.env` → `ZKTECO_PUSH_WHITELIST=101,103,1,NUEVO_SN`
4. `pm2 reload sishoras-api sishoras-bridge`
5. Verificar con `curl http://localhost:8081/push-state`

---

## 🔧 Procedimiento: migrar código de empleado

Cuando el código ZKTeco (`USERID`) de un empleado cambia:

```sql
-- En MySQL
UPDATE employees SET code = 'NUEVO_CODE' WHERE id = <id>;

-- En att2000 (SQL Server)
UPDATE USERINFO SET USERID = <nuevo> WHERE USERID = <viejo>;
UPDATE CHECKINOUT SET USERID = <nuevo> WHERE USERID = <viejo>;
```

Los marcajes históricos ya en `attendance_logs` no necesitan cambio — `employee_id` es FK interno.

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
