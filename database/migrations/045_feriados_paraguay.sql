-- =============================================================
-- Migración 045: feriados nacionales de Paraguay (2025–2027).
--
-- init.sql sembraba feriados genéricos (México/Guatemala). Acá se cargan
-- los feriados nacionales paraguayos. INSERT IGNORE respeta la clave única
-- por fecha: no pisa ni duplica los que ya existan.
--
-- Fijos: Año Nuevo, Héroes (1 mar), Trabajador (1 may), Independencia
-- (14 y 15 may), Paz del Chaco (12 jun), Fundación de Asunción (15 ago),
-- Victoria de Boquerón (29 sep), Virgen de Caacupé (8 dic), Navidad.
-- Móviles: Jueves y Viernes Santo (según Pascua de cada año).
-- Idempotente.
-- =============================================================

-- Eliminar los feriados genéricos que sembró init.sql (México/Guatemala) y
-- que NO son feriados de Paraguay, para que los cálculos no traten esas
-- fechas como no laborables. Se borran sólo por (name,date) exactos del seed,
-- sin tocar feriados cargados por el usuario. Los que coinciden con una fecha
-- PY (Año Nuevo, Navidad…) se recrean abajo con el nombre correcto.
DELETE FROM holidays WHERE (name = 'Año Nuevo'         AND date = '2026-01-01')
                        OR (name = 'Día del Trabajo'   AND date = '2026-05-01')
                        OR (name = 'Independencia'      AND date = '2026-09-15')
                        OR (name = 'Navidad'            AND date = '2026-12-25');

INSERT IGNORE INTO holidays (name, date, type) VALUES
  -- 2025
  ('Año Nuevo',                    '2025-01-01', 'national'),
  ('Día de los Héroes',            '2025-03-01', 'national'),
  ('Jueves Santo',                 '2025-04-17', 'national'),
  ('Viernes Santo',                '2025-04-18', 'national'),
  ('Día del Trabajador',           '2025-05-01', 'national'),
  ('Independencia Nacional',       '2025-05-14', 'national'),
  ('Independencia Nacional',       '2025-05-15', 'national'),
  ('Paz del Chaco',                '2025-06-12', 'national'),
  ('Fundación de Asunción',        '2025-08-15', 'national'),
  ('Victoria de Boquerón',         '2025-09-29', 'national'),
  ('Virgen de Caacupé',            '2025-12-08', 'national'),
  ('Navidad',                      '2025-12-25', 'national'),
  -- 2026
  ('Año Nuevo',                    '2026-01-01', 'national'),
  ('Día de los Héroes',            '2026-03-01', 'national'),
  ('Jueves Santo',                 '2026-04-02', 'national'),
  ('Viernes Santo',                '2026-04-03', 'national'),
  ('Día del Trabajador',           '2026-05-01', 'national'),
  ('Independencia Nacional',       '2026-05-14', 'national'),
  ('Independencia Nacional',       '2026-05-15', 'national'),
  ('Paz del Chaco',                '2026-06-12', 'national'),
  ('Fundación de Asunción',        '2026-08-15', 'national'),
  ('Victoria de Boquerón',         '2026-09-29', 'national'),
  ('Virgen de Caacupé',            '2026-12-08', 'national'),
  ('Navidad',                      '2026-12-25', 'national'),
  -- 2027
  ('Año Nuevo',                    '2027-01-01', 'national'),
  ('Día de los Héroes',            '2027-03-01', 'national'),
  ('Jueves Santo',                 '2027-03-25', 'national'),
  ('Viernes Santo',                '2027-03-26', 'national'),
  ('Día del Trabajador',           '2027-05-01', 'national'),
  ('Independencia Nacional',       '2027-05-14', 'national'),
  ('Independencia Nacional',       '2027-05-15', 'national'),
  ('Paz del Chaco',                '2027-06-12', 'national'),
  ('Fundación de Asunción',        '2027-08-15', 'national'),
  ('Victoria de Boquerón',         '2027-09-29', 'national'),
  ('Virgen de Caacupé',            '2027-12-08', 'national'),
  ('Navidad',                      '2027-12-25', 'national');

SELECT 'Migración 045 aplicada: feriados nacionales Paraguay 2025-2027' AS info;
