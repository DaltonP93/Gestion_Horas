-- =============================================================
-- Migración 082: metadatos de firma PAdES del reporte mensual.
--
-- FASE 2 — Extiende monthly_report_approvals (migración 081, misma cadena)
-- con DOS columnas NULLABLES para registrar, cuando aplique, que el documento
-- se firmó con PAdES vía los servicios locales (html2pdf + pades-signer):
--
--   signature_provider  etiqueta NO-PII del proveedor de firma
--                       (p.ej. 'pades-local'); NULL mientras no se firme PAdES.
--   signed_pades_at      momento en que se generó el PDF firmado PAdES.
--
-- Por qué una migración nueva y no editar la 081: 081 crea la tabla con
-- CREATE TABLE IF NOT EXISTS, que en una BD donde la tabla YA existe es un
-- no-op y NO agregaría estas columnas. Un ALTER idempotente aparte sí las
-- agrega tanto en instalaciones nuevas como existentes.
--
-- ADITIVA y NO destructiva: columnas nullables, sin default que reescriba
-- filas, sin tocar datos existentes. No toca att2000, attendance_logs ni
-- daily_summary. SIN PII: sólo una etiqueta de proveedor y un timestamp.
--
-- Fail-closed: estas columnas se llenan SÓLO cuando la firma PAdES se aplicó
-- de verdad; nunca se marca "firmado PAdES" si no se pudo firmar.
--
-- Idempotente (patrón de procedimiento almacenado + INFORMATION_SCHEMA).
--
-- ROLLBACK:
--     ALTER TABLE monthly_report_approvals
--       DROP COLUMN signed_pades_at,
--       DROP COLUMN signature_provider;
--     DELETE FROM schema_migrations
--      WHERE filename = '082_monthly_report_pades_metadata.sql';
-- =============================================================

DROP PROCEDURE IF EXISTS mig_082_add_col;
DELIMITER $$
CREATE PROCEDURE mig_082_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN defn TEXT)
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

CALL mig_082_add_col('monthly_report_approvals', 'signature_provider', 'VARCHAR(64) NULL AFTER integrity_hash');
CALL mig_082_add_col('monthly_report_approvals', 'signed_pades_at',    'DATETIME NULL AFTER signature_provider');

DROP PROCEDURE IF EXISTS mig_082_add_col;

SELECT 'Migración 082 aplicada: monthly_report_approvals.signature_provider + signed_pades_at' AS info;
