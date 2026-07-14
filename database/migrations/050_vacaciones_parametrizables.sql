-- =============================================================
-- Migración 050: Vacaciones parametrizables.
--
-- 1) vacation_brackets — derecho a vacaciones por antigüedad (parametrizable
--    por el administrador). Ej. Paraguay (Cód. del Trabajo art. 218):
--      < 5 años   → 12 días
--      5 a 10     → 18 días
--      > 10 años  → 30 días
--    max_years NULL = sin tope superior.
--
-- 2) vacation_balances — saldo por empleado y año: días asignados (RRHH puede
--    sobrescribir el derecho), ajuste manual (+/-) y nota. Los días TOMADOS se
--    calculan en la consulta a partir de los permisos de vacaciones aprobados.
--
-- 3) permissions — columnas para el rechazo con fecha alternativa: cuando RRHH
--    rechaza una solicitud puede proponer un rango alternativo.
--
-- Idempotente.
-- =============================================================

CREATE TABLE IF NOT EXISTS vacation_brackets (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  min_years  INT NOT NULL DEFAULT 0,      -- antigüedad mínima (años, inclusive)
  max_years  INT NULL,                    -- antigüedad máxima (años, exclusiva); NULL = sin tope
  days       INT NOT NULL,                -- días de vacaciones que corresponden
  active     TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_vb_years (min_years)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed por defecto (sólo si la tabla está vacía) — valores de Paraguay.
INSERT INTO vacation_brackets (min_years, max_years, days, active)
SELECT * FROM (
  SELECT 0  AS min_years, 5    AS max_years, 12 AS days, 1 AS active UNION ALL
  SELECT 5  AS min_years, 10   AS max_years, 18 AS days, 1 AS active UNION ALL
  SELECT 10 AS min_years, NULL AS max_years, 30 AS days, 1 AS active
) seed
WHERE NOT EXISTS (SELECT 1 FROM vacation_brackets);

CREATE TABLE IF NOT EXISTS vacation_balances (
  employee_id INT NOT NULL,
  year        INT NOT NULL,
  assigned    INT NULL,                   -- días asignados (override del derecho); NULL = usar derecho
  adjustment  INT NOT NULL DEFAULT 0,     -- ajuste manual (+/-) por RRHH
  note        VARCHAR(255) NULL,
  updated_by  INT NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (employee_id, year),
  CONSTRAINT fk_vbal_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Columnas de fecha alternativa en permissions (rechazo con propuesta).
DROP PROCEDURE IF EXISTS mig_050_add_col;
DELIMITER $$
CREATE PROCEDURE mig_050_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN defn TEXT)
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

CALL mig_050_add_col('permissions', 'alt_date_from', 'DATE NULL AFTER rejection_reason');
CALL mig_050_add_col('permissions', 'alt_date_to', 'DATE NULL AFTER alt_date_from');
CALL mig_050_add_col('permissions', 'alt_proposed_by', 'INT NULL AFTER alt_date_to');
CALL mig_050_add_col('permissions', 'alt_proposed_at', 'DATETIME NULL AFTER alt_proposed_by');

DROP PROCEDURE IF EXISTS mig_050_add_col;

SELECT 'Migración 050 aplicada: vacaciones parametrizables' AS info;
