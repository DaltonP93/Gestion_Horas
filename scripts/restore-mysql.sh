#!/usr/bin/env bash
# scripts/restore-mysql.sh
# Restaura la BD `asistencia` desde un backup .sql.gz creado por
# backup-mysql.sh. Es DESTRUCTIVO: sobrescribe los datos de la base destino.
#
# Uso:
#   DB_PASSWORD=... ./scripts/restore-mysql.sh <archivo.sql.gz>
#   DB_PASSWORD=... ./scripts/restore-mysql.sh <archivo.sql.gz> --yes   # sin prompt
#
# Variables de entorno (mismas que el resto del proyecto):
#   DB_NAME (default asistencia), DB_HOST (localhost), DB_PORT (3306),
#   DB_USER (root), DB_PASSWORD.
#
# NOTA: el dump lo genera `mysqldump <db>` (sin --databases), así que NO trae
# CREATE DATABASE: la base destino debe existir. En el stack de compose la crea
# el contenedor mysql (MYSQL_DATABASE); en un host, crearla antes si no existe.

set -Eeuo pipefail

usage() {
  echo "Uso: DB_PASSWORD=... $0 <archivo.sql.gz> [--yes]"
  echo "  Restaura el backup sobre DB_NAME (default: asistencia). DESTRUCTIVO."
  exit 1
}

FILE="${1:-}"
CONFIRM="${2:-}"
[ -n "$FILE" ] || usage
[ -f "$FILE" ] || { echo "❌ No existe el archivo: $FILE"; exit 1; }

DB_NAME="${DB_NAME:-asistencia}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-root}"

# Verificar integridad del gzip ANTES de tocar la base.
if ! gzip -t "$FILE"; then
  echo "❌ Backup corrupto (gzip -t falló): $FILE"
  exit 1
fi

echo "⚠️  RESTORE DESTRUCTIVO"
echo "    Archivo : $FILE"
echo "    Destino : base '$DB_NAME' en $DB_HOST:$DB_PORT (usuario $DB_USER)"
echo "    Esto SOBRESCRIBE los datos actuales de esa base."

if [ "$CONFIRM" != "--yes" ]; then
  # Confirmación explícita: hay que tipear el nombre de la base.
  read -r -p "Para confirmar, escribí el nombre de la base ('$DB_NAME'): " ACK
  [ "$ACK" = "$DB_NAME" ] || { echo "Cancelado (no coincide)."; exit 1; }
fi

# MYSQL_PWD evita exponer la clave en argv/ps.
export MYSQL_PWD="${DB_PASSWORD:-}"

echo "[$(date '+%F %T')] Restaurando '$FILE' → '$DB_NAME'..."
gunzip -c "$FILE" | mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME"

echo "[$(date '+%F %T')] ✅ Restore completo sobre '$DB_NAME'."
echo "    Verificación sugerida:"
echo "      mysql -h $DB_HOST -P $DB_PORT -u $DB_USER $DB_NAME -e 'SELECT COUNT(*) FROM employees;'"
echo "      (desde api/) npm run migrate:status   # confirma la cadena de migraciones"
