-- =============================================================
-- Migración 068: catálogo administrable de tipos de pago.
--
-- Reemplaza la lista hardcodeada (mensualizado / jornalero) por una
-- tabla persistente con ABM. Preserva 100% de los valores existentes:
--   1. Crea la tabla `payment_types` (idempotente).
--   2. Inserta las opciones actuales (mensualizado, jornalero) si faltan.
--   3. Migra `employees.pay_type` de ENUM a VARCHAR(40) para permitir
--      códigos nuevos sin ALTER futuro. El default 'mensualizado' se
--      preserva. Todos los valores actuales quedan intactos porque
--      caen dentro del universo de la nueva columna.
--
-- Auditoría: los cambios los registra la ruta /api/payment-types.
-- La eliminación física de un tipo en uso se bloquea desde la API
-- (deactivate en su lugar), por lo que aquí no se agrega FK explícita
-- para no forzar backfill en instalaciones legadas.
-- =============================================================

CREATE TABLE IF NOT EXISTS payment_types (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  code         VARCHAR(40)  NOT NULL,
  name         VARCHAR(120) NOT NULL,
  description  VARCHAR(500) NULL,
  active       TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order   INT          NOT NULL DEFAULT 0,
  created_by   INT          NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payment_types_code (code),
  UNIQUE KEY uq_payment_types_name (name),
  KEY ix_payment_types_active (active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed idempotente de las opciones actuales.
INSERT INTO payment_types (code, name, description, active, sort_order)
SELECT * FROM (
  SELECT 'mensualizado' AS code, 'Mensualizado' AS name,
         'Salario mensual base 30 días (descuenta reposo, ausencias, licencias sin goce y vacaciones)' AS description,
         1 AS active, 10 AS sort_order
) x
WHERE NOT EXISTS (SELECT 1 FROM payment_types p WHERE p.code = 'mensualizado');

INSERT INTO payment_types (code, name, description, active, sort_order)
SELECT * FROM (
  SELECT 'jornalero' AS code, 'Jornalero' AS name,
         'Se informa la cantidad exacta de días trabajados' AS description,
         1 AS active, 20 AS sort_order
) x
WHERE NOT EXISTS (SELECT 1 FROM payment_types p WHERE p.code = 'jornalero');

-- Migrar `employees.pay_type` de ENUM a VARCHAR(40) para admitir códigos
-- nuevos administrados desde la UI. Idempotente: si ya es VARCHAR se salta.
DROP PROCEDURE IF EXISTS mig_068_relax_paytype;
DELIMITER $$
CREATE PROCEDURE mig_068_relax_paytype()
BEGIN
  DECLARE curType VARCHAR(64);
  SELECT DATA_TYPE INTO curType
    FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'employees'
     AND COLUMN_NAME  = 'pay_type'
   LIMIT 1;
  IF curType IS NOT NULL AND curType <> 'varchar' THEN
    ALTER TABLE employees
      MODIFY COLUMN pay_type VARCHAR(40) NOT NULL DEFAULT 'mensualizado';
  END IF;
END$$
DELIMITER ;
CALL mig_068_relax_paytype();
DROP PROCEDURE IF EXISTS mig_068_relax_paytype;

SELECT 'Migración 068 aplicada: payment_types + employees.pay_type VARCHAR(40)' AS info;
