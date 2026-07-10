-- =============================================================
-- Migración 042: módulo de Turnera (programación de turnos / calendario)
--
-- Replica la planilla de turnos mensual (ej. TURNERA RECEPCIÓN) donde:
--   - cada empleado tiene, por día, uno o dos tramos de horario
--     (turno partido: 07:00-14:00 + 17:00-19:00),
--   - se calculan las horas por día y el total semanal,
--   - se controla el cumplimiento de las 48 hs semanales (Paraguay).
--
-- Tablas:
--   shift_templates    plantillas de turno reutilizables (Mañana, Tarde…)
--   shift_schedules    turnera mensual por sede/departamento
--   shift_assignments  asignación por empleado/día (admite 2 tramos)
--
-- Idempotente (IF NOT EXISTS).
-- =============================================================

CREATE TABLE IF NOT EXISTS shift_templates (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(80)  NOT NULL,
  start_time     TIME         NULL,
  end_time       TIME         NULL,
  break_minutes  INT          NOT NULL DEFAULT 0,
  color          VARCHAR(16)  NOT NULL DEFAULT '#0ea5e9',
  active         TINYINT(1)   NOT NULL DEFAULT 1,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shift_schedules (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  name                  VARCHAR(120) NOT NULL,
  branch_id             INT          NULL,
  department_id         INT          NULL,
  year                  INT          NOT NULL,
  month                 INT          NOT NULL,
  weekly_target_minutes INT          NOT NULL DEFAULT 2880, -- 48 h
  status                ENUM('draft','published') NOT NULL DEFAULT 'draft',
  notes                 TEXT         NULL,
  created_by            INT          NULL,
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sched_period (year, month),
  INDEX idx_sched_branch (branch_id),
  INDEX idx_sched_dept   (department_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shift_assignments (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  schedule_id  INT          NOT NULL,
  employee_id  INT          NOT NULL,
  work_date    DATE         NOT NULL,
  segment      TINYINT      NOT NULL DEFAULT 1, -- 1 o 2 (turno partido)
  start_time   TIME         NULL,
  end_time     TIME         NULL,
  template_id  INT          NULL,
  kind         ENUM('work','off','vacation','permiso','presupuesto') NOT NULL DEFAULT 'work',
  note         VARCHAR(120) NULL,
  minutes      INT          NOT NULL DEFAULT 0, -- calculado por el backend
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_assign (schedule_id, employee_id, work_date, segment),
  INDEX idx_assign_sched_emp (schedule_id, employee_id),
  INDEX idx_assign_date (work_date),
  CONSTRAINT fk_assign_sched FOREIGN KEY (schedule_id) REFERENCES shift_schedules(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Plantillas de ejemplo (sólo si la tabla está vacía).
INSERT INTO shift_templates (name, start_time, end_time, break_minutes, color)
SELECT * FROM (
  SELECT 'Mañana'        AS name, '07:00:00' AS start_time, '14:00:00' AS end_time, 0 AS break_minutes, '#0ea5e9' AS color UNION ALL
  SELECT 'Tarde',        '14:00:00', '21:00:00', 0, '#8b5cf6' UNION ALL
  SELECT 'Completo',     '07:00:00', '19:00:00', 0, '#10b981' UNION ALL
  SELECT 'Corrido corto','07:30:00', '16:00:00', 0, '#f59e0b'
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM shift_templates);
