#!/usr/bin/env bash
# =============================================================================
# ops-migrate.sh — Aplica migraciones de MySQL con un usuario ADMIN, FUERA de la
# API (paso de OPS). El runtime de la API NO tiene CREATE ROUTINE/TRIGGER y ya NO
# aplica migraciones por HTTP (se retiró /api/fase-e/migrations/apply).
#
# Las migraciones 073 (función/trigger), 082 (procedimiento) y 084 (procedimiento)
# crean rutinas, así que las corre OPS con un usuario ADMIN de MySQL que tenga —al
# menos temporalmente— privilegio CREATE ROUTINE. Preferentemente por SOCKET con
# auth unix_socket (sin password), o con credenciales admin PROVISTAS EN EL
# MOMENTO por variables de entorno — NUNCA guardadas en PM2/API. La 084 usa un
# procedimiento efímero (mig_084_apply) que se crea y se DROPea dentro del propio
# archivo para reconciliar de forma idempotente la forma de las tablas de la consola.
#
# ACOTADO a 084: aplica SÓLO hasta 084_fase_e_console_shape_reconcile.sql (--upto),
# NO arrastra migraciones futuras (085+) que pudieran aparecer en el repo. El
# servicio de la consola EXIGE 083 Y 084 (GO/NO-GO de forma completa), por eso el
# tope es 084 y no 083. La verificación de idempotencia usa el MISMO límite.
#
# ENTORNO ADMIN SANEADO: se invoca a migrate.js con MIGRATE_NO_DOTENV=1 para que
# api/.env NO pueda inyectar la contraseña runtime ni mezclar identidades; OPS
# pasa DB_* explícitos. En auth por SOCKET, DB_PASSWORD se fuerza VACÍO.
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
UPTO="084_fase_e_console_shape_reconcile.sql"   # tope duro: no arrastrar migraciones futuras (085+)

# ── Entorno admin SANEADO y EXPLÍCITO para migrate.js ─────────────────────────
# MIGRATE_NO_DOTENV=1 evita que api/.env aporte la password runtime o mezcle
# identidades. Se exportan sólo las DB_* que OPS definió.
DB_NAME="${DB_NAME:-asistencia}"
DB_USER="${DB_USER:-root}"
export MIGRATE_NO_DOTENV=1 DB_NAME DB_USER

if [ -n "${DB_SOCKET:-}" ]; then
  # Auth por socket (unix_socket): SIN password. Se fuerza DB_PASSWORD vacío para
  # que ni el entorno ni api/.env aporten una clave que mezcle identidades.
  export DB_SOCKET DB_PASSWORD=""
  unset MYSQL_PWD || true
  MYSQL=(mysql --socket="$DB_SOCKET" -u "$DB_USER" "$DB_NAME")
  echo "→ Conexión ADMIN por SOCKET: $DB_SOCKET (usuario $DB_USER, sin password)"
else
  # TCP: credenciales admin efímeras del shell (no de PM2/API).
  DB_HOST="${DB_HOST:-127.0.0.1}"; DB_PORT="${DB_PORT:-3306}"
  export DB_HOST DB_PORT
  if [ -n "${DB_PASSWORD:-}" ]; then export DB_PASSWORD MYSQL_PWD="$DB_PASSWORD"; fi
  MYSQL=(mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME")
  echo "→ Conexión ADMIN por TCP: $DB_HOST:$DB_PORT (usuario $DB_USER)"
fi

echo "== 1) Preflight: migraciones pendientes (read-only) =="
( cd "$ROOT/api" && node scripts/migrate.js --status )

echo "== 2) Aplicar migraciones pendientes ACOTADO a $UPTO (forward-only, en orden) =="
# migrate.js hereda DB_*/DB_SOCKET/MIGRATE_NO_DOTENV del entorno. --upto acota el
# tope: nunca aplica más allá de 084.
if ( cd "$ROOT/api" && node scripts/migrate.js --upto="$UPTO" ); then
  APPLY_EXIT=0
else
  APPLY_EXIT=$?
fi
echo "   exit real del runner: $APPLY_EXIT"
if [ "$APPLY_EXIT" -ne 0 ]; then
  echo "❌ El runner de migraciones falló (exit $APPLY_EXIT). NO continuar." >&2
  exit "$APPLY_EXIT"
fi

echo "== 3) Validar explícitamente 072→084 registradas (exactamente 1 entrada c/u) =="
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
  083_fase_e_activation_console.sql \
  084_fase_e_console_shape_reconcile.sql ; do
  N=$("${MYSQL[@]}" -N -B -e "SELECT COUNT(*) FROM schema_migrations WHERE filename='$m'")
  # Debe estar registrada EXACTAMENTE una vez: 0 = falta; >1 = duplicada (anómalo).
  if [ "$N" != "1" ]; then echo "   ❌ $m registrada $N veces (esperado 1)"; MISSING=1; else echo "   ✓ $m"; fi
done
[ "$MISSING" -eq 0 ] || { echo "❌ Faltan/duplicadas migraciones de 072→084." >&2; exit 1; }

echo "== 4) Verificar que NO se aplicó ninguna migración por ENCIMA del tope ($UPTO) =="
# El servicio exige 083+084 pero el tope NO debe arrastrar 085+. Si en el repo
# hubiera migraciones posteriores al tope, no deben figurar en schema_migrations.
ABOVE=$("${MYSQL[@]}" -N -B -e "SELECT COUNT(*) FROM schema_migrations WHERE filename > '$UPTO'")
if [ "$ABOVE" != "0" ]; then
  echo "   ❌ Hay $ABOVE migración(es) por encima del tope $UPTO aplicadas (no debería)." >&2
  "${MYSQL[@]}" -N -B -e "SELECT filename FROM schema_migrations WHERE filename > '$UPTO' ORDER BY filename" >&2
  exit 1
fi
echo "   ✓ nada por encima de $UPTO"

echo "== 5) Re-aplicar ACOTADO a $UPTO = no-op (idempotencia, MISMO límite) =="
( cd "$ROOT/api" && node scripts/migrate.js --upto="$UPTO" | tail -1 )

echo "✅ Migraciones 072→084 aplicadas y verificadas (exit 0). Nada por encima de $UPTO se tocó."
