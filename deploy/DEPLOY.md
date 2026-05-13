# SisHoras — Guía completa de despliegue

> Servidor producción: `root@antigravity:/var/www/html/Gestion_Horas`
> Repo: https://github.com/DaltonP93/Gestion_Horas
> Dominio: https://sishoras.saa.com.py

---

## 1. Actualizar producción tras git push

Ejecutar **en el servidor**:

```bash
cd /var/www/html/Gestion_Horas

# 1. Traer cambios de GitHub
git pull origin main

# 2. Aplicar la migración 037 (columnas address/photo_url)
mysql -u root -p asistencia < database/migrations/037_employee_address_photo.sql

# 3. Backend (API Node)
cd api
npm install --omit=dev   # solo si package.json cambió
pm2 reload api

# 4. Frontend (Next.js)
cd ../web
npm install              # solo si package.json cambió
npm run build
pm2 reload web

# 5. Bridge / analytics (no cambiaron, pero por si acaso)
pm2 status
# Reiniciar solo si hace falta:
# pm2 reload bridge
# pm2 reload analytics

# 6. Verificar logs
pm2 logs api --lines 30 --nostream
pm2 logs web --lines 30 --nostream
```

---

## 2. Nginx + Let's Encrypt (HTTPS válido)

**Crítico**: sin HTTPS válido (no autofirmado), ni Android instala la PWA ni
iOS Safari activa la cámara.

```bash
cd /var/www/html/Gestion_Horas

# 1. Copiar la nueva config nginx (ya tiene /.well-known antes del 301)
sudo cp deploy/nginx-sishoras.conf /etc/nginx/sites-available/sishoras
sudo ln -sf /etc/nginx/sites-available/sishoras /etc/nginx/sites-enabled/sishoras

# 2. Crear webroot para certbot
sudo mkdir -p /var/www/certbot

# 3. Validar y recargar nginx
sudo nginx -t
sudo systemctl reload nginx

# 4. Pedir el certificado (solo HTTP-01)
sudo certbot certonly --webroot -w /var/www/certbot -d sishoras.saa.com.py \
  --non-interactive --agree-tos --email dalton9302@gmail.com

# 5. Editar el bloque HTTPS de nginx para apuntar al cert nuevo
sudo nano /etc/nginx/sites-available/sishoras
# Cambiar:
#   ssl_certificate     /etc/ssl/sishoras/fullchain.pem;
#   ssl_certificate_key /etc/ssl/sishoras/privkey.pem;
# Por:
#   ssl_certificate     /etc/letsencrypt/live/sishoras.saa.com.py/fullchain.pem;
#   ssl_certificate_key /etc/letsencrypt/live/sishoras.saa.com.py/privkey.pem;

sudo nginx -t && sudo systemctl reload nginx

# 6. Auto-renovación (certbot ya instala el cron al instalarse, pero verificar)
sudo certbot renew --dry-run
```

### Verificar que todo quedó bien

```bash
# Cert válido
curl -vI https://sishoras.saa.com.py/ 2>&1 | grep -E "subject|issuer|HTTP/"

# Permissions-Policy permite cámara y GPS
curl -sI https://sishoras.saa.com.py/ | grep -i permissions-policy
# Debe devolver: permissions-policy: geolocation=(self), microphone=(), camera=(self)

# Manifest dinámico responde JSON
curl -s https://sishoras.saa.com.py/manifest.webmanifest | head -20
```

---

## 3. Comandos rápidos día a día

```bash
# Ver estado de todos los servicios
pm2 status

# Logs en vivo
pm2 logs                 # todos
pm2 logs api             # solo API
pm2 logs web             # solo web

# Recargar tras cambios de código
git pull origin main && cd web && npm run build && pm2 reload all

# Reiniciar nginx (raro)
sudo systemctl reload nginx

# Ver headers de respuesta para debug
curl -I https://sishoras.saa.com.py/

# Validar SSL desde fuera (Mozilla SSL Test)
# https://www.ssllabs.com/ssltest/analyze.html?d=sishoras.saa.com.py
```

