# ADR 0001 — Migración de autenticación web a cookies HttpOnly (por etapas)

- **Estado:** Propuesto (Draft). Requiere aprobación del propietario antes de desarrollar código.
- **Fecha:** 2026-09-06 · **Autor:** Agente 0 (líder). Decisión D3 = opción A (cookies HttpOnly, por etapas).
- **Relacionado:** `SECURITY.md` H2/H3/H4/H5; `INTEGRATION_PLAN.md`.

## Contexto (estado real, verificado sobre `main @ 078cd67`)

- El web guarda **`access_token` y `refreshToken` en `localStorage`** (`web/src/lib/api.ts`,
  `web/src/lib/socket.ts`) → robables por un XSS (H2, P1).
- Las **descargas/exports** (PDF, xlsx) se abren con `window.open` y pasan el JWT por
  **query string** (`?access_token=…`), que el proxy/logs pueden capturar (H3, P1). La redacción
  en logs la aporta #194; el token en la URL sigue siendo un vector.
- El **WebSocket** ya autentica por `handshake.auth.token` (no por URL) — no requiere token en query.
- El **access token es stateless (1h)**; `authenticate` no revalida `active`/empresa ni hay
  `jti`/tabla de sesiones → revocación inefectiva (H4/H5).
- **Topología:** un `nginx` sirve el mismo dominio para el web (Next.js `:3000`) y la API
  (`/api` → `:4000`) → **first-party same-site**, por lo que cookies `SameSite` son viables.
  CORS ya usa `credentials: true`. El **Bridge** usa `x-api-key` (no cookies de usuario) → no afectado.

## Decisión

Migrar la autenticación web a **cookies `HttpOnly` + `Secure` + `SameSite`** para el
access y el refresh token, **por etapas**, con **compatibilidad hacia atrás** y todo el
comportamiento nuevo **apagado por defecto** (flags fail-closed: sólo el literal `"true"`
habilita) hasta aprobación explícita. Sin corte brusco.

## Diseño (consideraciones obligatorias)

- **Topología web/API:** mismo sitio detrás de nginx → cookies first-party. Definir dominio/subdominio
  exacto en config, no hardcodeado.
- **`SameSite`:** `Lax` para el flujo normal (navegación + XHR same-site); evaluar `Strict` para el
  refresh. `None` sólo si algún cliente cross-site lo exige (no es el caso hoy) y siempre con `Secure`.
- **CORS con credenciales:** mantener `credentials: true` y **origen explícito** (no `*`); mover los
  orígenes a env (hoy hay hosts hardcodeados, H12).
- **CSRF:** con cookies, los métodos mutantes necesitan protección CSRF (double-submit token o
  `SameSite=Strict` + verificación de `Origin`/`Referer`). Definir e implementar antes de activar cookies.
- **Refresh: rotación + detección de replay:** rotar el refresh en cada uso; si se reusa uno ya
  rotado, invalidar toda la familia (hoy se borra el viejo pero no hay detección explícita de replay).
- **Logout y revocación:** endpoint que borra cookies e invalida el refresh en servidor; ligar a
  `jti`/tabla de sesiones para revocación efectiva (cierra H4/H5). Suspensión de usuario/empresa
  debe cortar sesiones vivas.
- **Sincronización entre pestañas:** con cookies HttpOnly el JS no lee el token; usar un canal
  (storage event / BroadcastChannel) sólo para señales de login/logout, no para el token.
- **Expiración:** access corto (p. ej. 15 min) + refresh con vida mayor; renovación transparente
  vía endpoint de refresh que setea nuevas cookies.
- **WebSocket sin token en URL:** ya usa `handshake.auth`; con cookies, el handshake puede leer la
  cookie en el server. Revalidación periódica de la conexión (cierra H5).
- **Descargas/exports que hoy usan token por query:** reemplazar por (a) cookie enviada por el
  navegador en la request de descarga, o (b) un **token de descarga de un solo uso y corta vida**
  emitido por un endpoint y validado por el de descarga. Elimina el JWT de la URL (H3).
- **Compatibilidad (Bridge/PWA/otros):** el Bridge usa `x-api-key` (sin cambios). Si hay PWA u otros
  clientes que dependan de Bearer, mantener el modo Bearer en **coexistencia** durante la migración.
- **Rollback:** cada etapa detrás de flag; desactivar el flag revierte al comportamiento anterior.
- **Coexistencia:** período en que el backend acepta **ambos** (Bearer header y cookie); el retiro
  del modo Bearer es la última etapa, sólo tras validación.
- **Pruebas adversariales:** CSRF sin token → rechazo; XSS no puede leer la cookie HttpOnly; replay de
  refresh rotado → familia invalidada; descarga sin token reutilizable en URL; revocación tras
  suspensión corta el access y el WS; CORS con origen no permitido → preflight falla.

## Plan por etapas (cadena Draft pequeña; flags fail-closed; NO activar ahora)

1. **Fundación backend compatible (OFF):** emitir/leer cookies además del Bearer, sin cambiar el
   default; endpoints de refresh/logout que setean/borran cookies; `jti`/tabla de sesiones. Flag `AUTH_COOKIE_MODE` (default off).
2. **Cookies seguras + CSRF (con tests):** `HttpOnly/Secure/SameSite` + protección CSRF de mutantes.
3. **Cliente web sin `localStorage`:** dejar de persistir tokens; usar cookies; sincronización entre pestañas por señal.
4. **WebSocket autenticado sin credencial en query:** handshake por cookie + revalidación periódica.
5. **Descargas/exports sin token reutilizable en URL:** token de un solo uso o cookie.
6. **Retiro del modo heredado (Bearer/localStorage):** última etapa, sólo tras validación; no ahora.

## Consecuencias

- **Positivas:** cierra H2 (XSS no roba sesión), H3 (token fuera de URL/logs), y habilita H4/H5
  (revocación efectiva). Mejora la postura sin romper el Bridge.
- **Costos:** CSRF nuevo, cambios en front y en el flujo de descargas, período de coexistencia,
  y una tabla de sesiones (migración). Cada etapa es revertible por flag.

## Estado de decisión

Este ADR **no** implementa código. La cadena de etapas se abrirá como PRs Draft pequeños
**cuando se libere capacidad de rama** (máximo 2 ramas de código activas) y con aprobación del
propietario para arrancar la etapa 1. Ninguna etapa activa comportamiento por defecto.
