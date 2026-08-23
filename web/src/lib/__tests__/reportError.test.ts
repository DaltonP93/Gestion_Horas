/**
 * reportError.test.ts — Clasificación de fallos del reporte.
 *
 * El caso central es el 502: el API se reinicia cuando PM2 lo mata por
 * memoria, y durante ese reinicio Nginx devuelve 502 a todo. Antes eso dejaba
 * el spinner girando para siempre, porque la consulta fallaba pero no había
 * estado de error que mostrar.
 */

import { describeReportError } from '../reportError';

const conStatus = (status: number, data?: any) => ({ response: { status, data } });

describe('502 y familia — el incidente de producción', () => {
  it('el 502 se reporta como recuperable y con qué hacer', () => {
    const r = describeReportError(conStatus(502))!;
    expect(r.reintentable).toBe(true);
    expect(r.status).toBe(502);
    expect(r.mensaje).toMatch(/no está respondiendo/i);
    // El consejo importa: acortar el período es lo que evita el reinicio.
    expect(r.detalle).toMatch(/acortarlo|segundos/i);
  });

  it('503 y 504 se tratan igual que el 502', () => {
    for (const s of [503, 504]) {
      const r = describeReportError(conStatus(s))!;
      expect(r.reintentable).toBe(true);
      expect(r.status).toBe(s);
    }
  });

  it('siempre devuelve un mensaje: nunca deja la UI sin nada que mostrar', () => {
    for (const s of [400, 401, 403, 413, 422, 500, 502, 507, 418]) {
      const r = describeReportError(conStatus(s));
      expect(r).not.toBeNull();
      expect(r!.mensaje.length).toBeGreaterThan(0);
    }
  });
});

describe('errores que NO tiene sentido reintentar', () => {
  it('403 no es reintentable', () => {
    const r = describeReportError(conStatus(403))!;
    expect(r.reintentable).toBe(false);
    expect(r.mensaje).toMatch(/permiso/i);
  });

  it('401 pide volver a iniciar sesión', () => {
    // El cliente de API renueva el token solo; si el 401 llegó igual, la
    // renovación no alcanzó.
    const r = describeReportError(conStatus(401))!;
    expect(r.reintentable).toBe(false);
    expect(r.mensaje).toMatch(/sesión/i);
  });

  it('el período demasiado grande dice qué achicar, y no ofrece reintentar', () => {
    const r = describeReportError(conStatus(413))!;
    expect(r.reintentable).toBe(false);
    expect(r.detalle).toMatch(/rango|departamento/i);
  });

  it('un 400 usa el mensaje del servidor cuando lo trae', () => {
    const r = describeReportError(conStatus(400, { error: 'Rango de fechas inválido' }))!;
    expect(r.mensaje).toBe('Rango de fechas inválido');
    expect(r.reintentable).toBe(false);
  });
});

describe('cancelación', () => {
  it('una petición abortada NO es un error', () => {
    // TanStack aborta la petición en vuelo cuando cambia la clave. Mostrar un
    // cartel rojo por eso sería alarmar por el funcionamiento normal.
    expect(describeReportError({ code: 'ERR_CANCELED' })).toBeNull();
    expect(describeReportError({ code: 'ECONNABORTED' })).toBeNull();
  });

  it('sin error devuelve null, para usarlo como condición de render', () => {
    expect(describeReportError(null)).toBeNull();
    expect(describeReportError(undefined)).toBeNull();
  });
});

describe('fallos de red', () => {
  it('sin respuesta del servidor es reintentable', () => {
    const r = describeReportError({ message: 'Network Error' })!;
    expect(r.reintentable).toBe(true);
    expect(r.status).toBeUndefined();
    expect(r.mensaje).toMatch(/conectar/i);
  });

  it('un 500 genérico es reintentable y conserva el detalle del servidor', () => {
    const r = describeReportError(conStatus(500, { error: 'demasiados marcajes' }))!;
    expect(r.reintentable).toBe(true);
    expect(r.detalle).toBe('demasiados marcajes');
  });
});
