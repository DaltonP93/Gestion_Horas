-- =============================================================
-- Migración 052: Maternidad / Lactancia — reducción horaria.
--
-- lactancia_periods — período de lactancia de una empleada, con la reducción
-- horaria diaria (en minutos) que le corresponde hasta que el hijo cumple
-- cierta edad (por defecto 24 meses en Paraguay). Un período vigente es
-- status='active'.
--
-- La reducción por defecto, la edad máxima del hijo y la anticipación de la
-- alerta de fin de período son parametrizables vía settings
-- (lactancia_reduction_minutes, lactancia_max_child_age_months,
-- lactancia_alert_days). Idempotente.
-- =============================================================

CREATE TABLE IF NOT EXISTS lactancia_periods (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  employee_id       INT NOT NULL,
  child_birth_date  DATE NULL,                  -- fecha de nacimiento del hijo
  start_date        DATE NOT NULL,              -- inicio de la reducción
  end_date          DATE NULL,                  -- fin (por defecto nacimiento + edad máx.)
  reduction_minutes INT NOT NULL DEFAULT 90,    -- reducción horaria diaria (min)
  status            ENUM('active','ended') NOT NULL DEFAULT 'active',
  note              VARCHAR(255) NULL,
  created_by        INT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_lp_emp (employee_id),
  INDEX idx_lp_status (status),
  INDEX idx_lp_dates (start_date, end_date),
  CONSTRAINT fk_lp_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'Migración 052 aplicada: maternidad/lactancia' AS info;
