'use strict';

/**
 * checkSchemaDriftFaseC.test.js — asegura que el drift-checker cubre las
 * dependencias de runtime de FASE C (perfil 073 de employee_schedule_history).
 *
 * Sin base de datos: inspecciona la fuente. Un esquema parcial (072 aplicada,
 * 073 a medias) rompe loadScheduleHistory con ER_BAD_FIELD_ERROR; el chequeo de
 * tabla no lo ve. Estas entradas curadas (tabla, columna) cierran ese punto ciego.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-schema-drift.js'), 'utf8');

// Columnas del perfil 073 que loadScheduleHistory SIEMPRE selecciona.
const FASE_C_COLUMNS = [
  'work_regime', 'daily_target_minutes', 'weekly_target_minutes',
  'overtime_policy', 'rounding_policy', 'night_start', 'night_end', 'work_days',
];

describe('drift-checker cubre las columnas de runtime de FASE C', () => {
  test('cada columna 073 aparece asociada a employee_schedule_history', () => {
    // Acotamos a la porción del array COLUMNAS_CRITICAS para no matchear otra cosa.
    const arrStart = SRC.indexOf('const COLUMNAS_CRITICAS');
    const arr = SRC.slice(arrStart, SRC.indexOf('];', arrStart));
    for (const col of FASE_C_COLUMNS) {
      const re = new RegExp(`tabla:\\s*'employee_schedule_history',\\s*columna:\\s*'${col}'`);
      expect({ col, present: re.test(arr) }).toEqual({ col, present: true });
    }
  });

  test('la lista sigue verificando el par (tabla, columna), no el nombre suelto', () => {
    // Cada entrada nueva nombra su tabla, así que un `status` en otra tabla no
    // la satisface. Aserción de forma: hay al menos 8 pares de employee_schedule_history.
    const count = (SRC.match(/tabla:\s*'employee_schedule_history'/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(8);
  });
});
