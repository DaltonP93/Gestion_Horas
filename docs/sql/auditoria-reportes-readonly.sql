-- =====================================================================
-- Auditoría de reportes — consultas SOLO LECTURA
--
-- Ninguna sentencia de este archivo modifica datos. No hay UPDATE,
-- INSERT, DELETE ni DDL. Se puede ejecutar en producción.
--
-- Sugerido: conectarse con un usuario de sólo lectura y ejecutar por
-- bloques, guardando la salida de cada uno.
--
--   mysql -h "$DB_HOST" -u "$DB_USER" -p "$DB_NAME" \
--     --table < docs/sql/auditoria-reportes-readonly.sql > auditoria.txt
--
-- Los bloques Q1..Q4 responden "¿el error está en los datos o sólo en
-- la presentación?". Los Q5..Q8 dimensionan el 502.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Q0. Contexto del servidor
--
-- `timestamp` es DATETIME (sin zona): MySQL lo guarda literal.
-- `created_at` es TIMESTAMP: MySQL lo guarda en UTC y lo convierte con
-- la zona de sesión. Esa diferencia es la palanca de todo el análisis.
-- ---------------------------------------------------------------------
SELECT
  @@global.time_zone   AS tz_global,
  @@session.time_zone  AS tz_sesion,
  NOW()                AS now_sesion,
  UTC_TIMESTAMP()      AS now_utc,
  VERSION()            AS version;


-- ---------------------------------------------------------------------
-- Q1. ★ CORTE REAL Y OFFSET APLICADO, deducido de los propios datos
--
-- Para marcajes insertados en tiempo casi real (device), `created_at`
-- es el instante real de inserción y `timestamp` la hora de pared que
-- se guardó. La diferencia entre ambos ES el offset que el sistema
-- estaba aplicando en ese momento.
--
-- Se excluyen backfills/imports: sólo filas insertadas dentro de las
-- 24 h del marcaje.
--
-- Cómo leerlo:
--   diff ~ +180 min  → se aplicó UTC-3
--   diff ~ +240 min  → se aplicó UTC-4
-- El mes donde `diff_min_moda` cambia de valor es el CORTE REAL.
-- Si el offset aplicado es constante (siempre 180) mientras la zona
-- real de Paraguay cambiaba, el desfase histórico es de 1 hora en
-- invierno, NO de 3.
-- ---------------------------------------------------------------------
SELECT
  DATE_FORMAT(al.`timestamp`, '%Y-%m')                        AS mes,
  al.source,
  COUNT(*)                                                    AS filas,
  MIN(TIMESTAMPDIFF(MINUTE, al.`timestamp`, al.created_at))   AS diff_min_min,
  ROUND(AVG(TIMESTAMPDIFF(MINUTE, al.`timestamp`, al.created_at))) AS diff_min_prom,
  MAX(TIMESTAMPDIFF(MINUTE, al.`timestamp`, al.created_at))   AS diff_min_max
FROM attendance_logs al
WHERE al.created_at IS NOT NULL
  AND ABS(TIMESTAMPDIFF(HOUR, al.`timestamp`, al.created_at)) <= 24
GROUP BY mes, al.source
ORDER BY mes, al.source;


-- ---------------------------------------------------------------------
-- Q2. Distribución de orígenes por mes
--
-- Sirve para saber QUÉ pobló cada período: marcajes en vivo del reloj,
-- carga manual, móvil, o un import histórico desde ATT2000.
-- Un período dominado por un origen distinto se corrigió distinto.
-- ---------------------------------------------------------------------
SELECT
  DATE_FORMAT(al.`timestamp`, '%Y-%m') AS mes,
  al.source,
  COUNT(*)                             AS filas,
  COUNT(DISTINCT al.employee_id)       AS empleados,
  COUNT(DISTINCT al.device_id)         AS dispositivos,
  MIN(al.`timestamp`)                  AS primer_marcaje,
  MAX(al.`timestamp`)                  AS ultimo_marcaje
FROM attendance_logs al
GROUP BY mes, al.source
ORDER BY mes, al.source;


