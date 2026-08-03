-- =============================================================
-- Migración 069: catálogo administrable de cargos.
--
-- `employees.position` es texto libre VARCHAR(100). Escrito a mano en
-- cada alta, terminó con variantes del mismo cargo ("Operario",
-- "operario", "Operario ") que rompen cualquier agrupación por cargo.
--
-- Esta migración crea el catálogo y lo SIEMBRA con los cargos que ya
-- existen, de modo que ninguna ficha queda con un valor huérfano:
--   1. Crea `job_titles` (idempotente).
--   2. Inserta un cargo por cada `position` distinto no vacío.
--
-- Decisión importante: `employees.position` NO se toca. Sigue guardando
-- el nombre del cargo como texto, así que reportes, exportaciones y la
-- planilla MTESS —que leen `e.position` directamente— siguen andando sin
-- cambios. El catálogo gobierna qué se puede ELEGIR de acá en adelante;
-- no reescribe el histórico. Por eso la clave natural es `name` y no un
-- `code` separado: el nombre ES lo que la columna almacena.
--
-- El seed normaliza espacios (TRIM) pero respeta may/min tal como están:
-- decidir que "operario" y "Operario" son el mismo cargo es una fusión
-- de datos, y eso lo hace una persona desde el ABM, no una migración.
-- La UNIQUE de `name` es case-insensitive por el collation utf8mb4_unicode_ci,
-- así que de las variantes que sólo difieren en mayúsculas entra una sola.
--
-- Auditoría: los cambios los registra la ruta /api/job-titles.
-- =============================================================

CREATE TABLE IF NOT EXISTS job_titles (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  description  VARCHAR(500) NULL,
  active       TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order   INT          NOT NULL DEFAULT 0,
  created_by   INT          NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_job_titles_name (name),
  KEY ix_job_titles_active (active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed desde los cargos ya cargados. INSERT IGNORE + UNIQUE(name) lo hace
-- idempotente y descarta de una las variantes que sólo difieren en
-- mayúsculas o acentos (collation _unicode_ci).
INSERT IGNORE INTO job_titles (name, description, active, sort_order)
SELECT TRIM(e.position), 'Importado del texto libre de las fichas existentes', 1, 0
  FROM employees e
 WHERE e.position IS NOT NULL
   AND TRIM(e.position) <> ''
   AND CHAR_LENGTH(TRIM(e.position)) <= 100;

SELECT CONCAT('Migración 069 aplicada: job_titles con ',
              (SELECT COUNT(*) FROM job_titles), ' cargo(s) sembrado(s)') AS info;
