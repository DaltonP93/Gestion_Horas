-- =============================================================
-- Migración 070: línea base de consumo de red por lectura de reloj.
--
-- NO crea una tabla nueva. `device_sync_runs` ya registra por ejecución los
-- contadores (leídos, en rango, importados, duplicados, sin empleado,
-- basura), los intentos con su detalle JSON, la duración y el error. Lo que
-- falta para medir la red son cuatro datos, y van como columnas de esa misma
-- tabla:
--
--   mode              cómo se originó la lectura. Hoy se deriva del origen del
--                     lock ('automatic' → polling_auto, 'manual' →
--                     polling_manual); queda listo para 'recovery' y 'push'
--                     cuando esos flujos existan.
--   bytes_from_device volumen del payload decodificado que entregó el reloj.
--   bytes_estimated   1 cuando ese volumen es una estimación por muestreo y no
--                     una medición exacta. Sin esta bandera, un número
--                     aproximado se lee como si fuera exacto.
--   error_code        clasificación corta y segura del fallo (timeout,
--                     truncated, unreachable…). `error_message` ya existe pero
--                     es texto libre: no sirve para agrupar.
--
-- Todo es aditivo y opcional: el código lee las columnas que existan, así que
-- la API sigue funcionando con la migración sin aplicar.
-- =============================================================

DROP PROCEDURE IF EXISTS mig_070_add_net_cols;
DELIMITER $$
CREATE PROCEDURE mig_070_add_net_cols()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_sync_runs'
       AND COLUMN_NAME = 'mode'
  ) THEN
    ALTER TABLE device_sync_runs ADD COLUMN mode VARCHAR(24) NULL AFTER status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_sync_runs'
       AND COLUMN_NAME = 'bytes_from_device'
  ) THEN
    ALTER TABLE device_sync_runs ADD COLUMN bytes_from_device BIGINT NULL AFTER duration_ms;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_sync_runs'
       AND COLUMN_NAME = 'bytes_estimated'
  ) THEN
    ALTER TABLE device_sync_runs ADD COLUMN bytes_estimated TINYINT(1) NOT NULL DEFAULT 0 AFTER bytes_from_device;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_sync_runs'
       AND COLUMN_NAME = 'error_code'
  ) THEN
    ALTER TABLE device_sync_runs ADD COLUMN error_code VARCHAR(40) NULL AFTER error_message;
  END IF;

  -- El endpoint de métricas filtra por ventana y agrupa por reloj y modo.
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_sync_runs'
       AND INDEX_NAME = 'idx_dsr_started_device_mode'
  ) THEN
    ALTER TABLE device_sync_runs ADD INDEX idx_dsr_started_device_mode (started_at, device_id, mode);
  END IF;
END$$
DELIMITER ;
CALL mig_070_add_net_cols();
DROP PROCEDURE IF EXISTS mig_070_add_net_cols;

SELECT 'Migración 070 aplicada: device_sync_runs + métricas de red' AS info;
