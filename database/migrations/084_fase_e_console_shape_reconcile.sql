-- =============================================================
-- Migración 084 (FASE E): reconciliación IDEMPOTENTE de la forma de la consola.
--
-- POR QUÉ EXISTE (no editar 083):
--   La migración 083 pudo haberse aplicado ANTES con una forma distinta (en su
--   evolución se le agregaron columnas de conteo, `applied_json`, el índice único
--   por celda y `heartbeat_seq`). El runner llavea por NOMBRE de archivo: una vez
--   registrada 083, editarla NO la reaplica, así que una BD que corrió una 083
--   vieja quedaría con un esquema a medias. En vez de EDITAR 083, esta 084
--   ADITIVA e IDEMPOTENTE lleva `daily_summary_recalc_batch`, `daily_summary_backup`
--   y `fase_e_console_lock` a la FORMA ACTUAL COMPLETA, aplique 083 la forma que
--   aplique. En una instalación nueva (083 completa), 084 no encuentra nada que
--   agregar y es un no-op.
--
-- QUÉ AGREGA/ASEGURA (sólo si falta):
--   daily_summary_recalc_batch:
--     · columnas de conteo inequívoco: cells_processed, rows_inserted,
--       rows_updated, rows_deleted, rows_unchanged, rows_written, plan_digest;
--     · rows_skipped  → filas omitidas por el restore ante un cambio LEGÍTIMO
--       concurrente (para poder distinguir un restore completo de uno parcial);
--     · el valor 'restored_with_conflicts' en el ENUM `status` → estado explícito
--       de un restore que omitió filas (no marca 'restored' completo);
--     · índices idx_status, idx_created_at.
--   daily_summary_backup:
--     · applied_json (estado que el apply escribió, para el skip del restore);
--     · UNIQUE uq_batch_cell (batch_id, employee_id, date) e índice idx_batch.
--   fase_e_console_lock:
--     · heartbeat_seq (contador monótono del heartbeat del lease).
--
-- SEGURIDAD:
--   · Puramente aditiva: no toca ni una fila de daily_summary/attendance_logs.
--   · Idempotente: cada cambio va detrás de un chequeo de INFORMATION_SCHEMA, así
--     que re-ejecutar el archivo (directo con el cliente mysql o por el runner) no
--     falla ni duplica nada.
--   · Si las tablas de la consola todavía NO existen (083 no aplicada), 084 es un
--     no-op: no crea las tablas (eso es responsabilidad de 083) y no falla.
--   · No conoce ATT2000.
--
-- ESTADO: PROPUESTA. NO ejecutada en producción. Se aplica como paso de OPS
-- (scripts/ops-migrate.sh) junto con 083. La consola NO aplica migraciones por HTTP.
--
-- ROLLBACK: las columnas/índices agregados son nuleables/aditivos; revertirlos
--   (DROP COLUMN / DROP INDEX / MODIFY status sin 'restored_with_conflicts') no
--   pierde datos de daily_summary. Y:
--   DELETE FROM schema_migrations WHERE filename = '084_fase_e_console_shape_reconcile.sql';
-- =============================================================

