# Contrato de `/api/settings` (público vs. administrativo)

`/api/settings` se consulta desde `/login` **sin autenticación** (branding) y
también recibe tráfico externo. Por eso el endpoint público expone **sólo** lo
necesario para el login; la configuración interna vive en un endpoint separado
y autenticado. El filtrado ocurre **en el backend** (no se confía en el frontend).

## `GET /api/settings` — PÚBLICO (sin token)

Devuelve **exclusivamente** la allowlist pública (branding del login). Aunque
llegue con token, no expone configuración interna.

Campos incluidos (allowlist inmutable `PUBLIC_KEYS` en `api/src/routes/settings.js`):

- **Branding:** `system_name`, `system_company`, `system_logo_url`,
  `system_favicon_url`, `system_pwa_icon_url`, `system_login_bg`,
  `system_login_bg_image`, `system_login_title`, `system_login_subtitle`.
- **Tema/colores/estilo:** `system_primary_color`, `system_secondary_color`,
  `system_accent_color`, `system_sidebar_bg`, `system_sidebar_text`,
  `system_sidebar_active`, `system_theme_mode`, `system_font_family`,
  `system_border_radius`, `system_ui_style`, `system_ui_accent`,
  `system_ui_density`, `system_ui_motion`.
- **Login (layout/textos):** `system_login_layout`, `system_login_show_datetime`,
  `system_login_show_weather`, `system_login_glass`, `system_login_footer`.
- **Visualización/idioma:** `employee_display_mode`, `system_date_format`,
  `system_time_format`, `system_timezone`, `system_locale`.

**Excluido explícitamente** (nunca sale por el endpoint público):
`SIGNATURE_KEYS` (firma: nombre/cargo/**C.I.** del firmante, URLs de firma/sello)
y `EMPLOYER_KEYS` (RUC, N° patronal IPS, registro MTESS, domicilio, teléfono,
representante legal, tasas/parámetros de liquidación, geocerca). Tampoco expone
secretos, tokens, certificados, claves privadas, rutas internas, credenciales,
configuración S3/correo/webhooks/fiscal ni integraciones con terceros (esas
claves no están en la tabla que sirve este endpoint o viven en `process.env`).

Consumidores públicos (sin auth): `web/src/app/login/page.tsx`,
`components/theme/UiStyleProvider.tsx`, `components/layout/Sidebar.tsx`,
`app/manifest.ts`, `lib/useSettings.ts` (sólo lee campos públicos).

## `GET /api/settings/admin` — AUTENTICADO

Configuración **completa** (incluye firma y datos del empleador) para la pantalla
de Configuración.

- Requiere sesión (`authenticate`).
- Autorizado a roles de administración: `authorize('admin','gth','gestor')` +
  `requirePermission('configuracion','view')` — los mismos que ya pueden
  **editar** settings vía `PUT /api/settings`. (`super_admin`/`admin` tienen
  bypass de permisos.)
- Respuestas: `401` sin token, `403` con rol/permiso insuficiente, `200` con la
  config completa.

Consumidores (autenticados, con JWT): `configuracion/page.tsx`,
`configuracion/apariencia/page.tsx`, `configuracion/firma/page.tsx`,
`configuracion/sedes/page.tsx`.

## Escritura (sin cambios)

`PUT /api/settings`, `POST /api/settings/reset`, `POST /api/settings/upload`,
`POST /api/settings/signature-canvas`, `GET/PUT /api/settings/webhooks` mantienen
su autenticación/autorización previa. Este cambio **no** toca rate limiting,
contraseñas ni secretos JWT.

## ETag / 304

El handler no emite `ETag` ni maneja `304` (no existía); no se agrega ni se
altera ese comportamiento.

## Pruebas

`api/tests/settingsPublic.test.js` (Express real + JWT firmados): público sin
token 200; el cuerpo público sólo contiene claves de `PUBLIC_KEYS`; ausencia de
`SIGNATURE_KEYS`/`EMPLOYER_KEYS`; ningún valor sensible en el cuerpo; `/admin`
401 sin token, 403 para `employee`, 200 con `admin` incluyendo firma/empleador.
