# ADR 0001 — Migración de autenticación web a cookies HttpOnly (por etapas)

- **Estado:** **Dirección HttpOnly ACEPTADA; diseño técnico PENDIENTE de auditoría; implementación NO autorizada.**
  Este ADR **no** implementa código y **no** habilita la etapa 1. Requiere aprobación explícita del propietario,
  PR por PR, tras revisión de este documento.
- **Fecha:** 2026-09-06 · **Autor:** Agente 0 (líder). Decisión D3 = dirección "cookies HttpOnly, por etapas".
- **Relacionado:** `SECURITY.md` H2 (token en `localStorage`), H3 (token en URL/logs), H4/H5 (revocación),
  H12 (orígenes CORS hardcodeados); `INTEGRATION_PLAN.md`.

## Contexto (estado real, verificado sobre `main @ 078cd67`)

- El web guarda **`access_token` y `refreshToken` en `localStorage`** (`web/src/lib/api.ts`,
  `web/src/lib/socket.ts`) → robables por un XSS (H2, P1).
- Las **descargas/exports** (PDF, xlsx) se abren con `window.open` pasando el JWT por **query string**
  (`?access_token=…`), capturable por proxy/logs (H3, P1). #194 redacta el token en logs, pero el token
  en la URL sigue siendo un vector (historial, Referer, cachés intermedias).
- El **WebSocket** autentica por `handshake.auth.token` (no por URL).
- El **access token es stateless (1h)**; `authenticate` no revalida `active`/empresa ni hay `jti`/tabla de
  sesiones → revocación inefectiva (H4/H5).
- **Topología:** un `nginx` sirve el mismo dominio para el web (Next.js `:3000`) y la API (`/api` → `:4000`)
  → **first-party same-site**, por lo que cookies `SameSite` son viables. CORS ya usa `credentials: true`
  (con orígenes hoy hardcodeados, H12). El **Bridge** usa `x-api-key` (no cookies de usuario) → no afectado.

---

## Decisión 1 — ¿Dónde vive cada token? (elección por modelo de amenaza)

Se evaluaron dos modelos:

| | **A. Access + Refresh, ambos en cookie `__Host-` HttpOnly** | **B. Refresh en cookie HttpOnly; access corto SÓLO en memoria JS** |
|---|---|---|
| XSS puede leer el access | **No** (nunca en JS) | **Sí**, durante su vida corta (variable en memoria) |
| XSS puede leer el refresh | No | No |
| Superficie CSRF | Todas las requests autenticadas (mitigable: `SameSite`+CSRF+Origin) | Sólo el endpoint de refresh (el access va por header, no automático) |
| Envío en descargas/WS | Automático por cookie (simple) | Hay que pasar el access en memoria explícitamente (más frágil) |
| Complejidad de cliente | Baja | Alta (rehidratar access vía refresh en cada carga; coordinar memoria) |
| Persistencia tras cerrar pestaña | Controlada por atributos de cookie | El access muere con la pestaña; refresh persiste en cookie |

**Elección: Modelo A (ambos en cookie `__Host-` HttpOnly), con CSRF robusto.**
Justificación por amenaza para **esta** app (herramienta administrativa, first-party same-site tras nginx):
- Cierra **H2/H3 por completo**: ni XSS ni logs/URL ven token alguno; el JS nunca maneja credenciales.
- La topología same-site hace que `SameSite` + validación estricta de `Origin` + token CSRF sean una defensa
  fuerte contra el mayor costo de A (superficie CSRF).
- Descargas y WebSocket transportan la cookie de forma natural (el punto débil de B).
- El beneficio de B (menor superficie CSRF) **no compensa** dejar el access legible por XSS en memoria ni la
  complejidad extra de rehidratación y de pasar el access a WS/descargas.

> El costo asumido de A es implementar CSRF correctamente (Decisión 3). Se asume explícitamente.

## Decisión 2 — Atributos de cookie (`__Host-`, host-only)

Ambas cookies usan el prefijo **`__Host-`**, que el navegador sólo acepta si la cookie es:
**`Secure`**, **`Path=/`** y **SIN atributo `Domain`** (host-only). Esto impide que un **subdominio
same-site malicioso** (`evil.midominio`) las lea, escriba o sobreescriba.

