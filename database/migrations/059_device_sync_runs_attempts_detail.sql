-- =============================================================
-- Migración 059: detalle por intento en device_sync_runs.
--
-- Guarda el JSON de cada intento de lectura (mode, raw, valid, in_range,
-- first/last valid, truncated, duración, error) para diagnosticar relojes con
-- lectura parcial/inestable (p.ej. GT200/Granding con buffer truncado).
--
-- Idempotente (add-column vía procedimiento).
-- =============================================================

DROP PROCEDURE IF EXISTS mig_059_add_col;
DELIMITER $$
CREATE PROCEDURE mig_059_add_col()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_sync_runs' AND COLUMN_NAME = 'attempts_detail'
  ) THEN
    ALTER TABLE device_sync_runs ADD COLUMN attempts_detail JSON NULL AFTER error_message;
  END IF;
END$$
DELIMITER ;
CALL mig_059_add_col();
DROP PROCEDURE IF EXISTS mig_059_add_col;

SELECT 'Migración 059 aplicada: device_sync_runs.attempts_detail' AS info;
