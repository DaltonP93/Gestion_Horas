-- =============================================================
-- Migración 080 (FASE F4): base de nómina — SANDBOX NO OFICIAL.
--
-- Construye SÓLO la base segura para nómina. NO calcula liquidación oficial,
-- NO ejecuta fórmulas, NO realiza pagos ni integra con IPS/MTESS/bancos. Todo
-- período nace `is_official = 0`.
--
--   * `payroll_concepts`         — catálogo VERSIONADO de conceptos de ingreso/
--     descuento (con vigencia). `formula_hint` es TEXTO descriptivo, nunca se
--     evalúa: no se afirma cálculo legal sin fuente normativa y aprobación.
--   * `payroll_periods`          — períodos con máquina de estados
--     (draft→preview→locked→closed). Un período cerrado es inmutable.
--   * `payroll_period_snapshots` — snapshot AGREGADO al cerrar, para impedir que
--     un período cerrado cambie por modificaciones posteriores (trazabilidad).
--
-- COMPATIBILIDAD: aditiva, idempotente, no destructiva, sin backfill. No toca
-- attendance_logs, daily_summary ni att2000; no reemplaza el módulo de nómina
-- existente (routes/payroll.js) — es una base paralela, apagada por defecto.
-- =============================================================

CREATE TABLE IF NOT EXISTS payroll_concepts (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  code         VARCHAR(40)  NOT NULL,
  name         VARCHAR(200) NOT NULL,
  kind         ENUM('earning','deduction') NOT NULL,
  formula_hint VARCHAR(500) NULL,               -- SÓLO descriptivo; nunca se evalúa
  version      INT          NOT NULL DEFAULT 1,
  active       TINYINT(1)   NOT NULL DEFAULT 1,
  valid_from   DATE         NOT NULL,
  valid_to     DATE         NULL,
  created_by   INT          NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payroll_concepts_code_ver (code, version),
  KEY ix_payroll_concepts_kind (kind, active),
  KEY ix_payroll_concepts_valid (valid_from, valid_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payroll_periods (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  code         VARCHAR(40)  NOT NULL,
  label        VARCHAR(200) NOT NULL,
  period_start DATE         NOT NULL,
  period_end   DATE         NOT NULL,
  status       ENUM('draft','preview','locked','closed') NOT NULL DEFAULT 'draft',
  is_official  TINYINT(1)   NOT NULL DEFAULT 0,   -- SANDBOX: siempre 0 en F4
  closed_at    DATETIME     NULL,
  closed_by    INT          NULL,
  created_by   INT          NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payroll_periods_code (code),
  KEY ix_payroll_periods_status (status),
  KEY ix_payroll_periods_range (period_start, period_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payroll_period_snapshots (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  period_id     INT          NOT NULL,
  snapshot_json LONGTEXT     NOT NULL,           -- resumen AGREGADO, sin PII innecesaria
  created_by    INT          NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Exactamente UN snapshot por período (garantía en base, no sólo en código).
  UNIQUE KEY uq_pps_period (period_id),
  -- RESTRICT (no CASCADE): el snapshot de cierre es trazabilidad y no debe
  -- borrarse en cascada al eliminar un período. Un período con snapshot (cerrado)
  -- no se borra: se conserva la evidencia.
  CONSTRAINT fk_pps_period FOREIGN KEY (period_id) REFERENCES payroll_periods(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'Migración 080 aplicada: payroll_concepts + payroll_periods + payroll_period_snapshots (sandbox no oficial)' AS info;
