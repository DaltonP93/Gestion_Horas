-- =============================================================
-- Migración 079 (FASE F3): calendarios laborales con vigencia efectiva.
--
-- Complementa —sin duplicar— la tabla `holidays` (feriados nacionales, ya
-- existente) con calendarios laborales VERSIONADOS y con alcance opcional por
-- empresa/sucursal, más excepciones puntuales por fecha.
--
--   * `labor_calendars`    — cabecera: código, alcance (company/branch), zona
--     horaria (default America/Asuncion), inicio de semana (0=domingo) y
--     vigencia efectiva (`valid_from`/`valid_to`). Versionar = crear una nueva
--     fila vigente; no se sobreescribe el pasado.
--
--     ALCANCE DEL CÓDIGO (decisión explícita): `code` es único DENTRO de un
--     alcance (global / empresa / sucursal), no global. Así dos empresas o dos
--     sucursales pueden usar el mismo código (p.ej. 'ESTANDAR') sin colisionar,
--     y cada alcance versiona por `valid_from`. Se implementa con una columna
--     generada `scope_key` = COALESCE(company_id,0):COALESCE(branch_id,0) y una
--     UNIQUE(scope_key, code, valid_from). La columna generada mantiene la
--     unicidad incluso para el alcance GLOBAL (0:0), donde dos NULL no colisionan
--     por sí solos en una UNIQUE. El resolutor elige la versión por alcance +
--     fecha con precedencia sucursal > empresa > global.
--   * `calendar_exceptions`— días puntuales del calendario: no laborable,
--     laborable (excepción que habilita un día normalmente de descanso) o
--     especial. UNIQUE(calendar_id, day).
--
-- COEXISTENCIA CON ASISTENCIA: este calendario es CONFIGURACIÓN. No modifica
-- `attendance_logs`, `daily_summary` ni att2000, y no recalcula histórico. El
-- resolutor de calendario efectivo es de sólo lectura.
--
-- COMPATIBILIDAD: aditiva, idempotente, no destructiva, sin backfill. FKs a
-- companies/branches con ON DELETE SET NULL (F1); no requiere que existan filas.
-- =============================================================

CREATE TABLE IF NOT EXISTS labor_calendars (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  code         VARCHAR(40)  NOT NULL,
  name         VARCHAR(200) NOT NULL,
  company_id   INT          NULL,
  branch_id    INT          NULL,
  timezone     VARCHAR(64)  NOT NULL DEFAULT 'America/Asuncion',
  week_start   TINYINT      NOT NULL DEFAULT 0,       -- 0 = domingo
  work_days    VARCHAR(20)  NULL,                     -- días laborables 1..7 (1=domingo), p.ej. '2,3,4,5,6'
  active       TINYINT(1)   NOT NULL DEFAULT 1,
  valid_from   DATE         NOT NULL,
  valid_to     DATE         NULL,                     -- NULL = vigente
  -- Clave de alcance (columna generada, determinista): 0 = "sin dimensión".
  -- Hace la unicidad por-alcance robusta también para el alcance global (0:0).
  scope_key    VARCHAR(41)  AS (CONCAT(COALESCE(company_id, 0), ':', COALESCE(branch_id, 0))) STORED,
  created_by   INT          NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Versionado real + código por ALCANCE: un mismo `code` admite VARIAS
  -- versiones (por `valid_from`) y puede repetirse en OTRO alcance (otra empresa
  -- o sucursal). La unicidad es por (scope_key, code, valid_from), nunca por
  -- `code` a secas. El resolutor elige la versión por alcance + fecha.
  UNIQUE KEY uq_labor_calendars_scope_code_from (scope_key, code, valid_from),
  KEY ix_labor_calendars_code (code),
  KEY ix_labor_calendars_scope (company_id, branch_id),
  KEY ix_labor_calendars_valid (valid_from, valid_to),
  -- ON DELETE RESTRICT (no SET NULL): `company_id`/`branch_id` son columnas base
  -- de la generada `scope_key` indexada; MySQL prohíbe SET NULL/CASCADE sobre la
  -- base de una columna generada indexada. RESTRICT también es la semántica más
  -- segura para configuración: no se orfana un calendario silenciosamente ni se
  -- fusiona su alcance a "global" al borrar la empresa/sucursal — el borrado se
  -- bloquea mientras exista el calendario (F1 desactiva por estado, no borra).
  CONSTRAINT fk_labor_cal_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_labor_cal_branch  FOREIGN KEY (branch_id)  REFERENCES branches(id)  ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS calendar_exceptions (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  calendar_id  INT          NOT NULL,
  day          DATE         NOT NULL,
  kind         ENUM('nonworking','working','special') NOT NULL DEFAULT 'nonworking',
  label        VARCHAR(200) NULL,
  created_by   INT          NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_calendar_exceptions (calendar_id, day),
  KEY ix_calendar_exceptions_day (day),
  CONSTRAINT fk_cal_exc_calendar FOREIGN KEY (calendar_id) REFERENCES labor_calendars(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'Migración 079 aplicada: labor_calendars + calendar_exceptions' AS info;
