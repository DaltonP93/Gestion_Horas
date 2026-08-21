-- -------------------------------------------------------------
-- 073_workday_profile_and_overlap_guard.sql
--
-- Completa `employee_schedule_history` (migración 072) con el perfil laboral
-- y le agrega una guarda de solapamientos.
--
-- ═════════════════════════════════════════════════════════════════
-- DECISIÓN DE MODELO — por qué acá y no en una tabla nueva
-- ═════════════════════════════════════════════════════════════════
--
-- La alternativa era crear `employee_work_profile_history` aparte. Se
-- descartó: tendría exactamente la misma clave (empleado + vigencia) y el
-- mismo ciclo de vida que `employee_schedule_history`, así que serían dos
-- tablas que hay que mantener alineadas, con dos juegos de tramos que pueden
-- desalinearse entre sí y dos lugares donde validar solapamientos. El motor
-- terminaría resolviendo dos vigencias distintas para la misma fecha y
-- tendría que decidir qué hacer cuando no coinciden — un problema inventado.
--
-- Un tramo de vigencia describe "bajo qué condiciones trabajaba esta persona
-- en este período". El horario y la carga contractual son atributos de esa
-- misma respuesta, no de dos respuestas distintas.
--
-- Lo que NO se duplica acá:
--
--   `shift_assignments`   la excepción por fecha (Turnera) sigue siendo suya;
--                         gana sobre esta tabla, no se copia a ella.
--   `employee_contracts`  la relación laboral (alta, baja, salario, prueba)
--                         sigue siendo suya. Acá va sólo la carga horaria, que
--                         es lo que el cálculo de jornada necesita.
--   `shift_schedules`     conserva su `weekly_target_minutes` por turnera.
--
-- ═════════════════════════════════════════════════════════════════
-- PRECEDENCIA QUE IMPLEMENTA EL MOTOR
-- ═════════════════════════════════════════════════════════════════
--
--   1. `shift_assignments` de una turnera PUBLICADA para esa fecha exacta.
--   2. `employee_schedule_history` vigente para esa fecha.
--   3. `employee_contracts` vigente (sólo aporta la carga horaria).
--   4. `historical_fallback` — sin configuración, se describen los marcajes.
--
-- `employees.schedule_id` NO entra en la cadena. Guarda el horario de HOY y no
-- tiene fecha; usarlo para el pasado es lo que fabrica atrasos retroactivos.
--
-- ESTADO: NO ejecutada en producción.
--
-- Idempotente. Aditiva: no altera ninguna fila existente y la tabla que
-- modifica nació vacía en la 072.
--
-- ROLLBACK:
--     DROP TRIGGER IF EXISTS trg_esh_no_overlap_ins;
--     DROP TRIGGER IF EXISTS trg_esh_no_overlap_upd;
--     ALTER TABLE employee_schedule_history
--       DROP COLUMN daily_target_minutes,
--       DROP COLUMN work_regime,
--       DROP COLUMN overtime_policy,
--       DROP COLUMN rounding_policy,
--       DROP COLUMN night_start,
--       DROP COLUMN night_end;
--     DELETE FROM schema_migrations
--      WHERE filename = '073_workday_profile_and_overlap_guard.sql';
-- -------------------------------------------------------------

DROP PROCEDURE IF EXISTS mig_073_add_col;
DELIMITER $$
CREATE PROCEDURE mig_073_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN defn TEXT)
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

-- Objetivo DIARIO en minutos. Separado del semanal porque no siempre se deduce
-- uno del otro: 42 h semanales pueden repartirse 7×6 o 5×8+2, y el exceso
-- diario depende de cuál de las dos rige.
CALL mig_073_add_col('employee_schedule_history', 'daily_target_minutes', 'INT NULL AFTER weekly_target_minutes');

