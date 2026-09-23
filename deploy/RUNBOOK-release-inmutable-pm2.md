# Runbook — release inmutable con PM2

> Este documento describe el cambio de código entre releases ya preparadas.
> No autoriza por sí mismo una operación productiva. Cada despliegue, migración,
> cambio de flags o modificación de datos requiere autorización explícita.

## 0. Invariantes

- El commit autorizado debe ser un SHA completo y coincidir con `origin/main`.
- La release activa no se modifica: se prepara otro directorio y se conserva la anterior.
- Siempre hay backup MySQL íntegro antes de activar código nuevo.
- `att2000` continúa estrictamente **READ-ONLY**.
- El despliegue no vincula sedes, no cambia flags y no recalcula históricos.
- Las migraciones se revisan con `migrate:status`; aplicarlas es otra autorización.
- Nunca imprimir, copiar al repositorio ni pasar secretos por argumentos.

## 1. Preflight

Desde el checkout operativo, con el árbol limpio:

```bash
git fetch --prune origin main
test "$(git status --porcelain | wc -l)" = 0
test "$(git rev-parse origin/main)" = "<SHA_AUTORIZADO>"
git cat-file -e "<SHA_AUTORIZADO>^{commit}"
```

Registrar la release activa desde los cinco `pm_cwd` de PM2. Verificar espacio,
Node 22, estado de migraciones y salud de API, web y Analytics antes de continuar.

## 2. Backup y preparación

Crear un dump con `--single-transaction`, comprimirlo, ejecutar `gzip -t` y
registrar ruta, bytes y SHA-256. El archivo temporal sólo se renombra al terminar.

Preparar `/var/www/releases/Gestion_Horas/.prepare-<SHA>` con `umask 077`:

1. Extraer exclusivamente `git archive <SHA>`.
2. Copiar los archivos de configuración no versionados con modo `0600`.
3. Instalar o reutilizar dependencias sólo si sus lockfiles coinciden.
4. Crear `logs/` y `api/logs/` con permisos restringidos.
5. Ejecutar pruebas focalizadas, `node --check`, `migrate:status` y build web.
6. Escribir `.release-commit` y checksums de configuración sin mostrar valores.
7. Renombrar atómicamente el staging a `/var/www/releases/Gestion_Horas/<SHA>`.

No activar una carpeta `.prepare-*` ni una release sin build completo.

## 3. Contrato de Analytics

El BFF envía `ANALYTICS_API_KEY` como `X-API-Key`. Analytics resuelve, en orden:

1. `API_KEY` del entorno del proceso;
2. `ANALYTICS_API_KEY` del entorno del proceso;
3. únicamente `ANALYTICS_API_KEY` de `api/.env` en la misma release PM2.

La tercera vía usa `dotenv_values`: no exporta las demás variables de `api/.env`
ni incorpora el secreto al ecosystem o al dump de PM2. Si no existe una clave,
los endpoints protegidos responden `401` (fail-closed).

Docker conserva el contrato actual: Compose mapea `ANALYTICS_API_KEY` a
`API_KEY`. Nunca registrar el valor durante las verificaciones.

## 4. Activación PM2

Las rutas de `ecosystem.config.js` son absolutas y derivadas de `__dirname`.
Aun así, **no usar `reload` ni `startOrReload` para cambiar de release**:
PM2 puede conservar el `cwd` anterior.

Con la ruta nueva y la anterior resueltas explícitamente, recrear sólo:

- `sishoras-api`
- `sishoras-sync-worker`
- `sishoras-web`
- `sishoras-bridge`
- `sishoras-analytics`

```bash
pm2 delete sishoras-api sishoras-sync-worker sishoras-web \
  sishoras-bridge sishoras-analytics
cd /var/www/releases/Gestion_Horas/<SHA_NUEVO>
pm2 start ecosystem.config.js
```

No eliminar módulos de PM2 como `pm2-logrotate`. No ejecutar `pm2 save` todavía.

## 5. Gate posterior

Esperar readiness y exigir:

- los cinco procesos `online`, sin reinicios inesperados;
- cada `pm_cwd` dentro de la nueva release;
- `/api/health`, web, Analytics `/health` y salud externa en `200`;
- ruta protegida sin sesión en `401`;
- `migrate:status` sin pendientes inesperadas;
- configuración con los mismos checksums;
- logs nuevos sin errores de arranque.

Sólo después de aprobar el gate:

```bash
pm2 save
```

El dump debe contener referencias a la nueva release y el intérprete Python
`analytics/.venv/bin/python` de esa misma release.

## 6. Rollback

Si falla el arranque, readiness, cwd o salud:

1. eliminar exclusivamente los cinco procesos SisHoras;
2. iniciar `ecosystem.config.js` desde la release anterior;
3. repetir el gate de salud y cwd;
4. ejecutar `pm2 save` únicamente cuando la anterior esté estable;
5. conservar la release fallida y sus logs para diagnóstico.

El rollback de código no restaura datos. Si una migración hubiera sido autorizada
por separado, seguir el runbook específico y el backup; no improvisar un `down`.

## 7. Evidencia mínima

Registrar SHA autorizado y activo, backup y checksum, resultado de build/pruebas,
estado de migraciones, cinco cwd de PM2, códigos HTTP, reinicios y cualquier
rollback intermedio. No incluir secretos, datos personales ni topología sensible.
