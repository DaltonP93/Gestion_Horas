/**
 * dailySummaryCalc — aritmética del resumen diario en hora de pared.
 *
 * Corren en las tres zonas del CI. Las aserciones son absolutas a propósito:
 * si el cálculo volviera a depender de la zona del proceso o de la tzdata,
 * pasarían en una zona y fallarían en las otras.
 */

const calc = require('../src/services/dailySummaryCalc');
const { dbSecondsOfDay, dbDateISO } = require('../src/utils/dbTime');

/** Hora de pared "HH:mm" de una fecha dada, como la entrega el driver. */
function comoLoDevuelveElDriver(fecha, hhmm, offsetMin = -180) {
  const [h, m] = hhmm.split(':').map(Number);
  const [Y, M, D] = fecha.split('-').map(Number);
  return new Date(Date.UTC(Y, M - 1, D, h, m) - offsetMin * 60000);
}

const sec = (hhmmss) => calc.scheduleSeconds(hhmmss);
const min = sec;   // alias: los casos se escriben con horas de pared

describe('scheduleSeconds', () => {
  test('acepta HH:mm y HH:mm:ss', () => {
    expect(calc.scheduleSeconds('07:00')).toBe(7 * 3600);
    expect(calc.scheduleSeconds('07:00:00')).toBe(7 * 3600);
    expect(calc.scheduleSeconds('07:00:30')).toBe(7 * 3600 + 30);
    expect(calc.scheduleSeconds('23:59')).toBe(23 * 3600 + 59 * 60);
    expect(calc.scheduleSeconds('00:00')).toBe(0);
  });

  test('rechaza basura en vez de devolver 0', () => {
    // Devolver 0 haría que todo el día contara como atraso desde medianoche.
    expect(calc.scheduleSeconds(null)).toBeNull();
    expect(calc.scheduleSeconds('')).toBeNull();
    expect(calc.scheduleSeconds('mediodía')).toBeNull();
    expect(calc.scheduleSeconds('25:00')).toBeNull();
    expect(calc.scheduleSeconds('07:99')).toBeNull();
  });
});

describe('lateMinutes — turno normal', () => {
  test('llegar en hora no es atraso', () => {
    expect(calc.lateMinutes({ firstInSeconds: min('07:00'), checkInSeconds: min('07:00') })).toBe(0);
  });

  test('llegar antes tampoco, y nunca da negativo', () => {
    expect(calc.lateMinutes({ firstInSeconds: min('06:40'), checkInSeconds: min('07:00') })).toBe(0);
  });

  test('llegar tarde cuenta los minutos', () => {
    expect(calc.lateMinutes({ firstInSeconds: min('07:12'), checkInSeconds: min('07:00') })).toBe(12);
  });

  test('sin marcaje de entrada no hay atraso', () => {
    expect(calc.lateMinutes({ firstInSeconds: null, checkInSeconds: min('07:00') })).toBe(0);
  });

  test('sin horario definido tampoco', () => {
    expect(calc.lateMinutes({ firstInSeconds: min('09:00'), checkInSeconds: null })).toBe(0);
  });

  test('★ una llegada muy tarde del mismo día se cuenta entera', () => {
    // Con la envoltura simétrica esto daba 0: el atraso mayor a media jornada
    // se interpretaba como "es del día anterior" y desaparecía.
    expect(calc.lateMinutes({ firstInSeconds: min('20:00'), checkInSeconds: min('07:00') }))
      .toBe(780);
  });
});

describe('lateMinutes — tolerancia', () => {
  test('dentro de la tolerancia no es atraso', () => {
    expect(calc.lateMinutes({
      firstInSeconds: min('07:08'), checkInSeconds: min('07:00'), toleranceMin: 10,
    })).toBe(0);
  });

  test('pasada la tolerancia se cuenta desde el límite, no desde el horario', () => {
    expect(calc.lateMinutes({
      firstInSeconds: min('07:25'), checkInSeconds: min('07:00'), toleranceMin: 10,
    })).toBe(15);
  });

  test('justo en el borde de la tolerancia todavía no es atraso', () => {
    expect(calc.lateMinutes({
      firstInSeconds: min('07:10'), checkInSeconds: min('07:00'), toleranceMin: 10,
    })).toBe(0);
  });
});

