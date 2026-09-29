# Runbook — archivos subidos privados (`/uploads`)

> Para un despliegue **futuro y autorizado**. Este documento no autoriza ni
> ejecuta nada en producción. No mueve, borra ni transforma archivos existentes.

## Qué cambia

| Antes | Después |
|---|---|
| `/uploads/*` servía cualquier imagen de la raíz (avatares, firma, sello) y nginx agregaba `Cache-Control: public, immutable` + `expires 7d`. | **nginx** bloquea `/uploads/` por defecto y sólo deja pasar, por **nombre exacto**, los recursos de marca configurados en Apariencia (logo, favicon, icono PWA, fondo de login). La API aplica además su propia lista positiva. Todo lo demás responde `404`. |
| Fotos personales, firma y sello por URL pública. | Por endpoints autenticados con capacidad y alcance: `GET /api/me/photo`, `GET /api/employees/:id/photo`, `GET /api/settings/assets/:kind` (firma/sello), `GET /api/attendance/logs/:id/selfie`, `GET /api/permissions/:id/attachment`. Respuestas con `Cache-Control: private, no-store`. |
| Tipo del archivo según extensión/MIME del cliente. | Tipo según contenido; imágenes decodificadas por completo (dependencia `sharp` en la API), PDF con cabecera y terminador, DOCX/XLSX con estructura OOXML válida y sin macros. |
| Rol/estado del usuario tomados del JWT (hasta 1 h). | La API lee rol, estado y empleado vigentes de `users` en cada solicitud: una cuenta desactivada o degradada deja de acceder aunque su token siga vigente. |

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

## nginx (default deny + lista exacta)

Logos y firmas comparten el formato de nombre (`<epoch>_<hex>.<ext>`): un bloqueo
por prefijo no alcanza. nginx sirve **sólo** los nombres listados en
`/etc/nginx/snippets/sishoras-uploads-public.conf`; el resto de `/uploads/`
responde `404` en nginx, sin llegar a la API. Esta capa no depende del código de
la API y sigue vigente si se vuelve a una release anterior.

1. **Revisar el nginx real** (antes de tocar nada; sólo lectura):

   ```bash
   sudo nginx -T 2>/dev/null | grep -nE 'uploads|alias |root |proxy_cache|expires'
   ```

   No debe quedar otra `location` que sirva `/uploads` (ni un `alias`/`root` a la
   carpeta de uploads, ni `proxy_cache`/`expires` sobre `/uploads/` o `/api/`).
   Si aparece, se reemplaza por el bloque del repo.

2. **Generar la lista exacta** desde la base (un único `SELECT` de lectura sobre
   `notification_settings`; usuario de sólo lectura en un defaults-file `0600`):

   ```bash
   sudo DB_NAME=asistencia MYSQL_DEFAULTS_FILE=/root/.sishoras-ro.cnf \
     scripts/gen-nginx-uploads-allowlist.sh --upstream http://127.0.0.1:4000 \
     -o /etc/nginx/snippets/sishoras-uploads-public.conf
   sudo cat /etc/nginx/snippets/sishoras-uploads-public.conf   # revisar: sólo logo/favicon/PWA/fondo
   ```

   Si algún valor no es un recurso público válido el script **no escribe** y sale
   con código 3 (corregirlo en Apariencia o usar `--skip-invalid` conscientemente).
   Stack de compose: `--upstream http://api:4000 -o deploy/nginx-snippets/sishoras-uploads-public.conf`
   (montado por `docker-compose.yml`). El archivo versionado está vacío a
   propósito: sin regenerarlo no se sirve nada de `/uploads/` (login sin logo,
   nada privado expuesto).

3. **Aplicar** el bloque `/uploads/` de `deploy/nginx-sishoras.conf` (include del
   snippet + `location /uploads/ { return 404; }`) y recargar:

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

4. **Cambios de marca posteriores**: al subir un logo/favicon nuevo en
   Apariencia hay que **regenerar** el snippet (paso 2) y recargar nginx; hasta
   entonces el recurso nuevo responde 404 (falla cerrada).

**Prueba aislada reproducible** (no toca el sistema): `deploy/tests/nginx-uploads-isolated.sh`
levanta nginx en 127.0.0.1 con las dos configuraciones del repo y verifica
despliegue (código nuevo) y recuperación (guard de `ef82b32` y main `7638fa9`
sin guard): logo/favicon 200; firma/sello numéricos, fotos, selfies,
documentos, justificativos, carpetas desconocidas y rutas con recorrido 404.
También corre en CI.

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
# Privados por URL directa → 404, Cache-Control: no-store (incluida la firma con nombre numérico)
for p in "<firma-configurada-epoch_hex.png>" "<avatar_...png>" "permissions/<archivo>" "selfies/<archivo>" "employee-documents/<archivo>"; do
  curl -s -o /dev/null -w "%{http_code} $p\n" "$BASE/uploads/$p"
done
# Endpoint privado sin token → 401
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/api/me/photo"
```

En la web: foto en el menú de cuenta, Mi perfil, Cuenta › Perfil, ficha del
empleado y firma/sello en Configuración › Firma.

## Recuperación conservando los controles de acceso

La protección de `/uploads/` vive en **nginx** (default deny + lista exacta), no
en el código de la API. Por eso:

1. **No se revierte la configuración de nginx** al volver a una release anterior
   de la API o de la web. El bloque `/uploads/` y el snippet generado se
   mantienen tal cual. (El runbook anterior proponía bloquear sólo prefijos
   `avatar_`/`signature_`/`seal_` y tres carpetas: no cubría firmas y sellos
   subidos por formulario, que se guardan en la raíz con nombre numérico.)
2. **Problema sólo de la web**: volver a la release web anterior. Las fotos y la
   firma dejan de verse en la web vieja (degradación aceptada), nada se expone.
3. **Problema en la API**: preferir corregir hacia adelante. Si hay que volver a
   la release anterior, hacerlo **sin** tocar nginx; verificar inmediatamente con
   los `curl` de la sección anterior que lo privado sigue en 404 y el logo en 200.
   Con la release anterior, la revocación inmediata de sesiones (identidad
   vigente) y la validación de documentos por contenido dejan de aplicar: es una
   degradación de la API, no una reapertura de `/uploads/`.
4. **Si hubiera que retirar el bloqueo de nginx** (no recomendado), el único
   reemplazo aceptable es otro bloqueo por defecto con lista exacta; nunca un
   `location /uploads/` que haga proxy de todo.
5. La restauración de base (si fuera necesaria) sigue `docs/BACKUP_RESTORE.md`.
