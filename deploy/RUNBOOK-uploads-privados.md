# Runbook — archivos subidos privados (`/uploads`)

> Para un despliegue **futuro y autorizado**. Este documento no autoriza ni
> ejecuta nada en producción. No mueve, borra ni transforma archivos existentes.

## Qué cambia

| Antes | Después |
|---|---|
| `/uploads/*` servía cualquier imagen de la raíz (avatares, firma, sello) y nginx agregaba `Cache-Control: public, immutable` + `expires 7d`. | **nginx** bloquea `/uploads/` y sólo publica `/uploads/brand/<imagen>`: la carpeta a la que van **únicamente** los recursos de marca subidos desde Apariencia (logo, favicon, icono PWA, fondo de login). Los logos heredados de la raíz se sirven por `/api/settings/brand/:kind`. Todo lo demás responde `404`. Cambiar la marca desde la aplicación no requiere tocar nginx. |
| Fotos personales, firma y sello por URL pública. | Por endpoints autenticados con capacidad y alcance: `GET /api/me/photo`, `GET /api/employees/:id/photo`, `GET /api/settings/assets/:kind` (firma/sello), `GET /api/attendance/logs/:id/selfie`, `GET /api/permissions/:id/attachment`. Respuestas con `Cache-Control: private, no-store`. |
| Tipo del archivo según extensión/MIME del cliente. | Tipo según contenido; imágenes decodificadas por completo (dependencia `sharp` en la API), PDF con cabecera y terminador, DOCX/XLSX con estructura OOXML válida y sin macros. |
| Rol/estado del usuario tomados del JWT (hasta 1 h). | La API lee rol, estado y empleado vigentes de `users` en cada solicitud: una cuenta desactivada o degradada deja de acceder aunque su token siga vigente. |

Los archivos existentes **no se mueven**: las URLs guardadas en la base
(`/uploads/avatar_…`, `/uploads/permissions/…`, etc.) siguen siendo válidas como
referencia interna; sólo cambia quién puede leerlas y por dónde.

## Antes de desplegar

1. **Backup verificado** según `docs/BACKUP_RESTORE.md` (SHA-256, gzip, restaurabilidad).
2. **Recursos de marca**: no requieren acción. Los ya configurados en la raíz de
   uploads se siguen viendo por `/api/settings/brand/<kind>`; los que se suban
   después van a `uploads/brand/`. Un valor que no sea una imagen de un solo
   segmento en `/uploads/` dejará de servirse: volver a subirlo desde Apariencia.
3. **Dependencias**: `npm ci` en `api/` instala `sharp` (binarios precompilados
   desde el registro npm, igual que ya ocurre en `web/`). Verificar
   `node -e "require('sharp')"` en la release nueva antes de conmutar.
4. **Web y API juntas**: la web nueva muestra fotos y firma mediante los endpoints
   autenticados. Una web vieja contra la API nueva mostrará iniciales en lugar de
   fotos (sin error funcional). Desplegar ambas en la misma release.

## nginx (bloqueo por defecto + carpeta pública de marca)

nginx responde `404` a todo `/uploads/` **salvo** `/uploads/brand/<archivo>`
(un segmento, extensión de imagen, sólo GET, reescrito a la ruta canónica).
`uploads/brand/` recibe **únicamente** cargas de marca desde Apariencia; firma,
sello, fotos, selfies, documentos y adjuntos se guardan fuera de ella y se
sirven sólo por endpoints autenticados. La API impide además que un ajuste de
marca apunte a otro archivo de `/uploads` (PUT → 400).

- **Cambios de marca**: subir, reemplazar o restablecer desde Apariencia se
  refleja de inmediato; nginx no se toca.
- **Logos heredados** (ya configurados en la raíz antes de este cambio): no se
  mueven. La API los anuncia como `/api/settings/brand/<kind>?v=…` (ruta
  pública que resuelve el ajuste vigente, sólo para las cuatro claves de
  marca). Al volver a subirlos desde Apariencia pasan a `uploads/brand/`.

1. **Revisar el nginx real** (sólo lectura, antes de tocar nada):

   ```bash
   sudo nginx -T 2>/dev/null | grep -nE 'uploads|alias |root |proxy_cache|expires'
   ```

   No debe quedar otra `location` que sirva `/uploads` (ni `alias`/`root` a la
   carpeta de uploads, ni `proxy_cache`/`expires` sobre `/uploads/` o `/api/`).

2. **Aplicar** los dos bloques `/uploads/` de `deploy/nginx-sishoras.conf`
   (compose: `deploy/nginx.compose.conf`; no requiere archivos montados extra)
   y recargar:

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

**Prueba aislada reproducible** (no toca el sistema): `deploy/tests/nginx-uploads-isolated.sh`
levanta nginx en 127.0.0.1 con las dos configuraciones del repo. Con el código
nuevo, **después del arranque**, cambia cada recurso de marca desde el endpoint
real (subir, reemplazar, restablecer) y verifica la URL anunciada por nginx;
comprueba el logo heredado y que la firma no se pueda publicar. Luego repite
con el guard de `ef82b32` y main `7638fa9` sin guard (recuperación): la marca
nueva sigue visible y lo privado queda en 404. También corre en CI.

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
# Marca: la URL que anuncia GET /api/settings (system_logo_url, etc.) → 200,
# Cache-Control: public, max-age=3600 (/uploads/brand/... o /api/settings/brand/...)
LOGO=$(curl -s "$BASE/api/settings" | node -pe 'JSON.parse(require("fs").readFileSync(0)).system_logo_url')
[ -n "$LOGO" ] && curl -sI "$BASE$LOGO" | grep -iE '^HTTP|cache-control'
# Cambiar el logo desde Apariencia y repetir: la URL nueva responde sin tocar nginx.
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

La protección de `/uploads/` vive en **nginx** (bloqueo por defecto + carpeta
pública de marca), no en el código de la API. Por eso:

1. **No se revierte la configuración de nginx** al volver a una release anterior
   de la API o de la web.
2. **Con la release anterior de la API**: los recursos de marca subidos a
   `uploads/brand/` siguen visibles (nginx los publica y la API anterior los
   sirve como estático); lo privado sigue en 404 porque nginx lo corta antes.
   Degradaciones aceptadas mientras dure la recuperación: los logos heredados
   de la raíz no se ven (la ruta `/api/settings/brand/:kind` no existe en la
   versión anterior), una carga de marca hecha con la versión anterior se guarda
   en la raíz y no se publica, y dejan de aplicar la revocación inmediata de
   sesiones y la validación de documentos por contenido. Ninguna reabre
   archivos privados.
3. **Problema sólo de la web**: volver a la release web anterior; las fotos y la
   firma dejan de verse en la web vieja, nada se expone.
4. **Si hubiera que retirar el bloqueo de nginx** (no recomendado), el único
   reemplazo aceptable es otro bloqueo por defecto; nunca un `location /uploads/`
   que haga proxy de todo.
5. La restauración de base (si fuera necesaria) sigue `docs/BACKUP_RESTORE.md`.
