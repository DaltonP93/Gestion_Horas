-- =============================================================
-- Migración 087 — permissions.sla_due_at (reparación hacia adelante).
--
-- La 024 agrega level1_at, level2_at y sla_due_at en un solo ALTER, pero
-- usa `level1_at` como guarda; la 011 ya crea level1_at, así que en una
-- instalación desde cero (init.sql + migraciones) la 024 no agrega
-- sla_due_at y POST /api/permissions falla al insertar.
--
-- La 024 queda INTACTA (historial inmutable). Esta migración agrega sólo la
-- columna faltante, con su propia guarda:
--   · base sin la columna      → la agrega (NULL; sin backfill);
--   · base que ya la tiene     → no hace nada (conserva datos y tipo);
--   · reejecución              → no-op.
-- ADITIVA, IDEMPOTENTE, sin rutinas (no requiere CREATE ROUTINE).
-- =============================================================

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'permissions' AND COLUMN_NAME = 'sla_due_at'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE permissions ADD COLUMN sla_due_at DATETIME NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
