/**
 * swaggerDailySummaryContract.test.js — El contrato público no puede quedarse
 * atrás del motor.
 *
 * Los endpoints de integración publican `daily_summary.status` tal cual. Si el
 * motor gana un estado nuevo (p. ej. non_working/unconfigured de la 074) pero el
 * enum de OpenAPI no lo lista, un cliente de nómina generado desde el contrato
 * rechaza una respuesta válida. Este test ata el enum del contrato al conjunto
 * de estados que el motor puede emitir, para que no se desalineen en silencio.
 */

const spec = require('../src/config/swagger');
const dsEngine = require('../src/services/dailySummaryEngine');

describe('contrato OpenAPI de DailySummary.status', () => {
  const enumContrato = spec.components.schemas.DailySummary.properties.status.enum;

  test('el enum incluye TODOS los estados que el motor puede emitir', () => {
    const estadosMotor = Object.values(dsEngine.STATUS);
    for (const estado of estadosMotor) {
      expect(enumContrato).toContain(estado);
    }
  });

  test('el enum no inventa estados que el motor no produce', () => {
    const estadosMotor = new Set(Object.values(dsEngine.STATUS));
    for (const estado of enumContrato) {
      expect(estadosMotor.has(estado)).toBe(true);
    }
  });
});
