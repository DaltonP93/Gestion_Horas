// KPI de marcas crudas: "vinculadas hoy" debe incluir 'mapped' Y 'duplicate'
// (las relecturas del auto-polling). Reproduce la evidencia de producción.
const { LINKED_STATUSES, LINKED_SQL, summarizeRawPunches } = require('../src/services/rawPunchStats');

const TODAY = '2026-07-28';
const AYER = '2026-07-27';
// Helpers para armar filas de raw_device_punches.
const row = (mapping_status, { day = TODAY, device_id = 1, source = 'zkteco_direct', employee_id = 1 } = {}) =>
  ({ record_time_py: `${day} 08:00:00`, mapping_status, device_id, source, employee_id });
const many = (n, status, opts) => Array.from({ length: n }, () => row(status, opts));

describe('definición de VINCULADA', () => {
  test('LINKED_STATUSES = mapped + duplicate', () => {
    expect(LINKED_STATUSES).toEqual(['mapped', 'duplicate']);
  });
  test('LINKED_SQL cubre mapped y duplicate y excluye unmapped/invalid', () => {
    expect(LINKED_SQL).toMatch(/'mapped'/);
    expect(LINKED_SQL).toMatch(/'duplicate'/);
    expect(LINKED_SQL).not.toMatch(/'unmapped'/);
    expect(LINKED_SQL).not.toMatch(/'invalid'/);
  });
});

describe('summarizeRawPunches', () => {
  test('lectura MANUAL (marcas nuevas → mapped) cuenta como vinculada', () => {
    const s = summarizeRawPunches(many(52, 'mapped'), TODAY);
    expect(s.mapped_today).toBe(52);
    expect(s.raw_today).toBe(52);
    expect(s.unmapped_today).toBe(0);
  });

  test('AUTO-POLLING (relectura → duplicate) TAMBIÉN cuenta como vinculada', () => {
    // Antes del fix estas 64 se perdían (sólo se contaba 'mapped').
    const s = summarizeRawPunches(many(64, 'duplicate'), TODAY);
    expect(s.mapped_today).toBe(64);
    expect(s.raw_today).toBe(64);
  });

  test('unmapped NO cuenta como vinculada, sí como pendiente', () => {
    const s = summarizeRawPunches(many(5, 'unmapped', { employee_id: null }), TODAY);
    expect(s.mapped_today).toBe(0);
    expect(s.unmapped_today).toBe(5);
    expect(s.unmapped_pending).toBe(5);
  });

  test('invalid (basura) no cuenta en ninguna categoría de vinculación', () => {
    const s = summarizeRawPunches(many(3, 'invalid', { employee_id: null }), TODAY);
    expect(s.mapped_today).toBe(0);
    expect(s.unmapped_today).toBe(0);
    expect(s.raw_today).toBe(3); // sigue siendo cruda de hoy
  });

  test('varios relojes: se suman mapped + duplicate de todos los devices', () => {
    const rows = [
      ...many(52, 'mapped',    { device_id: 2 }),   // Comedor (manual)
      ...many(102, 'mapped',   { device_id: 3 }),   // Lavadero (manual)
      ...many(64, 'duplicate', { device_id: 1 }),   // Gerencia (auto-polling)
    ];
    const s = summarizeRawPunches(rows, TODAY);
    expect(s.mapped_today).toBe(218); // 52 + 102 + 64
  });

  test('varias fuentes (zkteco_direct, att2000, device) no afecta el conteo', () => {
    const rows = [
      row('mapped',    { source: 'zkteco_direct' }),
      row('duplicate', { source: 'att2000' }),
      row('mapped',    { source: 'device' }),
    ];
    expect(summarizeRawPunches(rows, TODAY).mapped_today).toBe(3);
  });

  test('duplicadas de días anteriores no inflan el conteo de HOY', () => {
    const rows = [
      ...many(10, 'duplicate', { day: TODAY }),
      ...many(7,  'duplicate', { day: AYER }),   // ayer: fuera de "hoy"
    ];
    const s = summarizeRawPunches(rows, TODAY);
    expect(s.mapped_today).toBe(10);
    expect(s.raw_today).toBe(10);
  });

  test('escenario COMPLETO de producción: 218 vinculadas + 5 pendientes = 223 crudas', () => {
    const rows = [
      ...many(52, 'mapped',    { device_id: 2 }),   // Comedor
      ...many(102, 'mapped',   { device_id: 3 }),   // Lavadero
      ...many(64, 'duplicate', { device_id: 1 }),   // Gerencia (auto)
      ...many(5,  'unmapped',  { device_id: 1, employee_id: null }),
    ];
    const s = summarizeRawPunches(rows, TODAY);
    expect(s.raw_today).toBe(223);
    expect(s.mapped_today).toBe(218);
    expect(s.unmapped_today).toBe(5);
    expect(s.mapped_today + s.unmapped_today).toBe(s.raw_today);
  });

  test('unmapped_pending acumula de todos los días; unmapped_today sólo hoy', () => {
    const rows = [
      ...many(5, 'unmapped', { day: TODAY, employee_id: null }),
      ...many(8, 'unmapped', { day: AYER,  employee_id: null }),
    ];
    const s = summarizeRawPunches(rows, TODAY);
    expect(s.unmapped_pending).toBe(13);
    expect(s.unmapped_today).toBe(5);
  });
});
