# test-stack — integración de PRUEBA de la firma PAdES (html2pdf + pades-signer)

Stack **de PRUEBA, COMPATIBLE** con el contrato HTTP de los servicios de firma
del despliegue (`html2pdf` y `pades-signer`). **NO son las imágenes reales del
dueño ni su certificado real:** es una re-implementación mínima del **mismo
contrato** (mismos endpoints, headers y formatos) con dependencias abiertas y un
certificado `.p12` **autofirmado de prueba**, cuyo único fin es ejercer de punta
a punta, en CI y localmente, el adaptador `api/src/services/signing/padesSigner.js`
y la **verificación criptográfica** del PDF (`verifyPdfSignature.js`).

> ⚠️ **Esto NO valida las imágenes reales.** Un verde acá prueba que el backend
> habla el contrato correctamente y que la verificación/pin funcionan contra una
> firma PAdES real — **no** que las imágenes `html2pdf`/`pades-signer` del dueño
> ni su certificado de producción se comporten igual. Antes de activar
> `SIGNING_MODE=pades_local` en un entorno real hay un **paso separado** que
> prueba las imágenes y el certificado REALES (ver
> [`deploy/signing/README.md`](../README.md) §"Validar las imágenes y el
> certificado REALES antes de activar `pades_local`").

## Contrato (idéntico al real)
- **html2pdf**: `POST /pdf` con `x-render-key: <SHARED_SECRET>`, body `{ html, options }` → PDF binario.
- **pades-signer**: `POST /sign` con `x-sign-key: <SHARED_SECRET>`, `multipart/form-data` `file`+`reason` → PDF **firmado** (PAdES/PKCS#7 detached).
- Ambos exponen `GET /health`.

El firmador de prueba usa [`@signpdf`](https://github.com/vbede/node-signpdf)
(`placeholder-plain` + `signer-p12`): agrega el placeholder de firma al PDF y lo
firma con el `.p12` → firma **criptográfica real** (no un sello).

## Reproducibilidad de dependencias
Los `package.json` de ambos servicios fijan **versiones EXACTAS** (sin `^`), así
la instalación es reproducible. `prepare.sh` instala `node_modules` en el host y
el `docker build` los COPIA (no usa red). `certs/`, `**/node_modules/` y los
`package-lock.json` generados están gitignored.

## Cómo correrlo
```bash
cd deploy/signing/test-stack
./prepare.sh                 # instala node_modules en el host (el build los copia; no usa red)
./gen-cert.sh                # genera ./certs/test.p12 (gitignored)
docker compose up --build -d # levanta html2pdf (127.0.0.1:3012) y pades-signer (127.0.0.1:3011)

# PIN: fingerprint SHA-256 del cert de prueba (lo mismo que exige pades_local).
FP=$(openssl x509 -in ./certs/cert.pem -noout -fingerprint -sha256 | sed 's/.*=//; s/://g')

# Integración real del backend contra el stack:
cd ../../../api
IT_SIGNING=1 SIGNING_MODE=pades_local \
  HTML2PDF_URL=http://127.0.0.1:3012 PADES_SIGNER_URL=http://127.0.0.1:3011 \
  HTML2PDF_SHARED_SECRET=render-test-secret PADES_SIGNER_SHARED_SECRET=sign-test-secret \
  SIGNING_ALLOWED_HOSTS=127.0.0.1 PADES_TRUSTED_CERT_SHA256="$FP" \
  npx jest tests/it/signing.it.test.js --runInBand --forceExit

cd ../deploy/signing/test-stack && docker compose down -v
```

En CI este flujo corre como el job **obligatorio** `signing-it` (`.github/workflows/ci.yml`),
que además **falla si el IT quedara skipped** (verifica `numPendingTests === 0`).

La prueba `tests/it/signing.it.test.js` valida:
- `signReportDocument` → `mode='pades_local'` con `signatureInfo.verified=true` y `pinned=true`;
- el PDF devuelto verifica criptográficamente (`verifyPdfSignature` → `valid`, `sha256`, CN + fingerprint que coincide con el PIN);
- manipular el PDF firmado rompe la verificación (integridad real);
- un secreto de firma incorrecto → **401 real** del servicio → degrada a `simple` (fail-closed);
- un **PIN incorrecto** → firma real pero degrada a `simple` (`PIN_MISMATCH`): nunca se afirma PAdES contra un cert que no es el de confianza.
