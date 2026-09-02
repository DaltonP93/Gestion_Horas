-- =============================================================
-- Migración 077 (FASE F1): correlation id en auditoría.
--
-- Agrega `audit_events.correlation_id` para poder trazar todos los eventos
-- de auditoría generados por una misma request (o cadena de requests) contra
-- el `X-Correlation-Id` que ahora emite la API (middleware requestId).
--
-- COMPATIBILIDAD: aditiva y nuleable. El servicio `audit.js` degrada de forma
-- deliberada si esta migración todavía no está aplicada: detecta la ausencia
-- de la columna (ER_BAD_FIELD_ERROR) y reintenta el INSERT sin ella, de modo
-- que la auditoría nunca se pierde por un esquema parcial.
--
-- Idempotente vía procedimiento (agrega columna + índice sólo si faltan).
-- =============================================================

DROP PROCEDURE IF EXISTS mig_077_apply;
DELIMITER $$
CREATE PROCEDURE mig_077_apply()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_events' AND COLUMN_NAME = 'correlation_id'
  ) THEN
    ALTER TABLE audit_events ADD COLUMN correlation_id VARCHAR(64) NULL AFTER entity_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_events' AND INDEX_NAME = 'ix_audit_correlation'
  ) THEN
    CREATE INDEX ix_audit_correlation ON audit_events(correlation_id);
  END IF;
END$$
DELIMITER ;
CALL mig_077_apply();
DROP PROCEDURE IF EXISTS mig_077_apply;

SELECT 'Migración 077 aplicada: audit_events.correlation_id + ix_audit_correlation' AS info;
