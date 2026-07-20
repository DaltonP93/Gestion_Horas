-- =============================================================
-- Migración 057: auditoría de lecturas de reloj (device_sync_runs).
--
-- Cada lectura directa de un reloj (backupDeviceDirect, no dry-run) registra una
-- fila con su resultado: contadores, duración, intentos y error. Permite mostrar
-- en Config → Relojes el estado real por equipo (última lectura, error, marcas
-- de hoy) y saber si un reloj dejó de aportar marcas (p.ej. Comedor/Lavadero),
-- para no dar por completo un día que en realidad es parcial.
--
-- Idempotente (CREATE TABLE IF NOT EXISTS).
-- =============================================================

CREATE TABLE IF NOT EXISTS device_sync_runs (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  device_id         INT NULL,
  started_at        DATETIME NOT NULL,
  finished_at       DATETIME NULL,
  status            ENUM('success','partial','error','timeout') NOT NULL DEFAULT 'success',
  raw_count         INT DEFAULT 0,
  valid_count       INT DEFAULT 0,
  in_range_count    INT DEFAULT 0,
  imported_count    INT DEFAULT 0,
  duplicate_count   INT DEFAULT 0,
  unmapped_count    INT DEFAULT 0,
  garbage_count     INT DEFAULT 0,
  first_valid_time  VARCHAR(19) NULL,
  last_valid_time   VARCHAR(19) NULL,
  attempts          INT DEFAULT 1,
  duration_ms       INT NULL,
  from_date         VARCHAR(10) NULL,
  to_date           VARCHAR(10) NULL,
  error_message     VARCHAR(500) NULL,
  created_by        INT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_dsr_device (device_id, id),
  INDEX idx_dsr_started (started_at),
  INDEX idx_dsr_status (status),
  CONSTRAINT fk_dsr_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'Migración 057 aplicada: device_sync_runs' AS info;
