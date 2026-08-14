/**
 * dailySummaryCalc — aritmética del resumen diario en hora de pared.
 *
 * Corren en las tres zonas del CI. Las aserciones son absolutas a propósito:
 * si el cálculo volviera a depender de la zona del proceso o de la tzdata,
 * pasarían en una zona y fallarían en las otras.
 */

const calc = require('../src/services/dailySummaryCalc');
const { dbMinutesOfDay, dbDateISO } = require('../src/utils/dbTime');

/** Hora de pared "HH:mm" de una fecha dada, como la entrega el driver. */
function comoLoDevuelveElDriver(fecha, hhmm, offsetMin = -180) {
  const [h, m] = hhmm.split(':').map(Number);
  const [Y, M, D] = fecha.split('-').map(Number);
  return new Date(Date.UTC(Y, M - 1, D, h, m) - offsetMin * 60000);
}

const min = (hhmm) => calc.scheduleMinutes(hhmm);

describe('scheduleMinutes', () => {
  test('acepta HH:mm y HH:mm:ss', () => {
    expect(calc.scheduleMinutes('07:00')).toBe(420);
    expect(calc.scheduleMinutes('07:00:00')).toBe(420);
    expect(calc.scheduleMinutes('23:59')).toBe(1439);
    expect(calc.scheduleMinutes('00:00')).toBe(0);
  });

  test('rechaza basura en vez de devolver 0', () => {
    // Devolver 0 haría que todo el día contara como atraso desde medianoche.
    expect(calc.scheduleMinutes(null)).toBeNull();
    expect(calc.scheduleMinutes('')).toBeNull();
    expect(calc.scheduleMinutes('mediodía')).toBeNull();
    expect(calc.scheduleMinutes('25:00')).toBeNull();
    expect(calc.scheduleMinutes('07:99')).toBeNull();
  });
});

describe('lateMinutes — turno normal', () => {
  test('llegar en hora no es atraso', () => {
    expect(calc.lateMinutes({ firstInMinutes: min('07:00'), checkInMinutes: min('07:00') })).toBe(0);
  });

  test('llegar antes tampoco, y nunca da negativo', () => {
    expect(calc.lateMinutes({ firstInMinutes: min('06:40'), checkInMinutes: min('07:00') })).toBe(0);
  });

  test('llegar tarde cuenta los minutos', () => {
    expect(calc.lateMinutes({ firstInMinutes: min('07:12'), checkInMinutes: min('07:00') })).toBe(12);
  });

  test('sin marcaje de entrada no hay atraso', () => {
    expect(calc.lateMinutes({ firstInMinutes: null, checkInMinutes: min('07:00') })).toBe(0);
  });

  test('sin horario definido tampoco', () => {
    expect(calc.lateMinutes({ firstInMinutes: min('09:00'), checkInMinutes: null })).toBe(0);
  });
});

describe('lateMinutes — tolerancia', () => {
  test('dentro de la tolerancia no es atraso', () => {
    expect(calc.lateMinutes({
      firstInMinutes: min('07:08'), checkInMinutes: min('07:00'), toleranceMin: 10,
    })).toBe(0);
  });

  test('pasada la tolerancia se cuenta desde el límite, no desde el horario', () => {
    expect(calc.lateMinutes({
      firstInMinutes: min('07:25'), checkInMinutes: min('07:00'), toleranceMin: 10,
    })).toBe(15);
  });

  test('justo en el borde de la tolerancia todavía no es atraso', () => {
    expect(calc.lateMinutes({
      firstInMinutes: min('07:10'), checkInMinutes: min('07:00'), toleranceMin: 10,
    })).toBe(0);
  });
});

describe('lateMinutes — turno nocturno y cruce de medianoche', () => {
  test('★ entra 23:00 y marca 00:30 → 90 minutos, no un número negativo', () => {
    // En aritmética directa daría -1350. El marcaje es del día siguiente.
    expect(calc.lateMinutes({
      firstInMinutes: min('00:30'), checkInMinutes: min('23:00'),
    })).toBe(90);
  });

  test('entra 22:00 y marca 22:05 el mismo día', () => {
    expect(calc.lateMinutes({ firstInMinutes: min('22:05'), checkInMinutes: min('22:00') })).toBe(5);
  });

  test('entra 23:00 y marca 22:50 (anticipado) no es atraso', () => {
    expect(calc.lateMinutes({ firstInMinutes: min('22:50'), checkInMinutes: min('23:00') })).toBe(0);
  });

  test('entra 00:00 y marca 23:50 del día anterior tampoco', () => {
    expect(calc.lateMinutes({ firstInMinutes: min('23:50'), checkInMinutes: min('00:00') })).toBe(0);
  });
});