-- Régimen laboral: etiqueta CONCEPTUAL, deliberadamente libre.
--
-- No se modela como ENUM ni se deriva de las horas. Que alguien trabaje 36 h
-- no determina por sí solo su régimen ni su liquidación, y codificar esa
-- inferencia acá la volvería invisible y difícil de corregir.
CALL mig_073_add_col('employee_schedule_history', 'work_regime', 'VARCHAR(40) NULL AFTER daily_target_minutes');

-- Políticas nombradas. NULL = sin política definida, y el motor entonces
-- mide el exceso sobre el objetivo pero no lo valoriza como hora extra.
CALL mig_073_add_col('employee_schedule_history', 'overtime_policy', 'VARCHAR(40) NULL AFTER work_regime');
CALL mig_073_add_col('employee_schedule_history', 'rounding_policy', 'VARCHAR(40) NULL AFTER overtime_policy');

-- Franja nocturna. NULL = no hay franja definida y night_minutes sale 0.
-- Sin valor por defecto a propósito: el horario nocturno y su recargo son
-- materia legal y de convenio.
CALL mig_073_add_col('employee_schedule_history', 'night_start', 'TIME NULL AFTER rounding_policy');
CALL mig_073_add_col('employee_schedule_history', 'night_end',   'TIME NULL AFTER night_start');

DROP PROCEDURE IF EXISTS mig_073_add_col;

-- -------------------------------------------------------------
-- Guarda de solapamientos
--
-- La UNIQUE de la 072 impide el duplicado exacto de `valid_from`, pero no dos
-- tramos que se pisan: 2024-01-01→2024-12-31 y 2024-06-01→NULL conviven sin
-- protestar, y entonces "qué configuración regía el 2024-08-01" tiene dos
-- respuestas. El motor resolvería una de las dos en silencio.
--
-- MySQL no admite subconsultas en CHECK, así que la validación va en triggers.
-- Se rechaza con SIGNAL, que llega a la aplicación como un error de base
-- legible en vez de como una fila aceptada que rompe el cálculo más adelante.
--
-- Criterio de solapamiento, con `valid_to` NULL = vigente (infinito):
--     nuevo.from <= existente.to   Y   existente.from <= nuevo.to
-- -------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_esh_no_overlap_ins;
DROP TRIGGER IF EXISTS trg_esh_no_overlap_upd;

DELIMITER $$

CREATE TRIGGER trg_esh_no_overlap_ins
BEFORE INSERT ON employee_schedule_history
FOR EACH ROW
BEGIN
  IF NEW.valid_to IS NOT NULL AND NEW.valid_to < NEW.valid_from THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'employee_schedule_history: valid_to no puede ser anterior a valid_from';
  END IF;

  IF EXISTS (
    SELECT 1 FROM employee_schedule_history h
    WHERE h.employee_id = NEW.employee_id
      AND NEW.valid_from <= IFNULL(h.valid_to,   '9999-12-31')
      AND h.valid_from   <= IFNULL(NEW.valid_to, '9999-12-31')
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'employee_schedule_history: el tramo se solapa con otro ya cargado para el mismo empleado';
  END IF;
END$$

CREATE TRIGGER trg_esh_no_overlap_upd
BEFORE UPDATE ON employee_schedule_history
FOR EACH ROW
BEGIN
  IF NEW.valid_to IS NOT NULL AND NEW.valid_to < NEW.valid_from THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'employee_schedule_history: valid_to no puede ser anterior a valid_from';
  END IF;

  -- `h.id <> NEW.id` es lo que permite editar un tramo sin que choque consigo
  -- mismo; sin esa condición ninguna edición pasaría.
  IF EXISTS (
    SELECT 1 FROM employee_schedule_history h
    WHERE h.employee_id = NEW.employee_id
      AND h.id <> NEW.id
      AND NEW.valid_from <= IFNULL(h.valid_to,   '9999-12-31')
      AND h.valid_from   <= IFNULL(NEW.valid_to, '9999-12-31')
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'employee_schedule_history: el tramo se solapa con otro ya cargado para el mismo empleado';
  END IF;
END$$

DELIMITER ;

SELECT 'Migración 073 aplicada: perfil laboral + guarda de solapamientos' AS info;
