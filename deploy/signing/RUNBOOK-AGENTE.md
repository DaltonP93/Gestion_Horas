# Runbook de agente — activar la firma del reporte mensual (html2pdf + pades-signer)

> Checklist paso a paso para el agente/operador que ejecuta **en el servidor de
> SisHoras**. Todo el material de referencia está en esta misma carpeta
> (`deploy/signing/`) y en el backend (`api/src/services/signing/padesSigner.js`).
>
> **Fail-closed por diseño:** mientras esto no esté completo, el reporte sale con
> firma **simple** (sello + hash) y el sistema **nunca** afirma que firmó. No hay
> riesgo de "quedar a medias": o firma de verdad, o degrada solo.

## Alcance e invariantes (leer antes de tocar nada)

- Esto **sólo** configura la firma del reporte mensual. **No** toca `att2000`
  (READ-ONLY), **no** recalcula `daily_summary`, **no** activa writers de FASE E,
  **no** corre sincronizaciones ni migraciones remotas.
- **Ningún secreto va al repo.** Certificado, passphrase y shared secrets viven en
  el servidor (env / volumen / secreto del orquestador). `.gitignore` ya bloquea
  `.env`, `certs/`, `*.p12`, `*.tar`, etc.
- **PARÁ Y PREGUNTÁ al dueño** antes de: rotar/definir credenciales que no tengas,
  exponer puertos fuera de loopback, o cualquier cambio de producción no listado acá.

---

## Precondición 0 — Rotar los secretos filtrados (obligatorio)

Durante la preparación se compartieron por chat dos credenciales reales. **Antes
de activar**, rotarlas en el servidor donde corren los servicios:

- [ ] Nuevo `SHARED_SECRET` del contenedor **html2pdf** (regenerar, p. ej.
      `openssl rand -hex 32`) → actualizar el `.env`/stack del servicio y `up -d`.
- [ ] Nueva **passphrase del `.p12`** de **pades-signer** (`P12_PASSWORD`) →
      re-exportar el `.p12` con la nueva passphrase, actualizar la variable y `up -d`.
- [ ] Anotar los nuevos valores en el gestor de secretos (NO en el repo).

---

## Paso 1 — Traer las imágenes de los servicios al server de SisHoras

Dos caminos (elegir el que aplique). Detalle en `README.md`.

- [ ] **(a) Desde los `.tar`** (`docker save` del otro servidor):
      ```bash
      docker load -i html2pdf.tar
      docker load -i pades-signer.tar
      docker images | grep -Ei 'html2pdf|pades'   # anotar nombre:tag reales
      ```
- [ ] **(b) Desde el compose real** (Portainer → Stacks → Editor, o el
      `docker-compose.yml` en `/opt/<servicio>/`): copiar `image:`/`build:` a
      `deploy/signing/docker-compose.yml`.
- [ ] Verificar que **son dos imágenes distintas** (si los `.tar` pesan igual al
      byte, se exportó dos veces la misma).

## Paso 2 — Certificado de firma

- [ ] Colocar el `.p12` en el volumen que monta `pades-signer`
      (`deploy/signing/certs/signing.p12` o el `P12_PATH` del stack), **read-only**.
- [ ] Confirmar `P12_PATH` y `P12_PASSWORD` (ya rotada) en el entorno del servicio.
- [ ] Nunca versionar el `.p12` ni la passphrase.

## Paso 3 — Levantar los servicios

- [ ] ```bash
      cd deploy/signing
      cp .env.example .env      # completar HTML2PDF_IMAGE/PADES_SIGNER_IMAGE, puertos, PADES_CERT_DIR
      docker compose up -d
      docker compose ps          # ambos "running"/"healthy"
      ```
- [ ] Confirmar que publican **sólo en loopback** (`127.0.0.1:3002` y `:3001`).

## Paso 4 — Smoke test (contrato real, con headers)

- [ ] ```bash
      cd deploy/signing
      export HTML2PDF_SHARED_SECRET=...        # el nuevo, del contenedor html2pdf
      export PADES_SIGNER_SHARED_SECRET=...    # el nuevo, del contenedor pades-signer
      ./smoke-test.sh /tmp/firmado.pdf
      ```
- [ ] Debe imprimir `OK ✔`, y el negativo (sin header) devolver **401**.
- [ ] Abrir `/tmp/firmado.pdf` y verificar que trae **firma digital** válida.
- [ ] Si algo falla: revisar `docker compose logs`, corregir, repetir. **No avanzar
      al paso 5 hasta que el smoke test pase.**

## Paso 5 — Activar la firma en el backend (`api/`)

En el `.env` de la API (o secretos del server), **no** en el repo. Ver
`api/.env.example` (sección "Firma del reporte mensual"):

- [ ] ```ini
      SIGNING_MODE=pades_local
      HTML2PDF_URL=http://127.0.0.1:3002        # o http://html2pdf:3000 si va por red Docker
      PADES_SIGNER_URL=http://127.0.0.1:3001    # o http://pades-signer:3000
      HTML2PDF_SHARED_SECRET=...                # = el del contenedor html2pdf
      PADES_SIGNER_SHARED_SECRET=...            # = el del contenedor pades-signer
      ```
      (Las URLs van **sin** `/pdf` ni `/sign`: el adaptador agrega el path.)
- [ ] Recargar la API (`pm2 reload api` u equivalente) — **con autorización del dueño**.
- [ ] Verificar arranque sin errores en logs (el header de secreto no se loguea).

## Paso 6 — Validar de punta a punta en la app

- [ ] Aprobar un **período de prueba** (coordinador → gerente → RR.HH.).
- [ ] Descargar `GET /api/reports/monthly/approvals/:id/signed-pdf`.
- [ ] Confirmar header **`X-Signature-Mode: pades_local`** (no `simple`).
- [ ] El PDF abre con **firma válida** en un lector (Adobe/okular).

---

## Rollback (volver a firma simple, sin romper nada)

- [ ] En el `.env` de la API: `SIGNING_MODE=simple` (o quitar las URLs/secretos) y
      recargar. El reporte vuelve al sello + hash de integridad; las aprobaciones
      ya persistidas **no** se ven afectadas.
- [ ] Opcional: `docker compose down` en `deploy/signing/` para bajar los servicios.

## Diagnóstico rápido

| Síntoma | Causa probable | Acción |
|---|---|---|
| `X-Signature-Mode: simple` con todo configurado | falta una URL o un secreto | revisar las 4 variables del paso 5 (fail-closed las degrada) |
| Smoke test da `401` en el POST con header | secreto del `.env` ≠ del contenedor | igualar `*_SHARED_SECRET` a `SHARED_SECRET` real del stack |
| `pades-signer` 500 al firmar | `.p12`/passphrase mal | revisar `P12_PATH`/`P12_PASSWORD` y el volumen `certs` |
| `html2pdf` no responde `/health` | contenedor caído | `docker compose logs html2pdf` |

## Nota honesta sobre el nivel de firma

`pades-signer` embebe una firma **PKCS#7/CMS real** con tu `.p12` (válida y
verificable), pero por defecto **sin** sellado de tiempo (TSA) ni datos de
revocación (LTV). Para **PAdES-LT/LTV pleno** hay que mejorar el propio servicio
`pades-signer` (agregar TSA/OCSP); no es un cambio del backend de SisHoras.
