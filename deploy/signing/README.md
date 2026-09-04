# Firma digital PAdES en SisHoras — despliegue de servicios

SisHoras firma el **reporte mensual aprobado** llamando a dos servicios por HTTP:

1. **`html2pdf`** — recibe el HTML del reporte y devuelve un PDF.
2. **`pades-signer`** — recibe el PDF y devuelve el PDF **firmado con PAdES**.

El "cliente" ya está en el backend (`api/src/services/signing/padesSigner.js`),
es **fail-closed**: si los servicios no están o no están configurados, el reporte
sale con la firma simple (sello + hash de integridad), nunca rompe.

Este directorio prepara la **instalación de esos dos servicios** en (o cerca de)
el servidor de SisHoras, igual que ya los tenés corriendo en tu otro servidor.

---

## Qué falta de tu lado (lo que solo vos tenés)

- [ ] **Las imágenes reales** de los dos servicios. Dos caminos, cualquiera sirve:
      - **(a) Ya tenés los `.tar`** (`docker save` de tu otro servidor) →
        `docker load` en el server de SisHoras y apuntá `HTML2PDF_IMAGE` /
        `PADES_SIGNER_IMAGE` en `.env`. Ver **"Tenés las imágenes exportadas"**.
      - **(b) El `docker-compose.yml` del Editor de Portainer** (Stacks → html2pdf
        / pades-signer) → copiá sus `image:`/`build:`/`environment:` acá.
- [ ] **El certificado de firma** de `pades-signer` (montarlo en `./certs`, o como
      secreto del orquestador). **Nunca** subirlo al repo.
- [ ] **El contrato HTTP real** de cada servicio (endpoint + request/response),
      para dejar clavado el adaptador (ver más abajo).

---

## Tenés las imágenes exportadas en `.tar` (`docker save`)

Si en tu otro servidor hiciste `docker save` de las imágenes, tenés dos archivos
(p. ej. `html2pdf.tar` y `pades-signer.tar`, ~870 MB c/u). Son **archivos OCI**
(adentro se ven `blobs/`, `index.json`, `manifest.json`, `oci-layout`): la imagen
completa con todas sus capas, lista para cargar en Docker.

> ⚠️ **Estos `.tar` NO van al repositorio Git ni se le pasan al asistente.** Son
> binarios enormes; el repo solo lleva el `docker-compose.yml` y este runbook.
> Ya están cubiertos por `deploy/signing/.gitignore` (`*.tar`).
>
> ⚠️ **Verificá que sean dos imágenes distintas.** Si los dos `.tar` pesan
> *exactamente* lo mismo al byte y su carpeta `blobs/` es idéntica, exportaste dos
> veces la misma imagen. `html2pdf` (trae Chromium) y `pades-signer` (Java/PDFBox
> u otro) deben tener capas distintas y por lo tanto tamaños distintos.

### Cargar las imágenes en el servidor de SisHoras

```bash
# En el servidor de SisHoras, con los .tar copiados por scp/rsync:
docker load -i html2pdf.tar
docker load -i pades-signer.tar

# Docker imprime el nombre:tag real de cada imagen cargada, p. ej.:
#   Loaded image: html2pdf:latest
#   Loaded image: pades-signer-pades-signer:latest
docker images | grep -Ei 'html2pdf|pades'
```

Poné esos `nombre:tag` en `deploy/signing/.env`:

```ini
HTML2PDF_IMAGE=html2pdf:latest            # el que imprimió "docker load"
PADES_SIGNER_IMAGE=pades-signer:latest    # idem
```

Con eso el `docker-compose.yml` de esta carpeta ya levanta tus imágenes tal cual,
sin necesidad de reconstruirlas ni de un registry.

### Cómo obtener el contrato HTTP sin mandar los 872 MB a nadie

Para dejar clavado el adaptador (`api/src/services/signing/padesSigner.js`) hace
falta saber **endpoint + forma del request/response** de cada servicio. Se saca
del propio contenedor con comandos cortos cuya **salida de texto** es lo único que
hay que compartir:

```bash
# 1) Puerto, variables y comando de arranque (revelan framework y config):
docker image inspect html2pdf:latest \
  --format '{{json .Config}}' | python3 -m json.tool

# 2) Levantar y probar los endpoints típicos (la salida dice cuál responde):
docker run --rm -d --name _h2p -p 3002:3000 html2pdf:latest
for p in / /health /convert /api/convert /pdf /render; do
  echo "== POST $p =="; \
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:3002$p" \
    -H 'Content-Type: application/json' -d '{"html":"<h1>ok</h1>"}'
done
docker logs _h2p; docker rm -f _h2p
```

(análogo para `pades-signer` en el puerto `3001`). La combinación de
`Config` + los códigos de respuesta + los logs identifica el contrato real; con
eso el ajuste del adaptador es de una línea. **Alternativa más simple:** pegar el
`docker-compose.yml` del Editor de Portainer (sus `environment:` y `command:`
suelen nombrar endpoint y variables).

---

## Instalación (runbook)

### 1. Traer los servicios al servidor de SisHoras
Copiá las definiciones reales de tus dos stacks al `docker-compose.yml` de esta
carpeta (o dejá los stacks como los tenés y solo apuntá SisHoras a ellos por red).

```bash
cd deploy/signing
cp .env.example .env            # completá imágenes, puertos y ruta del cert
# poné el certificado de firma en ./certs (o configurá un secreto)
docker compose up -d
docker compose ps               # ambos "running" y "healthy"
```

