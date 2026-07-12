-- =============================================================
-- Migración 046: semana de DOMINGO a SÁBADO (Domingo = 1 … Sábado = 7).
--
-- Antes: schedules.work_days usaba 1=Lun … 7=Dom (convención de la UI), pero
-- materializeAbsents lo leía como DAYOFWEEK-1 (0=Dom..6=Sáb) → inconsistente
-- para sábado/domingo. Se unifica a la convención de MySQL DAYOFWEEK:
--   1=Domingo, 2=Lunes, 3=Martes, 4=Miércoles, 5=Jueves, 6=Viernes, 7=Sábado.
--
-- Remapeo de los datos existentes (viejo 1=Lun..7=Dom → nuevo 1=Dom..7=Sáb):
--   nuevo = (viejo mod 7) + 1   →  Lun1→2, Mar2→3, …, Sáb6→7, Dom7→1.
-- Se hace con doble REEMPLAZO usando tokens temporales (a..g) para no
-- encadenar mapeos. Los valores son dígitos sueltos 1..7 separados por comas.
--
-- init.sql siembra en la convención vieja, por eso esta migración también
-- corrige las filas recién sembradas en instalaciones nuevas (el runner la
-- ejecuta después de init.sql). El runner la aplica una sola vez.
-- =============================================================

UPDATE schedules SET work_days =
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
    work_days,
    '1','a'),'2','b'),'3','c'),'4','d'),'5','e'),'6','f'),'7','g'),
    'a','2'),'b','3'),'c','4'),'d','5'),'e','6'),'f','7'),'g','1')
WHERE work_days IS NOT NULL AND work_days <> '';

-- Nuevo default de columna: Lunes a Viernes en la convención nueva (2..6).
ALTER TABLE schedules ALTER COLUMN work_days SET DEFAULT '2,3,4,5,6';

SELECT 'Migración 046 aplicada: work_days remapeado a Domingo=1..Sábado=7' AS info;
