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

### 3. Activar la firma PAdES en SisHoras (variables del backend `api/`)
En el `.env` de la API (o secretos del servidor), **no** en el repo:

```ini
SIGNING_MODE=pades_local
HTML2PDF_URL=...            # según A o B
PADES_SIGNER_URL=...        # según A o B
SIGNING_TIMEOUT_MS=15000
SIGNING_PROVIDER_NAME=pades-local
# Ajustar solo si el contrato real de tus servicios usa otros nombres de campo:
# HTML2PDF_HTML_FIELD=html
# PADES_PDF_FIELD=pdf_base64
```

Con `SIGNING_MODE` ausente o sin ambas URLs, el backend sigue en modo `simple`
(fail-closed). Recién con todo configurado firma PAdES de verdad.

### 4. Smoke test (verificación rápida)
```bash
# ¿responden?
curl -fsS http://127.0.0.1:3002/health && echo " html2pdf OK"
curl -fsS http://127.0.0.1:3001/health && echo " pades-signer OK"
```
Luego, en la app: aprobá un período de prueba y descargá el **reporte firmado**
(`/api/reports/monthly/approvals/:id/signed-pdf`). El header `X-Signature-Mode`
debe decir `pades_local` y el PDF debe abrir con firma válida en un lector.

### 5. Confirmar el contrato HTTP (ajuste final del adaptador)
El adaptador asume un contrato REST común. Si tus servicios difieren, el ajuste
es de una línea (nombres de campo ya son configurables por env). Contrato asumido:

- **html2pdf** — `POST {HTML2PDF_URL}`, `application/json`,
  body `{ "html": "<...>", "filename": "reporte.pdf" }`, respuesta PDF binario o
  JSON con el PDF en base64 (`pdf_base64|pdf|data|result`).
- **pades-signer** — `POST {PADES_SIGNER_URL}`, `application/json`,
  body `{ "pdf_base64": "<...>", "reason": "...", "name": "...", "location": "..." }`,
  respuesta PDF firmado binario o JSON base64
  (`signed_pdf_base64|signed_pdf|pdf_base64|pdf|data`).

Si el request real es `multipart/form-data` en vez de JSON base64, avisá: es un
cambio acotado en `padesSigner.js`.

---

## Seguridad
- Servicios publicados **solo en loopback** (`127.0.0.1`), nunca a Internet;
  el acceso es interno desde el backend.
- Certificado y passphrase **fuera del repo** (volumen de solo lectura o secreto).
- El backend nunca afirma "firmado PAdES" si la firma no se aplicó de verdad.
- Sin secretos, hosts ni IPs reales versionados en esta carpeta.
