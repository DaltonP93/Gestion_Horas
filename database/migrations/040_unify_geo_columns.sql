-- =============================================================
-- Migración 040: unifica la geolocalización en latitude/longitude
--
-- Contexto:
--   attendance_logs tenía dos pares de columnas de coordenadas:
--     · latitude/longitude (init.sql, las lee el marcaje móvil y reportes)
--     · lat/lng            (migración 016, solo las escribía el self-checkin)
--   Ningún lector usa lat/lng; el código ya se unificó para escribir en
--   latitude/longitude. Esta migración retro-completa los datos históricos
--   del self-checkin para que queden legibles por el par canónico.
--
-- Seguro e idempotente: solo copia donde el canónico está vacío. No borra
-- las columnas lat/lng (se conservan por compatibilidad; pueden eliminarse
-- manualmente más adelante una vez verificado).
-- =============================================================

-- Backfill: si latitude está vacío pero lat tiene dato, copiarlo.
UPDATE attendance_logs
   SET latitude  = lat
 WHERE latitude IS NULL AND lat IS NOT NULL;

UPDATE attendance_logs
   SET longitude = lng
 WHERE longitude IS NULL AND lng IS NOT NULL;

-- Verificación: filas con geo por columna.
SELECT
  SUM(latitude  IS NOT NULL) AS con_latitude,
  SUM(lat       IS NOT NULL) AS con_lat_legacy
FROM attendance_logs;
