# Dependencias y versión de Node

## Vulnerabilidades resueltas (este PR)

`npm audit` en producción quedó en **0 vulnerabilidades** en API y web.

### API
- **body-parser** (< 1.20.6, DoS) y **brace-expansion** (< 1.1.16, DoS): eran
  dependencias **transitivas** (vía Express). Resueltas con `npm audit fix` (sin
  `--force`): sólo se actualizó `package-lock.json`, sin cambios de código.

### Web
- **sharp** (< 0.35.0, CVEs de libvips): fijada a **^0.35.3** mediante `overrides`
  (sharp es transitiva de Next).
- **next**: subida al último estable **16.2.11**. Tras el override de sharp y la
  actualización, `npm audit` reporta **0 vulnerabilidades**.
- Los avisos de Next que aparecían además **no aplican a esta app** por su
  arquitectura: no usa **Server Actions** (SSRF/DoS/disclosure de server
  functions), no define **rewrites** (SSRF por destino), no usa **next/image**
  (DoS de optimización de SVG), no tiene **middleware** de auth (bypass de
  proxy) ni **custom server**. La autenticación es JWT del lado cliente contra la
  API. Cuando exista un estable 16.3.x con los parches, conviene subir igual.

> Regla del proyecto: **nunca** `npm audit fix --force`. Cada dependencia se
> analiza y se actualiza de forma controlada.

## Versión de Node

- Producción corre **Node 20** y la app funciona correctamente.
- `mssql@12` / `tedious` emiten una advertencia porque prefieren **Node ≥ 22**.
  No bloquea el build ni la conexión a SQL Server (att2000).
- Se agregó `engines.node = ">=20"` en `api`, `web` y `bridge` como mínimo
  soportado documentado.

### Recomendación para subir a Node 22 (controlado, no en este PR)

El CI se mantiene en **Node 20** para conservar paridad con producción. La
migración a Node 22 LTS debe validarse primero en un entorno de prueba:

1. Preparar staging con Node 22 LTS.
2. `npm ci` en `api`, `web`, `bridge` y `npm run build` del web.
3. Probar conexión a SQL Server (att2000) y las migraciones.
4. Levantar los cuatro procesos PM2 (api, web, bridge, analytics) + worker y
   correr una jornada de humo.
5. Recién entonces actualizar Node en producción y el `node-version` del CI.

Alternativa si no se quiere subir Node: fijar `mssql`/`tedious` a una línea
compatible con Node 20. Como hoy funciona en Node 20, no es urgente.
