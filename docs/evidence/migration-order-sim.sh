#!/usr/bin/env bash
#
# migration-order-sim.sh — evidencia P1-C (#206): demuestra con el runner REAL
# `api/scripts/migrate.js` que aplicar 081-083 ANTES que las MENORES 076-080 es
# SQL-safe para el conjunto actual (sin dependencia cruzada), y que el runner no
# tiene guardia de monotonicidad. MySQL 8 DESCARTABLE; nunca producción/att2000.
#
# Los archivos 076-083 viven sólo en ramas de PR; se extraen por SHA de HEAD:
#   076-080  #161  807f82a83f11f019d1297154abb01d2d9f901499
#   081      #198  272a739dd81be2186000573bb0480f204c89e0c6
#   082      #201  bf8b583eef5c33fdb61bbadead8700a6582b0bf2
#   083      #202  6254f778a34df01cad1188d5896814da0d7ba390
#
# Credenciales: contenedor efímero descartable (patrón CI de #194). No secretos.
set -u
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"; SIM="$WORK/sim"; CID="${CID:-sishoras-migorder-evidence}"
export DB_HOST=127.0.0.1 DB_PORT="${DB_PORT:-3307}" DB_USER=root \
       DB_PASSWORD="${DB_PASSWORD:-disposable_ci_pw}" DB_NAME=asistencia
export NODE_PATH="$REPO_DIR/api/node_modules"
MZ="mysql --protocol=TCP -h127.0.0.1 -P${DB_PORT} -uroot -p${DB_PASSWORD}"
log(){ echo "== $* =="; }

declare -A SHA=( [161]=807f82a83f11f019d1297154abb01d2d9f901499
                 [198]=272a739dd81be2186000573bb0480f204c89e0c6
                 [201]=bf8b583eef5c33fdb61bbadead8700a6582b0bf2
                 [202]=6254f778a34df01cad1188d5896814da0d7ba390 )
log "fetch de los HEAD de PR con las migraciones 076-083"
git -C "$REPO_DIR" fetch -q origin "${SHA[161]}" "${SHA[198]}" "${SHA[201]}" "${SHA[202]}"
mkdir -p "$WORK/migs" "$SIM/api/scripts" "$SIM/database/migrations"
for f in 076_governance_companies_cost_centers 077_audit_correlation_id \
         078_people_candidates_assignments 079_labor_calendars 080_payroll_base; do
  git -C "$REPO_DIR" show "${SHA[161]}:database/migrations/$f.sql" > "$WORK/migs/$f.sql"; done
git -C "$REPO_DIR" show "${SHA[198]}:database/migrations/081_monthly_report_approvals.sql"   > "$WORK/migs/081_monthly_report_approvals.sql"
git -C "$REPO_DIR" show "${SHA[201]}:database/migrations/082_monthly_report_pades_metadata.sql" > "$WORK/migs/082_monthly_report_pades_metadata.sql"
git -C "$REPO_DIR" show "${SHA[202]}:database/migrations/083_fase_e_activation_console.sql"   > "$WORK/migs/083_fase_e_activation_console.sql"
cp "$REPO_DIR/api/scripts/migrate.js" "$SIM/api/scripts/migrate.js"
MIGRATE(){ ( cd "$SIM/api" && node scripts/migrate.js "$@" ); }

docker rm -f "$CID" >/dev/null 2>&1
log "arrancando mysql:8.0 efímero"
docker run -d --name "$CID" -e MYSQL_ROOT_PASSWORD="$DB_PASSWORD" -e MYSQL_DATABASE="$DB_NAME" \
  -p 127.0.0.1:${DB_PORT}:3306 mysql:8.0 >/dev/null
for i in $(seq 1 90); do $MZ -N -e "SELECT 1;" >/dev/null 2>&1 && break; sleep 2; done
sleep 3

log "base mínima: init.sql + stubs de tablas de otras migraciones (branches/audit_events/employee_documents/payroll_periods)"
$MZ "$DB_NAME" < "$REPO_DIR/database/init.sql" 2>/dev/null
$MZ "$DB_NAME" -e "
  CREATE TABLE IF NOT EXISTS branches (id INT PRIMARY KEY AUTO_INCREMENT, code VARCHAR(50), name VARCHAR(150)) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS audit_events (id BIGINT PRIMARY KEY AUTO_INCREMENT, entity_id INT NULL, action VARCHAR(60)) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS employee_documents (id INT PRIMARY KEY AUTO_INCREMENT, employee_id INT NULL) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS payroll_periods (id INT PRIMARY KEY AUTO_INCREMENT);
  CREATE TABLE IF NOT EXISTS schema_migrations (filename VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB;" 2>/dev/null

cp "$WORK"/migs/081_*.sql "$WORK"/migs/082_*.sql "$WORK"/migs/083_*.sql "$SIM/database/migrations/"
echo; log "FASE 1: migrate con 081-083 presentes, SIN 076-080"
MIGRATE 2>&1 | tail -6

cp "$WORK"/migs/076_*.sql "$WORK"/migs/077_*.sql "$WORK"/migs/078_*.sql "$WORK"/migs/079_*.sql "$WORK"/migs/080_*.sql "$SIM/database/migrations/"
echo; log "FASE 2: se AÑADEN 076-080 (menores) y se corre migrate de nuevo"
MIGRATE 2>&1 | tail -8
echo "-- orden temporal (applied_at) de 076-083:"
$MZ -N -e "SELECT filename, applied_at FROM asistencia.schema_migrations WHERE filename REGEXP '^0(7[6-9]|8[0-3])' ORDER BY applied_at, filename;" 2>/dev/null

echo; log "FASE 3: idempotencia — migrate otra vez"
MIGRATE 2>&1 | tail -3

echo; log "VERIFICACIÓN (companies cost_centers labor_calendars mra branches.company_id fk_branches_company)"
$MZ -N -e "SELECT
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES  WHERE TABLE_SCHEMA='asistencia' AND TABLE_NAME='companies'),
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES  WHERE TABLE_SCHEMA='asistencia' AND TABLE_NAME='cost_centers'),
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES  WHERE TABLE_SCHEMA='asistencia' AND TABLE_NAME='labor_calendars'),
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES  WHERE TABLE_SCHEMA='asistencia' AND TABLE_NAME='monthly_report_approvals'),
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='asistencia' AND TABLE_NAME='branches' AND COLUMN_NAME='company_id'),
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='asistencia' AND CONSTRAINT_NAME='fk_branches_company');" 2>/dev/null

log "limpieza"; docker rm -f "$CID" >/dev/null 2>&1; rm -rf "$WORK"; echo "DONE"
