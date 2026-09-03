# Guía de Prueba Local — Paso a Paso

## El flujo real del sistema

```
Relojes ZKTeco (3)
  10.x.x.11  Reloj Ejemplo 1
  10.x.x.12  Reloj Ejemplo 2
  10.x.x.13  Reloj Ejemplo 3
        ↓
ZKTeco Fingerprint Attendance System V2011
        ↓
SQL Server "ADVENTISTA" → base de datos: att2000
  Tablas clave:
    CHECKINOUT   ← marcajes (USERID, CHECKTIME, CHECKTYPE, SENSORID)
    USERINFO     ← empleados (USERID, Badgenumber, Name)
    DEPARTMENTS  ← departamentos
    SHIFT        ← horarios
    Machines     ← relojes
        ↓
[NUEVO SISTEMA]  ← lee att2000 y procesa en su propio MySQL
        ↓
Dashboard web en tiempo real + App móvil
```

El nuevo sistema se conecta a att2000 en **modo solo lectura**.
Tiene su propio MySQL donde guarda los datos procesados.

---

## PASO 1 — Instalar Docker Desktop

Docker levanta el MySQL y Redis del nuevo sistema con un comando.

1. Descarga: https://www.docker.com/products/docker-desktop/
2. Instala con opciones por defecto
3. Reinicia la PC
4. Verifica en CMD/PowerShell:
   ```
   docker --version
   ```

---

## PASO 2 — Instalar Node.js

1. Descarga versión LTS: https://nodejs.org/
2. Instala con opciones por defecto
3. Verifica:
   ```
   node --version
   ```

---

## PASO 3 — Habilitar SQL Server para conexiones TCP/IP

El nuevo sistema se conecta a SQL Server desde Docker.
Necesitas habilitar TCP/IP en el servidor ADVENTISTA:

1. Abre **SQL Server Configuration Manager** en el servidor
2. Ve a: SQL Server Network Configuration → Protocols for MSSQLSERVER
3. Haz doble click en **TCP/IP** → Habilitar
4. Reinicia el servicio SQL Server
5. Verifica que el puerto 1433 esté abierto en el firewall

---

## PASO 4 — Inspeccionar la base de datos att2000

```bash
cd nuevo-sistema/scripts
npm install
node inspect-att2000.js
```

El script preguntará:
- Servidor: `sqlserver.example.internal` (o su IP en la red, ej: 10.x.x.x)
- Usuario: `sa`
- Contraseña: la del sa

Verás un resumen de cuántos marcajes hay, empleados, departamentos,
y te mostrará el formato exacto de los datos.

---

## PASO 5 — Configurar el .env

```bash
copy .env.example .env
```

Edita `.env` con los datos del SQL Server:
```
# SQL Server att2000 (SOLO LECTURA)
ATT_HOST=sqlserver.example.internal     # o la IP del servidor, ej: 10.x.x.x
ATT_PORT=1433
ATT_USER=sishoras_integration
ATT_PASSWORD=<CONFIGURAR_SOLO_EN_API_ENV>
ATT_DATABASE=att2000
```

El resto del .env (MySQL, JWT, etc.) puede dejarse con los valores por defecto para pruebas.

---

## PASO 6 — Levantar los servicios de infraestructura

```bash
cd nuevo-sistema
docker compose -f docker-compose.dev.yml up -d
```

Esto levanta solo MySQL y Redis localmente.
Verifica que estén corriendo:
```bash
docker compose -f docker-compose.dev.yml ps
```

---

## PASO 7 — Iniciar el API en modo desarrollo

```bash
cd nuevo-sistema/api
npm install
npm run dev
```

Debes ver:
```
✅ Redis conectado
✅ MySQL conectado
🚀 API corriendo en puerto 4000
```

---

## PASO 8 — Primera sincronización

Con el API corriendo, haz login y sincroniza los datos de att2000:

```bash
# Login
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}'

# Guarda el accessToken que devuelve, luego:

# Probar conexión a att2000
curl http://localhost:4000/api/sync/test \
  -H "Authorization: Bearer TU_TOKEN"

# Sincronización completa (importa todo desde att2000)
curl -X POST http://localhost:4000/api/sync/full \
  -H "Authorization: Bearer TU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dateFrom":"2026-01-01","dateTo":"2026-04-11"}'
```

---

## PASO 9 — Abrir el Dashboard

```bash
cd nuevo-sistema/web
npm install
npm run dev
```

Abre: http://localhost:3000
Usuario: `admin` | Contraseña: `Admin1234!`

---

## Comandos de diagnóstico

```bash
# Ver logs del API
cd nuevo-sistema/api && npm run dev

# Ver tablas del nuevo MySQL
docker exec -it asistencia_db_dev mysql -u asistencia_user -p asistencia

# Probar conexión att2000
node scripts/inspect-att2000.js

# Reiniciar servicios Docker
docker compose -f docker-compose.dev.yml restart
```

---

## Arquitectura de red (importante)

```
Tu PC de desarrollo
  ├── Docker: MySQL :3306    (nuevo sistema)
  ├── Docker: Redis :6379    (pub/sub)
  ├── Node: API :4000        (conecta a ambas DBs)
  └── Node: Web :3000        (dashboard)
            ↕ red LAN
Servidor ADVENTISTA
  └── SQL Server :1433       (att2000 - solo lectura)
```

La PC de desarrollo debe tener acceso de red al servidor ADVENTISTA.
