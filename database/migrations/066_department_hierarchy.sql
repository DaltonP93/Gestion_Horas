-- =============================================================
-- Migración 066: jerarquía de departamentos (RBAC jerárquico).
--
-- Introduce `departments.parent_id` (auto-referencia, nullable) para que
-- un manager/coordinator/supervisor pueda "ver" a su departamento + a
-- todos sus descendientes en la jerarquía. Cuando `parent_id IS NULL`
-- el departamento es raíz.
--
-- El expandido descendiente se hace en `services/departmentScope.js`
-- (CTE recursiva vía MySQL 8 WITH RECURSIVE). Aquí sólo colocamos la
-- columna y el índice para lookup ascendente.
--
-- Idempotente vía procedimiento (add-column + add-key sólo si faltan).
-- =============================================================

DROP PROCEDURE IF EXISTS mig_066_apply;
DELIMITER $$
CREATE PROCEDURE mig_066_apply()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'departments' AND COLUMN_NAME = 'parent_id'
  ) THEN
    ALTER TABLE departments ADD COLUMN parent_id INT NULL AFTER code;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'departments' AND INDEX_NAME = 'idx_dept_parent'
  ) THEN
    CREATE INDEX idx_dept_parent ON departments(parent_id);
  END IF;
END$$
DELIMITER ;
CALL mig_066_apply();
DROP PROCEDURE IF EXISTS mig_066_apply;

SELECT 'Migración 066 aplicada: departments.parent_id + idx_dept_parent' AS info;
