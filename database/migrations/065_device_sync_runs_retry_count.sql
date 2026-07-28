-- =============================================================
-- Migración 065: reintentos por bloqueo en device_sync_runs.
--
-- `retry_count` guarda cuántas veces una corrida tuvo que reintentar una
-- sentencia por deadlock (1213) o lock-wait timeout (1205) de MySQL —
-- sumando persistencia (attendance_logs / raw_device_punches) y recálculo
-- de daily_summary. 0 = corrida sin bloqueos. Sirve para vigilar si el
-- deadlock reaparece tras el fix (rango sargable + lock por fecha + retry).
--
-- Idempotente (add-column vía procedimiento).
-- =============================================================

DROP PROCEDURE IF EXISTS mig_065_add_col;
DELIMITER $$
CREATE PROCEDURE mig_065_add_col()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_sync_runs' AND COLUMN_NAME = 'retry_count'
  ) THEN
    ALTER TABLE device_sync_runs ADD COLUMN retry_count INT NOT NULL DEFAULT 0 AFTER attempts;
  END IF;
END$$
DELIMITER ;
CALL mig_065_add_col();
DROP PROCEDURE IF EXISTS mig_065_add_col;

SELECT 'Migración 065 aplicada: device_sync_runs.retry_count' AS info;