-- ---------------------------------------------------------------------
-- Q3. ★ MISMO EMPLEADO, ANTES Y DESPUÉS DEL CORTE
--
-- Reemplazar :CODE por el código de un empleado con historia larga y
-- horario estable (idealmente uno con entrada fija, p. ej. 07:00).
--
-- Se piden cuatro ventanas deliberadamente elegidas:
--   A) invierno 2024  → Paraguay estaba en UTC-4 (DST off)
--   B) verano 2024/25 → Paraguay en UTC-3
--   C) invierno 2025  → Paraguay YA en UTC-3 permanente
--   D) reciente       → control, sabido correcto
--
-- Si la hora de entrada típica se corre 1 hora SÓLO en la ventana A,
-- el problema es la conversión de zona, y el desfase es de 1 h, no 3.
-- ---------------------------------------------------------------------
SELECT
  'A invierno-2024 (PY estaba UTC-4)' AS ventana,
  COUNT(*)                            AS marcajes,
  MIN(TIME(al.`timestamp`))           AS hora_min,
  ROUND(AVG(HOUR(al.`timestamp`) * 60 + MINUTE(al.`timestamp`))) AS minuto_prom_del_dia,
  MAX(TIME(al.`timestamp`))           AS hora_max
FROM attendance_logs al
JOIN employees e ON e.id = al.employee_id
WHERE e.code = :CODE
  AND al.type = 'in'
  AND al.`timestamp` >= '2024-05-01' AND al.`timestamp` < '2024-09-01'
UNION ALL
SELECT 'B verano-2024/25 (PY UTC-3)', COUNT(*), MIN(TIME(al.`timestamp`)),
       ROUND(AVG(HOUR(al.`timestamp`) * 60 + MINUTE(al.`timestamp`))), MAX(TIME(al.`timestamp`))
FROM attendance_logs al JOIN employees e ON e.id = al.employee_id
WHERE e.code = :CODE AND al.type = 'in'
  AND al.`timestamp` >= '2024-11-01' AND al.`timestamp` < '2025-03-01'
UNION ALL
SELECT 'C invierno-2025 (PY ya UTC-3 fijo)', COUNT(*), MIN(TIME(al.`timestamp`)),
       ROUND(AVG(HOUR(al.`timestamp`) * 60 + MINUTE(al.`timestamp`))), MAX(TIME(al.`timestamp`))
FROM attendance_logs al JOIN employees e ON e.id = al.employee_id
WHERE e.code = :CODE AND al.type = 'in'
  AND al.`timestamp` >= '2025-05-01' AND al.`timestamp` < '2025-09-01'
UNION ALL
SELECT 'D reciente (control)', COUNT(*), MIN(TIME(al.`timestamp`)),
       ROUND(AVG(HOUR(al.`timestamp`) * 60 + MINUTE(al.`timestamp`))), MAX(TIME(al.`timestamp`))
FROM attendance_logs al JOIN employees e ON e.id = al.employee_id
WHERE e.code = :CODE AND al.type = 'in'
  AND al.`timestamp` >= DATE_SUB(CURDATE(), INTERVAL 60 DAY);


-- ---------------------------------------------------------------------
-- Q4. ★ ¿daily_summary HEREDÓ EL ERROR?
--
-- Compara, para el mismo empleado y día, la primera entrada que está
-- guardada en daily_summary contra la que se deduce de attendance_logs.
--
-- Si delta_min = 0 siempre → daily_summary es consistente con los logs
--   (y entonces el error, si existe, es de presentación o está en los
--   logs mismos, no en el resumen).
-- Si delta_min ≠ 0 en períodos históricos → daily_summary CONGELÓ un
--   valor calculado con la conversión vieja y tiene error propio.
--   Ese caso exige recálculo, no sólo un fix de presentación.
-- ---------------------------------------------------------------------
SELECT
  DATE_FORMAT(ds.date, '%Y-%m')                        AS mes,
  COUNT(*)                                             AS dias_comparados,
  SUM(CASE WHEN TIMESTAMPDIFF(MINUTE, ds.first_in, x.min_in) = 0 THEN 1 ELSE 0 END) AS iguales,
  SUM(CASE WHEN TIMESTAMPDIFF(MINUTE, ds.first_in, x.min_in) <> 0 THEN 1 ELSE 0 END) AS distintos,
  MIN(TIMESTAMPDIFF(MINUTE, ds.first_in, x.min_in))    AS delta_min_min,
  MAX(TIMESTAMPDIFF(MINUTE, ds.first_in, x.min_in))    AS delta_min_max
FROM daily_summary ds
JOIN (
  SELECT employee_id, DATE(`timestamp`) AS d, MIN(`timestamp`) AS min_in
  FROM attendance_logs
  WHERE type = 'in'
  GROUP BY employee_id, DATE(`timestamp`)
) x ON x.employee_id = ds.employee_id AND x.d = ds.date
WHERE ds.first_in IS NOT NULL
GROUP BY mes
ORDER BY mes;


-- ---------------------------------------------------------------------
-- Q5. Dimensionado del 502 — filas por período
--
-- generateMarcadasReport NO tiene LIMIT: trae todas las filas del rango
-- y las procesa en memoria. Esta consulta dice cuántas filas pediría
-- cada rango típico.
-- ---------------------------------------------------------------------
SELECT
  'ultimo mes'  AS rango, COUNT(*) AS filas_logs, COUNT(DISTINCT al.employee_id) AS empleados
