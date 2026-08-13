/**
 * dbTime.test.js — formateo HH:mm de columnas DATETIME.
 *
 * Estos tests corren en las tres zonas del CI (UTC, America/Asuncion,
 * Asia/Tokyo). Las aserciones son valores absolutos a propósito: si el helper
 * dependiera de la zona del proceso, pasarían en una zona y fallarían en las
 * otras. Esa es justamente la propiedad que se quiere garantizar.
 */

const { dbTimeHHmm, parseOffsetMinutes } = require('../src/utils/dbTime');

/**
 * Simula lo que entrega mysql2: una hora de pared guardada en un DATETIME,
 * interpretada con el offset fijo del driver (-03:00) → instante UTC.
 */
function comoLoDevuelveElDriver(fecha, hhmm, offsetMin = -180) {
  const [h, m] = hhmm.split(':').map(Number);
  const [Y, M, D] = fecha.split('-').map(Number);
  return new Date(Date.UTC(Y, M - 1, D, h, m) - offsetMin * 60000);
}

describe('dbTimeHHmm', () => {
  test('la regresión: un Date ya no imprime el año', () => {
    const d = comoLoDevuelveElDriver('2025-08-12', '08:15');

    // Lo que hacía el código viejo, conservado como testigo del defecto.
    expect(String(d).slice(11, 16).trim()).toBe('2025');

    // Lo que hace el helper.
    expect(dbTimeHHmm(d)).toBe('08:15');
  });

  test('devuelve la hora de pared guardada, no la del proceso', () => {
    expect(dbTimeHHmm(comoLoDevuelveElDriver('2025-08-12', '08:15'))).toBe('08:15');
    expect(dbTimeHHmm(comoLoDevuelveElDriver('2025-01-02', '00:00'))).toBe('00:00');
    expect(dbTimeHHmm(comoLoDevuelveElDriver('2025-01-02', '23:59'))).toBe('23:59');
    expect(dbTimeHHmm(comoLoDevuelveElDriver('2025-12-31', '17:05'))).toBe('17:05');
  });

  test('el round-trip es exacto también en fechas históricas de invierno', () => {
    // Paraguay estaba en UTC-4 el 2024-06-15, pero el driver leyó con -03:00.
    // El helper debe devolver la hora tal como está guardada (07:30), sin
    // aplicar la tzdata histórica —que daría 06:30—. Esa corrección, si
    // corresponde, es una decisión aparte y documentada; no se cuela acá.
    const d = comoLoDevuelveElDriver('2024-06-15', '07:30');
    expect(dbTimeHHmm(d)).toBe('07:30');

    const conTzdataHistorica = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Asuncion', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
    expect(conTzdataHistorica).toBe('06:30');       // difiere en 1 h…
    expect(dbTimeHHmm(d)).not.toBe(conTzdataHistorica); // …y el helper no la aplica
  });

  test('acepta el string crudo de MySQL', () => {
    expect(dbTimeHHmm('2025-08-12 08:15:00')).toBe('08:15');
    expect(dbTimeHHmm('2025-08-12T08:15:00')).toBe('08:15');
    expect(dbTimeHHmm('2025-08-12T08:15:00.000Z')).toBe('08:15');
  });

  test('acepta columnas TIME sueltas', () => {
    expect(dbTimeHHmm('08:15:00')).toBe('08:15');
  });

  test('nulos y basura devuelven cadena vacía en vez de lanzar', () => {
    // Un dato corrupto aislado no debe tumbar la generación del reporte entero.
    expect(dbTimeHHmm(null)).toBe('');
    expect(dbTimeHHmm(undefined)).toBe('');
    expect(dbTimeHHmm('')).toBe('');
    expect(dbTimeHHmm('sin formato')).toBe('');
    expect(dbTimeHHmm(new Date('no-es-fecha'))).toBe('');
  });

  test('honra un offset distinto del de producción', () => {
    const d = comoLoDevuelveElDriver('2025-08-12', '08:15', 330); // +05:30
    expect(dbTimeHHmm(d, '+05:30')).toBe('08:15');
  });
});

describe('parseOffsetMinutes', () => {
  test('convierte offsets con signo', () => {
    expect(parseOffsetMinutes('-03:00')).toBe(-180);
    expect(parseOffsetMinutes('+00:00')).toBe(0);
    expect(parseOffsetMinutes('+05:30')).toBe(330);
    expect(parseOffsetMinutes('-04:00')).toBe(-240);
  });

  test('rechaza formatos inválidos en vez de asumir cero', () => {
    // Un offset mal escrito en la config debe fallar ruidosamente: asumir 0
    // desplazaría todas las horas del sistema en silencio.
    expect(() => parseOffsetMinutes('America/Asuncion')).toThrow();
    expect(() => parseOffsetMinutes('-3')).toThrow();
    expect(() => parseOffsetMinutes('')).toThrow();
    expect(() => parseOffsetMinutes(null)).toThrow();
  });
});
