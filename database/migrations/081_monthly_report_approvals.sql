-- -------------------------------------------------------------
-- 081_monthly_report_approvals.sql
--
-- FASE 2 — Circuito de aprobación multinivel + firma electrónica interna
-- para el REPORTE MENSUAL DE MARCADAS (planilla mensual de asistencia).
--
-- Reutiliza la MISMA semántica de roles del workflow de permisos
-- (migración 011): coordinador del depto → gerente de área (manager) →
-- RR.HH. (GTH/admin) que firma. Los estados son idénticos:
--
--   pending    → esperando coordinador (nivel 1)
--   level1_ok  → esperando gerente de área (nivel 2)
--   level2_ok  → esperando RR.HH. (firma final)
--   approved   → aprobado y FIRMADO por RR.HH.
--   rejected   → rechazado en cualquier nivel
--   cancelled  → cancelado por quien lo envió
--
-- Un período es (year, month, department_id). department_id NULL = reporte
-- de toda la organización (sólo RR.HH./admin lo aprueban; no hay coordinador
-- ni gerente de una organización entera).
--
-- SIN PII NI TEXTO LIBRE: estas tablas guardan ÚNICAMENTE ids, acciones,
-- roles, timestamps y el hash de integridad. Nunca nombres, comentarios ni
-- observaciones libres. La firma electrónica es SIMPLE INTERNA (no
-- certificada): identidad del firmante (signed_by), momento (signed_at) y un
-- SHA-256 (integrity_hash) sobre una representación canónica de los datos del
-- reporte, de modo que el hash cambie si los datos subyacentes cambian.
--
-- NO toca att2000, attendance_logs ni daily_summary. Sólo lectura de esas
-- fuentes desde la app para calcular el hash; acá no se altera ninguna fila
-- existente.
--
-- Idempotente (CREATE TABLE IF NOT EXISTS) y aditiva. No destructiva.
--
-- ROLLBACK:
--     DROP TABLE IF EXISTS monthly_report_approval_events;
--     DROP TABLE IF EXISTS monthly_report_approvals;
--     DELETE FROM schema_migrations
--      WHERE filename = '081_monthly_report_approvals.sql';
-- -------------------------------------------------------------

-- 1. Pedido de aprobación de un período (year, month, department_id).
--
--    dept_key es una columna generada = COALESCE(department_id, 0). Sirve
--    SÓLO para el UNIQUE: en MySQL dos filas con department_id NULL no chocan
--    en un índice único (NULL != NULL), así que sin ella podrían crearse
--    varios pedidos org-wide para el mismo período. Con dept_key el período
--    org-wide (0) es único igual que cualquier departamento. Los ids de
--    departamento arrancan en 1, así que 0 es un centinela seguro.
CREATE TABLE IF NOT EXISTS monthly_report_approvals (
  id             INT PRIMARY KEY AUTO_INCREMENT,
  year           SMALLINT NOT NULL,
  month          TINYINT  NOT NULL,
  department_id  INT NULL,
  dept_key       INT AS (COALESCE(department_id, 0)) STORED,
  status         ENUM('pending','level1_ok','level2_ok','approved','rejected','cancelled')
                   NOT NULL DEFAULT 'pending',
  submitted_by   INT NOT NULL,
  submitted_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  signed_by      INT NULL,
  signed_at      DATETIME NULL,
  integrity_hash CHAR(64) NULL,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_period (year, month, dept_key),
  INDEX idx_status (status),
  INDEX idx_dept (department_id),
  CONSTRAINT fk_mra_dept   FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE RESTRICT,
  CONSTRAINT fk_mra_submit FOREIGN KEY (submitted_by)  REFERENCES users(id)       ON DELETE RESTRICT,
  CONSTRAINT fk_mra_signer FOREIGN KEY (signed_by)     REFERENCES users(id)       ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Traza de transiciones. SIN texto libre: sólo id de actor, su rol, la
--    acción, el estado destino y el momento. ON DELETE RESTRICT para no
--    perder la traza al intentar borrar el pedido o el usuario que actuó.
CREATE TABLE IF NOT EXISTS monthly_report_approval_events (
  id             INT PRIMARY KEY AUTO_INCREMENT,
  approval_id    INT NOT NULL,
  actor_user_id  INT NOT NULL,
  actor_role     VARCHAR(32) NOT NULL,
  action         ENUM('submit','approve','reject','sign') NOT NULL,
  to_state       ENUM('pending','level1_ok','level2_ok','approved','rejected','cancelled') NOT NULL,
  at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_approval (approval_id),
  INDEX idx_at (at),
  CONSTRAINT fk_mrae_approval FOREIGN KEY (approval_id)   REFERENCES monthly_report_approvals(id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrae_actor    FOREIGN KEY (actor_user_id) REFERENCES users(id)                    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
