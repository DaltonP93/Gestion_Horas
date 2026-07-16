-- =============================================================
-- Migración 055: origen de marcaje 'att2000' (importación histórica).
--
-- Distingue las marcas IMPORTADAS desde att2000.CHECKINOUT (script/endpoint de
-- sync) de las leídas directamente del reloj ('zkteco_direct') y del legacy
-- 'device'. Así el diagnóstico por origen es real.
--
-- 'device' se mantiene por compatibilidad con datos históricos mezclados.
-- MODIFY es idempotente. Idempotente.
-- =============================================================

ALTER TABLE attendance_logs
  MODIFY COLUMN source ENUM('device','mobile','manual','zkteco_direct','att2000') DEFAULT 'device';

SELECT 'Migración 055 aplicada: source att2000' AS info;
