#!/usr/bin/env bash
# =============================================================================
# ops-migrate.sh — Aplica migraciones de MySQL con un usuario ADMIN, FUERA de la
# API (paso de OPS). El runtime de la API NO tiene CREATE ROUTINE/TRIGGER y ya NO
# aplica migraciones por HTTP (se retiró /api/fase-e/migrations/apply).
#
# Las migraciones 073 (función/trigger) y 082 (procedimiento) crean rutinas, así
# que las corre OPS con un usuario ADMIN de MySQL. Preferentemente por SOCKET con
# auth unix_socket (sin password), o con credenciales admin PROVISTAS EN EL
# MOMENTO por variables de entorno — NUNCA guardadas en PM2/API.
#
# Uso (por socket admin, recomendado en el server):
#   DB_SOCKET=/var/run/mysqld/mysqld.sock DB_USER=root DB_NAME=asistencia \
#     sudo -E bash scripts/ops-migrate.sh
#
# Uso (TCP admin, credenciales efímeras en el shell, no en PM2/API):
#   DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=admin DB_PASSWORD='...' DB_NAME=asistencia \
#     bash scripts/ops-migrate.sh
#
# Requiere: node y el cliente `mysql` en el PATH; un backup fresco (ver runbook).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_NAME="${DB_NAME:-asistencia}"
export DB_NAME

# El cliente mysql toma la clave de MYSQL_PWD (evita exponerla en argv). Con
# socket admin no hace falta password.
if [ -n "${DB_PASSWORD:-}" ]; then export MYSQL_PWD="$DB_PASSWORD"; fi

if [ -n "${DB_SOCKET:-}" ]; then
  MYSQL=(mysql --socket="$DB_SOCKET" -u "${DB_USER:-root}" "$DB_NAME")
  echo "→ Conexión ADMIN por SOCKET: $DB_SOCKET (usuario ${DB_USER:-root})"
else
  MYSQL=(mysql -h "${DB_HOST:-127.0.0.1}" -P "${DB_PORT:-3306}" -u "${DB_USER:-root}" "$DB_NAME")
  echo "→ Conexión ADMIN por TCP: ${DB_HOST:-127.0.0.1}:${DB_PORT:-3306} (usuario ${DB_USER:-root})"
fi

echo "== 1) Preflight: migraciones pendientes (read-only) =="
( cd "$ROOT/api" && node scripts/migrate.js --status )

echo "== 2) Aplicar migraciones pendientes (forward-only, en orden) =="
# migrate.js hereda DB_* / DB_SOCKET del entorno.
if ( cd "$ROOT/api" && node scripts/migrate.js ); then
  APPLY_EXIT=0
else
  APPLY_EXIT=$?
fi
echo "   exit real del runner: $APPLY_EXIT"
if [ "$APPLY_EXIT" -ne 0 ]; then
  echo "❌ El runner de migraciones falló (exit $APPLY_EXIT). NO continuar." >&2
  exit "$APPLY_EXIT"
fi

echo "== 3) Validar explícitamente 072→083 registradas =="
MISSING=0
for m in \
  072_employee_schedule_history.sql \
  073_workday_profile_and_overlap_guard.sql \
  074_daily_summary_status_unknown.sql \
  075_workday_configuration_phase_c.sql \
  076_governance_companies_cost_centers.sql \
  077_audit_correlation_id.sql \
  078_people_candidates_assignments.sql \
  079_labor_calendars.sql \
  080_payroll_base.sql \
  081_monthly_report_approvals.sql \
  082_monthly_report_pades_metadata.sql \
  083_fase_e_activation_console.sql ; do
  N=$("${MYSQL[@]}" -N -B -e "SELECT COUNT(*) FROM schema_migrations WHERE filename='$m'")
  if [ "$N" != "1" ]; then echo "   ❌ FALTA $m"; MISSING=1; else echo "   ✓ $m"; fi
done
[ "$MISSING" -eq 0 ] || { echo "❌ Faltan migraciones de 072→083." >&2; exit 1; }

echo "== 4) Re-aplicar = no-op (idempotencia) =="
( cd "$ROOT/api" && node scripts/migrate.js | tail -1 )

echo "✅ Migraciones 072→083 aplicadas y verificadas (exit 0)."
