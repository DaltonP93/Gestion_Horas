-- =============================================================
-- Migración 086 — Snapshot histórico de EMPRESA en employee_assignments.
--
-- Corrección H: la empresa vigente de un empleado en una fecha debe quedar
-- CONGELADA en la asignación, no reconstruirse leyendo branches.company_id /
-- cost_centers.company_id ACTUALES (si una sucursal/centro cambia de empresa,
-- una asignación antigua se resolvería con la empresa NUEVA — deriva
-- retroactiva). Se agrega `employee_assignments.company_id` que el servicio
-- resuelve y persiste al crear cada vigencia; el motor lee EXCLUSIVamente esa
-- columna para el default histórico de empresa.
--
-- FK a companies(id) ON DELETE RESTRICT: el snapshot es evidencia histórica;
-- impedir borrar una empresa referenciada por asignaciones preserva la
-- integridad del pasado (a diferencia de branch/dept/cost_center, que usan
-- SET NULL porque son referencias "vivas", no el snapshot).
--
-- ADITIVA, IDEMPOTENTE, SIN BACKFILL: `company_id` queda NULL en las filas
-- existentes (producción tiene employee_assignments = 0). NULL = "empresa
-- histórica desconocida": NO se infiere ni se rellena; una asignación con
-- company_id NULL simplemente no habilita el company_historical_default.
-- =============================================================

DROP PROCEDURE IF EXISTS mig_086_apply;
DELIMITER $$
CREATE PROCEDURE mig_086_apply()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_assignments'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_assignments' AND COLUMN_NAME = 'company_id'
    ) THEN
      ALTER TABLE employee_assignments ADD COLUMN company_id INT NULL AFTER cost_center_id;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_assignments' AND INDEX_NAME = 'ix_ea_company'
    ) THEN
      CREATE INDEX ix_ea_company ON employee_assignments(company_id);
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies'
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_assignments'
        AND CONSTRAINT_NAME = 'fk_ea_company'
    ) THEN
      ALTER TABLE employee_assignments
        ADD CONSTRAINT fk_ea_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
    END IF;
  END IF;
END$$
DELIMITER ;

CALL mig_086_apply();
DROP PROCEDURE IF EXISTS mig_086_apply;

SELECT 'employee_assignments.company_id (snapshot histórico de empresa, nuleable, sin backfill)' AS info;
