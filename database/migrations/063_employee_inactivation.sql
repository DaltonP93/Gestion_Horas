-- =============================================================
-- Migración 063: inactivación robusta de empleados.
--
-- Marca la baja conservando el histórico (no se borra nada). Registra quién,
-- cuándo y por qué, y deja pendiente la deshabilitación en el reloj — que se
-- ejecutará cuando exista la sincronización inversa empleados → reloj (por eso
-- device_disable_pending queda en 1 pero NO se escribe al reloj todavía).
--
-- Idempotente (add-column vía procedimiento).
-- =============================================================

DROP PROCEDURE IF EXISTS mig_063_add_col;
DELIMITER $$
CREATE PROCEDURE mig_063_add_col(IN col VARCHAR(64), IN defn TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE employees ADD COLUMN ', col, ' ', defn);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END$$
DELIMITER ;

CALL mig_063_add_col('deactivated_at',        'DATETIME NULL');
CALL mig_063_add_col('deactivated_by',        'INT NULL');
CALL mig_063_add_col('deactivation_reason',   'VARCHAR(255) NULL');
CALL mig_063_add_col('reactivated_at',        'DATETIME NULL');
CALL mig_063_add_col('reactivated_by',        'INT NULL');
-- Pendiente de deshabilitar en el reloj (se resolverá con la sync inversa).
CALL mig_063_add_col('device_disable_pending', 'TINYINT(1) NOT NULL DEFAULT 0');

DROP PROCEDURE IF EXISTS mig_063_add_col;

-- Índice para localizar rápido las bajas pendientes de deshabilitar en reloj.
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees'
               AND INDEX_NAME = 'idx_emp_device_disable_pending');
SET @s := IF(@idx = 0,
  'ALTER TABLE employees ADD INDEX idx_emp_device_disable_pending (device_disable_pending)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SELECT 'Migración 063 aplicada: inactivación robusta de empleados' AS info;
