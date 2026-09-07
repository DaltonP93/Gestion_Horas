# Evidencia — H1 preflight fail-closed contra MySQL 8 descartable (#208)

> Artefacto de auditoría (Rule 5): la verificación de `assertNoDefaultAdminCredential`
> se ejecuta contra un **MySQL 8 DESCARTABLE Y AISLADO** cargado con `database/init.sql`,
> usando el checker real `api/scripts/preflight-mysql-check.js`. **Nunca** producción ni att2000.

## Garantías de aislamiento del harness (`api/scripts/h1-preflight-evidence.sh`)

- `set -Eeuo pipefail` + `trap` de limpieza instalado desde el inicio.
- **Ignora** cualquier `DB_HOST/DB_PORT/DB_USER/DB_NAME/CID` del entorno: genera contenedor,
  base, puerto (loopback dinámico `127.0.0.1:0`) y password **únicos y aleatorios** por corrida (nonce).
- El contenedor lleva la etiqueta `h1evidence=<nonce>`; la limpieza **sólo** elimina un contenedor
  cuya etiqueta coincide con ESE nonce (nunca por nombre fijo/configurable).
- Todas las consultas administrativas van por `docker exec` (sin salir a red). La **única** conexión
  TCP es la del checker Node (mysql2) al puerto loopback del propio contenedor descartable — es
  justo el camino que se quiere validar.
- Imagen **fijada por DIGEST** (`mysql:8.0.40@sha256:d58ac9…`, manifest multi-arch inmutable; no `mysql:8.0` mutable).
- **Sólo Docker LOCAL:** aborta si hay `DOCKER_HOST` o un contexto Docker no-`default` (evita crear contenedores en un host remoto).
- **Guard de fuga:** verifica que la salida publicada **no** contenga SQL, hashes bcrypt, la contraseña demo ni el password descartable.
- Comprueba explícitamente: `docker run`, readiness (query **autenticada** a la base propia — no
  `mysqladmin ping`, que reporta "alive" ya en el server temporal de init), carga de `init.sql`,
  `UPDATE` y `DROP`. Cada paso falla con exit ≠ 0 si no cumple.
- Valida **mecánicamente** los 3 escenarios (exit + patrón); cualquier desviación aborta con exit ≠ 0.
- No usa `2>/dev/null` global: captura la salida y **sanitiza** (redacta el password del contenedor).

## Cómo reproducir

Requisitos: Docker + Node (con `api/node_modules`: `bcrypt`, `mysql2`). **No** requiere variables.

```bash
cd api && bash scripts/h1-preflight-evidence.sh   # exit 0 = los 3 escenarios validados
```

## Resultado (log sanitizado, 2026-09-06)

```
== arrancando mysql:8.0.40 efímero (nonce <nonce>) ==
== esperando readiness (query AUTENTICADA a la base propia, por docker exec) ==
== cargando database/init.sql (por docker exec) ==
== ESC1: admin demo activo (init.sql) ==
--- ESC1 DEFAULT_ADMIN_CREDENTIAL (exit=3) ---
BLOCKED: DEFAULT_ADMIN_CREDENTIAL
== ESC2: hash del admin ROTADO ==
--- ESC2 RESULT ok (exit=0) ---
RESULT: {"checked":true,"ok":true}
== ESC3: BD SIN tabla users ==
--- ESC3 DEFAULT_ADMIN_CHECK_UNAVAILABLE (exit=3) ---
error: preflight credencial demo: verificación no disponible; arranque bloqueado {"error_code":"ER_NO_SUCH_TABLE","event":"security.preflight.admin_credential","timestamp":"..."}
BLOCKED: DEFAULT_ADMIN_CHECK_UNAVAILABLE
== OK: los 3 escenarios validados mecánicamente ==
DONE
```

## Qué prueba

- **ESC1** — admin demo (`Admin1234!`, hash público de `init.sql`) **activo** → **exit 3**, `DEFAULT_ADMIN_CREDENTIAL`.
- **ESC2** — hash del admin **rotado** → **exit 0**, `{"checked":true,"ok":true}`.
- **ESC3** — tabla `users` ausente (verificación imposible) → **exit 3**, `DEFAULT_ADMIN_CHECK_UNAVAILABLE`,
  y **sólo** se loguea `error_code` seguro (`ER_NO_SUCH_TABLE`); nunca SQL, hashes ni contraseñas.

## Cobertura en CI (HONESTO)

- El CI de #208 (base `main`) **SÍ corre la suite `jest` completa** vía `npm test` en **UTC /
  America/Asuncion / Asia/Tokyo** (jobs "API", "Bridge") + build de Web. Incluye
  `securityPreflight.test.js` (9) y `credentialReintroduction.test.js` (8).
- Lo que el CI de #208 **NO** ejecuta es el **job de MySQL efímero** (vive en #194, sin fusionar);
  por eso esta evidencia MySQL se corre **localmente** con el harness aislado de arriba, no en el CI de #208.
- **El workflow NO ejecuta este harness**: no afirmar que el CI valida el harness.

## Limitaciones / no verificado

- H1 **no** se considera cerrado a nivel proyecto hasta llegar a `main`; `init.sql` sigue trayendo la
  credencial demo (decisión de bootstrap) y falta una política general de contraseñas débiles.
- La evidencia MySQL es **local reproducible** (este harness), no un job de CI de #208.