- `__Host-acc` — access token. `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age≈15min`.
- `__Host-ref` — refresh token. `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age≈vida-refresh`.
- `__Host-csrf` — token CSRF **legible por JS** (NO HttpOnly). `Secure; SameSite=Strict; Path=/` (ver Decisión 3).

Notas:
- `__Host-` **obliga `Path=/`**: no se puede acotar el refresh a `/api/auth`. Se acepta ese trade-off a cambio
  de la protección host-only; el servidor sólo **honra** el refresh en el endpoint de refresh (no basta con enviarlo).
- `SameSite=Strict` es viable porque todo el flujo es same-site (no hay POST cross-site legítimos). Es
  **defensa en profundidad**, no la única (navegadores viejos, y `Strict` no cubre todo) → CSRF explícito igual.
- Access corto (~15 min) acota la ventana de una sesión no revocable a nivel stateless (ver Decisión 4).
- Dominio/subdominio exacto y `Secure` vienen de configuración/entorno, **nunca** hardcodeados.

## Decisión 3 — CSRF (obligatorio antes de activar cookies)

Con cookies enviadas automáticamente, **toda** ruta mutante que dependa de la cookie necesita CSRF. Esquema:

1. **Double-submit con cookie legible + header:** el servidor emite `__Host-csrf` (aleatorio, ligado a la
   sesión). El cliente **lee** esa cookie (no es HttpOnly) y **repite** su valor en el header `X-CSRF-Token`
   en cada request mutante. El servidor exige que **header == cookie** (comparación en tiempo constante).
2. **Validación estricta de `Origin`** (y `Referer` como respaldo) contra un **allowlist de orígenes desde
   entorno** (cierra también H12): 
   - `Origin` **ausente** en una ruta mutante → **rechazo 403** (fail-closed).
   - `Origin` presente pero **no** en el allowlist → **rechazo 403**.
3. **Alcance:** aplica a **todos** los métodos que cambian estado (`POST/PUT/PATCH/DELETE`) cuando la
   autenticación proviene de la cookie — **incluidos `refresh` y `logout`** y cualquier ruta mutante cookie-based.
   Las GET idempotentes no mutan estado; las descargas usan el mecanismo de la Decisión 5.
4. El token CSRF **rota** con la sesión (nuevo en login y en cada rotación de refresh).

## Decisión 4 — Modelo de sesión, rotación y revocación (cierra H4/H5)

Tabla de sesiones del servidor (nombre tentativo `auth_sessions`). **Sin número de migración asignado
todavía** (ver Decisión 6). Campos (sin PII directa):

- `session_id` (UUID, PK), `user_id`, `family_id` (UUID por linaje de refresh), `jti` (del access vigente),
- `refresh_hash` — **hash** (p. ej. SHA-256) del secreto de refresh; **nunca** el refresh en claro,
- `issued_at`, `expires_at`, `rotated_at` (NULL si vigente), `replaced_by` (session_id sucesor),
  `revoked_at`, `user_agent_hash` (opcional, hash), **sin IP en claro** (a lo sumo hash, decisión de PII).

**Rotación one-time transaccional:** en cada refresh, dentro de **una transacción** (`SELECT … FOR UPDATE`):
- Verificar que el `refresh_hash` presentado coincide con la fila **vigente** y **no rotada**.
- Si coincide con una fila **ya rotada** → **REPLAY**: invalidar **toda la familia** `family_id`
  (`revoked_at` en todas) y **denegar**. 
- Si válido: emitir nuevo refresh (nuevo hash), marcar el anterior `rotated_at` + `replaced_by`, emitir nuevas
  cookies. Un refresh sólo sirve **una vez**.

**Revocación efectiva:**
- Desactivar/suspender usuario o cambiar su empresa → `revoked_at` en todas sus sesiones.
- El access es stateless y corto (~15 min): la revocación se materializa a más tardar en el próximo refresh.
  Para cortes inmediatos en rutas sensibles, consultar una **denylist rápida por `jti`** (Redis, TTL = vida
  del access). El refresh siempre revalida `active`/empresa contra la BD.
- **WebSocket:** el handshake valida la sesión leyendo la cookie en el server; **revalidación periódica**
  cierra la conexión si la sesión fue revocada (cierra H5).

## Decisión 5 — Descargas/exports sin JWT reutilizable en la URL (cierra H3)

