-- =============================================================
-- Migración 039: corrige el origen de marcaje del self-checkin
--
-- Problema:
--   attendance_logs.source es ENUM('device','mobile','manual'), pero el
--   flujo de self-checkin (web/QR/GPS) inserta 'web' | 'qr' | 'geo', lo que
--   en modo estricto de MySQL falla. La migración 016 pretendía dejar la
--   columna como VARCHAR(20) pero, al existir ya como ENUM, no la modificó.
--
-- Solución (segura e idempotente):
--   Ampliar `source` a VARCHAR(20). Convertir ENUM→VARCHAR preserva los
--   valores existentes; si ya es VARCHAR, el MODIFY es efectivamente un
--   no-op. No hay pérdida de datos.
-- =============================================================

SET @is_enum := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'attendance_logs'
    AND COLUMN_NAME  = 'source'
    AND DATA_TYPE    = 'enum'
);

SET @sql := IF(@is_enum > 0,
  "ALTER TABLE attendance_logs MODIFY COLUMN source VARCHAR(20) NOT NULL DEFAULT 'device'",
  "SELECT 'source ya es VARCHAR — sin cambios' AS info"
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Verificación
SELECT COLUMN_NAME, COLUMN_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'attendance_logs'
  AND COLUMN_NAME = 'source';
