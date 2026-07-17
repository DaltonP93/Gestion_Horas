-- =============================================================
-- Migración 056: staging de marcas crudas del reloj + mapeo device→empleado.
--
-- Objetivo: NUNCA perder una marca del reloj aunque no se pueda vincular a un
-- empleado. Toda marca válida del ZKTeco se guarda en `raw_device_punches`
-- (idempotente por device_id+device_user_id+record_time). Si se encuentra el
-- empleado, además se crea la fila en attendance_logs y se enlaza; si no, queda
-- mapping_status='unmapped' para reprocesar tras cargar el mapeo.
--
-- `employee_device_map` permite vincular un usuario biométrico del reloj a un
-- empleado de SisHoras aunque su device_user_id no coincida con employees.code.
--
-- Idempotente (CREATE TABLE IF NOT EXISTS).
-- =============================================================

CREATE TABLE IF NOT EXISTS raw_device_punches (
  id                        BIGINT AUTO_INCREMENT PRIMARY KEY,
  device_id                 INT NULL,
  device_user_id            VARCHAR(50) NOT NULL,          -- deviceUserId del reloj
  user_sn                   INT NULL,                      -- userSn del registro (si viene)
  record_time               DATETIME NOT NULL,             -- hora del reloj (instante)
  record_time_py            VARCHAR(19) NULL,              -- 'YYYY-MM-DD HH:MM:SS' hora Paraguay
  ip                        VARCHAR(45) NULL,
  raw_json                  JSON NULL,                     -- registro crudo tal cual
  source                    VARCHAR(30) NOT NULL DEFAULT 'zkteco_direct',
  mapping_status            ENUM('mapped','unmapped','duplicate','invalid') NOT NULL DEFAULT 'unmapped',
  employee_id               INT NULL,
  imported_attendance_log_id BIGINT NULL,
  created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_raw_punch (device_id, device_user_id, record_time),
  INDEX idx_raw_status (mapping_status),
  INDEX idx_raw_devuser (device_user_id),
  INDEX idx_raw_rectime (record_time),
  INDEX idx_raw_emp (employee_id),
  CONSTRAINT fk_raw_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL,
  CONSTRAINT fk_raw_emp    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_device_map (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  employee_id    INT NOT NULL,
  device_id      INT NULL,                    -- NULL = mapeo global (cualquier reloj)
  device_user_id VARCHAR(50) NOT NULL,        -- deviceUserId del reloj
  active         TINYINT(1) NOT NULL DEFAULT 1,
  note           VARCHAR(255) NULL,
  created_by     INT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_edm (device_id, device_user_id, active),
  INDEX idx_edm_emp (employee_id),
  INDEX idx_edm_devuser (device_user_id),
  CONSTRAINT fk_edm_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  CONSTRAINT fk_edm_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'Migración 056 aplicada: raw_device_punches + employee_device_map' AS info;
