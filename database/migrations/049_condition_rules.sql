-- =============================================================
-- Migración 049: Constructor de condiciones (motor de reglas).
--
-- Almacena reglas parametrizables "cuando [condiciones] entonces [acción]"
-- definidas por el administrador desde la UI, sin hardcodear lógica. Cada
-- regla pertenece a un módulo (asistencia, hora_extra, permiso, empleado, …),
-- combina condiciones con Y/O (match_type) y dispara una acción.
--
-- Las condiciones y los parámetros de la acción se guardan como JSON. La
-- semántica (campos/operadores/acciones válidos) vive en el registro del
-- servicio api/src/services/ruleEngine.js, que valida antes de persistir.
-- Idempotente.
-- =============================================================

CREATE TABLE IF NOT EXISTS condition_rules (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(160) NOT NULL,
  module        VARCHAR(60)  NOT NULL,
  description   VARCHAR(500) NULL,
  match_type    ENUM('all','any') NOT NULL DEFAULT 'all',
  conditions    JSON NOT NULL,                 -- [{ field, op, value, value2? }]
  action_type   VARCHAR(60)  NOT NULL,
  action_params JSON NULL,                     -- parámetros libres de la acción
  priority      INT NOT NULL DEFAULT 100,      -- menor = se evalúa primero
  active        TINYINT(1) NOT NULL DEFAULT 1,
  created_by    INT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_cr_module_active (module, active),
  INDEX idx_cr_priority (priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'Migración 049 aplicada: condition_rules' AS info;
