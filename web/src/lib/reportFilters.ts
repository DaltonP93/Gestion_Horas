/**
 * reportFilters.ts — Filtros en borrador vs filtros aplicados.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * EL PROBLEMA
 * ═══════════════════════════════════════════════════════════════════════
 *
 * La pantalla de Reportes tenía UN solo juego de filtros, el del formulario, y
 * lo usaba para tres cosas a la vez:
 *
 *   1. la `queryKey` de la consulta que llena la tabla,
 *   2. los parámetros del PDF y del CSV,
 *   3. el cuerpo del envío por email.
 *
 * Con la `queryKey` atada al formulario, cambiar una fecha DESPUÉS de generar
 * el reporte cambia la clave: TanStack pasa a una entrada de caché que no
 * existe y la tabla se vacía o se recarga sola mientras la persona sigue
 * eligiendo el rango. El botón "Generar reporte" queda de adorno, porque la
 * consulta ya se disparó por su cuenta.
 *
 * Peor es el segundo efecto, que es silencioso: el PDF y el CSV se arman con
 * el formulario, no con lo que está en pantalla. Si alguien genera enero,
 * mira la tabla y después toca la fecha para preparar febrero, el botón de PDF
 * descarga FEBRERO mientras la pantalla muestra enero. El archivo sale sin
 * ninguna señal de que no es lo que se estaba viendo, y termina adjunto a un
 * correo o impreso.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * LA SEPARACIÓN
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   borrador (draft)   lo que la persona está editando. Cambia con cada tecla
 *                      y no dispara nada.
 *   aplicados (applied) lo que se consultó. Cambia SÓLO al presionar "Generar
 *                      reporte", y es lo único que alimenta la consulta, el
 *                      PDF, el CSV y el email.
 *
 * `applied` empieza en `null`: antes de la primera generación no hay reporte,
 * que no es lo mismo que un reporte vacío. Es lo que permite distinguir "todavía
 * no generaste nada" de "no hay marcaciones en ese rango", dos mensajes que la
 * pantalla venía dando indistintamente.
 *
 * Este módulo es puro y no depende de React, para que la regla se pueda testear
 * sin montar la pantalla.
 */

import type { MarcadasFilters } from './reportParams';

export type ReportFilters = MarcadasFilters;

/** Filtros aplicados: `null` mientras no se haya generado ningún reporte. */
export type AppliedFilters = ReportFilters | null;

/** Igualdad campo a campo, tratando `''` y `undefined` como lo mismo. */
export function sameFilters(a: AppliedFilters, b: AppliedFilters): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.from === b.from
    && a.to === b.to
    && (a.empId || '') === (b.empId || '')
    && (a.deptId || '') === (b.deptId || '')
  );
}

/**
 * ¿El borrador difiere de lo que se está mostrando?
 *
 * La pantalla lo usa para avisar "los filtros cambiaron, generá de nuevo".
 * Sin ese aviso, la tabla de enero con el formulario en febrero se ve
 * exactamente igual que la tabla de febrero, y no hay forma de notar la
 * diferencia hasta que el reporte ya está impreso.
 */
export function isStale(draft: ReportFilters, applied: AppliedFilters): boolean {
  if (!applied) return false; // nunca se generó: no hay nada desactualizado
  return !sameFilters(draft, applied);
}

/**
 * Normaliza el borrador antes de aplicarlo.
 *
 * Recorta y ordena el rango: `from > to` no devuelve error de la API, devuelve
 * cero filas, que se lee como "no hubo marcaciones" y es una respuesta
 * engañosa. Invertirlo es lo que la persona quiso decir en todos los casos que
 * importan.
 */
export function normalizeFilters(draft: ReportFilters): ReportFilters {
  const from = (draft.from || '').trim();
  const to = (draft.to || '').trim();
  const invertido = !!from && !!to && from > to;
  return {
    from: invertido ? to : from,
    to: invertido ? from : to,
    empId: draft.empId || '',
    deptId: draft.deptId || '',
  };
}

/** ¿El borrador se puede aplicar? Sin rango completo no hay consulta que hacer. */
export function canApply(draft: ReportFilters): boolean {
  const { from, to } = normalizeFilters(draft);
  return !!from && !!to;
}

/**
 * Clave de caché de la consulta.
 *
 * Se construye desde los filtros APLICADOS, nunca desde el borrador: es
 * precisamente el acoplamiento que causaba que la tabla se recargara sola
 * mientras se editaba el formulario.
 */
export function marcadasQueryKey(applied: AppliedFilters): unknown[] {
  if (!applied) return ['marcadas', null];
  const f = normalizeFilters(applied);
  return ['marcadas', f.from, f.to, f.empId, f.deptId];
}
