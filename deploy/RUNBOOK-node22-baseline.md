# Runbook — Baseline Node 22 LTS (SisHoras)

> **Alcance:** estandarización del runtime Node del repo y CI en **Node 22 LTS**
> (política `>=22 <23`). **No** autoriza por sí solo cambiar el Node de producción:
> primero se prueba en el **stage aislado**, luego se cambia con OK del propietario.
> att2000 sigue **READ-ONLY**. No toca flags, migraciones ni secretos.
>
> **Por qué (bloqueante):** `api/` usa `mssql@12` para leer att2000, y su árbol
> transitivo (`tedious@20` → `node >=22`, varios `@azure/*` → `node >=22.0.0`)
> **exige Node 22**. En Node 20 (`20.20.2`, el de producción) `npm ci` con
> `engine-strict` **falla** (`EBADENGINE`). Por eso se estandariza el repo/CI en
> Node 22 **antes** de cambiar el runtime productivo.

## 0. Qué trae este baseline (sólo repo/CI, NO prod)
- `engines.node = ">=22 <23"` en `api`, `bridge`, `web`, `scripts` (+ locks sincronizados, sólo el campo `engines`).
- `.nvmrc = 22` (versión canónica).
- `.npmrc` con `engine-strict=true` en `api/bridge/web/scripts`: `npm ci` **aborta** ante engines incompatibles (incluye transitivos).
- Guard explícito `scripts/ci/check-node-engines.js` (evidencia legible en CI).
- CI `actions/setup-node` en **22** en TODOS los jobs; Dockerfiles en `node:22`.

## 1. Preflight de Node 22 (en el stage, read-only)
```bash
# Node 22 disponible (nvm o binarios /opt/nodeXX), SIN cambiar el global todavía:
node -v                     # el global actual (esperado 20.20.2 en prod)
nvm ls 2>/dev/null || ls -d /opt/node22 2>/dev/null || echo "instalar Node 22 side-by-side"
cat .nvmrc                  # -> 22
# Verificación de engines transitivos con el Node 22 candidato (sin instalar en prod):
nvm use 22 2>/dev/null || export PATH=/opt/node22/bin:$PATH
node -v                     # v22.x
( cd api && npm ci && node ../scripts/ci/check-node-engines.js . )
( cd bridge && npm ci && node ../scripts/ci/check-node-engines.js . )
( cd web && npm ci && node ../scripts/ci/check-node-engines.js . )
```
Si algún `npm ci` falla con `EBADENGINE`, el host candidato **no** es Node 22: no continuar.

## 2. Instalación side-by-side de Node 22 + rollback
> **Regla dura:** **PROHIBIDO** cambiar el Node **global** del host (ni `update-alternatives`,
> ni reemplazar `/usr/bin/node`) **sin haber probado antes en el stage aislado**
> `/root/sishoras-stage-040017ed4f9c-...`. El baseline es reversible sólo si Node 20
> permanece instalado en paralelo.

1. **Instalar Node 22 en paralelo** (no remover Node 20):
   - con `nvm`: `nvm install 22` (deja 20 y 22 disponibles); **no** ejecutar `nvm alias default 22` hasta validar en stage; o
   - con binarios: mantener `/opt/node20` y `/opt/node22` y elegir por `PATH`.
2. **Probar en el stage** con Node 22: `npm ci` en api/bridge/web, suites, arranque de procesos apuntando al binario de Node 22.
3. **PM2 side-by-side / rollback:**
   - Anotar el estado actual: `pm2 jlist > /root/pm2-before-node22.json` y `pm2 save` (guarda el dump actual).
   - Arrancar/recargar los procesos con el **Node 22** elegido (p.ej. `PATH=/opt/node22/bin:$PATH pm2 reload ecosystem.config.js --update-env`, o `pm2 start ... --interpreter /opt/node22/bin/node`).
   - `pm2 save` para persistir el nuevo dump; `pm2 startup` sólo si cambia el intérprete del servicio de arranque.
   - **Rollback:** volver a poner Node 20 en el `PATH`/intérprete de PM2 y `pm2 reload all --update-env` (o `pm2 resurrect` del dump previo). Como Node 20 sigue instalado, el rollback es inmediato y no requiere reinstalar nada.
4. **Cambiar el Node global a 22** (último paso, con OK del propietario) **sólo** después de que el stage y PM2-en-22 estén validados.

## 3. Analytics (Python) — NO se cambia todavía
El runtime Python de Analytics **no** se toca en este baseline. Requisito del host
para cuando se rehaga el venv (paso futuro, fuera de este PR):
```bash
# El venv nuevo de Analytics requiere el paquete de venv de la versión de Python objetivo.
# Si el objetivo es Python 3.10, el host necesita:
sudo apt-get install -y python3.10-venv
python3.10 -m venv analytics/.venv    # (ejemplo; ejecutar en el paso de Analytics, no ahora)
```
> No crear ni recrear el venv de Analytics en este baseline; sólo dejar documentado
> el prerrequisito `python3.10-venv` del host.

## 4. Verificación post-cambio (stage)
- `node -v` = v22.x en el intérprete de cada proceso PM2 (`pm2 jlist | grep exec_interpreter` o `pm2 info <app>`).
- Health de API/Web/Bridge/Analytics OK (ver `deploy/DEPLOY-RUNBOOK.md`).
- `pm2 status` sin reinicios en bucle.

## 5. Rollback resumido
1. `PATH` / intérprete de PM2 → Node 20.
2. `pm2 reload all --update-env` (o `pm2 resurrect` del dump `/root/pm2-before-node22.json`).
3. Confirmar `node -v` = v20.x en los procesos y health OK.
Node 20 nunca se desinstala durante la ventana de cambio, por lo que el rollback no depende de red ni de reinstalar paquetes.
