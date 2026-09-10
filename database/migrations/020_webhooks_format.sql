-- Migración 020: webhooks con format (slack/telegram/whatsapp/json) y channel destination
--
-- Autocontenida: en una BD nueva, la tabla `webhooks` todavía no existe (hoy
-- sólo la crea perezosamente la API al bootear, en routes/webhooks.js). Sin
-- este CREATE TABLE, `npm run migrate` abortaba acá con "Table 'webhooks'
-- doesn't exist" y bloqueaba 021→075. Se usa la misma forma que crea la API
-- (ensureWebhookTable) para que ambos caminos terminen en el mismo esquema.
-- Idempotente: IF NOT EXISTS + los ALTER condicionales de más abajo no
-- reaplican columnas ya creadas.

CREATE TABLE IF NOT EXISTS webhooks (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  name        VARCHAR(100) NOT NULL,
  url         VARCHAR(500) NOT NULL,
  secret      VARCHAR(100),
  events      JSON NOT NULL DEFAULT ('["attendance.checkin","attendance.checkout","alert.late"]'),
  active      TINYINT(1) DEFAULT 1,
  last_called DATETIME,
  last_status INT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND COLUMN_NAME = 'format'
);
SET @sql = IF(@col_exists = 0,
  "ALTER TABLE webhooks ADD COLUMN format ENUM('json','slack','telegram','whatsapp','discord') NOT NULL DEFAULT 'json' AFTER events",
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND COLUMN_NAME = 'channel'
);
SET @sql = IF(@col_exists = 0,
  "ALTER TABLE webhooks ADD COLUMN channel VARCHAR(100) NULL AFTER format",
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
