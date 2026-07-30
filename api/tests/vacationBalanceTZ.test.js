/**
 * vacationBalanceTZ.test.js — Invariancia de TZ.
 *
 * El bug original (PR #96 en producción America/Asuncion) fue que
 * `countDays('2026-08-03','2026-08-03','habiles')` devolvía 0 en Asunción
 * y 1 en UTC. Este suite ejecuta un lote de casos en subprocesos con
 * distintas TZ y exige resultados idénticos.
 */
const { spawnSync } = require('child_process');
const path = require('path');

function runInTZ(tz, script) {
  const res = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
    cwd: path.resolve(__dirname, '..'),
  });
  if (res.status !== 0) {
    throw new Error(`node exit ${res.status}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  }
  return JSON.parse(res.stdout.trim());
}

const CASES = `
  const vb = require('./src/services/vacationBalance');
  const out = {
    // countDays: lunes individual
    lun_habil:   vb.countDays('2026-08-03','2026-08-03',{dayType:'habiles'}),
    sab_habil:   vb.countDays('2026-08-01','2026-08-01',{dayType:'habiles'}),
    dom_habil:   vb.countDays('2026-08-02','2026-08-02',{dayType:'habiles'}),

    // rangos inclusivos
    semana_habiles: vb.countDays('2026-07-30','2026-08-05',{dayType:'habiles'}),
    semana_corridos: vb.countDays('2026-07-30','2026-08-05',{dayType:'corridos'}),

    // feriados
    con_feriado: vb.countDays('2026-07-30','2026-08-05',{
      dayType:'habiles',
      holidaysSet: new Set(['2026-07-31']),
    }),

    // recorte por año (dic-ene)
    recorte_ene: vb.countTakenIn(
      [{ date_from:'2025-12-28', date_to:'2026-01-05' }],
      { yearStart:'2026-01-01', yearEnd:'2026-12-31',
        dayType:'corridos', holidaysSet:new Set() }),

    // múltiples rangos hábiles
    multi_habiles: vb.countTakenIn(
      [{ date_from:'2026-02-02', date_to:'2026-02-06' },
       { date_from:'2026-03-02', date_to:'2026-03-03' }],
      { yearStart:'2026-01-01', yearEnd:'2026-12-31',
        dayType:'habiles', holidaysSet:new Set() }),

    // cambio de mes / año
    cambio_mes: vb.countDays('2026-01-30','2026-02-02',{dayType:'corridos'}),
    cambio_anio: vb.countDays('2025-12-30','2026-01-02',{dayType:'corridos'}),

    // años bisiestos
    bisiesto_feb: vb.countDays('2024-02-27','2024-03-01',{dayType:'corridos'}),
    no_bisiesto:  vb.countDays('2026-02-27','2026-03-01',{dayType:'corridos'}),
    bisiesto_29_lun_habil: vb.countDays('2024-02-29','2024-02-29',{dayType:'habiles'}),

    // yearsBetween: aniversarios de calendario
    anni_exacto: vb.yearsBetween('2020-07-30','2021-07-30'),
    anni_menos1: vb.yearsBetween('2020-07-30','2021-07-29'),
    anni_5:      vb.yearsBetween('2020-07-30','2026-07-30'),
    anni_bisiesto_feb: vb.yearsBetween('2020-02-29','2024-02-28'),
    anni_bisiesto_29:  vb.yearsBetween('2020-02-29','2024-02-29'),
  };
  process.stdout.write(JSON.stringify(out));
`;

describe('vacationBalance — invariancia respecto de la TZ del proceso', () => {
  const utc = runInTZ('UTC', CASES);
  const asuncion = runInTZ('America/Asuncion', CASES);

  test('resultado idéntico bajo TZ=UTC y TZ=America/Asuncion', () => {
    expect(asuncion).toEqual(utc);
  });

  // Anclas de valor esperadas (regresión sobre el bug reportado).
  test('un lunes individual = 1 día hábil (en ambas TZ)', () => {
    expect(utc.lun_habil).toBe(1);
    expect(asuncion.lun_habil).toBe(1);
  });
  test('sábado y domingo individuales = 0 hábiles', () => {
    expect(utc.sab_habil).toBe(0);
    expect(utc.dom_habil).toBe(0);
    expect(asuncion.sab_habil).toBe(0);
    expect(asuncion.dom_habil).toBe(0);
  });
  test('múltiples rangos hábiles = 7 (5+2)', () => {
    expect(utc.multi_habiles).toBe(7);
    expect(asuncion.multi_habiles).toBe(7);
  });
  test('recorte a enero = 5 corridos', () => {
    expect(utc.recorte_ene).toBe(5);
    expect(asuncion.recorte_ene).toBe(5);
  });
  test('rango semanal completo = 5 hábiles / 7 corridos', () => {
    expect(utc.semana_habiles).toBe(5);
    expect(utc.semana_corridos).toBe(7);
  });
  test('feriado en martes descuenta 1 hábil', () => {
    expect(utc.con_feriado).toBe(4);
    expect(asuncion.con_feriado).toBe(4);
  });
  test('cambios de mes y año cuentan la cantidad correcta de días', () => {
    expect(utc.cambio_mes).toBe(4);
    expect(utc.cambio_anio).toBe(4);
  });
  test('años bisiestos: 29-feb existe en 2024 pero no en 2026', () => {
    expect(utc.bisiesto_feb).toBe(4);       // 27,28,29,01
    expect(utc.no_bisiesto).toBe(3);        // 27,28,01
    expect(utc.bisiesto_29_lun_habil).toBe(1); // 2024-02-29 = jueves
    expect(asuncion.bisiesto_feb).toBe(4);
    expect(asuncion.no_bisiesto).toBe(3);
  });
  test('yearsBetween respeta el aniversario civil', () => {
    expect(utc.anni_exacto).toBe(1);
    expect(utc.anni_menos1).toBe(0);
    expect(utc.anni_5).toBe(6);
    expect(asuncion.anni_exacto).toBe(1);
    expect(asuncion.anni_menos1).toBe(0);
    expect(asuncion.anni_5).toBe(6);
  });
  test('yearsBetween con 29-feb como hire_date', () => {
    // En 2024 el 29-feb existe → aniversario cumplido.
    expect(utc.anni_bisiesto_29).toBe(4);
    expect(asuncion.anni_bisiesto_29).toBe(4);
    // En 2024-02-28 aún no llegó el aniversario del 29.
    expect(utc.anni_bisiesto_feb).toBe(3);
    expect(asuncion.anni_bisiesto_feb).toBe(3);
  });
});
