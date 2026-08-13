/**
 * reportParams.ts — Parámetros del reporte de Marcadas.
 *
 * POR QUÉ EXISTE
 *
 * La pantalla de Reportes consulta `/api/reports/marcadas` desde tres lugares
 * —la tabla en pantalla, el botón de PDF y el envío por email— y cada uno
 * armaba el objeto de parámetros por su cuenta. Con el tiempo divergieron:
 *
 *   - la tabla mandaba `departmentId`, que la API no lee (usa `deptId`),
 *     así que el filtro por departamento se descartaba en silencio;
 *   - el PDF sí mandaba `deptId` y filtraba bien;
 *   - el email no mandaba departamento en absoluto.
 *
 * El resultado visible era que, filtrando por departamento, la tabla y el PDF
 * de la misma pantalla mostraban conjuntos distintos.
 *
 * Centralizar el armado acá hace que los tres caminos no puedan volver a
 * desalinearse, y deja el contrato en un solo lugar testeable.
 *
 * El nombre canónico es `deptId`: es el que lee la API
 * (api/src/routes/reports.js) y el que ya usa el resto de la web.
 */

export interface MarcadasFilters {
  from: string;
  to: string;
  /** id de empleado; '' o undefined = todos */
  empId?: string;
  /** id de departamento; '' o undefined = todos */
  deptId?: string;
}

/**
 * Parámetros para GET /api/reports/marcadas y /marcadas/pdf.
 *
 * El tipo de retorno es `Record<string, string>` y no una interfaz con campos
 * opcionales, porque `downloadUrl` espera `Record<string, string | number>` y
 * un campo `employeeId?: string` se tipa como `string | undefined`, que no es
 * asignable. Los filtros vacíos se omiten, así que todo lo que está presente
 * es efectivamente un string.
 *
 * Omitir es distinto de mandar en blanco: un `deptId=''` viaja en la
 * querystring como string vacío y la API lo trataría como valor presente.
 */
export function marcadasParams({ from, to, empId, deptId }: MarcadasFilters): Record<string, string> {
  const params: Record<string, string> = { from, to };
  if (empId)  params.employeeId = empId;
  if (deptId) params.deptId = deptId;
  return params;
}

/**
 * Cuerpo para POST /api/reports/marcadas/email.
 *
 * Misma forma que los otros dos caminos más los destinatarios, para que el
 * reporte que llega por correo coincida con el que se ve en pantalla.
 */
export function marcadasEmailBody(filters: MarcadasFilters, recipients: string[]) {
  return { ...marcadasParams(filters), recipients };
}
