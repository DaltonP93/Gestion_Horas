-- =============================================================
-- Migración 043: tipo de pago del empleado (para la planilla de
-- comunicación del MTESS).
--
-- employees.pay_type distingue cómo se informan los "días trabajados":
--   - 'jornalero'    → se informa la cantidad EXACTA de días trabajados.
--   - 'mensualizado' → base 30, descontando reposo, ausencia injustificada,
--                      licencia especial, días sin goce y vacaciones
--                      (los francos/libres normales NO se descuentan).
--
-- Por defecto 'mensualizado' (caso más común).
-- Idempotente.
-- =============================================================

DROP PROCEDURE IF EXISTS mig_043_add_col;
DELIMITER $$
CREATE PROCEDURE mig_043_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN defn TEXT)
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

CALL mig_043_add_col('employees', 'pay_type',
  "ENUM('mensualizado','jornalero') NOT NULL DEFAULT 'mensualizado' AFTER salary_base");

DROP PROCEDURE IF EXISTS mig_043_add_col;

SELECT 'Migración 043 aplicada: employees.pay_type' AS info;
