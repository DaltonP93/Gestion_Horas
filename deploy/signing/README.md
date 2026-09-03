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

- [ ] **La definición real de los dos stacks.** Las imágenes de tu otro servidor
      (`html2pdf-html2pdf`, `pades-signer-pades-signer`) se construyen localmente
      y **no** salen de un registry público. En Portainer:
      **Stacks → html2pdf → "Editor"** (y lo mismo para `pades-signer`) mostrá el
      `docker-compose.yml`. Copialos acá reemplazando los `image:`/`build:` del
      `docker-compose.yml` de esta carpeta.
- [ ] **El certificado de firma** de `pades-signer` (montarlo en `./certs`, o como
      secreto del orquestador). **Nunca** subirlo al repo.
- [ ] **El contrato HTTP real** de cada servicio (endpoint + request/response),
      para dejar clavado el adaptador (ver más abajo).

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
