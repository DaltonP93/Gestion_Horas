# Runbook — archivos subidos privados (`/uploads`)

> Para un despliegue **futuro y autorizado**. Este documento no autoriza ni
> ejecuta nada en producción. No mueve, borra ni transforma archivos existentes.

## Qué cambia

| Antes | Después |
|---|---|
| `/uploads/*` servía cualquier imagen de la raíz (avatares, firma, sello) y nginx agregaba `Cache-Control: public, immutable` + `expires 7d`. | `/uploads/*` sirve **sólo** los recursos de marca configurados en Apariencia (logo, favicon, icono PWA, fondo de login). Todo lo demás responde `404`. |
| Fotos personales, firma y sello por URL pública. | Por endpoints autenticados con capacidad y alcance: `GET /api/me/photo`, `GET /api/employees/:id/photo`, `GET /api/settings/assets/:kind` (firma/sello), `GET /api/attendance/logs/:id/selfie`, `GET /api/permissions/:id/attachment`. Respuestas con `Cache-Control: private, no-store`. |
| Tipo del archivo según extensión/MIME del cliente. | Tipo según contenido; imágenes decodificadas por completo (dependencia `sharp` en la API) y PDF con cabecera y terminador. |

Los archivos existentes **no se mueven**: las URLs guardadas en la base
(`/uploads/avatar_…`, `/uploads/permissions/…`, etc.) siguen siendo válidas como
referencia interna; sólo cambia quién puede leerlas y por dónde.

## Antes de desplegar

1. **Backup verificado** según `docs/BACKUP_RESTORE.md` (SHA-256, gzip, restaurabilidad).
2. **Recursos de marca**: en Apariencia, confirmar que logo/favicon/icono PWA/fondo
   apunten a `/uploads/<archivo>` (un solo segmento, extensión de imagen). Un
   recurso fuera de esa forma dejará de servirse: volver a subirlo desde Apariencia.
3. **Dependencias**: `npm ci` en `api/` instala `sharp` (binarios precompilados
   desde el registro npm, igual que ya ocurre en `web/`). Verificar
   `node -e "require('sharp')"` en la release nueva antes de conmutar.
4. **Web y API juntas**: la web nueva muestra fotos y firma mediante los endpoints
   autenticados. Una web vieja contra la API nueva mostrará iniciales en lugar de
   fotos (sin error funcional). Desplegar ambas en la misma release.

## nginx

Aplicar el cambio de `deploy/nginx-sishoras.conf` (bloque `location /uploads/`
sin `expires` ni `add_header Cache-Control`; la API fija las cabeceras).
Verificar además que no existan fuera del repo:

- `proxy_cache_path` / `proxy_cache` aplicados a `/uploads/` o `/api/`;
- un `alias`/`root` que sirva la carpeta de uploads desde disco sin pasar por la API.

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## Copias ya cacheadas (no se retiran con una cabecera)

Con la configuración anterior, toda respuesta `2xx` de `/uploads/` salió con
`Cache-Control: public, immutable` y expiración de 7 días. Cambiar la cabecera
**no borra** esas copias:

- **Navegadores** de quienes ya abrieron un archivo: lo conservan hasta 7 días
  desde la última descarga. No hay forma de retirarlo desde el servidor. Opcional:
  enviar `Clear-Site-Data: "cache"` en el logout/login de la web para limpiar la
  caché del propio origen en los equipos que vuelvan a entrar.
- **Proxies intermedios** (corporativos, CDN): si existe alguno delante del
  dominio, purgar `/uploads/*` tras el despliegue. En la topología documentada
  no hay CDN; confirmarlo.
- **Caché de nginx**: si se hubiera configurado fuera del repo, purgarla.
- **Archivos especialmente sensibles** (justificativos médicos, documentos) que
  hayan circulado por URL pública: la mitigación completa sería renombrarlos y
  actualizar su referencia en la base. Es una **transformación de archivos
  históricos**: queda como plan separado, con su propia autorización, backup y
  verificación (no forma parte de este cambio).

## Verificación posterior (anónimo y autenticado)

```bash
BASE=https://<dominio>
# Público configurado → 200, Cache-Control: public, max-age=3600
curl -sI "$BASE/uploads/<logo-configurado>" | grep -iE '^HTTP|cache-control'
# Privados por URL directa → 404, Cache-Control: no-store
for p in "<avatar_...png>" "permissions/<archivo>" "selfies/<archivo>" "employee-documents/<archivo>"; do
  curl -s -o /dev/null -w "%{http_code} $p\n" "$BASE/uploads/$p"
done
# Endpoint privado sin token → 401
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/api/me/photo"
```

En la web: foto en el menú de cuenta, Mi perfil, Cuenta › Perfil, ficha del
empleado y firma/sello en Configuración › Firma.

## Recuperación conservando los controles de acceso

1. **Problema sólo de la web** (p. ej. una foto no se ve): volver a la release web
   anterior no reabre la exposición (la API sigue restringiendo).
2. **Problema en la API**: preferir corregir hacia adelante. Si hay que volver a la
   release API anterior, **antes** agregar en nginx bloqueos equivalentes para no
   reabrir los archivos privados:

   ```nginx
   location ~ ^/uploads/(permissions|selfies|employee-documents)/ { return 404; }
   location ~ ^/uploads/(avatar_|signature_|seal_) { return 404; }
   ```

   y recargar nginx. Con esa versión anterior las fotos no se verán en la web
   (degradación aceptada frente a exponerlas).
3. La restauración de base (si fuera necesaria) sigue `docs/BACKUP_RESTORE.md`.
