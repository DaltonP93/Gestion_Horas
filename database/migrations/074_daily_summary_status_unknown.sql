-- -------------------------------------------------------------
-- 074_daily_summary_status_unknown.sql
--
-- Extiende el ENUM de `daily_summary.status` para poder representar dos
-- estados que el motor de jornada ya distingue pero el esquema todavía no:
--
--   'non_working'   día de descanso por CONFIGURACIÓN (no por ser sábado o
--                   domingo). Puede caer un martes.
--   'unconfigured'  sin configuración histórica y sin marcajes: NO sabemos si
--                   la persona debía trabajar. NO es ausencia.
--
-- POR QUÉ HACE FALTA
--
-- El ENUM actual es ('present','absent','late','permission','holiday','weekend').
-- Sin estos dos valores, un recálculo se vería forzado a elegir entre marcar
-- 'absent' —fabricando ausencias masivas en 2022-2025, donde no hay horario
-- cargado— o 'weekend' —codificando el fin de semana a mano, que es justo lo
-- que el modelo configurable viene a eliminar—. Ninguna de las dos es honesta.
--
-- ESTADO: PROPUESTA. NO ejecutada en producción. Se entrega junto al motor
-- para que la habilitación del recálculo de daily_summary sea una decisión
-- aparte y revisada. Mientras esta migración no corra, dailySummaryEngine
-- igual EMITE 'non_working'/'unconfigured' para el dry-run y la auditoría; lo
-- único que falta es poder PERSISTIRLOS, y eso sólo importa cuando se habilite
-- la escritura.
--
-- Idempotente: sólo modifica el ENUM si todavía no contiene los valores
-- nuevos, así re-ejecutarla no hace nada. Es puramente aditiva: no toca
-- ninguna fila existente ni cambia el default ('absent').
--
-- ROLLBACK:
--   Volver el ENUM a su forma anterior EXIGE que ninguna fila use los valores
--   nuevos (si no, MySQL las convertiría a ''):
--       UPDATE daily_summary SET status = 'absent'
--        WHERE status IN ('non_working','unconfigured');   -- decisión de datos
--       ALTER TABLE daily_summary MODIFY COLUMN status
--         ENUM('present','absent','late','permission','holiday','weekend')
--         NOT NULL DEFAULT 'absent';
--       DELETE FROM schema_migrations
--        WHERE filename = '074_daily_summary_status_unknown.sql';
--   El UPDATE de arriba PIERDE la distinción que la migración agrega; por eso
--   el rollback es una decisión de negocio, no un paso mecánico.
-- -------------------------------------------------------------

DROP PROCEDURE IF EXISTS mig_074_extend_status;
DELIMITER $$
CREATE PROCEDURE mig_074_extend_status()
BEGIN
  DECLARE tipo_actual LONGTEXT;

  SELECT COLUMN_TYPE INTO tipo_actual
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'daily_summary'
    AND COLUMN_NAME = 'status';

  -- Sólo se toca si falta alguno de los valores nuevos.
  IF tipo_actual IS NOT NULL
     AND (LOCATE('non_working', tipo_actual) = 0 OR LOCATE('unconfigured', tipo_actual) = 0) THEN
    ALTER TABLE daily_summary MODIFY COLUMN status
      ENUM('present','absent','late','permission','holiday','weekend','non_working','unconfigured')
      NOT NULL DEFAULT 'absent';
  END IF;
END$$
DELIMITER ;

CALL mig_074_extend_status();
DROP PROCEDURE IF EXISTS mig_074_extend_status;

SELECT 'Migración 074 (PROPUESTA, aditiva): daily_summary.status admite non_working/unconfigured' AS info;
