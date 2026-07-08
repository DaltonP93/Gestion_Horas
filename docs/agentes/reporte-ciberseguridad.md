# Reporte de Auditoría de Ciberseguridad — SisHoras (OWASP Top 10 2021)

> Auditoría defensiva interna autorizada. Contexto: hardening / mejora defensiva, **no** explotación.
> Alcance: `api/src/`, `web/src/`, `bridge/`, `analytics/`, `docker-compose*.yml`, `ecosystem.config.js`.
> Conteo: **3 Críticos, 5 Altos, 7 Medios, 4 Bajos.**

## A03 — Inyección

- **[ALTO] SQLi en adaptador att2000** — `api/src/config/zkAdapter.js:34-35,41`: `where += ` AND CHECKTIME >= '${dateFrom}'`` y `SELECT TOP ${limit}`. `dateFrom/dateTo/limit` vienen de `req.query`/`req.body` (`sync.js:171-173,143`). Solo alcanzable por `super_admin`, pero es inyección de 2º grado sobre una BD sensible (SQL Server att2000). **Fix:** usar `request.input()` de `mssql` (ya soportado por `queryAtt2000`) y sanear `limit` a entero para `TOP (@n)`.
- **[OK] MySQL:** todas las rutas usan `sequelize.query(sql, {replacements})`. Los `UPDATE SET ${sets.join()}` (employees.js:163,187; permissions.js:222; courses.js:99; embed.js:154) construyen nombres de columna desde **listas blancas**, valores por parámetros. Sin SQLi.
- **[OK] Command injection:** `backups.js:48` usa `spawn('mysqldump', args[])` sin shell y con valores de `process.env`; `discovery.js` usa `net.Socket`. Sin riesgo.

## A01 — Control de acceso

- **[CRÍTICO] Bridge sin autenticación** — `bridge/src/index.js:141-261` y `pushServer.js`. Ningún control en `GET /discovery` (escanea 254 hosts de la LAN), `POST /diagnose` / `/discovery/probe` (SSRF interno), `POST /devices/:id/sync|ping|diagnose`, `GET /devices/:id/users`. Con `network_mode: host` (docker-compose) queda expuesto en la LAN. El PUSH `/iclock/cdata` tiene whitelist de SN **opcional** (`pushServer.js:33-37`): si `ZKTECO_PUSH_WHITELIST` está vacío acepta marcajes falsos de cualquiera. **Fix:** middleware `x-api-key` con `BRIDGE_API_KEY`, `app.listen(PORT,'127.0.0.1')`, whitelist obligatoria y validación de IP del reloj.
- **[MEDIO] JWT por query string** — `auth.js:18-20` acepta `?access_token=`; con `morgan('combined')` (`index.js:92`) el token queda en logs. **Fix:** cookies HttpOnly/Secure para descargas o tokens efímeros de un uso; redactar del log.
- **[OK] IDOR:** `users.js:50` (admin o self), `users.js:119-122`, rutas `/me/*` filtran por `req.user`. Sin IDOR explotable.
- **[BAJO] Bypass de rol inconsistente:** `authorize` da bypass a `super_admin`; `requirePermission` a `super_admin` y `admin` (`auth.js:38,86`).

## A02 — Cripto / fuga de datos

