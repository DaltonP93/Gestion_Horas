-- =============================================================
-- Migración 062: cuenta del usuario — perfil personal + sesiones.
--
-- Bloque de UX "Cuenta / Perfil / Seguridad personal":
--  * users: idioma, zona horaria y preferencias visuales editables por el
--    propio usuario desde "Mi perfil" / "Preferencias".
--  * refresh_tokens: metadata de sesión (IP, user-agent, último uso) para
--    listar "Seguridad de mi cuenta" (sesiones activas, dispositivos/IP
--    recientes) con datos reales, sin simular funcionalidad inexistente.
--
-- Idempotente (add-column vía procedimiento).
-- =============================================================

DROP PROCEDURE IF EXISTS mig_062_add_col;
DELIMITER $$
CREATE PROCEDURE mig_062_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN defn TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE ', tbl, ' ADD COLUMN ', col, ' ', defn);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END$$
DELIMITER ;

-- Preferencias personales del usuario (self-service).
CALL mig_062_add_col('users', 'language',  "VARCHAR(8)  NULL");
CALL mig_062_add_col('users', 'timezone',  "VARCHAR(64) NULL");
CALL mig_062_add_col('users', 'ui_prefs',  "TEXT        NULL");   -- JSON de preferencias visuales

-- Metadata de sesión para "Seguridad de mi cuenta".
CALL mig_062_add_col('refresh_tokens', 'ip_address',   "VARCHAR(64)  NULL");
CALL mig_062_add_col('refresh_tokens', 'user_agent',   "VARCHAR(255) NULL");
CALL mig_062_add_col('refresh_tokens', 'last_used_at', "DATETIME     NULL");

DROP PROCEDURE IF EXISTS mig_062_add_col;

SELECT 'Migración 062 aplicada: perfil personal + metadata de sesiones' AS info;
