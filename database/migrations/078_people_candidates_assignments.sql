-- =============================================================
-- Migración 078 (FASE F2): personas — candidatos y asignaciones con vigencia.
--
-- Agrega dos entidades que el modelo actual no tiene, SIN duplicar lo existente
-- (employee_contracts/051, employee_documents/067, job_titles/069):
--
--   * `candidates` — postulantes básicos, con conversión TRAZABLE a empleado
--     (`converted_employee_id`). La conversión NO fabrica un empleado: enlaza a
--     un empleado existente (creado por el flujo normal), y queda auditada.
--     ALCANCE ORGANIZACIONAL opcional y explícito (`company_id`/`branch_id`,
--     nuleables, sin backfill): un postulante puede pertenecer a una empresa o
--     sucursal. Los roles con alcance (manager/coordinator/supervisor/gestor)
--     sólo ven candidatos de SU empresa/sucursal; un candidato SIN alcance
--     (ambos NULL) sólo es visible por roles globales de RR.HH. El API impone
--     coherencia sucursal → empresa al escribir. Sin alcance ⇒ sin visibilidad
--     cruzada entre empresas/sucursales.
--
--   * `employee_assignments` — historial TEMPORAL de asignación organizativa
--     (sucursal, departamento, centro de costo, cargo, remuneración de
--     referencia) con vigencia efectiva (`valid_from`/`valid_to`). La tabla
--     `employees` guarda sólo el valor ACTUAL y sin fecha; esto permite
--     conservar el contexto anterior sin borrarlo: un cambio append-only cierra
--     la vigencia previa en vez de sobrescribirla.
--
-- Y un metadato aditivo de documentos laborales:
--   * `employee_documents.access_level` — nivel de acceso (sin tocar los
--     archivos reales; sólo metadato de visibilidad).
--
-- COMPATIBILIDAD: 100% aditiva, idempotente, no destructiva. No fabrica datos
-- (sin backfill). No toca `attendance_logs`, `daily_summary` ni att2000.
-- =============================================================

CREATE TABLE IF NOT EXISTS candidates (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  first_name            VARCHAR(100) NOT NULL,
  last_name             VARCHAR(100) NOT NULL,
  email                 VARCHAR(150) NULL,
  phone                 VARCHAR(40)  NULL,
  source                VARCHAR(60)  NULL,           -- referido / portal / aviso…
  position_applied      VARCHAR(100) NULL,
  status                ENUM('new','screening','interview','offer','hired','rejected')
                          NOT NULL DEFAULT 'new',
  notes                 VARCHAR(1000) NULL,
  company_id            INT NULL,                    -- alcance opcional (F1): empresa
  branch_id             INT NULL,                    -- alcance opcional (F1): sucursal
  converted_employee_id INT NULL,
  created_by            INT NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_candidates_status (status),
  KEY ix_candidates_converted (converted_employee_id),
  KEY ix_candidates_scope (company_id, branch_id),
  CONSTRAINT fk_candidates_employee
    FOREIGN KEY (converted_employee_id) REFERENCES employees(id) ON DELETE SET NULL,
  -- Alcance aditivo, nuleable, sin backfill. SET NULL: quitar una empresa o
  -- sucursal no borra el postulante (pasa a "sin alcance", visible sólo por RR.HH.
  -- global), coherente con F1.
  CONSTRAINT fk_candidates_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
  CONSTRAINT fk_candidates_branch  FOREIGN KEY (branch_id)  REFERENCES branches(id)  ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_assignments (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  employee_id       INT NOT NULL,
  branch_id         INT NULL,
  department_id     INT NULL,
  cost_center_id    INT NULL,
  job_title         VARCHAR(100) NULL,
  reference_salary  DECIMAL(14,2) NULL,
  valid_from        DATE NOT NULL,
  valid_to          DATE NULL,                       -- NULL = vigente
  change_reason     VARCHAR(500) NULL,
  created_by        INT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_ea_emp (employee_id, valid_from),
  KEY ix_ea_open (employee_id, valid_to),
  -- RESTRICT (no CASCADE): el historial de asignaciones es auditable y no debe
  -- borrarse silenciosamente al eliminar un empleado. El sistema da de baja por
  -- estado (inactivo), no por DELETE; si se intentara borrar un empleado con
  -- historial, la base lo bloquea en vez de perder la trazabilidad.
  CONSTRAINT fk_ea_emp   FOREIGN KEY (employee_id)    REFERENCES employees(id)    ON DELETE RESTRICT,
  CONSTRAINT fk_ea_branch FOREIGN KEY (branch_id)     REFERENCES branches(id)     ON DELETE SET NULL,
  CONSTRAINT fk_ea_dept  FOREIGN KEY (department_id)  REFERENCES departments(id)  ON DELETE SET NULL,
  CONSTRAINT fk_ea_cc    FOREIGN KEY (cost_center_id) REFERENCES cost_centers(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Metadato de acceso en employee_documents (si la tabla existe — migración 067).
DROP PROCEDURE IF EXISTS mig_078_apply;
DELIMITER $$
CREATE PROCEDURE mig_078_apply()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents' AND COLUMN_NAME = 'access_level'
    ) THEN
      ALTER TABLE employee_documents
        ADD COLUMN access_level VARCHAR(20) NOT NULL DEFAULT 'hr_only';
    END IF;
  END IF;
END$$
DELIMITER ;
CALL mig_078_apply();
DROP PROCEDURE IF EXISTS mig_078_apply;

SELECT 'Migración 078 aplicada: candidates (con alcance company/branch) + employee_assignments; employee_documents.access_level' AS info;