---

## 4. Troubleshooting frecuente

| Síntoma | Causa probable | Solución |
|---|---|---|
| iOS Safari: "Permiso de cámara denegado" | Cert autofirmado | Instalar Let's Encrypt (sección 2) |
| Android Chrome: no aparece banner "Instalar app" | Cert no válido o manifest mal servido | `curl -I /manifest.webmanifest` debe devolver 200 con `Content-Type: application/manifest+json` |
| Dashboard: chip "Reconectando..." persistente | Socket.io bloqueado por cert autofirmado | Mismo: instalar Let's Encrypt |
| KPIs en 0 | `daily_summary` vacía hoy | Click en "Actualizar KPIs" o `POST /api/attendance/recalc-summary` con admin |
| `/marcar` no se ven los chips de estado | Build viejo cacheado por SW | Service worker version bumped a `v2` — los users verán la nueva versión al recargar |
| Cambios no aparecen tras `pm2 reload web` | SW cachea | En DevTools → Application → Service Workers → "Unregister" |

---

## 5. Capacitor Phase 2 — Empaquetar como app Android/iOS

> Esto se hace **una sola vez** y luego se reconstruye solo cuando hay cambios
> grandes. La mayoría de actualizaciones no requieren rebuilding del APK porque
> usamos modo híbrido (la app carga la URL de producción).

### Pre-requisitos

**Para Android:**
- Java JDK 17+
- Android Studio + Android SDK 34
- Variable `ANDROID_HOME` definida

**Para iOS (solo desde macOS):**
- Xcode 15+
- CocoaPods (`sudo gem install cocoapods`)
- Cuenta de Apple Developer ($99/año) para distribución

### Setup inicial (una sola vez)

Ejecutar en la carpeta `web/` en tu máquina local (no en el servidor):

```bash
cd web

# 1. Instalar Capacitor core + CLI + plugins
npm i @capacitor/core @capacitor/cli
npm i @capacitor/camera @capacitor/geolocation
npm i @capacitor/splash-screen @capacitor/status-bar
npm i @capacitor/preferences @capacitor/network
npm i @capacitor/app

# 2. Inicializar Capacitor (lee capacitor.config.ts que ya está creado)
npx cap init SisHoras py.saa.sishoras --web-dir=out

# 3. Crear plataformas
npm i -D @capacitor/android @capacitor/ios
npx cap add android
npx cap add ios     # solo en macOS

# 4. (Opcional pero recomendado) Generar splash screens y íconos
npm i -D @capacitor/assets
mkdir -p assets
# Poné en assets/icon-only-1024.png un PNG cuadrado 1024×1024 con el logo
# Poné en assets/splash-2732.png un PNG 2732×2732 con el logo centrado
npx capacitor-assets generate
```

### Configurar permisos Android (`android/app/src/main/AndroidManifest.xml`)

Capacitor ya agrega los básicos. Verificar que tenga:

```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/>
<uses-permission android:name="android.permission.CAMERA"/>
<uses-feature android:name="android.hardware.camera" android:required="true"/>
<uses-feature android:name="android.hardware.location.gps" android:required="false"/>
```

### Configurar permisos iOS (`ios/App/App/Info.plist`)

Agregar **dentro** del `<dict>`:

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>SisHoras necesita tu ubicación para validar que estés en tu sede al marcar asistencia.</string>
<key>NSCameraUsageDescription</key>
<string>SisHoras necesita la cámara para tomar tu selfie de verificación al marcar asistencia.</string>
<key>NSPhotoLibraryUsageDescription</key>
<string>SisHoras puede guardar tu selfie en la galería como respaldo.</string>
```

### Compilar y correr

```bash
cd web

# Android — abrir Android Studio para correr en emulador o dispositivo
npm run cap:open:android

# iOS — abrir Xcode (solo en macOS)
npm run cap:open:ios

