/**
 * reportError.ts — Traducción de fallos del reporte a algo accionable.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * QUÉ FALLA HOY
 * ═══════════════════════════════════════════════════════════════════════
 *
 * El API se reinicia cuando PM2 lo mata por memoria, y durante ese reinicio
 * Nginx devuelve 502 a todo. Desde la pantalla eso se veía como un spinner que
 * no terminaba nunca: la consulta fallaba, pero no había ningún estado de
 * error que mostrar, así que la persona se quedaba mirando "Generando..."
 * indefinidamente y sin forma de reintentar salvo recargar.
 *
 * Un 502 es RECUPERABLE —el proceso vuelve en segundos— y hay que decirlo. Un
 * 403 no lo es, y reintentar sólo hace perder tiempo. Distinguirlos es la
 * diferencia entre un mensaje útil y "algo salió mal".
 *
 * ═══════════════════════════════════════════════════════════════════════
 * POR QUÉ ES UN MÓDULO APARTE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Para poder probar la clasificación sin montar la pantalla ni simular
 * TanStack. La pantalla se limita a mostrar lo que esto devuelve.
 */

export interface ReportError {
  /** Texto principal. Una frase, sin jerga de HTTP. */
  mensaje: string;
  /** Detalle secundario, si aporta algo que el usuario pueda usar. */
  detalle?: string;
  /** ¿Tiene sentido volver a intentar el mismo pedido? */
  reintentable: boolean;
  /** Código HTTP, cuando se pudo determinar. Para diagnóstico. */
  status?: number;
}

/** Forma mínima de un error de axios, sin importar el tipo del paquete. */
interface ErrorConRespuesta {
  response?: { status?: number; data?: { error?: string; message?: string } };
  code?: string;
  message?: string;
}

/**
 * Clasifica el fallo de la consulta del reporte.
 *
 * Devuelve `null` cuando no hay error, para que la pantalla pueda usar el
 * resultado directamente como condición de render.
 */
export function describeReportError(err: unknown): ReportError | null {
  if (!err) return null;

  const e = err as ErrorConRespuesta;
  const status = e.response?.status;
  const delServidor = e.response?.data?.error || e.response?.data?.message;

  // Cancelación: NO es un error. TanStack aborta la petición en vuelo cuando
  // cambia la clave, y mostrar un cartel rojo por eso sería alarmar por el
  // funcionamiento normal.
  if (e.code === 'ERR_CANCELED' || e.code === 'ECONNABORTED') return null;

  if (status === 502 || status === 503 || status === 504) {
    return {
      mensaje: 'El servidor no está respondiendo en este momento.',
      detalle: 'Suele resolverse en unos segundos. Probá generar el reporte de nuevo; '
        + 'si el período es muy largo, acortarlo ayuda.',
      reintentable: true,
      status,
    };
  }

  if (status === 401) {
    // El cliente de API renueva el token solo. Si el 401 llegó igual hasta
    // acá, la renovación no alcanzó y hay que volver a entrar.
    return {
      mensaje: 'La sesión expiró.',
      detalle: 'Volvé a iniciar sesión para continuar.',
      reintentable: false,
      status,
    };
  }

  if (status === 403) {
    return {
      mensaje: 'No tenés permiso para consultar este reporte.',
      detalle: delServidor,
      reintentable: false,
      status,
    };
  }

  if (status === 400 || status === 422) {
    return {
      mensaje: delServidor || 'Los filtros del reporte no son válidos.',
      reintentable: false,
      status,
    };
  }

  if (status === 413 || status === 507) {
    return {
      mensaje: 'El período pedido es demasiado grande para procesar de una vez.',
      detalle: 'Acortá el rango de fechas o filtrá por departamento.',
      reintentable: false,
      status,
    };
  }

  if (status && status >= 500) {
    return {
      mensaje: 'El servidor falló al generar el reporte.',
      detalle: delServidor,
      reintentable: true,
      status,
    };
  }

  // Sin respuesta: no llegó al servidor. Puede ser la red del cliente o el API
  // caído; en los dos casos reintentar es razonable.
  if (!status) {
    return {
      mensaje: 'No se pudo conectar con el servidor.',
      detalle: 'Revisá tu conexión y volvé a intentar.',
      reintentable: true,
    };
  }

  return {
    mensaje: delServidor || 'No se pudo generar el reporte.',
    reintentable: true,
    status,
  };
}