Puertos por defecto (iguales a tu otro servidor): `html2pdf` en **3002→3000**,
`pades-signer` en **3001→3000**, publicados solo en `127.0.0.1` (no exponer a
Internet).

### 2. Conectar SisHoras con los servicios
Dos opciones según dónde corra el backend:

- **A) SisHoras en Docker en el mismo host** → uní el contenedor de la API a la
  red `sishoras-signing` y usá los nombres de servicio:
  - `HTML2PDF_URL=http://html2pdf:3000`
  - `PADES_SIGNER_URL=http://pades-signer:3000`
- **B) SisHoras fuera de Docker (PM2)** → usá el host local:
  - `HTML2PDF_URL=http://127.0.0.1:3002`
  - `PADES_SIGNER_URL=http://127.0.0.1:3001`

### 3. Activar la firma en SisHoras (variables del backend `api/`)
En el `.env` de la API (o secretos del servidor), **no** en el repo. Los dos
servicios exigen un **shared secret** por header (responden `401` sin él), así
que hay que pasarles el mismo valor que tienen configurado los contenedores:

```ini
SIGNING_MODE=pades_local
HTML2PDF_URL=...                 # según A o B (sin el /pdf; el adaptador lo agrega)
PADES_SIGNER_URL=...             # según A o B (sin el /sign; el adaptador lo agrega)
HTML2PDF_SHARED_SECRET=...       # = SHARED_SECRET del contenedor html2pdf
PADES_SIGNER_SHARED_SECRET=...   # = SHARED_SECRET del contenedor pades-signer
SIGNING_TIMEOUT_MS=15000
SIGNING_PROVIDER_NAME=pades-local
# Overrides opcionales (los defaults ya coinciden con el contrato real):
# HTML2PDF_PATH=/pdf             HTML2PDF_AUTH_HEADER=x-render-key   HTML2PDF_HTML_FIELD=html
# PADES_SIGNER_PATH=/sign        PADES_SIGNER_AUTH_HEADER=x-sign-key PADES_FILE_FIELD=file
```

Fail-closed: con `SIGNING_MODE` ausente, sin ambas URLs **o sin ambos secretos**,
el backend queda en modo `simple` (sello + hash de integridad) y **nunca** afirma
que firmó. Recién con todo configurado aplica la firma real.

> El certificado `.p12` y su passphrase viven **dentro** del contenedor
> `pades-signer` (variables `P12_PATH` / `P12_PASSWORD` y el volumen `./certs`).
> El backend de SisHoras **no** los conoce ni los toca.

### 4. Smoke test (verificación rápida)
```bash
# ¿responden?
curl -fsS http://127.0.0.1:3002/health && echo " html2pdf OK"
curl -fsS http://127.0.0.1:3001/health && echo " pades-signer OK"
```
Luego, en la app: aprobá un período de prueba y descargá el **reporte firmado**
(`/api/reports/monthly/approvals/:id/signed-pdf`). El header `X-Signature-Mode`
debe decir `pades_local` y el PDF debe abrir con firma válida en un lector.

### 5. Contrato HTTP (CONFIRMADO contra los `server.js` de los servicios)
El adaptador `padesSigner.js` ya está pinchado a este contrato real; los
defaults coinciden, así que normalmente no hay que tocar nada:

- **html2pdf** — `POST {HTML2PDF_URL}/pdf`, `application/json`
  - Header de auth: `x-render-key: <SHARED_SECRET del contenedor>`
  - Body: `{ "html": "<...>", "options": { "format": "A4", ... } }`
  - Respuesta: **PDF binario** (`application/pdf`). Sin el header → `401`.
- **pades-signer** — `POST {PADES_SIGNER_URL}/sign`, `multipart/form-data`
  - Header de auth: `x-sign-key: <SHARED_SECRET del contenedor>`
  - Campos: `file` = el PDF, `reason` = motivo NO-PII.
  - Respuesta: **PDF firmado binario** (`application/pdf`). Firma PKCS#7
    embebida con el `.p12` del servicio (`node-signpdf`). Sin el header → `401`.

Si algún día cambiás rutas, headers o nombres de campo, todo es override-able
por env (`HTML2PDF_PATH`, `HTML2PDF_AUTH_HEADER`, `HTML2PDF_HTML_FIELD`,
`PADES_SIGNER_PATH`, `PADES_SIGNER_AUTH_HEADER`, `PADES_FILE_FIELD`) sin tocar
código.

> **Nota sobre "PAdES":** `node-signpdf` embebe una firma **PKCS#7/CMS** real
> con tu certificado — es una firma digital criptográfica válida y verificable.
> No incluye por sí sola sellado de tiempo (TSA) ni datos de revocación (LTV/PAdES-LT).
> Si necesitás PAdES-LT/LTV pleno, es una mejora del propio servicio
> `pades-signer` (agregar TSA/OCSP), no del backend de SisHoras.

---

## Seguridad
- Servicios publicados **solo en loopback** (`127.0.0.1`), nunca a Internet;
  el acceso es interno desde el backend.
- **Shared secret obligatorio**: ambos servicios responden `401` sin su header.
  El backend lo pasa por `HTML2PDF_SHARED_SECRET` / `PADES_SIGNER_SHARED_SECRET`
  (env/secretos, nunca en el repo). El header de secreto no se loguea.
- Certificado `.p12` y passphrase **fuera del repo**, dentro del contenedor
  `pades-signer` (volumen de solo lectura o secreto). El backend no los conoce.
- El backend nunca afirma "firmado" si la firma no se aplicó de verdad.
- Sin secretos, hosts ni IPs reales versionados en esta carpeta.