describe('workedMinutes', () => {
  test('jornada normal', () => {
    expect(calc.workedMinutes({
      firstInMinutes: min('08:00'), lastOutMinutes: min('17:00'),
    })).toBe(540);
  });

  test('★ turno nocturno: entra 22:00, sale 02:00 → 240', () => {
    expect(calc.workedMinutes({
      firstInMinutes: min('22:00'), lastOutMinutes: min('02:00'),
    })).toBe(240);
  });

  test('falta una de las dos marcas → 0', () => {
    expect(calc.workedMinutes({ firstInMinutes: min('08:00'), lastOutMinutes: null })).toBe(0);
    expect(calc.workedMinutes({ firstInMinutes: null, lastOutMinutes: min('17:00') })).toBe(0);
  });
});

describe('dayStatus', () => {
  test('sin marcaje: ausente, salvo feriado o fin de semana', () => {
    expect(calc.dayStatus({ hasFirstIn: false, late: 0 })).toBe('absent');
    expect(calc.dayStatus({ hasFirstIn: false, late: 0, isHoliday: true })).toBe('holiday');
    expect(calc.dayStatus({ hasFirstIn: false, late: 0, isWeekend: true })).toBe('weekend');
  });

  test('con marcaje manda el atraso, aunque sea feriado', () => {
    // Si trabajó un feriado, el día cuenta como trabajado; el feriado se
    // refleja en las extras, no en el estado.
    expect(calc.dayStatus({ hasFirstIn: true, late: 0, isHoliday: true })).toBe('present');
    expect(calc.dayStatus({ hasFirstIn: true, late: 12 })).toBe('late');
  });
});

describe('★ invariancia histórica — el defecto que se corrige', () => {
  // El cálculo viejo construía el horario previsto con offset fijo `-03:00`.
  // En fechas de invierno anteriores al 2024-10-06 Paraguay estaba en UTC-4,
  // así que la referencia quedaba corrida una hora y el atraso salía mal
  // aunque first_in fuese exacto.
  //
  // Acá se comprueba que el mismo par (horario, marcaje) da el MISMO atraso
  // en las dos épocas, porque no interviene ninguna conversión de zona.

  const INVIERNO_2024 = '2024-06-15';   // Paraguay en UTC-4
  const VERANO_2025   = '2025-01-15';   // Paraguay en UTC-3 permanente

  test('el atraso no depende de la época', () => {
    for (const fecha of [INVIERNO_2024, VERANO_2025]) {
      const marcaje = comoLoDevuelveElDriver(fecha, '07:12');
      const atraso = calc.lateMinutes({
        firstInMinutes: dbMinutesOfDay(marcaje),
        checkInMinutes: min('07:00'),
      });
      expect(atraso).toBe(12);
    }
  });

  test('la comparación con la tzdata histórica sí difiere — por eso importa', () => {
    // Testigo del defecto: formatear con America/Asuncion sobre una fecha de
    // invierno de 2024 da una hora menos que la guardada.
    const marcaje = comoLoDevuelveElDriver(INVIERNO_2024, '07:12');
    const conTzdata = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Asuncion', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(marcaje);

    expect(conTzdata).toBe('06:12');                    // una hora menos…
    expect(dbMinutesOfDay(marcaje)).toBe(min('07:12')); // …y el cálculo usa la guardada
  });

  test('la fecha del día tampoco se corre', () => {
    // Un marcaje a las 00:30 de una fecha de invierno: convertir a
    // America/Asuncion lo llevaría al día anterior.
    const marcaje = comoLoDevuelveElDriver(INVIERNO_2024, '00:30');
    expect(dbDateISO(marcaje)).toBe(INVIERNO_2024);

    const conTzdata = new Intl.DateTimeFormat('sv', { timeZone: 'America/Asuncion' }).format(marcaje);
    expect(conTzdata).toBe('2024-06-14');   // el día anterior
  });
});

describe('wallDelta', () => {
  test('resuelve el cruce en ambos sentidos', () => {
    expect(calc.wallDelta(min('23:00'), min('00:30'))).toBe(90);
    expect(calc.wallDelta(min('00:30'), min('23:00'))).toBe(-90);
    expect(calc.wallDelta(min('08:00'), min('17:00'))).toBe(540);
  });

  test('media jornada es el punto de corte', () => {
    expect(calc.wallDelta(0, calc.HALF_DAY)).toBe(calc.HALF_DAY);
    expect(calc.wallDelta(0, calc.HALF_DAY + 1)).toBe(calc.HALF_DAY + 1 - calc.DAY);
  });
});
