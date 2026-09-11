#!/usr/bin/env bash
# Genera un certificado autofirmado + .p12 de PRUEBA para pades-signer.
# NO es un certificado de producción. Salida en ./certs (gitignored).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)/certs"
PASS="${P12_PASSPHRASE:-testpass}"
mkdir -p "$DIR"
openssl req -x509 -newkey rsa:2048 -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
  -days 3 -nodes -subj "/CN=SisHoras Reporte Mensual (test)" >/dev/null 2>&1
openssl pkcs12 -export -out "$DIR/test.p12" -inkey "$DIR/key.pem" -in "$DIR/cert.pem" \
  -passout "pass:$PASS" >/dev/null 2>&1
echo "cert de prueba generado en $DIR/test.p12 (CN=SisHoras Reporte Mensual (test))"
