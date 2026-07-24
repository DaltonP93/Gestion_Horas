-- =============================================================
-- Migración 064: endurecimiento del auto-polling.
--
--  * device_locks — lock distribuido por reloj (fallback si no hay Redis).
--    Garantiza que ninguna lectura se superponga: worker automático,
--    "sincronizar ahora", lectura por rango, endpoint individual y scripts
--    comparten el mismo lock por device_id.
--  * sync_jobs — cola persistente de trabajos de lectura manual. La API crea
--    el trabajo y responde 202; el worker lo procesa reloj por reloj sin
--    mantener la petición HTTP abierta.
--
-- Idempotente (CREATE TABLE IF NOT EXISTS).
-- =============================================================

CREATE TABLE IF NOT EXISTS device_locks (
  device_id   INT PRIMARY KEY,
  token       VARCHAR(64)  NOT NULL,
  owner       VARCHAR(64)  NULL,     -- proceso propietario (pid/host)
  job_id      VARCHAR(64)  NULL,     -- trabajo asociado (si aplica)
  origin      VARCHAR(32)  NULL,     -- automatic | manual | script | direct
  acquired_at DATETIME     NOT NULL,
  expires_at  DATETIME     NOT NULL,
  INDEX idx_device_locks_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sync_jobs (
  id                 BIGINT PRIMARY KEY AUTO_INCREMENT,
  batch_id           VARCHAR(64)  NULL,   -- agrupa varios relojes de una misma petición
  device_id          INT          NOT NULL,
  origin             VARCHAR(32)  NOT NULL DEFAULT 'manual', -- manual | script | automatic
  requested_by       INT          NULL,   -- users.id que lo inició
  mode               VARCHAR(16)  NULL,    -- auto | tcp | udp (fuerza protocolo)
  date_from          DATE         NULL,
  date_to            DATE         NULL,
  recalc             TINYINT(1)   NOT NULL DEFAULT 1,
  attempts_requested INT          NULL,
  attempts_executed  INT          NULL,
  status             VARCHAR(16)  NOT NULL DEFAULT 'queued', -- queued|running|success|partial|error|cancelled
  cancel_requested   TINYINT(1)   NOT NULL DEFAULT 0,
  progress           VARCHAR(255) NULL,
  result             TEXT         NULL,    -- JSON con el resumen de la corrida
  error              VARCHAR(500) NULL,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at         DATETIME     NULL,
  finished_at        DATETIME     NULL,
  duration_ms        INT          NULL,
  INDEX idx_sync_jobs_status (status),
  INDEX idx_sync_jobs_device (device_id),
  INDEX idx_sync_jobs_batch (batch_id),
  INDEX idx_sync_jobs_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SELECT 'Migración 064 aplicada: device_locks + sync_jobs' AS info;
