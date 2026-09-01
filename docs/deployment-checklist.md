# Deployment Checklist — SisHoras producción

Checklist para dejar el sistema 100% funcional en producción.

## 1. Base de datos

> **FASE E / Workday Engine:** en una producción existente, NO ejecutar todavía
> `npm run migrate` a ciegas. Para un preflight estrictamente sin escritura usar
> `node api/scripts/workday-config-preflight.js --json`. El comando
> `migrate:status` queda reservado hasta integrar #154, que corrige su antiguo
> efecto lateral de crear `schema_migrations`. Las migraciones 072→075 requieren
> rollout controlado, backup y flags del motor en OFF.

- [ ] Aplicar migration 005:
  ```bash
  sudo mysql asistencia < database/migrations/005_attendance_logs_unique.sql
  ```
  Verificar: `SHOW INDEX FROM attendance_logs WHERE Key_name = 'uq_attendance_punch';`

## 2. Variables de entorno

En `api/.env`:

```
# att2000 es FUENTE READ-ONLY. No existe ni debe agregarse un flag de escritura.
ATT_HOST=<sqlserver-att2000>
ATT_PORT=1433
ATT_USER=<usuario-solo-lectura>
ATT_PASSWORD=<secreto-local>
ATT_DATABASE=att2000

ATT2000_PULL_CRON=*/10 * * * *      # lectura periódica opcional
BRIDGE_URL=http://localhost:8081
ZKTECO_PUSH_WHITELIST=<seriales-autorizados-opcional>
```

> **Invariante:** Gestion_Horas nunca ejecuta INSERT/UPDATE/DELETE sobre att2000.
> Si un entorno todavía contiene `ATT2000_WRITE_ENABLED`, es una variable obsoleta
> y debe eliminarse; el código actual no la consume.

En `bridge/.env`:
```
API_URL=http://localhost:4000
API_SERVICE_KEY=<misma que en api/.env>
PUSH_PORT=8080
PORT=8081
REDIS_URL=redis://localhost:6379
ZKTECO_AUTO_POLL=false              # PUSH es el canal principal
```

## 3. Servidor ADVENTISTA (Windows — SQL Server att2000)

- [ ] `services.msc` → buscar "ZKTeco" / "Attendance Management" / "ADMS"
- [ ] Detener servicio
- [ ] Cambiar tipo de inicio a **Deshabilitado**
- [ ] Cerrar GUI del Attendance Management Program

Verificar: `netstat -an | findstr :4370` no debe mostrar conexiones ESTABLISHED desde otra IP.

## 4. Firewall Linux

Usar el segmento LAN real del entorno; no documentarlo en el repositorio público.

```bash
sudo ufw allow from <LAN_CIDR> to any port 8080   # PUSH ZKTeco
sudo ufw allow from <LAN_CIDR> to any port 4370   # acceso a relojes
sudo ufw status
```

## 5. Configurar relojes

Ver `docs/zkteco-push-setup.md`. Repetir la validación para cada reloj autorizado
tomando IP/serial desde la configuración local o la base de datos, no desde este repositorio.

## 6. Actualizar código + reiniciar

```bash
cd /var/www/html/Gestion_Horas
git pull origin main
cd api && npm install && cd ..
cd bridge && npm install && cd ..
cd web && npm install && npm run build && cd ..
pm2 reload all
```

## 7. Logs rotativos

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

## 8. Backups MySQL

Agregar al crontab de root:
```
0 2 * * * /var/www/html/Gestion_Horas/scripts/backup-mysql.sh
```

## 9. Validación end-to-end (script simulador)

```bash
# Test 1 — handshake + marcaje ficticio contra localhost
node scripts/simulate-push.js localhost:8080 SIMTEST01 999 3

# Test 2 — verificar en BD
sudo mysql asistencia -e "SELECT * FROM attendance_logs WHERE raw_data LIKE '%SIMTEST01%' LIMIT 5"

# Test 3 — con empleado real (code=123 en employees)
node scripts/simulate-push.js localhost:8080 TEST 123 1
```

## 10. Validación con reloj físico

- [ ] Marcar huella en reloj Comedor
- [ ] `pm2 logs sishoras-bridge` → `PUSH de SN=...`
- [ ] `/dashboard` → marcaje en vivo vía Socket.io
- [ ] MySQL: `SELECT * FROM attendance_logs ORDER BY id DESC LIMIT 5;`
- [ ] SQL Server att2000: sólo lectura; opcionalmente verificar que la fuente sigue accesible con un `SELECT`. No esperar replicación desde SisHoras.

## 11. Monitoreo post-deploy

Primeras 24 h vigilar:
```bash
pm2 logs sishoras-bridge | grep -i "error\|timeout"
pm2 logs sishoras-api    | grep -i "error\|desconocido"
```

Si algún reloj deja de reportar > 15 min → la UI muestra "PUSH inactivo" en `/configuracion → Verificar PUSH`.
