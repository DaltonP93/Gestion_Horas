-- =============================================================
-- Migración 076 (FASE F1): gobierno y organización — empresas y
-- centros de costo.
--
-- Introduce dos entidades organizativas que hoy no existen como tablas:
--
--   * `companies`     — la persona jurídica empleadora. Hasta ahora el
--                       dato patronal (RUC, razón social) vivía disperso en
--                       `settings` (ver migración 041); esta tabla lo vuelve
--                       una entidad de primera clase para soportar múltiples
--                       empresas/sucursales.
--   * `cost_centers`  — centros de costo, opcionalmente ligados a una empresa.
--
-- Y agrega DOS enlaces NULEABLES, aditivos y SIN backfill:
--   * `branches.company_id`       → a qué empresa pertenece la sucursal.
--   * `departments.cost_center_id`→ a qué centro de costo imputa el depto.
--
-- POR QUÉ SIN BACKFILL: asignar una empresa/centro "por defecto" a las filas
-- existentes sería fabricar un dato de gobierno que nadie decidió. Las
-- columnas nacen en NULL y una persona las completa desde el ABM. El sistema
-- actual sigue funcionando idéntico mientras estén en NULL.
--
-- COMPATIBILIDAD: 100% aditiva. No altera ni una columna existente, no borra
-- nada, no toca `employees`, `attendance_logs`, `daily_summary` ni att2000.
-- Instalación limpia y upgrade desde el esquema previo se comportan igual.
--
-- Idempotente vía procedimiento (crea columnas/índices/FKs sólo si faltan).
--
-- Autoría de cambios: la registran las rutas /api/companies y
-- /api/cost-centers (auditoría con correlation id).
-- =============================================================

CREATE TABLE IF NOT EXISTS companies (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  code         VARCHAR(40)  NOT NULL,
  legal_name   VARCHAR(200) NOT NULL,
  trade_name   VARCHAR(200) NULL,
  tax_id       VARCHAR(40)  NULL,          -- RUC patronal (dato registral público)
  active       TINYINT(1)   NOT NULL DEFAULT 1,
  created_by   INT          NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_companies_code (code),
  KEY ix_companies_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cost_centers (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT          NULL,
  code         VARCHAR(40)  NOT NULL,
  name         VARCHAR(200) NOT NULL,
  active       TINYINT(1)   NOT NULL DEFAULT 1,
  created_by   INT          NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cost_centers_code (code),
  KEY ix_cost_centers_company (company_id),
  KEY ix_cost_centers_active (active),
  CONSTRAINT fk_cost_centers_company
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Enlaces aditivos, nuleables y sin backfill (idempotentes).
DROP PROCEDURE IF EXISTS mig_076_apply;
DELIMITER $$
CREATE PROCEDURE mig_076_apply()
BEGIN
  -- branches.company_id (la tabla branches la crea la migración 015).
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches' AND COLUMN_NAME = 'company_id'
    ) THEN
      ALTER TABLE branches ADD COLUMN company_id INT NULL AFTER code;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches' AND INDEX_NAME = 'ix_branches_company'
    ) THEN
      CREATE INDEX ix_branches_company ON branches(company_id);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches'
        AND CONSTRAINT_NAME = 'fk_branches_company'
    ) THEN
      ALTER TABLE branches
        ADD CONSTRAINT fk_branches_company
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;
    END IF;
  END IF;

  -- departments.cost_center_id (departments existe desde init.sql).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'departments' AND COLUMN_NAME = 'cost_center_id'
  ) THEN
    ALTER TABLE departments ADD COLUMN cost_center_id INT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'departments' AND INDEX_NAME = 'ix_departments_cost_center'
  ) THEN
    CREATE INDEX ix_departments_cost_center ON departments(cost_center_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'departments'
      AND CONSTRAINT_NAME = 'fk_departments_cost_center'
  ) THEN
    ALTER TABLE departments
      ADD CONSTRAINT fk_departments_cost_center
      FOREIGN KEY (cost_center_id) REFERENCES cost_centers(id) ON DELETE SET NULL;
  END IF;
END$$
DELIMITER ;
CALL mig_076_apply();
DROP PROCEDURE IF EXISTS mig_076_apply;

SELECT CONCAT('Migración 076 aplicada: companies + cost_centers; ',
              'branches.company_id y departments.cost_center_id (nuleables, sin backfill)') AS info;
