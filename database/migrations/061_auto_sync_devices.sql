-- =============================================================
-- Migración 061: configuración de sincronización automática por reloj.
--
-- FASE 2 (auto-polling): el worker PM2 sishoras-sync-worker lee estos campos
-- para programar lecturas por reloj. ARRANCA DESACTIVADO: auto_sync_enabled=0
-- en todos los relojes y el master global (setting zkteco_auto_sync_enabled)
-- también nace apagado. Además, ZKTECO_AUTO_POLL=false en el entorno bloquea
-- todo aunque la base diga activado.
--
-- Se pre-perfilan (sin activar) los intervalos recomendados con horarios
-- escalonados: Gerencia :00/:15/:30/:45 · Comedor :05/:20/:35/:50 ·
-- Lavadero :10/:40.
--
-- Idempotente (add-column vía procedimiento).
-- =============================================================

DROP PROCEDURE IF EXISTS mig_061_add_col;
DELIMITER $$
CREATE PROCEDURE mig_061_add_col(IN col VARCHAR(64), IN defn TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE devices ADD COLUMN ', col, ' ', defn);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END$$
DELIMITER ;

CALL mig_061_add_col('auto_sync_enabled',      'TINYINT(1) NOT NULL DEFAULT 0');
CALL mig_061_add_col('auto_sync_paused',       'TINYINT(1) NOT NULL DEFAULT 0');
CALL mig_061_add_col('auto_sync_interval_min', 'INT NOT NULL DEFAULT 15');
CALL mig_061_add_col('auto_sync_offset_min',   'INT NOT NULL DEFAULT 0');
CALL mig_061_add_col('auto_sync_attempts',     'INT NOT NULL DEFAULT 3');
CALL mig_061_add_col('auto_sync_cooldown_sec', 'INT NOT NULL DEFAULT 4');
CALL mig_061_add_col('auto_sync_timeout_sec',  'INT NOT NULL DEFAULT 600');
CALL mig_061_add_col('last_auto_sync_at',      'DATETIME NULL');
CALL mig_061_add_col('next_auto_sync_at',      'DATETIME NULL');

DROP PROCEDURE IF EXISTS mig_061_add_col;

-- Perfiles iniciales recomendados (NO activan nada: auto_sync_enabled sigue 0).
UPDATE devices SET auto_sync_interval_min = 15, auto_sync_offset_min = 5,  auto_sync_attempts = 3, auto_sync_cooldown_sec = 4, auto_sync_timeout_sec = 600 WHERE name LIKE '%Comedor%';
UPDATE devices SET auto_sync_interval_min = 30, auto_sync_offset_min = 10, auto_sync_attempts = 5, auto_sync_cooldown_sec = 4, auto_sync_timeout_sec = 600 WHERE name LIKE '%Lavadero%';
UPDATE devices SET auto_sync_interval_min = 15, auto_sync_offset_min = 0,  auto_sync_attempts = 3, auto_sync_cooldown_sec = 4, auto_sync_timeout_sec = 600 WHERE name LIKE '%Gerencia%';

SELECT 'Migración 061 aplicada: auto-sync por reloj (desactivado)' AS info;
