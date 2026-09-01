# SisHoras — Sistema de Gestión de Asistencia

@docs/AI_HANDOFF.md

## Descripción
Reemplazo del sistema ZKTeco (SisHoras legacy) por una aplicación web moderna.
Conecta a relojes biométricos ZKTeco y genera reportes de asistencia por empleado, día, semana y mes.

## Stack
- **API:** Node.js + Express, puerto 4000, JWT auth, Socket.io tiempo real
- **Web:** Next.js 14 App Router, puerto 3000, Tailwind CSS, Recharts
- **Analytics:** FastAPI Python 3.12, puerto 5000
- **Bridge:** Node.js ZKTeco bridge, puerto 8081 (API) / 8080 (PUSH relojes)
- **BD principal:** MySQL 8 → base de datos `asistencia`
- **BD fuente:** SQL Server `att2000` en entorno ADVENTISTA — SOLO LECTURA
- **Cache/RT:** Redis puerto 6379

## Producción
- **Entorno:** Ubuntu 22.04
- **Dominio:** configurado por variables/infraestructura del despliegue
- **Directorio:** definido en el servidor de despliegue
- **Gestor de procesos:** PM2 (api, web, bridge, analytics)
- **Repo GitHub:** https://github.com/DaltonP93/Gestion_Horas.git

## Seguridad y credenciales
> **Importante:** No almacenar credenciales, contraseñas, hosts internos, IPs privadas ni datos sensibles en el repositorio.
>
> Configurar todo mediante variables de entorno locales o secretos del servidor:
>- `DB_HOST`
>- `DB_PORT`
>- `DB_NAME`
>- `DB_USER`
>- `DB_PASSWORD`
>- `ATT2000_HOST`
>- `ATT2000_PORT`
>- `ATT2000_USER`
>- `ATT2000_PASSWORD`
>- `JWT_SECRET`
>- `REDIS_URL`
>
> **att2000 (fuente SQL Server) — variables reales y READ-ONLY:**
>- `ATT_HOST`
>- `ATT_PORT`
>- `ATT_USER`
>- `ATT_PASSWORD`
>- `ATT_DATABASE`
>
> **att2000 es ESTRICTAMENTE READ-ONLY.** Gestion_Horas nunca escribe en att2000:
> el conector `config/att2000.js` sólo expone lectura/introspección, no existe
> `writeCheckinOut` ni ningún `INSERT/UPDATE/DELETE` sobre `CHECKINOUT`, y el
> viejo flag `ATT2000_WRITE_ENABLED` fue eliminado. `att2000Readonly.test.js`
> lo verifica sobre el fuente. Las variables `ATT2000_*` que figuraban antes no
> son las reales; usar `ATT_*`.

## Relojes ZKTeco
La configuración de relojes biométricos debe mantenerse fuera del repositorio, usando base de datos, archivo `.env` o secretos del entorno.

## Estructura del proyecto
```
/
├── api/          Express API (src/index.js, src/routes/, src/services/)
├── web/          Next.js (src/app/(app)/ para páginas con sidebar)
├── bridge/       ZKTeco bridge
├── analytics/    FastAPI (.venv/ para Python)
├── database/     init.sql + migrations/
├── scripts/      test-connection.js, inspect-att2000.js
└── ecosystem.config.js   PM2 config
```

## Páginas implementadas
- `/login` — autenticación JWT
- `/dashboard` — KPIs en tiempo real vía Socket.io
- `/asistencia` — tabla diaria con live feed
- `/empleados` — listado con filtros
- `/empleados/[id]` — detalle con historial y edición inline
- `/empleados/nuevo` — formulario alta
- `/permisos` — gestión aprobación/rechazo (incluye rechazo con fecha alternativa en vacaciones)
- `/reportes` — Marcadas (formato PDF ZKTeco), programados, SMTP
- `/reportes/planillas-legales` — MTESS (control de asistencia y comunicación), IPS jornales/aportes, aguinaldo y parámetros de liquidación
- `/turnera` — planificación de turnos (semana domingo→sábado)
- `/horas-extra` — revisión y autorización de horas extra
- `/marcaciones-fuera-rango` — entradas muy tempranas / salidas muy tardías con umbrales configurables
- `/marcaciones-geocerca` — marcajes registrados fuera del perímetro de la sede (modo "advertir")
- `/vacaciones` — plan mensual, saldos por empleado y política parametrizable por antigüedad
- `/ingresos` — Ingresos/Egresos: contratos, período de prueba, alertas y baja de personal
- `/lactancia` — maternidad/lactancia: reducción horaria parametrizable con vigencia y alertas
- `/onboarding` — checklists de ingreso/egreso (tareas operativas)
- `/marcar` — marcación móvil con geocerca (validación de perímetro por sede)
- `/configuracion/reglas` — constructor de condiciones (motor de reglas parametrizable)
- `/configuracion/sedes` — sedes + geocerca (coordenadas y radio por sede, modo global)
- `/usuarios` — CRUD usuarios con roles
- `/analytics/[id]` — gráficas por empleado (Recharts)
- `/configuracion` — configuración general
- **Ayuda contextual:** el botón flotante "?" (HelpButton) muestra la documentación de cada módulo desde `web/src/data/helpContent.ts`

## Comandos frecuentes en producción
```bash
# Ver estado de servicios
pm2 status

# Ver logs en tiempo real
pm2 logs api
pm2 logs web

# Recargar tras cambio de código
pm2 reload api
pm2 reload web

# Actualizar desde GitHub
git pull origin main
cd web && npm run build && cd ..
pm2 reload all

# Base de datos
# usar las credenciales del entorno, no hardcodeadas

# Reiniciar Nginx
systemctl reload nginx
```

## Flujo de sincronización att2000 → asistencia
1. API lee `att2000.CHECKINOUT` — campos: `USERID`, `CHECKTIME`, `CHECKTYPE` (I/O)
2. Mapea `USERID` → `employees.code`
3. Inserta en `attendance_logs` con type `in`/`out`
4. Calcula `daily_summary` (worked_minutes, late_minutes, status)

## Notas importantes
- Las páginas con sidebar van en `web/src/app/(app)/` (route group)
- El alias `@/*` → `src/*` está en `tsconfig.json`
- La API debe leer secretos desde `process.env`
- El bridge tiene DOS puertos: 8080 (PUSH ZKTeco) y 8081 (API bridge)
- Analytics Python debe ejecutarse con su entorno virtual local
