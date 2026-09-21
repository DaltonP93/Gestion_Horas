-- =============================================================
-- Migración 085 — Configuración Laboral Histórica y Jerárquica (defaults).
--
-- Agrega los DOS niveles de configuración de jornada que faltaban en la
-- precedencia (el nivel empleado ya existe como `employee_schedule_history`):
--
--   * `workday_config_defaults` — configuración de jornada VERSIONADA por
--     ALCANCE: general (org), empresa (company_id) o departamento
--     (department_id), con vigencia efectiva `valid_from`/`valid_to`. Versionar
--     = crear una fila nueva vigente; NUNCA se sobrescribe el pasado, de modo
--     que la resolución de una fecha histórica es estable (mismo principio que
--     `labor_calendars` 079 y el snapshot de `employee_schedule_history`).
--     `code`/alcance únicos por `valid_from` vía la columna generada
--     `scope_key` = scope:company:department.
--
--   * `workday_config_default_audit` — quién cambió qué y cuándo sobre los
--     defaults (before/after JSON + actor + motivo). El nivel empleado ya audita
--     por la ruta workdayConfiguration; este es el equivalente para defaults.
--
-- PRECEDENCIA (resuelta en código por el ÚNICO resolvedor del motor,
-- workdayConfig.resolveForDate — sin algoritmo paralelo):
--   published shift assignment > employee historical override
--   > department historical default > company/general historical default
--   > employee contract trace > historical_fallback.
--
-- APPEND-ONLY (Corrección I): versionar = crear una fila nueva y CERRAR la
-- anterior (supersedeDefault); la configuración efectiva de una versión es
-- INMUTABLE in-place. El UPDATE del servicio sólo toca metadata (label/motivo).
--
-- COEXISTENCIA / INVARIANTES: esto es CONFIGURACIÓN. No modifica
-- attendance_logs, daily_summary ni att2000, no recalcula histórico y no
-- inventa datos. Aditiva, idempotente, no destructiva, sin backfill. Los
-- escritores viven detrás de WORKDAY_CONFIG_WRITE_ENABLED (fail-closed).
-- =============================================================

CREATE TABLE IF NOT EXISTS workday_config_defaults (
  id                       INT AUTO_INCREMENT PRIMARY KEY,
  scope                    ENUM('general','company','department') NOT NULL,
  company_id               INT          NULL,
  department_id            INT          NULL,
  label                    VARCHAR(120) NULL,
  valid_from               DATE         NOT NULL,
  valid_to                 DATE         NULL,                 -- NULL = vigente
  -- Payload de jornada (paridad con employee_schedule_history 072/073/075).
  check_in                 TIME         NULL,
  check_out                TIME         NULL,
  tolerance_in             INT          NULL,
  tolerance_out            INT          NULL,
  break_mode               ENUM('none','fixed_unpaid','punched') NOT NULL DEFAULT 'punched',
  break_minutes            INT          NOT NULL DEFAULT 0,
  break_after_minutes      INT          NOT NULL DEFAULT 0,
  weekly_target_minutes    INT          NULL,
  daily_target_minutes     INT          NULL,
  work_regime              VARCHAR(40)  NULL,
  overtime_policy          VARCHAR(40)  NULL,
  overtime_policy_version  INT          NULL,
  overtime_policy_config   JSON         NULL,
  rounding_policy          VARCHAR(40)  NULL,
  rounding_policy_version  INT          NULL,
  rounding_policy_config   JSON         NULL,
  night_start              TIME         NULL,
  night_end                TIME         NULL,
  work_days                VARCHAR(20)  NULL,                 -- 1..7 (1=domingo), p.ej. '2,3,4,5,6'
  config_version           SMALLINT     NOT NULL DEFAULT 1,
  change_reason            VARCHAR(255) NULL,
  active                   TINYINT(1)   NOT NULL DEFAULT 1,
  created_by               INT          NULL,
  updated_by               INT          NULL,
  created_at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Clave de alcance determinista (0 = "sin dimensión"): hace la unicidad
  -- por-alcance robusta incluso para el alcance general (general:0:0).
  scope_key                VARCHAR(64)  AS (CONCAT(scope, ':', COALESCE(company_id, 0), ':', COALESCE(department_id, 0))) STORED,
  -- Versionado real: un alcance admite VARIAS versiones por `valid_from`.
  -- La NO superposición de vigencias dentro del alcance se valida en el
  -- servicio (assertNoOverlap), igual que employee_schedule_history.
  UNIQUE KEY uq_wcd_scope_from (scope_key, valid_from),
  KEY ix_wcd_scope (scope_key),
  KEY ix_wcd_company (company_id),
  KEY ix_wcd_department (department_id),
  KEY ix_wcd_valid (valid_from, valid_to),
  CONSTRAINT fk_wcd_company    FOREIGN KEY (company_id)    REFERENCES companies(id)   ON DELETE RESTRICT,
  CONSTRAINT fk_wcd_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE RESTRICT,
  -- Semántica de alcance ÚNICA (Corrección C): la BD y el servicio coinciden.
  --   general    → company_id NULL      y department_id NULL   → general:0:0
  --   company    → company_id NOT NULL  y department_id NULL   → company:<c>:0
  --   department → department_id NOT NULL y company_id NULL     → department:0:<d>
  -- Impide crear un default de departamento con company_id (scope_key
  -- department:<c>:<d>) que el resolvedor jamás consultaría (invisible).
  CONSTRAINT ck_wcd_scope CHECK (
    (scope = 'general'    AND company_id IS NULL     AND department_id IS NULL)
    OR (scope = 'company'    AND company_id IS NOT NULL AND department_id IS NULL)
    OR (scope = 'department' AND department_id IS NOT NULL AND company_id IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lock TRANSACCIONAL por alcance (Corrección K): la serialización entre writers
-- del mismo scope se hace bloqueando la fila correspondiente con
-- `SELECT ... FOR UPDATE`; el row-lock de InnoDB se retiene hasta COMMIT/ROLLBACK
-- (no como GET_LOCK/RELEASE_LOCK, que se soltaba antes del commit). La fila se
-- asegura on-demand con INSERT ... ON DUPLICATE KEY UPDATE.
CREATE TABLE IF NOT EXISTS workday_config_scope_locks (
  scope_key   VARCHAR(64) NOT NULL PRIMARY KEY,
  created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS workday_config_default_audit (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  default_id     INT          NULL,               -- fila afectada (NULL si ya no existe)
  scope          VARCHAR(20)  NULL,
  company_id     INT          NULL,
  department_id  INT          NULL,
  action         VARCHAR(30)  NOT NULL,           -- create | update | close
  actor_id       INT          NULL,
  before_json    JSON         NULL,
  after_json     JSON         NULL,
  change_reason  VARCHAR(255) NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_wcda_default (default_id),
  KEY ix_wcda_scope (scope, company_id, department_id),
  KEY ix_wcda_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
