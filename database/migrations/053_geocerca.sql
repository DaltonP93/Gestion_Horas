-- =============================================================
-- Migración 053: Geocerca (geofence) para marcación móvil.
--
-- Registra el resultado de la validación de perímetro en cada marcaje:
--   - geofence_status: 'inside' | 'outside' | 'unknown'
--   - distance_m: distancia (metros) al centro de la sede
--
-- El perímetro por sede vive en branches.geo_lat / geo_lng / geo_radius_m
-- (creadas en la migración 016). El MODO de aplicación es parametrizable vía
-- settings (geofence_mode: off | warn | enforce) y el radio por defecto en
-- geofence_default_radius_m. Idempotente.
-- =============================================================

DROP PROCEDURE IF EXISTS mig_053_add_col;
DELIMITER $$
CREATE PROCEDURE mig_053_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN defn TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE ', tbl, ' ADD COLUMN ', col, ' ', defn);
    PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

CALL mig_053_add_col('attendance_logs', 'geofence_status', "VARCHAR(12) NULL AFTER accuracy");
CALL mig_053_add_col('attendance_logs', 'distance_m',      "INT NULL AFTER geofence_status");

DROP PROCEDURE IF EXISTS mig_053_add_col;

SELECT 'Migración 053 aplicada: geocerca' AS info;
