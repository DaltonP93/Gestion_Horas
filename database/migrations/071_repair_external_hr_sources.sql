-- -------------------------------------------------------------
-- 071_repair_external_hr_sources.sql
--
-- Repara una DERIVA DE ESQUEMA, no agrega funcionalidad.
--
-- Síntoma en producción:
--     ER_NO_SUCH_TABLE   stage: load_schedules   sqlState: 42S02
--
-- Causa: la tabla `external_hr_sources` la crea la migración 007, pero NO
-- está en `database/init.sql`, que es de donde se construyó la base de
-- producción. El runner de migraciones se adoptó después con
-- `--baseline=<archivo posterior a 007>`, y el baseline marca las migraciones
-- como aplicadas SIN ejecutarlas. Resultado: `schema_migrations` afirma que
-- 007 corrió, la tabla nunca se creó, y volver a correr `migrate` no lo
-- arregla porque 007 ya figura como hecha.
--
-- Por eso hace falta un archivo NUEVO: es el único que el runner va a
-- ejecutar. La estructura es exactamente la de 007 — no se inventó nada.
--
-- Idempotente: CREATE TABLE IF NOT EXISTS. En una base que sí tiene la tabla
-- (creada por 007 en su momento) esta migración no hace nada y no altera
-- ninguna fila existente.
--
-- ROLLBACK:
--   La migración es puramente aditiva. Para revertirla:
--       DROP TABLE IF EXISTS external_hr_sources;
--       DELETE FROM schema_migrations
--        WHERE filename = '071_repair_external_hr_sources.sql';
--   Advertencia: el DROP borra la configuración de las fuentes HR externas.
--   Si el módulo está en uso, exportar la tabla antes. Si nunca se usó (el
--   caso que motiva esta migración), no hay datos que perder.
-- -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS external_hr_sources (
  id              INT PRIMARY KEY AUTO_INCREMENT,
  name            VARCHAR(100) NOT NULL,
  type            ENUM('http_json','http_csv','webhook') NOT NULL DEFAULT 'http_json',

  -- Configuración HTTP
  url             VARCHAR(500) NOT NULL,
  method          ENUM('GET','POST') NOT NULL DEFAULT 'GET',
  headers_json    JSON,
  body_json       JSON,
  auth_type       ENUM('none','bearer','basic','api_key') DEFAULT 'none',
  auth_token      VARCHAR(500),

  -- Parseo / Mapeo
  json_root_path  VARCHAR(100) DEFAULT '',
  field_mapping   JSON NOT NULL,

  -- Scheduler
  schedule_cron   VARCHAR(50),
  enabled         TINYINT(1) DEFAULT 1,

  -- Estado de últimas ejecuciones
  last_run_at     DATETIME NULL,
  last_status     ENUM('success','error','running') NULL,
  last_result     JSON,

  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Índice de 007: loadHrSchedules filtra por enabled.
  INDEX idx_enabled (enabled),

  -- Índice adicional derivado del consumidor real: la consulta de arranque es
  --   WHERE enabled=1 AND schedule_cron IS NOT NULL
  -- y con idx_enabled sola hay que filtrar schedule_cron fila por fila.
  INDEX idx_enabled_schedule (enabled, schedule_cron)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- En una base donde 007 SÍ corrió, la tabla ya existe y el CREATE de arriba
-- no hace nada — incluido el índice nuevo. Se agrega por separado, tolerando
-- que ya esté, para que ambas bases terminen con el mismo esquema.
--
-- El procedimiento lleva el prefijo de la migración a propósito: un nombre
-- genérico como `_add_idx_enabled_schedule` podría existir ya como rutina
-- operativa, y el DROP inicial la borraría sin aviso.
DROP PROCEDURE IF EXISTS mig_071_add_idx_enabled_schedule;
DELIMITER //
CREATE PROCEDURE mig_071_add_idx_enabled_schedule()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = 'external_hr_sources'
       AND INDEX_NAME   = 'idx_enabled_schedule'
  ) THEN
    ALTER TABLE external_hr_sources
      ADD INDEX idx_enabled_schedule (enabled, schedule_cron);
  END IF;
END //
DELIMITER ;
CALL mig_071_add_idx_enabled_schedule();
DROP PROCEDURE IF EXISTS mig_071_add_idx_enabled_schedule;
