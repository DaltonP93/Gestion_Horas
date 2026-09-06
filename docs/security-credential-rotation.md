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

**Opción B — generar un hash bcrypt y actualizar el registro** (sólo si no podés
usar la app; en un entorno autorizado, nunca desde este repo). La **entrada de la
contraseña debe ir oculta** (no eco en pantalla ni en el historial de shell):

```bash
# 1) Generar el hash leyendo la contraseña con el ECO APAGADO (no se muestra ni
#    queda en el historial). Node con la TTY en modo raw:
node -e '
const b=require("bcrypt");
process.stdout.write("Nueva contraseña admin (oculta): ");
const rl=require("readline").createInterface({input:process.stdin});
if (process.stdin.isTTY) process.stdin.setRawMode(true);      // sin eco
let buf="";
process.stdin.on("data",d=>{ for (const ch of d.toString("utf8")) {
  if (ch==="\n"||ch==="\r"){ if(process.stdin.isTTY)process.stdin.setRawMode(false);
    process.stdout.write("\n"+b.hashSync(buf,12)+"\n"); process.exit(0); }
  else if (ch===""){ process.exit(1); } else buf+=ch; }});
'
# (equivalente en shell: `read -rs NUEVA` y luego pasar $NUEVA al generador, sin echo)

# 2) Actualizar SOLO el/los admin afectados (en el servidor de la BD, con backup previo):
#    UPDATE users SET password_hash = '<hash_generado>' WHERE username = 'admin';
```

- Usar **cost 12** (el que usa la app al crear/cambiar contraseñas).
- **Nunca** commitear ni loguear la contraseña ni el hash; **nunca** mostrarlos en pantalla.
- Rotar todos los usuarios `admin`/`super_admin` que tengan la demo, **incluidos inactivos**.
- Preferí la **Opción A (desde la app)**; la Opción B es sólo un fallback.

## Verificar
- Reiniciar la API en producción: ya **no** debe fallar con `DEFAULT_ADMIN_CREDENTIAL`.
- Probar login con la nueva contraseña; el login con `Admin1234!` debe fallar.

## Notas de diseño del preflight (FAIL-CLOSED)
- Sólo corre con `NODE_ENV=production`; dev/test conservan la init reproducible.
- Detecta por `bcrypt.compare` contra la(s) contraseña(s) demo conocida(s) (no compara
  texto plano de la BD). Evalúa **todos** los `admin`/`super_admin`, **incluidos inactivos**.
- **Fail-closed:** si la verificación **no** puede completarse (error de consulta, tabla
  o permiso) el arranque se **bloquea** con `DEFAULT_ADMIN_CHECK_UNAVAILABLE`. No poder
  comprobar ≠ estar a salvo. Sólo se loguea un `error_code` seguro (nunca SQL ni valores).
- No modifica ninguna credencial ni base: sólo lee para verificar.
- La lista de contraseñas por defecto es **privada del módulo** y no se exporta ni se imprime.
  `ADMIN_WEAK_PASSWORDS` (CSV) sólo **añade** entradas; **no** reemplaza ni desactiva la
  comprobación incorporada. (El antiguo override `DEMO_ADMIN_PASSWORD` fue **eliminado**.)

## Prevención de reintroducción (defensa en profundidad, tiempo de "set")
Además del preflight de arranque, los puntos que fijan una contraseña rechazan la credencial
por defecto conocida en **cualquier** entorno (400, mensaje genérico, sin escribir en la BD):
`POST /api/users` (alta), `PUT /api/users/:id/password` (cambio por admin),
`POST /api/auth/change-password` (self-service) y `POST /api/auth/password/reset` (reset).
Comparten `isDefaultAdminPassword()` (devuelve sólo un booleano; no expone la lista).

> **Alcance H1 (honesto):** esto cierra la **reintroducción de la credencial demo conocida**.
> Una política general de contraseñas débiles (diccionario, longitud/entropía, rotación
> forzada) queda **fuera de alcance** de este PR y es trabajo futuro.

## Recomendación futura (fuera de este PR)
Que `init.sql` no fije una contraseña demo conocida en despliegues productivos:
generar una contraseña aleatoria en el bootstrap y forzar cambio en el primer login
(requiere una decisión de flujo de instalación).
