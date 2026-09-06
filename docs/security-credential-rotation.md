# Runbook — rotación de la credencial administradora inicial (H1)

> `database/init.sql` crea un usuario administrador inicial con la contraseña **demo**
> `Admin1234!`. Es sólo para instalación/desarrollo. **Debe rotarse antes de producción.**
> En producción, el arranque de la API **falla de forma segura** si detecta que un
> admin/super_admin activo todavía usa esa contraseña por defecto
> (`api/src/config/securityPreflight.js`, error `DEFAULT_ADMIN_CREDENTIAL`).

## Cuándo aplica
- Primer despliegue a producción.
- Tras restaurar un backup que contenga el usuario demo.
- Si el arranque falla con `DEFAULT_ADMIN_CREDENTIAL`.

## Cómo rotar (elegí una opción; NO se ejecuta desde el repo)

**Opción A — desde la app (recomendada):** iniciar sesión como el admin y usar
*cambiar contraseña* (`POST /api/auth/change-password`) o el módulo de usuarios.
Esto re-hashea con bcrypt por el mismo mecanismo que valida el preflight.

**Opción B — generar un hash bcrypt y actualizar el registro** (en un entorno
autorizado, nunca desde este repo ni con la contraseña en el historial de shell):

```bash
# 1) Generar el hash de una contraseña fuerte (no la tipees en línea de comando en claro
#    en máquinas compartidas; usá un prompt):
node -e 'const b=require("bcrypt");const rl=require("readline").createInterface({input:process.stdin,output:process.stdout});rl.question("Nueva contraseña admin: ",p=>{console.log(b.hashSync(p,12));rl.close())})'

# 2) Actualizar SOLO el/los admin afectados (en el servidor de la BD, con backup previo):
#    UPDATE users SET password_hash = '<hash_generado>' WHERE username = 'admin';
```

- Usar **cost 12** (el que usa la app al crear/cambiar contraseñas).
- **Nunca** commitear la contraseña ni el hash. **Nunca** loguearlos.
- Rotar todos los usuarios `admin`/`super_admin` que tengan la demo, no sólo `admin`.

## Verificar
- Reiniciar la API en producción: ya **no** debe fallar con `DEFAULT_ADMIN_CREDENTIAL`.
- Probar login con la nueva contraseña; el login con `Admin1234!` debe fallar.

## Notas de diseño del preflight
- Sólo corre con `NODE_ENV=production`; dev/test conservan la init reproducible.
- Detecta por `bcrypt.compare` contra la contraseña demo conocida (no compara texto plano de la BD).
- Ante un error de lectura transitorio **no** bloquea (la conexión ya fue validada); sólo
  bloquea ante **detección afirmativa**.
- No modifica ninguna credencial ni base: sólo lee para verificar.
- Override del valor demo por entorno: `DEMO_ADMIN_PASSWORD` (por si el instalador usó otra plantilla).

## Recomendación futura (fuera de este PR)
Que `init.sql` no fije una contraseña demo conocida en despliegues productivos:
generar una contraseña aleatoria en el bootstrap y forzar cambio en el primer login
(requiere una decisión de flujo de instalación).
