-- -------------------------------------------------------------
-- 083_fase_e_activation_console.sql
--
-- Soporte de esquema para la CONSOLA DE ACTIVACIÓN GUIADA de FASE E.
--
-- Agrega, de forma ADITIVA e IDEMPOTENTE, lo que la consola necesita para
-- activar el motor de jornada de forma REVERSIBLE y con respaldo:
--
--   1. `fase_e_forward_enabled` (system_settings)
--      Segundo cerrojo, en BASE DE DATOS, del escritor "hacia adelante" del
--      motor. El escritor exige AMBOS: el env kill-switch de ops
--      WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED === 'true' Y este setting en
--      'true'. Nace en 'false' (fail-closed): mientras cualquiera de los dos
--      esté apagado, el recálculo operativo conserva su camino LEGACY. La
--      consola sólo hace el flip controlado de este setting; el env sigue siendo
--      el kill-switch de operaciones, reversible sin reiniciar el proceso.
--
--   2. `daily_summary_recalc_batch`
--      Cabecera de cada LOTE de recálculo histórico ACOTADO ejecutado desde la
--      consola (rango + alcance por departamento/empleado). Da trazabilidad
--      (batch_id, quién, cuándo, cuántas filas) y permite el RESTORE.
--
--   3. `daily_summary_backup`
--      RESPALDO fila por fila del estado PREVIO de daily_summary, tomado ANTES
--      de sobrescribir cualquier fila en un recálculo. Es lo que hace el
--      recálculo REVERSIBLE: RESTORE por batch_id repone el valor original
--      (o BORRA la fila si el recálculo la había creado, existed = 0).
--
-- POR QUÉ ES SEGURA
--
-- - Puramente aditiva: crea tablas nuevas y una fila de setting; no toca ni una
--   fila de daily_summary, attendance_logs ni ninguna tabla existente.
-- - Idempotente: CREATE TABLE IF NOT EXISTS + INSERT IGNORE. Re-ejecutarla no
--   hace nada.
-- - No conoce ATT2000: no la referencia de ninguna forma.
--
-- ESTADO: PROPUESTA. NO ejecutada en producción. Se aplica como paso de OPS
-- (scripts/ops-migrate.sh, usuario admin de MySQL por socket) — NO desde la
-- consola de FASE E: la consola ya NO aplica migraciones por HTTP y el runtime de
-- la API no tiene CREATE ROUTINE/TRIGGER. OPS corre el runner acotado con
-- `--upto=083_fase_e_activation_console.sql` (hasta 083, sin arrastrar futuras),
-- con backup previo (ver deploy/RUNBOOK-migraciones-fase-e-ops.md). Activar el
-- writer es OTRO paso (flags), no esta migración.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS fase_e_console_lock;
--   DROP TABLE IF EXISTS daily_summary_backup;
--   DROP TABLE IF EXISTS daily_summary_recalc_batch;
--   DELETE FROM system_settings WHERE key_name = 'fase_e_forward_enabled';
--   DELETE FROM schema_migrations
--    WHERE filename = '083_fase_e_activation_console.sql';
--   Al nacer vacías y ser aditivas, revertirlas no puede perder datos previos
--   de daily_summary (el respaldo es una COPIA; el original nunca se movió).
-- -------------------------------------------------------------

-- 1. Segundo cerrojo (BD) del escritor hacia adelante. Fail-closed en 'false'.
--    system_settings existe desde la migración 033 (key_name/value genérico).
INSERT IGNORE INTO system_settings (key_name, value)
VALUES ('fase_e_forward_enabled', 'false');

