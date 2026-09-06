# Evidencia — H1 preflight fail-closed contra MySQL 8 descartable (#208)

> Artefacto de auditoría (Rule 5): la verificación de `assertNoDefaultAdminCredential`
> se ejecuta contra un **MySQL 8 DESCARTABLE** cargado con `database/init.sql`, usando el
> checker real `api/scripts/preflight-mysql-check.js`. **Nunca** contra producción ni att2000.
> Sin secretos operativos: las credenciales son de un contenedor efímero (patrón del job de CI de #194).

## Cómo reproducir

Requisitos: Docker + Node (con `api/node_modules` instalado: `bcrypt`, `mysql2`).

```bash
cd api
DB_PORT=3307 DB_PASSWORD=disposable_ci_pw bash scripts/h1-preflight-evidence.sh
```

El harness (`api/scripts/h1-preflight-evidence.sh`) arranca `mysql:8.0`, carga `init.sql`,
y corre tres escenarios con el checker real. Salidas esperadas: exit 3 = bloqueado, 0 = OK.

## Escenarios y resultado (log sanitizado, 2026-09-06)

```
== arrancando mysql:8.0 efímero ==
== cargando database/init.sql ==

== ESC1: admin demo activo (init.sql) -> se espera DEFAULT_ADMIN_CREDENTIAL ==
BLOCKED: DEFAULT_ADMIN_CREDENTIAL
exit=3

== ESC2: hash del admin rotado -> se espera RESULT ok ==
RESULT: {"checked":true,"ok":true}
exit=0

== ESC3: BD sin tabla users -> se espera DEFAULT_ADMIN_CHECK_UNAVAILABLE (fail-closed) ==
error: preflight credencial demo: verificación no disponible; arranque bloqueado {"error_code":"ER_NO_SUCH_TABLE","event":"security.preflight.admin_credential","timestamp":"..."}
BLOCKED: DEFAULT_ADMIN_CHECK_UNAVAILABLE
exit=3

== limpieza ==
DONE
```

## Qué prueba

- **ESC1** — con el admin demo (`Admin1234!`, hash público de `init.sql`) **activo**, el arranque
  se **bloquea** (`DEFAULT_ADMIN_CREDENTIAL`).
- **ESC2** — tras **rotar** el hash del admin, el preflight devuelve `ok` (arranque permitido).
- **ESC3** — si la verificación **no puede completarse** (tabla `users` ausente), el arranque se
  **bloquea** fail-closed (`DEFAULT_ADMIN_CHECK_UNAVAILABLE`) y **sólo** se loguea un `error_code`
  seguro (`ER_NO_SUCH_TABLE`); nunca SQL, hashes ni contraseñas.

## Cobertura complementaria (unit, determinista)

- `api/tests/securityPreflight.test.js` (9) y `api/tests/credentialReintroduction.test.js` (8):
  `npm test` en `api/` — verde en `TZ=UTC / America/Asuncion / Asia/Tokyo`. Suite API completa: 77 suites / 1309 tests.

## Limitaciones / no verificado

- El job remoto de CI de #208 cubre sólo **API (install+syntax) / Web / Bridge**; **no** corre `jest`
  completo ni un job de MySQL (esos viven en #194, sin fusionar). Esta evidencia MySQL es **local
  reproducible** (este harness), no un job de CI de #208.
- H1 **no** se considera cerrado a nivel proyecto hasta llegar a `main`; `init.sql` sigue trayendo la
  credencial demo (decisión de bootstrap) y falta una política general de contraseñas débiles.
