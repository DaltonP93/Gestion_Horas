-- -------------------------------------------------------------
-- 072_employee_schedule_history.sql
--
-- Vigencia histórica de la configuración de jornada.
--
-- PROBLEMA QUE RESUELVE
--
-- `employees.schedule_id` guarda UN horario, el actual. No tiene fecha: no
-- hay forma de saber qué horario tenía una persona en diciembre de 2024.
-- Cualquier reporte histórico que use esa columna está aplicando el horario
-- de hoy al pasado, y con eso fabrica atrasos que nunca existieron: si a
-- alguien se le cambió el turno de 08:00 a 07:00 en 2026, todo 2024 aparece
-- llegando una hora tarde.
--
-- Esta tabla registra tramos de vigencia. `workdayEngine.resolveEffectiveConfig`
-- busca el tramo que cubre la fecha de la jornada; si ninguno la cubre, la
-- jornada se calcula en modo `historical_fallback` —se describe lo que los
-- marcajes dicen y NO se calcula atraso—, que es la respuesta correcta para un
-- período del que no se sabe qué horario regía.
--
-- QUÉ NO HACE
--
-- No copia `employees.schedule_id` hacia atrás. La tabla nace VACÍA a
-- propósito: llenarla con la asignación actual y una fecha inventada sería
-- exactamente el error que viene a evitar. Se puebla desde la UI, tramo por
-- tramo, con la vigencia que RRHH pueda respaldar.
--
-- No toca ninguna tabla existente ni ninguna fila existente. `employees`,
-- `schedules`, `attendance_logs` y `daily_summary` quedan como están.
--
-- ESTADO: esta migración NO fue ejecutada en producción. Se entrega junto al
-- motor para que la habilitación sea una decisión aparte y revisada.
--
-- Idempotente: CREATE TABLE IF NOT EXISTS.
--
-- ROLLBACK:
--     DROP TABLE IF EXISTS employee_schedule_history;
--     DELETE FROM schema_migrations
--      WHERE filename = '072_employee_schedule_history.sql';
--   Al ser aditiva y nacer vacía, revertirla no puede perder datos previos:
--   sólo se pierde lo que se haya cargado después desde la UI.
-- -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS employee_schedule_history (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  employee_id           INT          NOT NULL,

  -- Horario vigente en el tramo. NULL = el tramo declara explícitamente que
  -- NO había horario configurado, que no es lo mismo que "no hay tramo":
  -- permite dejar constancia de un período sin horario en vez de un hueco.
  schedule_id           INT          NULL,

  valid_from            DATE         NOT NULL,
  valid_to              DATE         NULL,   -- NULL = vigente

  -- Sobreescrituras opcionales del horario para este tramo. NULL = usar lo
  -- que diga `schedules`. Existen porque un cambio de tolerancia o de
  -- descanso no debería obligar a crear un horario nuevo y reasignarlo.
  check_in              TIME         NULL,
  check_out             TIME         NULL,
  tolerance_in          INT          NULL,
  tolerance_out         INT          NULL,

  -- Modo de descanso (ver workdayEngine):
  --   none          no se descuenta nada
  --   fixed_unpaid  se descuenta `break_minutes` si la jornada supera
  --                 `break_after_minutes`
  --   punched       el descanso es el que se marcó entre tramos
  break_mode            ENUM('none','fixed_unpaid','punched') NOT NULL DEFAULT 'punched',
  break_minutes         INT          NOT NULL DEFAULT 0,
  break_after_minutes   INT          NOT NULL DEFAULT 0,

  -- Objetivo semanal EN MINUTOS. Sin valor por defecto con contenido legal:
  -- NULL significa "no hay objetivo definido" y el motor no inventa uno. Las
  -- 48 h paraguayas se cargan como 2880 desde la configuración, igual que
  -- 45, 42, 36, 32, 24 o 20 h, que son jornadas reales del padrón.
  weekly_target_minutes INT          NULL,

  notes                 VARCHAR(255) NULL,
  created_by            INT          NULL,
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Un solo tramo por empleado y fecha de inicio. No impide solapamientos
  -- arbitrarios —eso lo valida la aplicación, que puede dar un mensaje útil—
  -- pero sí impide el duplicado exacto, que es el error de carga frecuente.
  UNIQUE KEY uk_emp_from (employee_id, valid_from),
  INDEX idx_esh_emp_rango (employee_id, valid_from, valid_to),

  CONSTRAINT fk_esh_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  CONSTRAINT fk_esh_schedule FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'Migración 072 aplicada: employee_schedule_history (vacía por diseño)' AS info;
