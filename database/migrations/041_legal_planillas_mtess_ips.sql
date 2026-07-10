-- =============================================================
-- Migración 041: soporte para planillas legales (MTESS / IPS)
--
-- - employees.ips_number: número de asegurado IPS (para la planilla de
--   sueldos y jornales del Instituto de Previsión Social).
-- - employees.salary_base: salario/jornal base (opcional, usado en el
--   resumen para IPS; NULL si no se gestiona nómina desde el sistema).
-- Los datos del EMPLEADOR (RUC, patronal IPS, registro MTESS, razón social,
-- domicilio) se guardan como settings clave→valor (ver settings.js), no
-- requieren columnas.
-- Idempotente.
-- =============================================================

DROP PROCEDURE IF EXISTS mig_041_add_col;
DELIMITER $$
CREATE PROCEDURE mig_041_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN defn TEXT)
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

CALL mig_041_add_col('employees', 'ips_number',  'VARCHAR(30) NULL AFTER document_number');
CALL mig_041_add_col('employees', 'salary_base', 'DECIMAL(14,2) NULL AFTER ips_number');

DROP PROCEDURE mig_041_add_col;

SELECT 'Migración 041 aplicada: employees.ips_number, employees.salary_base' AS info;
