-- =============================================================
-- Migración 048: autorización de horas extra (punto 9 del roadmap).
--
-- Cuando el sistema está configurado para requerir autorización de horas
-- extra (setting att_overtime_requires_auth = '1'), el overtime se calcula
-- igual pero NO se paga/informa hasta que RRHH o el jefe lo apruebe.
--
-- La aprobación vive en su propia tabla (no en daily_summary) para que el
-- recálculo diario no la pise. Clave por (empleado, fecha).
-- Idempotente.
-- =============================================================

CREATE TABLE IF NOT EXISTS overtime_approvals (
  employee_id  INT          NOT NULL,
  date         DATE         NOT NULL,
  status       ENUM('approved','rejected') NOT NULL,
  minutes      INT          NOT NULL DEFAULT 0,  -- minutos de OT al momento de decidir
  decided_by   INT          NULL,
  decided_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  note         VARCHAR(255) NULL,
  PRIMARY KEY (employee_id, date),
  INDEX idx_ot_date (date),
  CONSTRAINT fk_ot_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'Migración 048 aplicada: overtime_approvals' AS info;