- **[CRÍTICO] Secretos con defaults** — `docker-compose.yml`: `JWT_SECRET:-cambia_este_secreto_en_produccion`, `JWT_REFRESH_SECRET:-otro_secreto_refresh`, `DB_PASSWORD:-asistencia_pass`, `MYSQL_ROOT_PASSWORD:-rootpass`, `BRIDGE_API_KEY:-bridge_secret_key`, `ANALYTICS_API_KEY:-analytics_secret_key`. `analytics/main.py:44` `API_KEY="analytics_secret_key"`, `:23` password default. `att2000.js:22-26` user `sa`/password `''`. Un `JWT_SECRET` conocido permite **forjar tokens de cualquier rol**. **Fix:** eliminar defaults, fallar el arranque si faltan (`:?` en compose), rotar lo ya usado.
- **[ALTO] API key de Analytics por query string** — `analytics/main.py:46` `Query(..., alias="api_key")`. Queda en logs/referers. **Fix:** leer de header `X-API-Key`.
- **[ALTO] Contraseñas default de Analytics/DB** (mismo origen que el crítico #2).
- **[MEDIO] Fuga de `err.message`** — `index.js:185-189` y muchas rutas (`res.json({error: err.message})`) exponen errores SQL/columnas. **Fix:** mensaje genérico en prod, detalle solo al logger.
- **[BAJO] bcrypt 10 rondas** (`authController.js:9`) — subir a 12.
- **[BAJO] IPs/dominios internos hardcodeados** — `bridge/src/index.js:7-9,38-42`, `devices.js:261-263`, `.env.example`, CORS `index.js:76-77`. Contradice la política de CLAUDE.md.
- **[OK]** bcrypt para passwords, refresh tokens hasheados SHA-256 con rotación (`authController.js:69,120`), `jwt.verify` fija `HS256` en el middleware. Nota: `refresh()` (`authController.js:100`) no fija `algorithms`.

## A05 — Configuración

- **[ALTO] Puertos de infraestructura expuestos al host** — `docker-compose.yml` publica `3306:3306`, `6379:6379`, `5000:5000`, `8080`; **Redis sin contraseña**. **Fix:** no mapear a `0.0.0.0` (solo red interna o `127.0.0.1`), `requirepass` en Redis, exponer solo Nginx 80/443.
- **[MEDIO] CORS acepta requests sin `Origin`** con `credentials:true` — `index.js:79-80`.
- **[MEDIO] Payload 10 MB global** — `index.js:90`.
- **[BAJO] Swagger UI público** — `index.js:172-177`.
- **[OK]** `helmet()` activo, `trust proxy` configurado.

## A07 — Autenticación

- **[OK]** `loginLimiter` 8/15min con `skipSuccessfulRequests` (`index.js:103-122`), `pwdResetLimiter` 10/h, tokens 1h/7d con rotación y revocación, 2FA TOTP, respuesta de login uniforme.
- **[MEDIO] Política de contraseña no unificada** — `users.js:73-75` solo exige longitud ≥8 (sin la regla letras+números de `changePassword`); sin lockout de cuenta. **Fix:** unificar política y considerar bloqueo temporal.

## A06 — Dependencias (`npm audit --omit=dev`)

- **API:** 22 vulns (7 altas, 15 moderadas). **axios 1.0.0–1.15.2 (ALTO):** bypass auth por prototype pollution, SSRF por bypass `no_proxy`, CRLF, fuga `Proxy-Authorization`, ReDoS. **form-data 4.0.0–4.0.5 (ALTO):** CRLF injection.
- **WEB:** 7 vulns (1 crítica, 3 altas, 3 moderadas). **next (CRÍTICO):** DoS con Server Components. **axios (ALTO)**, **postcss <8.5.10 (ALTO):** XSS por `</style>`. **form-data (ALTO)**.
- **Fix:** `npm audit fix`, subir `axios`, `form-data@>=4.0.6`, `next` a la última estable de la línea 14, `postcss>=8.5.10`; integrar auditoría en CI.

---

## Resumen ejecutivo — hallazgos más críticos

1. **CRÍTICO** — El Bridge ZKTeco (puertos 8080/8081, `network_mode: host`) no tiene autenticación: permite escanear la LAN (`/discovery`), sondear IPs (SSRF) y controlar relojes; el PUSH acepta marcajes falsos si la whitelist de SN está vacía.
2. **CRÍTICO** — Secretos con valores por defecto en `docker-compose.yml` y `analytics/main.py` (JWT_SECRET, API keys, passwords BD/root); un `JWT_SECRET` conocido permite forjar tokens de cualquier rol.
3. **CRÍTICO** — Next.js con CVE crítico de DoS (y axios/form-data/postcss con CVE altos en API y Web).
4. **ALTO** — Inyección SQL en el adaptador att2000 (`zkAdapter.js:34-41`): fechas y `limit` interpolados directamente.
5. **ALTO** — Redis sin contraseña y puertos 3306/6379/5000 expuestos al host en docker-compose.
6. **ALTO** — API key de Analytics viaja por query string (fuga en logs).

**Correcciones prioritarias:** autenticar y aislar el Bridge, eliminar/rotar secretos default, parchear dependencias, parametrizar att2000 y cerrar puertos de infraestructura.
