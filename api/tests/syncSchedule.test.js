const { computeNextRun, inWindow, pyDate } = require('../src/services/syncSchedule');

describe('syncSchedule.computeNextRun', () => {
  test('alinea al offset (intervalo 15, offset 5 → :05/:20/:35/:50)', () => {
    const from = new Date(2026, 0, 1, 10, 12, 0); // 10:12 local
    const next = computeNextRun(15, 5, from);
    expect(next.getMinutes()).toBe(20);
    expect(next.getHours()).toBe(10);
  });

  test('offset 0 intervalo 15 desde :00 → :15', () => {
    const from = new Date(2026, 0, 1, 9, 0, 30);
    const next = computeNextRun(15, 0, from);
    expect(next.getMinutes()).toBe(15);
  });

  test('siempre estrictamente en el futuro', () => {
    const from = new Date(2026, 0, 1, 9, 5, 0);
    const next = computeNextRun(15, 5, from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  test('cruza de hora correctamente (10:52 offset 5 int 15 → 11:05)', () => {
    const from = new Date(2026, 0, 1, 10, 52, 0);
    const next = computeNextRun(15, 5, from);
    expect(next.getHours()).toBe(11);
    expect(next.getMinutes()).toBe(5);
  });

  test('intervalo mínimo 5 aunque se pida menor', () => {
    const from = new Date(2026, 0, 1, 10, 0, 0);
    const next = computeNextRun(1, 0, from);
    // interval forzado a 5 → próxima a :05
    expect(next.getMinutes() % 5).toBe(0);
  });

  test('offset negativo se normaliza', () => {
    const from = new Date(2026, 0, 1, 10, 3, 0);
    const next = computeNextRun(15, -10, from); // -10 % 15 → 5
    expect(next.getMinutes()).toBe(5);
  });
});

describe('syncSchedule.inWindow', () => {
  test('dentro de la ventana', () => {
    expect(inWindow('04:00-23:59', '12:00')).toBe(true);
    expect(inWindow('04:00-23:59', '04:00')).toBe(true);
    expect(inWindow('04:00-23:59', '23:59')).toBe(true);
  });
  test('fuera de la ventana', () => {
    expect(inWindow('04:00-23:59', '03:59')).toBe(false);
    expect(inWindow('08:00-17:00', '18:00')).toBe(false);
  });
  test('ventana inválida = sin restricción', () => {
    expect(inWindow('', '12:00')).toBe(true);
    expect(inWindow('malo', '12:00')).toBe(true);
  });
});

describe('syncSchedule.pyDate', () => {
  test('formato YYYY-MM-DD', () => {
    expect(pyDate(new Date('2026-07-24T15:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