Reemplazar `window.open('…?access_token=JWT')` por, en orden de preferencia:
1. **Cookie de sesión** enviada por el navegador en la GET de descarga (same-origin) — sin token en URL.
2. Si (1) no aplica, un **token de descarga OPACO, aleatorio, de un solo uso y corta vida** emitido por un
   endpoint autenticado y **consumido** (marcado usado) por el endpoint de descarga. 
   **Nunca** un JWT reutilizable ni un token con información en la query.

## Decisión 6 — Migración y semántica de los flags (rollback)

- **No se asigna número de migración en este ADR.** Se asignará **en la etapa de implementación**, después de
  resolver el orden de migraciones de FASE F (ver `INTEGRATION_PLAN.md` §Orden de migraciones) y **garantizando
  unicidad global** de numeración entre PRs abiertos.
- **Apagar un flag revierte el COMPORTAMIENTO, no la migración.** La tabla `auth_sessions` es aditiva y
  **forward-only**; con el modo cookie apagado queda **inerte** (no se usa). El rollback de una etapa = **bajar
  el flag**, no borrar la tabla. Flags fail-closed: sólo el literal `"true"` habilita; cualquier otro valor = off.

## Plan por etapas (cadena Draft pequeña; flags fail-closed; NO activar ahora)

1. **Fundación backend compatible (OFF):** emitir/leer cookies `__Host-` **además** del Bearer, sin cambiar el
   default; tabla `auth_sessions` + rotación transaccional; endpoints de refresh/logout que setean/borran
   cookies. Flag `AUTH_COOKIE_MODE` (default off).
2. **Cookies seguras + CSRF (con tests):** atributos de Decisión 2 + CSRF de Decisión 3 + allowlist de orígenes por entorno.
3. **Cliente web sin `localStorage`:** dejar de persistir tokens; usar cookies. **Sin fallback silencioso a
   `localStorage`** (reintroduciría H2). Sincronización entre pestañas por **señal** (BroadcastChannel/storage
   event) de login/logout — **nunca** el token.
4. **WebSocket autenticado por cookie + revalidación periódica** (sin credencial en query).
5. **Descargas/exports** por cookie o token opaco de un solo uso (Decisión 5).
6. **Retiro del modo heredado (Bearer/localStorage):** última etapa, sólo tras validación; no ahora.

## Pruebas adversariales (obligatorias por etapa, antes de activar)

- **XSS:** un script inyectado **no** puede leer `__Host-acc`/`__Host-ref` (HttpOnly) ni exfiltrarlos.
- **Subdominio same-site malicioso:** `evil.midominio` **no** puede leer/escribir/sobrescribir cookies `__Host-`.
- **CSRF:** request mutante con cookie válida pero **sin** `X-CSRF-Token` (o token≠cookie) → **403**.
- **Origin:** ruta mutante con `Origin` **ausente** → 403; con `Origin` **no permitido** → 403; CORS con
  origen no permitido → preflight falla.
- **Replay de refresh:** reutilizar un refresh ya rotado → **familia invalidada**, todas las sesiones del
  linaje revocadas, request denegada.
- **Logout:** borra cookies e invalida el refresh en servidor; un refresh posterior con la cookie vieja → denegado.
- **Suspensión/deactivación:** corta el access (≤ vida del access / denylist `jti`) y **cierra el WebSocket** en la revalidación.
- **Multi-pestaña:** logout en una pestaña propaga el cierre por señal; ninguna pestaña conserva token en storage.
- **Descargas:** no hay JWT en la URL; el token opaco es de **un solo uso** (segundo uso → rechazado) y corta vida.

## Consecuencias

- **Positivas:** cierra H2 (XSS no roba sesión), H3 (token fuera de URL/logs), habilita H4/H5 (revocación
  efectiva vía sesiones + WS re-auth) y H12 (orígenes por entorno). No afecta el Bridge (`x-api-key`).
- **Costos:** implementar CSRF, tabla de sesiones (migración forward-only inerte bajo flag), cambios en front y
  en el flujo de descargas, y un período de **coexistencia** (backend acepta Bearer **y** cookie) cuyo retiro
  del modo Bearer es la última etapa. Cada etapa es revertible bajando su flag.

## Estado de decisión (repetido para que quede inequívoco)

**Dirección HttpOnly aceptada. Diseño técnico pendiente de auditoría. Implementación NO autorizada.**
Ninguna etapa se abre ni activa comportamiento por defecto sin OK expreso del propietario, PR por PR, y
respetando el máximo de 2 ramas de código activas.
