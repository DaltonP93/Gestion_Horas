-- =============================================================
-- Migración 038: Índices de performance para cargas de horas
-- (attendance_logs, daily_summary, permissions)
--
-- SOLO cambios aditivos y seguros:
--   * CREATE INDEX únicamente si no existe (verificación vía
--     INFORMATION_SCHEMA, igual que migraciones 009/015/019).
--   * Sin DROPs destructivos. Los índices redundantes detectados
--     se listan comentados al final para revisión manual.
--
-- Requiere MySQL >= 8.0.13 (índices funcionales). La tabla
-- attendance_logs ya usa uno: idx_date ((DATE(timestamp))).
--
-- Uso:
--   mysql asistencia < database/migrations/038_performance_indexes.sql
-- =============================================================

-- Helper idempotente para crear índices
DROP PROCEDURE IF EXISTS mig_038_add_idx;
DELIMITER $$
CREATE PROCEDURE mig_038_add_idx(IN p_table VARCHAR(64), IN p_idx VARCHAR(64), IN p_cols TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = p_table
      AND INDEX_NAME   = p_idx
  ) THEN
    SET @s = CONCAT('CREATE INDEX `', p_idx, '` ON `', p_table, '` (', p_cols, ')');
    PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

-- -------------------------------------------------------------
-- 1) attendance_logs: índice funcional compuesto (empleado, día)
--
-- Acelera todas las consultas "marcajes de UN empleado en UN día":
--   * detectMarkType / recalcDailySummary
--     (api/src/controllers/attendanceController.js:95,111)
--   * subconsulta last_mark (api/src/routes/supervisor.js:40-41)
--   * /api/me/attendance (api/src/routes/me.js:152-153)
--
-- Hoy esas consultas usan DATE(timestamp) = ?, que NO puede usar
-- idx_emp_ts (employee_id, timestamp) por la función sobre la
-- columna; solo puede usar idx_date ((DATE(timestamp))), que barre
-- los marcajes de TODOS los empleados de ese día.
-- Con este índice el acceso pasa a ser ref (employee_id, día) → las
-- ~2-6 filas exactas del empleado en el día.
-- -------------------------------------------------------------
CALL mig_038_add_idx('attendance_logs', 'idx_al_emp_day',
  'employee_id, (DATE(`timestamp`))');

-- -------------------------------------------------------------
-- 2) daily_summary: índice cubriente para agregaciones por rango
--
-- Cubre los reportes/dashboards que agregan por rango de fechas:
--   * /api/reports/monthly       (api/src/routes/reports.js:19-35)
--   * /api/payroll/export        (api/src/routes/payroll.js:30-52)
--   * /api/executive/overview    (api/src/routes/executive.js:27-109)
--   * /api/trends/attendance     (api/src/routes/trends.js:46-61)
--   * alertas diarias            (api/src/services/scheduler.js:422-449)
--
-- Con idx_date (date) actual, MySQL hace range scan + lookup al
-- clustered index por cada fila para leer status/minutos.
-- Este índice es "covering": todo lo que las agregaciones SUM/COUNT
-- necesitan está en el índice → EXPLAIN pasa a "Using index"
-- (index-only scan) y elimina los lookups aleatorios.
-- -------------------------------------------------------------
CALL mig_038_add_idx('daily_summary', 'idx_ds_date_cover',
  '`date`, employee_id, status, worked_minutes, late_minutes, overtime_minutes');

-- -------------------------------------------------------------
-- 3) permissions: bandeja de aprobaciones pendientes
--
--   * /api/supervisor/pending-approvals (api/src/routes/supervisor.js:77-87)
--     WHERE p.status IN (...) ORDER BY p.created_at DESC
--
-- Evita full scan + filesort: range por status y orden ya resuelto
-- por el índice (backward index scan).
-- -------------------------------------------------------------
CALL mig_038_add_idx('permissions', 'idx_perm_status_created',
  'status, created_at');

-- -------------------------------------------------------------
-- 4) daily_summary: fecha + estado (alertas y KPIs del día)
--
--   * WHERE ds.date = CURDATE() AND ds.status = 'late'
--     (api/src/services/scheduler.js:426, notifications.js)
--   * KPIs del dashboard con date = hoy
--
-- Índice pequeño y selectivo; con late_minutes incluido, la alerta
-- de atrasos es index-only.
-- -------------------------------------------------------------
CALL mig_038_add_idx('daily_summary', 'idx_ds_date_status',
  '`date`, status, late_minutes');

DROP PROCEDURE mig_038_add_idx;

-- -------------------------------------------------------------
-- Verificación
-- -------------------------------------------------------------
SELECT
  TABLE_NAME, INDEX_NAME,
  GROUP_CONCAT(COALESCE(COLUMN_NAME, EXPRESSION) ORDER BY SEQ_IN_INDEX) AS cols
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND INDEX_NAME IN ('idx_al_emp_day','idx_ds_date_cover','idx_perm_status_created','idx_ds_date_status')
GROUP BY TABLE_NAME, INDEX_NAME;

-- =============================================================
-- ÍNDICES REDUNDANTES DETECTADOS (revisar y eliminar MANUALMENTE
-- en una ventana de mantenimiento — NO se ejecutan aquí):
--
-- 1. employees.idx_code duplica la clave UNIQUE de employees.code
--    (init.sql:41 y 57):
--    -- ALTER TABLE employees DROP INDEX idx_code;
--
-- 2. attendance_logs.idx_emp_ts (employee_id, timestamp) es prefijo
--    exacto de uq_attendance_punch (employee_id, timestamp, (IFNULL(
--    device_id,0))) creada en la migración 005:
--    -- ALTER TABLE attendance_logs DROP INDEX idx_emp_ts;
--
-- Ambos DROPs son seguros para las consultas (el optimizador usará
-- el índice equivalente), pero se dejan fuera por política de esta
-- migración (solo cambios aditivos).
-- =============================================================