DROP PROCEDURE IF EXISTS mig_084_apply;
DELIMITER $$
CREATE PROCEDURE mig_084_apply()
proc_body: BEGIN
  -- Si 083 no creó las tablas, no hay nada que reconciliar (no-op seguro).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_summary_recalc_batch'
  ) THEN
    LEAVE proc_body;
  END IF;

  -- ── daily_summary_recalc_batch: columnas de conteo ──────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='daily_summary_recalc_batch' AND COLUMN_NAME='cells_processed') THEN
    ALTER TABLE daily_summary_recalc_batch ADD COLUMN cells_processed INT NOT NULL DEFAULT 0 AFTER rows_backed_up;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='daily_summary_recalc_batch' AND COLUMN_NAME='rows_inserted') THEN
    ALTER TABLE daily_summary_recalc_batch ADD COLUMN rows_inserted INT NOT NULL DEFAULT 0 AFTER cells_processed;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='daily_summary_recalc_batch' AND COLUMN_NAME='rows_updated') THEN
    ALTER TABLE daily_summary_recalc_batch ADD COLUMN rows_updated INT NOT NULL DEFAULT 0 AFTER rows_inserted;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='daily_summary_recalc_batch' AND COLUMN_NAME='rows_deleted') THEN
    ALTER TABLE daily_summary_recalc_batch ADD COLUMN rows_deleted INT NOT NULL DEFAULT 0 AFTER rows_updated;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='daily_summary_recalc_batch' AND COLUMN_NAME='rows_unchanged') THEN
    ALTER TABLE daily_summary_recalc_batch ADD COLUMN rows_unchanged INT NOT NULL DEFAULT 0 AFTER rows_deleted;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='daily_summary_recalc_batch' AND COLUMN_NAME='rows_written') THEN
    ALTER TABLE daily_summary_recalc_batch ADD COLUMN rows_written INT NOT NULL DEFAULT 0 AFTER rows_unchanged;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='daily_summary_recalc_batch' AND COLUMN_NAME='rows_skipped') THEN
    ALTER TABLE daily_summary_recalc_batch ADD COLUMN rows_skipped INT NOT NULL DEFAULT 0 AFTER rows_written;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='daily_summary_recalc_batch' AND COLUMN_NAME='plan_digest') THEN
    ALTER TABLE daily_summary_recalc_batch ADD COLUMN plan_digest CHAR(64) NULL AFTER rows_skipped;
  END IF;

  -- ENUM de estado: agregar 'restored_with_conflicts' sólo si no está (evita un
  -- rebuild innecesario en re-corridas). Preserva el resto de la máquina de estados.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='daily_summary_recalc_batch' AND COLUMN_NAME='status'
      AND COLUMN_TYPE LIKE '%restored_with_conflicts%'
  ) THEN
    ALTER TABLE daily_summary_recalc_batch
      MODIFY COLUMN status ENUM('prepared','applying','applied','failed','restoring','restored','restored_with_conflicts')
             NOT NULL DEFAULT 'prepared';
  END IF;

  -- Índices de la cabecera.
  IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='daily_summary_recalc_batch' AND INDEX_NAME='idx_status') THEN
    CREATE INDEX idx_status ON daily_summary_recalc_batch(status);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='daily_summary_recalc_batch' AND INDEX_NAME='idx_created_at') THEN
    CREATE INDEX idx_created_at ON daily_summary_recalc_batch(created_at);
  END IF;

  -- ── daily_summary_backup: applied_json + unicidad por celda + índice ─────
  IF EXISTS (SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='daily_summary_backup') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='daily_summary_backup' AND COLUMN_NAME='applied_json') THEN
      ALTER TABLE daily_summary_backup ADD COLUMN applied_json JSON NULL AFTER row_json;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='daily_summary_backup' AND INDEX_NAME='uq_batch_cell') THEN
      ALTER TABLE daily_summary_backup ADD UNIQUE KEY uq_batch_cell (batch_id, employee_id, date);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='daily_summary_backup' AND INDEX_NAME='idx_batch') THEN
      CREATE INDEX idx_batch ON daily_summary_backup(batch_id);
    END IF;
  END IF;

  -- ── fase_e_console_lock: heartbeat_seq ───────────────────────────────────
  IF EXISTS (SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fase_e_console_lock') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fase_e_console_lock' AND COLUMN_NAME='heartbeat_seq') THEN
      ALTER TABLE fase_e_console_lock ADD COLUMN heartbeat_seq BIGINT NOT NULL DEFAULT 0;
    END IF;
  END IF;
END$$
DELIMITER ;
CALL mig_084_apply();
DROP PROCEDURE IF EXISTS mig_084_apply;

SELECT 'Migración 084 aplicada: forma de consola FASE E reconciliada (rows_skipped + restored_with_conflicts + conteos/applied_json/heartbeat_seq/índices)' AS info;
