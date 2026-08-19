/**
 * reportFilters.test.ts — La separación borrador / aplicados.
 *
 * El caso que más importa acá no es que la tabla se recargue sola —eso se ve—
 * sino que el PDF salga con un período distinto del que está en pantalla, que
 * NO se ve. Ese es el que tiene su propio test.
 */

import {
  sameFilters, isStale, normalizeFilters, canApply, marcadasQueryKey,
  type ReportFilters,
} from '../reportFilters';
import { marcadasParams } from '../reportParams';

const ENERO: ReportFilters = { from: '2026-01-01', to: '2026-01-31', empId: '', deptId: '' };
const FEBRERO: ReportFilters = { from: '2026-02-01', to: '2026-02-28', empId: '', deptId: '' };

describe('sameFilters', () => {
  it('trata "" y undefined como el mismo valor vacío', () => {
    expect(sameFilters(
      { from: '2026-01-01', to: '2026-01-31' },
      { from: '2026-01-01', to: '2026-01-31', empId: '', deptId: '' },
    )).toBe(true);
  });

  it('distingue por cada campo', () => {
    expect(sameFilters(ENERO, FEBRERO)).toBe(false);
    expect(sameFilters(ENERO, { ...ENERO, empId: '42' })).toBe(false);
    expect(sameFilters(ENERO, { ...ENERO, deptId: '7' })).toBe(false);
  });

  it('null sólo es igual a null', () => {
    expect(sameFilters(null, null)).toBe(true);
    expect(sameFilters(null, ENERO)).toBe(false);
    expect(sameFilters(ENERO, null)).toBe(false);
  });
});

describe('isStale', () => {
  it('no marca nada como desactualizado antes de la primera generación', () => {
    expect(isStale(ENERO, null)).toBe(false);
  });

  it('avisa cuando el formulario se movió respecto de lo que se muestra', () => {
    expect(isStale(FEBRERO, ENERO)).toBe(true);
  });

  it('no avisa cuando coinciden', () => {
    expect(isStale(ENERO, { ...ENERO })).toBe(false);
  });
});

describe('normalizeFilters', () => {
  it('invierte un rango al revés en vez de devolver cero filas', () => {
    // `from > to` no da error de la API: da un resultado vacío, que se lee
    // como "no hubo marcaciones". Es la respuesta más engañosa posible.
    const out = normalizeFilters({ from: '2026-01-31', to: '2026-01-01' });
    expect(out.from).toBe('2026-01-01');
    expect(out.to).toBe('2026-01-31');
  });

  it('recorta espacios y normaliza los vacíos', () => {
    const out = normalizeFilters({ from: ' 2026-01-01 ', to: ' 2026-01-31 ' });
    expect(out).toEqual({ from: '2026-01-01', to: '2026-01-31', empId: '', deptId: '' });
  });

  it('conserva los filtros de empleado y departamento', () => {
    const out = normalizeFilters({ ...ENERO, empId: '42', deptId: '7' });
    expect(out.empId).toBe('42');
    expect(out.deptId).toBe('7');
  });
});

describe('canApply', () => {
  it('exige el rango completo', () => {
    expect(canApply(ENERO)).toBe(true);
    expect(canApply({ from: '', to: '2026-01-31' })).toBe(false);
    expect(canApply({ from: '2026-01-01', to: '' })).toBe(false);
  });
});

describe('marcadasQueryKey', () => {
  it('sin filtros aplicados devuelve una clave estable que no consulta nada', () => {
    expect(marcadasQueryKey(null)).toEqual(['marcadas', null]);
  });

  it('cambia sólo cuando cambian los filtros aplicados', () => {
    const a = marcadasQueryKey(ENERO);
    const b = marcadasQueryKey({ ...ENERO });
    expect(a).toEqual(b);
    expect(marcadasQueryKey(FEBRERO)).not.toEqual(a);
  });

  it('normaliza antes de armar la clave: dos formas del mismo filtro comparten caché', () => {
    expect(marcadasQueryKey({ from: '2026-01-01', to: '2026-01-31' }))
      .toEqual(marcadasQueryKey({ from: '2026-01-01', to: '2026-01-31', empId: '', deptId: '' }));
  });
});

describe('la regresión que no se ve: el PDF y la pantalla', () => {
  it('las descargas se arman con los filtros aplicados, no con el formulario', () => {
    // Guion real: se genera enero, se mira la tabla, y después se toca la
    // fecha para preparar febrero SIN volver a generar. El botón de PDF tiene
    // que seguir descargando enero, que es lo que está en pantalla.
    const aplicados = ENERO;
    const borrador = FEBRERO;

    expect(marcadasParams(aplicados)).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(marcadasParams(aplicados)).not.toEqual(marcadasParams(borrador));
    // Y la pantalla tiene que estar avisando de la diferencia.
    expect(isStale(borrador, aplicados)).toBe(true);
  });

  it('el email viaja con el mismo período que la tabla', () => {
    const aplicados = { ...ENERO, deptId: '7' };
    expect(marcadasParams(aplicados)).toEqual({
      from: '2026-01-01', to: '2026-01-31', deptId: '7',
    });
  });
});
