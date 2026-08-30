-- -------------------------------------------------------------
-- 075_workday_configuration_phase_c.sql
--
-- FASE C — metadata de snapshot histórico + políticas versionadas.
--
-- Esta migración NO modifica attendance_logs, NO backfillea horarios y NO
-- aplica employees.schedule_id hacia atrás. 072/073/074 ya forman parte del
-- historial de main y se tratan como inmutables; este archivo sólo agrega
-- metadata aditiva a employee_schedule_history.
--
-- DECISIÓN DE MODELO
-- ------------------
-- employee_schedule_history sigue siendo el snapshot único de las condiciones
-- de jornada de un empleado durante una vigencia. Horario y perfil de cálculo
-- comparten exactamente el mismo intervalo efectivo, evitando dos historiales
-- que puedan desalinearse. employee_contracts conserva datos administrativos
-- (tipo, salario, prueba, alta/baja) y NO se duplica acá.
--
-- Semántica de vigencia:
--   valid_from INCLUSIVO
--   valid_to   INCLUSIVO
--   valid_to NULL = vigente
--
-- Las columnas *_policy_* no activan ninguna regla por sí solas. Guardan el
-- nombre/versión/configuración de la policy que RR.HH. eligió para el snapshot.
-- WorkdayEngine sólo aplicará una policy cuando exista implementación explícita.
--
-- ESTADO: no ejecutar automáticamente en producción. La aplicación tolera que
-- 072/073/074/075 todavía no existan y cae en historical_fallback.
--
-- ROLLBACK (sólo si 075 fue aplicada y antes de cargar datos dependientes):
--   ALTER TABLE employee_schedule_history
--     DROP COLUMN overtime_policy_config,
--     DROP COLUMN overtime_policy_version,
--     DROP COLUMN rounding_policy_config,
--     DROP COLUMN rounding_policy_version,
--     DROP COLUMN updated_by,
--     DROP COLUMN change_reason,
--     DROP COLUMN snapshot_source,
--     DROP COLUMN snapshot_version,
--     DROP COLUMN schedule_name_snapshot;
-- -------------------------------------------------------------

DROP PROCEDURE IF EXISTS mig_075_add_col;
DELIMITER $$
CREATE PROCEDURE mig_075_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN defn TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE ', tbl, ' ADD COLUMN ', col, ' ', defn);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

CALL mig_075_add_col(
  'employee_schedule_history',
  'schedule_name_snapshot',
  'VARCHAR(120) NULL AFTER schedule_id'
);

CALL mig_075_add_col(
  'employee_schedule_history',
  'snapshot_version',
  'SMALLINT NOT NULL DEFAULT 1 AFTER work_days'
);

CALL mig_075_add_col(
  'employee_schedule_history',
  'snapshot_source',
  "VARCHAR(30) NOT NULL DEFAULT 'manual' AFTER snapshot_version"
);

CALL mig_075_add_col(
  'employee_schedule_history',
  'change_reason',
  'VARCHAR(255) NULL AFTER snapshot_source'
);

CALL mig_075_add_col(
  'employee_schedule_history',
  'updated_by',
  'INT NULL AFTER created_by'
);

CALL mig_075_add_col(
  'employee_schedule_history',
  'rounding_policy_version',
  'INT NULL AFTER rounding_policy'
);

CALL mig_075_add_col(
  'employee_schedule_history',
  'rounding_policy_config',
  'JSON NULL AFTER rounding_policy_version'
);

CALL mig_075_add_col(
  'employee_schedule_history',
  'overtime_policy_version',
  'INT NULL AFTER overtime_policy'
);

CALL mig_075_add_col(
  'employee_schedule_history',
  'overtime_policy_config',
  'JSON NULL AFTER overtime_policy_version'
);

DROP PROCEDURE IF EXISTS mig_075_add_col;

DROP PROCEDURE IF EXISTS mig_075_add_index;
DELIMITER $$
CREATE PROCEDURE mig_075_add_index(IN tbl VARCHAR(64), IN idx VARCHAR(64), IN ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND INDEX_NAME = idx
  ) THEN
    SET @s = CONCAT('ALTER TABLE ', tbl, ' ADD ', ddl);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

CALL mig_075_add_index(
  'employee_schedule_history',
  'idx_esh_emp_validity',
  'INDEX idx_esh_emp_validity (employee_id, valid_from, valid_to)'
);

DROP PROCEDURE IF EXISTS mig_075_add_index;

SELECT 'Migración 075 lista: metadata de snapshot histórico y policies versionadas' AS info;
