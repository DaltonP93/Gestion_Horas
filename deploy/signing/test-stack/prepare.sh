#!/usr/bin/env bash
# Instala node_modules (en el HOST) de los dos servicios de prueba antes de
# `docker compose build`. El build copia node_modules (no usa red).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
for svc in html2pdf pades-signer; do
  echo "→ npm install en $svc"
  ( cd "$DIR/$svc" && npm install --omit=dev --no-audit --no-fund )
done
echo "✅ node_modules listos"