# O directo desde la línea de comandos:
npm run cap:android
npm run cap:ios
```

### Generar APK firmado para distribuir

```bash
cd web/android
./gradlew assembleRelease
# El APK queda en android/app/build/outputs/apk/release/app-release.apk
```

Para Play Store: usar `bundleRelease` (genera AAB) y firmar con tu keystore.

### Generar IPA para iOS

Desde Xcode:
1. Product → Archive
2. Distribute App → App Store Connect (o Ad Hoc / Enterprise)
3. Subir a TestFlight o exportar IPA firmado

---

## 6. ¿Qué falta para 100% completo?

### Imprescindible (para producción robusta)
- [ ] **Let's Encrypt instalado en el servidor** (sección 2) — *bloqueante para PWA install y cámara iOS*
- [ ] **Migración 037 corrida en MySQL** (sección 1) — *bloqueante para edición de perfil*
- [ ] **Test end-to-end real**: login con `criss.velazquez` desde iPhone Safari y Android Chrome — verificar:
  - PWA se instala como app
  - `/marcar` muestra chips verdes tras conceder permisos
  - ENTRADA → GPS → selfie → confirma → marcaje aparece en `asistencia`

### Recomendable (mejoras importantes)
- [ ] **Generar PNGs de íconos**: convertir `web/public/icons/icon.svg` a PNG 192×192, 512×512 y 180×180. Herramientas online o ImageMagick:
      ```bash
      convert -background none -resize 192x192 web/public/icons/icon.svg web/public/icons/icon-192.png
      convert -background none -resize 512x512 web/public/icons/icon.svg web/public/icons/icon-512.png
      convert -background none -resize 180x180 web/public/icons/icon.svg web/public/icons/apple-touch-icon-180.png
      ```
- [ ] **Push notifications**: implementar Web Push con VAPID en el backend (el SW ya tiene el handler).
- [ ] **2FA**: el módulo `/seguridad` lo prepara pero falta probarlo end-to-end.
- [ ] **Backups automáticos** de MySQL configurados en cron + envío a S3/B2.

### Capacitor (Fase 2 — opcional)
- [ ] Setup inicial (sección 5) — solo si querés app nativa en Play Store / App Store
- [ ] Splash screens generados con `@capacitor/assets`
- [ ] Firmar APK/IPA con keystore propio
- [ ] Subir a Play Console y App Store Connect
- [ ] Configurar deep links (`https://sishoras.saa.com.py/marcar` abre la app)

### Capacitor Fase 3 (futuro)
- [ ] Migrar tokens de `localStorage` a `@capacitor/preferences` (más seguro)
- [ ] Biometría con `@capacitor-community/biometric-auth` para 2FA
- [ ] Push notifications nativas con Firebase Cloud Messaging
- [ ] App icon adaptativo Android (foreground + background separados)
- [ ] Modo offline robusto: SQLite local con `@capacitor-community/sqlite`

---

## 7. ⚠️ Rotación de credenciales tras alerta GitGuardian

GitGuardian detectó secretos expuestos en `web/.env.local` (commit `569d115`).
El archivo ya fue eliminado del tracking en commit `ae8a7f8`, pero **el historial
de git aún contiene los valores antiguos**, así que TODO secreto que haya
estado en ese archivo debe rotarse.

### Secretos a rotar (ejecutar EN EL SERVER)

```bash
ssh root@antigravity
cd /var/www/html/Gestion_Horas

# 1. Backup del .env actual
cp api/.env api/.env.bak.$(date +%Y%m%d)

# 2. Generar valores nuevos seguros
echo ""
echo "JWT_SECRET=$(openssl rand -base64 48)"
echo "JWT_REFRESH_SECRET=$(openssl rand -base64 48)"
echo "BRIDGE_API_KEY=$(openssl rand -hex 32)"
echo "INTEGRATION_API_KEY=$(openssl rand -hex 32)"
echo "ANALYTICS_API_KEY=$(openssl rand -hex 32)"
echo ""

# 3. Editar api/.env y reemplazar los 5 valores
nano api/.env

# 4. Si BRIDGE_API_KEY estaba en bridge/, también actualizar ahí:
nano bridge/.env

# 5. Reiniciar todos los servicios para que tomen los nuevos secretos
pm2 reload all

# 6. (Importante) los JWT viejos ahora son inválidos.
#    TODOS los usuarios deberán volver a hacer login.
#    Avisar al equipo antes de hacer esto.
```