FROM attendance_logs al WHERE al.`timestamp` >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)
UNION ALL
SELECT 'ultimo trimestre', COUNT(*), COUNT(DISTINCT al.employee_id)
FROM attendance_logs al WHERE al.`timestamp` >= DATE_SUB(CURDATE(), INTERVAL 3 MONTH)
UNION ALL
SELECT 'ultimo anho', COUNT(*), COUNT(DISTINCT al.employee_id)
FROM attendance_logs al WHERE al.`timestamp` >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)
UNION ALL
SELECT 'historico completo', COUNT(*), COUNT(DISTINCT al.employee_id)
FROM attendance_logs al;


-- ---------------------------------------------------------------------
-- Q6. ★ CUENTA (empleado × día) — el número que dispara el RangeError
--
-- Tanto la API como la web calculan maxPairs con
--   Math.max(...employees.flatMap(e => e.rows).map(...))
-- El spread de V8 revienta con RangeError alrededor de 125.000
-- elementos. Ese array tiene exactamente un elemento por combinación
-- (empleado, día con marcajes).
--
-- Si `pares_emp_dia` supera ~125.000 para un rango, ese rango NO puede
-- generar el reporte: lanza RangeException antes de responder.
-- ---------------------------------------------------------------------
SELECT
  'ultimo anho'        AS rango,
  COUNT(*)             AS pares_emp_dia,
  CASE WHEN COUNT(*) > 125000 THEN 'EXCEDE el limite del spread' ELSE 'ok' END AS veredicto
FROM (
  SELECT al.employee_id, DATE(al.`timestamp`) AS d
  FROM attendance_logs al
  WHERE al.`timestamp` >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)
  GROUP BY al.employee_id, DATE(al.`timestamp`)
) t
UNION ALL
SELECT 'historico completo', COUNT(*),
       CASE WHEN COUNT(*) > 125000 THEN 'EXCEDE el limite del spread' ELSE 'ok' END
FROM (
  SELECT al.employee_id, DATE(al.`timestamp`) AS d
  FROM attendance_logs al
  GROUP BY al.employee_id, DATE(al.`timestamp`)
) t2;


-- ---------------------------------------------------------------------
-- Q7. Plan de ejecución de la consulta de marcadas
--
-- Reemplazar :FROM y :TO por un rango histórico grande (el que produce
-- el 502). Interesa ver:
--   - si `key` usa idx_date / idx_emp_ts o queda NULL (full scan)
--   - `rows` estimadas
--   - si aparece "Using filesort" por el ORDER BY e.last_name
-- ---------------------------------------------------------------------
EXPLAIN
SELECT
  e.id AS employee_id,
  CONCAT(e.first_name,' ',e.last_name) AS employee_name,
  e.code, d.name AS department,
  al.`timestamp`, al.type
FROM attendance_logs al
JOIN employees e ON al.employee_id = e.id
LEFT JOIN departments d ON e.department_id = d.id
WHERE e.status = 'active'
  AND DATE(al.`timestamp`) BETWEEN :FROM AND :TO
ORDER BY e.last_name, al.`timestamp`;

-- Variante equivalente por rango medio-abierto (sin envolver la columna
-- en DATE()). Comparar el plan con el anterior: si esta usa idx_emp_ts
-- o idx_ts y la otra no, ahí hay una mejora medible.
EXPLAIN
SELECT
  e.id AS employee_id, e.code, al.`timestamp`, al.type
FROM attendance_logs al
JOIN employees e ON al.employee_id = e.id
WHERE e.status = 'active'
  AND al.`timestamp` >= :FROM
  AND al.`timestamp` <  DATE_ADD(:TO, INTERVAL 1 DAY)
ORDER BY e.last_name, al.`timestamp`;


-- ---------------------------------------------------------------------
-- Q8. Índices existentes en las tablas involucradas
-- ---------------------------------------------------------------------
SELECT
  TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, EXPRESSION, CARDINALITY
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('attendance_logs', 'daily_summary', 'employees')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;


-- ---------------------------------------------------------------------
-- Q9. Tamaño de las tablas
-- ---------------------------------------------------------------------
SELECT
  TABLE_NAME,
  TABLE_ROWS                                        AS filas_aprox,
  ROUND(DATA_LENGTH  / 1024 / 1024) AS datos_mb,
  ROUND(INDEX_LENGTH / 1024 / 1024) AS indices_mb
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('attendance_logs', 'daily_summary', 'employees')
ORDER BY DATA_LENGTH DESC;
