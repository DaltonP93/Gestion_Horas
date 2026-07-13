-- =============================================================
-- Migración 047: descanso configurable por horario (punto 10 del roadmap).
--
-- schedules.break_minutes: minutos de descanso que se descuentan
-- automáticamente del tiempo trabajado (worked_minutes) al recalcular el
-- resumen diario. 0 = sin descuento. Parametrizable por horario (y por lo
-- tanto por empleado/departamento según el horario asignado).
-- Idempotente.
-- =============================================================

DROP PROCEDURE IF EXISTS mig_047_add_col;
DELIMITER $$
CREATE PROCEDURE mig_047_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN defn TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE ', tbl, ' ADD COLUMN ', col, ' ', defn);
    PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

CALL mig_047_add_col('schedules', 'break_minutes', 'INT NOT NULL DEFAULT 0 AFTER tolerance_out');

DROP PROCEDURE IF EXISTS mig_047_add_col;

SELECT 'Migración 047 aplicada: schedules.break_minutes' AS info;