### Sobre SMTP

El `web/.env.local` tenía `SMTP_USER=` y `SMTP_PASS=` **vacíos** (no había
credenciales reales en esos campos). GitGuardian alertó porque detecta el
patrón del par de variables. **Si nunca usaste SMTP real en producción, no
hay nada que rotar para SMTP.**

Si alguna vez configuraste SMTP real (por ej. desde la UI en Reportes →
Configurar SMTP), revoca esa "App password" de Gmail:
1. Ir a https://myaccount.google.com/apppasswords
2. Eliminar el App password que tenías para SisHoras
3. Crear uno nuevo
4. Actualizar `SMTP_PASS=` en `api/.env`

### Sobre IPs ZKTeco

Las IPs `172.16.20.16x` que aparecieron en el `.env.local` son LAN privada.
No son secretos públicos pero exponen tu topología de red. La nueva versión
del sistema lee esas IPs **desde la BD** (tabla `devices`), no desde el
`.env`, así que ya no es problema futuro.

### Opcional — Borrar los secretos del historial de git

El commit `ae8a7f8` los quitó del HEAD, pero los commits viejos en GitHub
todavía los tienen. Para borrarlos del historial completo:

> ⚠️ **Esto es destructivo**: cambia todos los hashes de commits viejos.
> Si alguien más cloneó el repo, deberá hacer fresh clone después.

```bash
# En tu PC (NO en el server, porque destruye history):
git clone https://github.com/DaltonP93/Gestion_Horas.git Gestion_Horas_clean
cd Gestion_Horas_clean

# Instalar git-filter-repo (más rápido y seguro que filter-branch)
# Ubuntu/Debian: sudo apt install git-filter-repo
# Windows con Python: pip install git-filter-repo
# Mac: brew install git-filter-repo

# Borrar el archivo del historial completo
git filter-repo --invert-paths --path web/.env.local

# Force-push
git remote add origin https://github.com/DaltonP93/Gestion_Horas.git
git push --force --all origin
git push --force --tags origin
```

Luego en el server:
```bash
cd /var/www/html/Gestion_Horas
git fetch origin
git reset --hard origin/main
```

### Recomendación práctica

**No hace falta reescribir history** si rotás los secretos. Los valores
viejos en GitHub quedan inservibles. Solo reescribí history si el repo es
**público** y querés que no aparezcan en buscadores tipo TruffleHog.

Tu repo `DaltonP93/Gestion_Horas` puede ser privado — verificá en GitHub:
- https://github.com/DaltonP93/Gestion_Horas/settings → Danger Zone → "Change
  visibility" → si dice "Make public" significa que YA ES PRIVADO ✅

---

## 8. Resumen de servicios PM2

```
┌─────┬───────────┬─────────┬──────┬───────┬──────────┐
│ id  │ name      │ port    │ mode │ logs  │ rol      │
├─────┼───────────┼─────────┼──────┼───────┼──────────┤
│ 0   │ api       │ 4000    │ fork │ ~/.pm2│ REST API │
│ 1   │ web       │ 3000    │ fork │ ~/.pm2│ Next.js  │
│ 2   │ bridge    │ 8080/81 │ fork │ ~/.pm2│ ZKTeco   │
│ 3   │ analytics │ 5000    │ fork │ ~/.pm2│ FastAPI  │
└─────┴───────────┴─────────┴──────┴───────┴──────────┘
```

Si alguno está caído:
```bash
pm2 restart <id>
# o
pm2 start ecosystem.config.js --only api
```
