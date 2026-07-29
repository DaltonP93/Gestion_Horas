# Warning de Chrome "CSS preloaded but not used"

## Síntoma

En Chrome DevTools, al navegar por la app aparecía repetidamente:

```
The resource <chunk>.css was preloaded using link preload but not used within a
few seconds from the window's load event. Please make sure it has an appropriate
`as` value and it is preloaded intentionally.
```

No hay fallo funcional: las páginas cargan y las rutas funcionan.

## Reproducción (build de producción)

```bash
cd web
npm run build
node scripts/inspect-css-preload.js   # inspecciona el HTML PRERENDERIZADO
```

Además se cargó el build con `npm run start` y Chromium headless (motor de
Chrome) inyectando un usuario admin en `localStorage` (así el sidebar renderiza),
capturando la consola y los `<link rel="preload">` inyectados en:

- carga directa de `/dashboard`, `/configuracion`, `/m/talento`, `/m/administracion`;
- navegación cliente entre esas rutas;
- recarga y contexto nuevo (equivalente a incógnito, sin caché).

## Causa raíz

El **HTML del build actual (Next 16.2.11) NO emite preloads de CSS** en esas
cuatro rutas: el CSS se entrega como `<link rel="stylesheet">` (2 chunks
inmutables compartidos por todas las páginas). Verificado con Chromium: **0**
`<link rel="preload" as="style">` en la carga inicial y **0** inyectados durante
la navegación cliente.

El único origen real de un preload de CSS **sin usar** en el build era:

- **Ruta:** `/seguridad`
- **Archivo responsable:** `web/src/app/(app)/seguridad/page.tsx`, que hacía un
  `redirect('/cuenta/seguridad')` del lado del servidor.
- **HTML responsable:** al prerenderizar esa página, Next incluía el CSS del
  layout como `<link rel="preload" as="style" href="/_next/static/chunks/….css">`
  **y** el `<link rel="stylesheet">`. Como la página **redirige de inmediato**,
  ese CSS precargado nunca se "usa" en ese documento → warning de Chrome.

Es decir: una **página que redirige** bajo el layout `(app)` precargaba CSS que
no llegaba a aplicarse. Las demás rutas no generan el preload.

`nginx-sishoras.conf` **no** agrega ningún header `Link: <...css>; rel=preload`
(sólo hace `proxy_pass` a Next). No se modificó Nginx.

### Vector secundario: caché tras deploy (service worker)

El service worker (`web/public/sw.js`) cacheaba los assets inmutables de
`/_next/static/` con estrategia *cache-first* bajo un nombre de caché **fijo**
(`sishoras-v2`). Como `activate` sólo borra cachés con **otro** nombre, los
chunks de builds anteriores quedaban atrapados entre deploys y podían mezclarse
con el HTML nuevo — el escenario "HTML anterior + chunks de un build nuevo".

## Solución (dos cambios, ambos respaldados por evidencia)

### 1) Redirección a nivel de routing (causa raíz reproducida)

Se movió `/seguridad → /cuenta/seguridad` a `redirects()` en `next.config.js`
(308, **antes** de renderizar) y se eliminó `src/app/(app)/seguridad/page.tsx`.
Al no renderizar HTML para `/seguridad`, no se emite ningún preload de CSS. El
enlace antiguo sigue funcionando (redirección permanente) y es más rápido.

### 2) Higiene de caché del service worker (vector post-deploy)

- El SW **ya no cachea** `/_next/static/` (assets inmutables con hash en el
  nombre; los maneja la caché HTTP del navegador con `Cache-Control: immutable`).
  Así un deploy no deja chunks/CSS de builds anteriores atrapados.
- Se subió el nombre de caché a `sishoras-v3` para **purgar** el caché viejo en
  la próxima activación del SW.

No se aplicó ninguna solución artificial: no se ocultan warnings con filtros, no
se eliminan `<link>` por JavaScript, no se desactiva el prefetch ni ninguna
optimización de Next, no se convirtió nada a client component, no se eliminó CSS
necesario y no se agregó ningún preload manual.

## Antes / después

| | Antes | Después |
|---|---|---|
| `/seguridad` en el build | `seguridad.html` con **2** `<link rel="preload" as="style">` de CSS | la página no se renderiza (redirect 308); **0** |
| Todas las páginas prerenderizadas | 1 con preload de CSS | **0 / 63** (verificado por `scripts/inspect-css-preload.js`) |
| SW `/_next/static` | cache-first bajo `sishoras-v2` (nunca purgado) | no cacheado; caché `sishoras-v3` purga la vieja |

## Navegadores probados

- **Chromium / Chrome** (motor donde aparece el warning): headless vía Playwright
  sobre el build de producción. El warning es específico de Chromium; Firefox y
  Safari no emiten este aviso.

## Pruebas automatizadas

- **`web/src/__tests__/noManualCssPreload.test.ts`** (jest, corre en CI): falla si
  el código fuente introduce un preload de CSS manual (`<link rel="preload"
  as="style">`, `ReactDOM.preload/preinit` de un `.css`, o header `Link` de
  preload de CSS).
- **`web/scripts/inspect-css-preload.js`**: tras `npm run build`, revisa el HTML
  prerenderizado y falla (exit 1) si aparece un preload de CSS en el documento.

## Validación en producción

1. Desplegar el frontend:
   ```bash
   git pull origin main
   cd web && npm run build && cd ..
   pm2 reload web
   ```
2. En Chrome (ventana normal y también incógnito), abrir DevTools → Console y
   navegar por `/dashboard`, `/configuracion`, `/m/talento`, `/m/administracion`
   y visitar un enlace viejo a `/seguridad` (debe redirigir a `/cuenta/seguridad`
   con 308). No debe aparecer el warning "preloaded but not used".
3. El service worker nuevo (`sishoras-v3`) se activa al recargar; purga el caché
   anterior. Si un cliente conserva el SW viejo, una recarga forzada o cerrar
   todas las pestañas lo reemplaza.

No toca worker, backend, ZKTeco, configuración de relojes, base de datos ni
USER_WRQ.