-- 2. Cabecera de lote de recálculo histórico acotado.
CREATE TABLE IF NOT EXISTS daily_summary_recalc_batch (
  batch_id       CHAR(36)     NOT NULL PRIMARY KEY,   -- UUID generado por la app
  from_date      DATE         NOT NULL,
  to_date        DATE         NOT NULL,
  scope_kind     ENUM('all','department','employee') NOT NULL DEFAULT 'all',
  scope_id       INT          NULL,                   -- department_id o employee_id según scope_kind
  -- Máquina de estados del lote. NUNCA se marca 'applied' antes de que el motor
  -- termine; un fallo intermedio deja 'failed' (con el respaldo completo, para
  -- que el RESTORE deshaga lo parcial). El RESTORE es TRANSACCIONAL (todo o nada)
  -- y REINTENTABLE: sólo llega a 'restored' al commitear; un fallo parcial hace
  -- rollback y el lote queda restaurable (no se persiste 'restoring').
  status         ENUM('prepared','applying','applied','failed','restoring','restored')
                 NOT NULL DEFAULT 'prepared',
  employees      INT          NOT NULL DEFAULT 0,     -- empleados en alcance
  rows_backed_up INT          NOT NULL DEFAULT 0,     -- filas respaldadas antes de escribir
  -- Conteos INEQUÍVOCOS del efecto real sobre daily_summary (no un length):
  cells_processed INT         NOT NULL DEFAULT 0,     -- celdas del plan aplicadas
  rows_inserted  INT          NOT NULL DEFAULT 0,     -- filas nuevas creadas
  rows_updated   INT          NOT NULL DEFAULT 0,     -- filas existentes que cambiaron
  rows_deleted   INT          NOT NULL DEFAULT 0,     -- filas borradas (reconcile)
  rows_unchanged INT          NOT NULL DEFAULT 0,     -- celdas cuyo resultado no mutó nada
  rows_written   INT          NOT NULL DEFAULT 0,     -- compat: inserted+updated+deleted (mutaciones reales)
  plan_digest    CHAR(64)     NULL,                   -- sha256 del plan validado (paridad dry-run/apply)
  created_by     INT          NULL,                   -- user_id que ejecutó el recálculo
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  restored_by    INT          NULL,
  restored_at    DATETIME     NULL,
  INDEX idx_status     (status),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Respaldo fila-por-fila del estado PREVIO, para el RESTORE reversible.
--    Guarda las columnas MUTABLES que el escritor del motor puede cambiar más
--    un marcador `existed` (0 = no había fila: el recálculo la creó y el RESTORE
--    la borra) y un `row_json` forense con la fila completa original.
CREATE TABLE IF NOT EXISTS daily_summary_backup (
  id               BIGINT       NOT NULL PRIMARY KEY AUTO_INCREMENT,
  batch_id         CHAR(36)     NOT NULL,
  employee_id      INT          NOT NULL,
  date             DATE         NOT NULL,
  existed          TINYINT(1)   NOT NULL DEFAULT 1,
  first_in         DATETIME     NULL,
  last_out         DATETIME     NULL,
  worked_minutes   INT          NULL,
  break_minutes    INT          NULL,
  late_minutes     INT          NULL,
  overtime_minutes INT          NULL,
  status           VARCHAR(32)  NULL,
  notes            TEXT         NULL,
  row_json         JSON         NULL,
  -- Estado que el recálculo ESCRIBIÓ en esta celda (los 8 campos efectivos, o
  -- NULL si la borró). Permite que el RESTORE detecte un cambio LEGÍTIMO
  -- concurrente posterior al apply: si la fila actual ya no coincide con lo que
  -- escribimos, el restore la SALTA (no pisa el cambio ajeno) en vez de revertir.
  applied_json     JSON         NULL,
  backed_up_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Una sola fila de respaldo por celda dentro de un lote: hace el backup
  -- idempotente y evita huérfanos duplicados si un INSERT se reintenta.
  UNIQUE KEY uq_batch_cell (batch_id, employee_id, date),
  INDEX idx_batch       (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. Lock ÚNICO de operaciones mutantes de la consola, CON PROPIEDAD.
--    Exclusión mutua con token + lease: quien toma el lock genera un lock_token
--    propio; SÓLO con ese token se renueva (heartbeat) o se libera. Así una
--    operación vieja NUNCA libera el lock de otra. El lease auto-recupera si un
--    proceso murió (se puede re-tomar cuando lease_expires_at < NOW()). El
--    heartbeat renueva el lease para operaciones más largas que el lease inicial.
CREATE TABLE IF NOT EXISTS fase_e_console_lock (
  id               TINYINT     NOT NULL PRIMARY KEY,    -- fila única (1)
  lock_token       CHAR(36)    NULL,                    -- NULL = libre; UUID del dueño actual
  operation        VARCHAR(32) NULL,                    -- 'recalc' | 'restore'
  held_by          INT         NULL,                    -- user_id que la tomó
  acquired_at      DATETIME    NULL,
  lease_expires_at DATETIME    NULL,                    -- el lock es re-tomable si esto < NOW()
  -- Contador monótono que el heartbeat SIEMPRE incrementa. Hace que la fila
  -- CAMBIE cuando el WHERE (id + lock_token) machea, así affectedRows distingue
  -- MATCHED (renovado, >=1) de LOST (token robado, 0) sin falsos negativos cuando
  -- el heartbeat cae en el mismo segundo (lease_expires_at idéntico).
  heartbeat_seq    BIGINT      NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO fase_e_console_lock (id, lock_token) VALUES (1, NULL);

SELECT 'Migración 083 (PROPUESTA, aditiva): consola FASE E — fase_e_forward_enabled + respaldo/lotes de recálculo + lock' AS info;
