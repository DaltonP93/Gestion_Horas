import { addCivilDays, firstOfMonth, todayPy } from '../datetime'

// Fechas civiles de Paraguay para valores por defecto (independientes de la
// zona del navegador; CI corre la suite web en UTC).
describe('datetime: fechas civiles de Paraguay', () => {
  it('todayPy usa el día de Paraguay alrededor de la medianoche UTC', () => {
    expect(todayPy(new Date('2026-10-07T02:59:59Z'))).toBe('2026-10-06')
    expect(todayPy(new Date('2026-10-07T03:00:00Z'))).toBe('2026-10-07')
    expect(todayPy(new Date('2026-11-01T01:00:00Z'))).toBe('2026-10-31')
  })

  it('addCivilDays cruza mes y año', () => {
    expect(addCivilDays('2026-10-06', -3)).toBe('2026-10-03')
    expect(addCivilDays('2026-11-01', -3)).toBe('2026-10-29')
    expect(addCivilDays('2026-01-02', -3)).toBe('2025-12-30')
    expect(addCivilDays('2028-03-01', -1)).toBe('2028-02-29')
  })

  it('firstOfMonth', () => {
    expect(firstOfMonth('2026-10-31')).toBe('2026-10-01')
    expect(firstOfMonth('2026-11-01')).toBe('2026-11-01')
  })
})
