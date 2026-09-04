#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# deploy/signing/smoke-test.sh
#
# Smoke-test de los DOS servicios de firma del reporte mensual, contra su
# CONTRATO REAL (confirmado en README.md):
#   - html2pdf     : POST {HTML2PDF_URL}{HTML2PDF_PATH}   header x-render-key
#                    body JSON { html, options }          -> PDF binario
#   - pades-signer : POST {PADES_SIGNER_URL}{PADES_SIGNER_PATH} header x-sign-key
#                    multipart/form-data (file + reason)  -> PDF firmado binario
#
# NO versiona secretos: los lee del entorno o de deploy/signing/.env (gitignored).
# NO toca datos reales; sólo renderiza y firma un PDF de prueba.
#
# Uso:
#   cd deploy/signing
#   export HTML2PDF_SHARED_SECRET=...        # = SHARED_SECRET del contenedor html2pdf
#   export PADES_SIGNER_SHARED_SECRET=...    # = SHARED_SECRET del contenedor pades-signer
#   ./smoke-test.sh                 # deja el PDF firmado en un temporal
#   ./smoke-test.sh /ruta/salida.pdf   # además guarda el firmado ahí
#
# Con un deploy/signing/.env presente (HTML2PDF_URL, PADES_SIGNER_URL y los dos
# *_SHARED_SECRET), no hace falta exportar nada.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Cargar .env local si existe (sin volcarlo a pantalla).
if [ -f "$HERE/.env" ]; then set -a; . "$HERE/.env"; set +a; fi

# Bases (por defecto loopback, iguales al otro servidor). SIN el path: se agrega abajo.
HTML2PDF_URL="${HTML2PDF_URL:-http://127.0.0.1:3002}"
PADES_SIGNER_URL="${PADES_SIGNER_URL:-http://127.0.0.1:3001}"
HTML2PDF_PATH="${HTML2PDF_PATH:-/pdf}"
PADES_SIGNER_PATH="${PADES_SIGNER_PATH:-/sign}"
HTML2PDF_AUTH_HEADER="${HTML2PDF_AUTH_HEADER:-x-render-key}"
PADES_SIGNER_AUTH_HEADER="${PADES_SIGNER_AUTH_HEADER:-x-sign-key}"

# Los servicios exigen su shared secret (401 sin él): son obligatorios.
: "${HTML2PDF_SHARED_SECRET:?Falta HTML2PDF_SHARED_SECRET (exportalo o ponelo en deploy/signing/.env; NUNCA en el repo)}"
: "${PADES_SIGNER_SHARED_SECRET:?Falta PADES_SIGNER_SHARED_SECRET (exportalo o ponelo en deploy/signing/.env; NUNCA en el repo)}"

OUT_SIGNED="${1:-}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
RENDERED="$WORK/rendered.pdf"
SIGNED="$WORK/signed.pdf"

is_pdf() { head -c4 "$1" 2>/dev/null | grep -q '%PDF'; }

echo "==> 1) /health de ambos servicios"
curl -fsS "$HTML2PDF_URL/health"     >/dev/null && echo "    html2pdf     OK ($HTML2PDF_URL)"
curl -fsS "$PADES_SIGNER_URL/health" >/dev/null && echo "    pades-signer OK ($PADES_SIGNER_URL)"

echo "==> 2) html2pdf $HTML2PDF_PATH  (header $HTML2PDF_AUTH_HEADER, body JSON html+options)"
curl -fsS -X POST "$HTML2PDF_URL$HTML2PDF_PATH" \
  -H "Content-Type: application/json" \
  -H "$HTML2PDF_AUTH_HEADER: $HTML2PDF_SHARED_SECRET" \
  -d '{"html":"<h1>SisHoras — smoke test</h1><p>Reporte de prueba (no es un dato real).</p>","options":{"format":"A4","printBackground":true,"margin":{"top":"15mm","right":"15mm","bottom":"15mm","left":"15mm"}}}' \
  -o "$RENDERED"
is_pdf "$RENDERED" && echo "    PDF renderizado OK ($(wc -c <"$RENDERED") bytes)" \
                   || { echo "    ERROR: html2pdf no devolvió un PDF"; exit 1; }

echo "==> 3) pades-signer $PADES_SIGNER_PATH  (multipart file+reason, header $PADES_SIGNER_AUTH_HEADER)"
curl -fsS -X POST "$PADES_SIGNER_URL$PADES_SIGNER_PATH" \
  -H "$PADES_SIGNER_AUTH_HEADER: $PADES_SIGNER_SHARED_SECRET" \
  -F "file=@$RENDERED;type=application/pdf" \
  -F "reason=Smoke test SisHoras" \
  -o "$SIGNED"
is_pdf "$SIGNED" && echo "    PDF firmado OK ($(wc -c <"$SIGNED") bytes)" \
                 || { echo "    ERROR: pades-signer no devolvió un PDF firmado"; exit 1; }

echo "==> 4) control negativo: sin el header debe dar 401"
code_h=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$HTML2PDF_URL$HTML2PDF_PATH" \
  -H "Content-Type: application/json" -d '{"html":"x"}' || true)
code_p=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$PADES_SIGNER_URL$PADES_SIGNER_PATH" \
  -F "file=@$RENDERED;type=application/pdf" || true)
echo "    html2pdf sin header     => HTTP $code_h (se espera 401)"
echo "    pades-signer sin header => HTTP $code_p (se espera 401)"

if [ -n "$OUT_SIGNED" ]; then
  cp "$SIGNED" "$OUT_SIGNED"
  echo "==> PDF firmado guardado en: $OUT_SIGNED"
fi

echo
echo "OK ✔  html2pdf y pades-signer responden el contrato real."
echo "     El backend usará este mismo circuito con SIGNING_MODE=pades_local."
