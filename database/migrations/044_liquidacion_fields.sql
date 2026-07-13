-- =============================================================
-- Migración 044: campos para el motor de liquidación (montos de planilla).
--
--   employees.children_count  → N° de hijos, para la bonificación familiar
--                               (5% del salario mínimo por hijo, art. 261 CT).
--   employees.antiguedad_rate → % de antigüedad a aplicar sobre el básico
--                               (varía según el CCT; se carga manualmente).
--
-- Los divisores, franja nocturna y porcentajes se guardan como settings.
-- Idempotente.
-- =============================================================

DROP PROCEDURE IF EXISTS mig_044_add_col;
DELIMITER $$
CREATE PROCEDURE mig_044_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN defn TEXT)
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

CALL mig_044_add_col('employees', 'children_count',  'INT NOT NULL DEFAULT 0 AFTER pay_type');
CALL mig_044_add_col('employees', 'antiguedad_rate', 'DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER children_count');

DROP PROCEDURE IF EXISTS mig_044_add_col;

SELECT 'Migración 044 aplicada: employees.children_count, employees.antiguedad_rate' AS info;
