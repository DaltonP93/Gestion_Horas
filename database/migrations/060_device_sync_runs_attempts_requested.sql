-- =============================================================
-- Migración 060: distinguir intentos pedidos vs ejecutados.
--
-- `attempts` pasa a reflejar los intentos REALMENTE ejecutados (el early-stop
-- puede cortar antes de agotar los pedidos). `attempts_requested` guarda los
-- que se pidieron (--attempts). Así la auditoría no confunde 5 pedidos con 1
-- ejecutado cuando la primera lectura completa fue suficiente.
--
-- Idempotente (add-column vía procedimiento).
-- =============================================================

DROP PROCEDURE IF EXISTS mig_060_add_col;
DELIMITER $$
CREATE PROCEDURE mig_060_add_col()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_sync_runs' AND COLUMN_NAME = 'attempts_requested'
  ) THEN
    ALTER TABLE device_sync_runs ADD COLUMN attempts_requested INT NULL AFTER attempts;
  END IF;
END$$
DELIMITER ;
CALL mig_060_add_col();
DROP PROCEDURE IF EXISTS mig_060_add_col;

SELECT 'Migración 060 aplicada: device_sync_runs.attempts_requested' AS info;
