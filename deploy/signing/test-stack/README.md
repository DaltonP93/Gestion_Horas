# test-stack — integración REAL de la firma PAdES (html2pdf + pades-signer)

Stack de **PRUEBA** que implementa el **mismo contrato HTTP** que los servicios
reales del dueño (`html2pdf` y `pades-signer`), con dependencias abiertas y un
certificado `.p12` de prueba, para ejercer de punta a punta el adaptador de
firma `api/src/services/signing/padesSigner.js` y la **verificación
criptográfica** del PDF resultante (`verifyPdfSignature.js`).

> ⚠️ **NO es producción.** El certificado es autofirmado de prueba, los secretos
> son de ejemplo y los servicios escuchan sólo en `127.0.0.1`. En producción se
> usan las imágenes del dueño y un certificado real montado como secreto.

## Contrato (idéntico al real)
- **html2pdf**: `POST /pdf` con `x-render-key: <SHARED_SECRET>`, body `{ html, options }` → PDF binario.
- **pades-signer**: `POST /sign` con `x-sign-key: <SHARED_SECRET>`, `multipart/form-data` `file`+`reason` → PDF **firmado** (PAdES/PKCS#7 detached).
- Ambos exponen `GET /health`.

El firmador de prueba usa [`@signpdf`](https://github.com/vbede/node-signpdf)
(`placeholder-plain` + `signer-p12`): agrega el placeholder de firma al PDF y lo
firma con el `.p12` → firma **criptográfica real** (no un sello).

## Cómo correrlo
```bash
cd deploy/signing/test-stack
./prepare.sh                 # instala node_modules en el host (el build los copia; no usa red)
./gen-cert.sh                # genera ./certs/test.p12 (gitignored)
docker compose up --build -d # levanta html2pdf (127.0.0.1:3012) y pades-signer (127.0.0.1:3011)

# Integración real del backend contra el stack:
cd ../../../api
IT_SIGNING=1 SIGNING_MODE=pades_local \
  HTML2PDF_URL=http://127.0.0.1:3012 PADES_SIGNER_URL=http://127.0.0.1:3011 \
  HTML2PDF_SHARED_SECRET=render-test-secret PADES_SIGNER_SHARED_SECRET=sign-test-secret \
  SIGNING_ALLOWED_HOSTS=127.0.0.1 \
  npx jest tests/it/signing.it.test.js --runInBand --forceExit

cd ../deploy/signing/test-stack && docker compose down -v
```

La prueba `tests/it/signing.it.test.js` valida:
- `signReportDocument` → `mode='pades_local'` con `signatureInfo.verified=true`;
- el PDF devuelto verifica criptográficamente (`verifyPdfSignature` → `valid`, `sha256`, CN del cert);
- manipular el PDF firmado rompe la verificación (integridad real);
- un secreto de firma incorrecto → **401 real** del servicio → degrada a `simple` (fail-closed, nunca afirma PAdES).

`certs/` y `**/node_modules/` están gitignored.
