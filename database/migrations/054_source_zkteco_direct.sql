-- =============================================================
-- Migración 054: nuevo origen de marcaje 'zkteco_direct'.
--
-- Distingue los marcajes LEÍDOS DIRECTAMENTE de los relojes ZKTeco (job de
-- lectura directa → attendance_logs) de los importados desde att2000
-- (source='device'). Permite reportar el flujo real por origen y no depender
-- de att2000 para la operación diaria.
--
-- MODIFY es idempotente (fija la definición de la columna). Idempotente.
-- =============================================================

ALTER TABLE attendance_logs
  MODIFY COLUMN source ENUM('device','mobile','manual','zkteco_direct') DEFAULT 'device';

SELECT 'Migración 054 aplicada: source zkteco_direct' AS info;