describe('lateMinutes — turno nocturno y cruce de medianoche', () => {
  test('★ entra 23:00 y marca 00:30 → 90 minutos, no un número negativo', () => {
    // En aritmética directa daría -1350. El marcaje es del día siguiente.
    expect(calc.lateMinutes({
      firstInSeconds: min('00:30'), checkInSeconds: min('23:00'),
    })).toBe(90);
  });

  test('entra 22:00 y marca 22:05 el mismo día', () => {
    expect(calc.lateMinutes({ firstInSeconds: min('22:05'), checkInSeconds: min('22:00') })).toBe(5);
  });

  test('entra 23:00 y marca 22:50 (anticipado) no es atraso', () => {
    expect(calc.lateMinutes({ firstInSeconds: min('22:50'), checkInSeconds: min('23:00') })).toBe(0);
  });

  test('horario 00:00 con marca 23:50 del MISMO día es atraso, no anticipación', () => {
    // Caso deliberadamente incómodo. Podría leerse como "llegó 10 minutos
    // antes del turno de mañana", pero recalcDailySummary sólo ve los
    // marcajes de UN día: para él la persona debía entrar 00:00 y marcó
    // 23:50 de ese mismo día.
    //
    // Envolverlo a 0 exigiría envolver diferencias positivas, y eso es
    // justamente lo que convertía una jornada de 13 horas en cero minutos
    // trabajados. Se prefiere el valor literal: la ambigüedad de turnos que
    // cruzan la medianoche se resuelve asignando bien la fecha laboral, no
    // adivinando en la aritmética.
    expect(calc.lateMinutes({ firstInSeconds: min('23:50'), checkInSeconds: min('00:00') }))
      .toBe(23 * 60 + 50);
  });
});

describe('workedMinutes', () => {
  test('jornada normal', () => {
    expect(calc.workedMinutes({
      firstInSeconds: min('08:00'), lastOutSeconds: min('17:00'),
    })).toBe(540);
  });

  test('★ turno nocturno: entra 22:00, sale 02:00 → 240', () => {
    expect(calc.workedMinutes({
      firstInSeconds: min('22:00'), lastOutSeconds: min('02:00'),
    })).toBe(240);
  });

  test('falta una de las dos marcas → 0', () => {
    expect(calc.workedMinutes({ firstInSeconds: min('08:00'), lastOutSeconds: null })).toBe(0);
    expect(calc.workedMinutes({ firstInSeconds: null, lastOutSeconds: min('17:00') })).toBe(0);
  });

  test('★ jornada larga del mismo día: 13 horas son 780, no cero', () => {
    // Envolver las diferencias positivas —tratándolas como cruce de
    // medianoche— convertía esta jornada en -660 y por lo tanto en CERO
    // minutos trabajados. Peor que el defecto que este PR corrige.
    expect(calc.workedMinutes({
      firstInSeconds: min('08:00'), lastOutSeconds: min('21:00'),
    })).toBe(780);
  });

  test('★ los segundos no se pierden antes de restar', () => {
    // 08:00:59 → 17:00:00 son 539 minutos COMPLETOS. Pasar antes por minutos
    // del día daba 540: sobrestimaba un minuto siempre que los segundos de la
    // entrada superaran a los de la salida.
    expect(calc.workedMinutes({
      firstInSeconds: sec('08:00:59'), lastOutSeconds: sec('17:00:00'),
    })).toBe(539);

    expect(calc.workedMinutes({
      firstInSeconds: sec('08:00:00'), lastOutSeconds: sec('17:00:59'),
    })).toBe(540);
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
        firstInSeconds: dbSecondsOfDay(marcaje),
        checkInSeconds: min('07:00'),
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
    expect(dbSecondsOfDay(marcaje)).toBe(min('07:12')); // …y el cálculo usa la guardada
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
  test('resuelve el cruce hacia el día siguiente', () => {
    expect(calc.wallDelta(min('23:00'), min('00:30'))).toBe(90 * 60);
    expect(calc.wallDelta(min('08:00'), min('17:00'))).toBe(540 * 60);
  });

  test('★ las diferencias POSITIVAS nunca se envuelven', () => {
    // recalcDailySummary lee un solo día: una diferencia positiva grande no
    // puede ser cruce de medianoche. Envolverla convertía una jornada de 13
    // horas en cero minutos trabajados.
    expect(calc.wallDelta(0, calc.HALF_DAY + 3600)).toBe(calc.HALF_DAY + 3600);
    expect(calc.wallDelta(min('08:00'), min('21:00'))).toBe(13 * 3600);
  });

  test('sólo se envuelve lo muy negativo', () => {
    expect(calc.wallDelta(min('23:00'), min('00:30'))).toBe(90 * 60);   // cruce
    expect(calc.wallDelta(min('07:00'), min('06:00'))).toBe(-3600);     // anticipación
  });
});
