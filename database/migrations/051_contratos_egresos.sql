-- =============================================================
-- Migración 051: Ingresos / Egresos — contratos laborales.
--
-- 1) employee_contracts — contratos del empleado: tipo, vigencia
--    (inicio/fin), fin del período de prueba, salario y estado. Un empleado
--    puede tener historial de contratos; el vigente es status='active'.
--
-- 2) employees — columnas de egreso: fecha y motivo de baja.
--
-- Los tipos de contrato y los días de anticipación de las alertas son
-- parametrizables vía settings (contract_types, contract_expiry_alert_days,
-- probation_alert_days). Idempotente.
-- =============================================================

CREATE TABLE IF NOT EXISTS employee_contracts (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  employee_id        INT NOT NULL,
  type               VARCHAR(60) NOT NULL,           -- indefinido / plazo fijo / pasantía…
  start_date         DATE NOT NULL,
  end_date           DATE NULL,                      -- NULL = indefinido / sin vencimiento
  probation_end_date DATE NULL,                      -- fin del período de prueba
  salary             DECIMAL(14,2) NULL,
  status             ENUM('active','ended') NOT NULL DEFAULT 'active',
  note               VARCHAR(255) NULL,
  created_by         INT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ec_emp (employee_id),
  INDEX idx_ec_status (status),
  INDEX idx_ec_end (end_date),
  INDEX idx_ec_probation (probation_end_date),
  CONSTRAINT fk_ec_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Columnas de egreso en employees (idempotente).
DROP PROCEDURE IF EXISTS mig_051_add_col;
DELIMITER $$
CREATE PROCEDURE mig_051_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN defn TEXT)
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

CALL mig_051_add_col('employees', 'termination_date', 'DATE NULL AFTER hire_date');
CALL mig_051_add_col('employees', 'termination_reason', 'VARCHAR(255) NULL AFTER termination_date');

DROP PROCEDURE IF EXISTS mig_051_add_col;

SELECT 'Migración 051 aplicada: contratos y egresos' AS info;
