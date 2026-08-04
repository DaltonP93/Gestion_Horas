/**
 * Contrato de push-status del lado del Bridge.
 *
 * Se consulta por serial o IP a propósito: el id del Bridge sale de la
 * posición dentro de ZKTECO_DEVICES y no tiene nada que ver con devices.id
 * de MySQL, que era lo que la API venía mandando.
 */
const request = require('supertest');
const express = require('express');

const {
  buildPushStatusPayload,
  validatePushStatusPayload,
  PUSH_STATUS_CONTRACT_VERSION,
  MATCHED_BY,
} = require('../src/pushStatusContract');

// ── Réplica mínima del endpoint tal como queda montado en el Bridge ──
function bootApp(pushState, { apiKey = 'clave' } = {}) {
  const app = express();
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use((req, res, next) => {
    const provided = req.get('x-api-key');
    if (apiKey && provided && provided === apiKey) return next();
    return res.status(401).json({ error: 'No autorizado' });
  });
  app.get('/push-status', (req, res) => {
    const serial = (req.query.serial || '').toString().trim();
    const ip     = (req.query.ip || '').toString().trim();
    if (!serial && !ip) return res.status(400).json({ error: 'serial o ip requerido' });

    let matchedBy = MATCHED_BY.NONE, sn = null, state = null;
    if (serial && pushState[serial]) {
      sn = serial; state = pushState[serial]; matchedBy = MATCHED_BY.SERIAL;
    } else if (ip) {
      const porIp = Object.entries(pushState).find(([, s]) => s && s.ip === ip);
      if (porIp) { sn = porIp[0]; state = porIp[1]; matchedBy = MATCHED_BY.IP; }
    }
    res.json(buildPushStatusPayload({
      serial: sn,
      lastPushAt:  state ? state.lastSeen  || null : null,
      lastEventAt: state ? state.lastPunch || null : null,
      matchedBy,
    }));
  });
  return app;
}

const ESTADO = {
  'SN-123': { ip: '10.0.0.5', lastSeen: '2026-08-04T18:00:00.000Z', lastPunch: '2026-08-04T17:55:00.000Z' },
};

describe('autenticación', () => {
  test('/health sigue siendo público — por eso el Bridge "parecía" sano', async () => {
    await request(bootApp(ESTADO)).get('/health').expect(200);
  });

  test('sin x-api-key devuelve 401: ésta era la causa del 502', async () => {
    await request(bootApp(ESTADO)).get('/push-status?serial=SN-123').expect(401);
  });

  test('con la clave correcta responde 200', async () => {
    await request(bootApp(ESTADO))
      .get('/push-status?serial=SN-123').set('x-api-key', 'clave').expect(200);
  });
});

describe('resolución del reloj', () => {
  const get = (qs) => request(bootApp(ESTADO)).get(`/push-status?${qs}`).set('x-api-key', 'clave');

  test('por serial', async () => {
    const r = await get('serial=SN-123').expect(200);

    expect(r.body.found).toBe(true);
    expect(r.body.serial).toBe('SN-123');
    expect(r.body.matched_by).toBe('serial');
    expect(r.body.last_push_at).toBe('2026-08-04T18:00:00.000Z');
    expect(r.body.last_event_at).toBe('2026-08-04T17:55:00.000Z');
  });

  test('por IP cuando no hay serial', async () => {
    const r = await get('ip=10.0.0.5').expect(200);

    expect(r.body.found).toBe(true);
    expect(r.body.matched_by).toBe('ip');
    expect(r.body.serial).toBe('SN-123');
  });

  test('el serial gana sobre la IP', async () => {
    const r = await get('serial=SN-123&ip=10.9.9.9').expect(200);
    expect(r.body.matched_by).toBe('serial');
  });

  test('reloj desconocido: found false, no un 404', async () => {
    const r = await get('serial=SN-NO-EXISTE').expect(200);

    expect(r.body.found).toBe(false);
    expect(r.body.serial).toBeNull();
    expect(r.body.matched_by).toBe('none');
  });

  test('sin serial ni ip → 400', async () => {
    await get('').expect(400);
  });

  test('la respuesta no incluye la IP del reloj', async () => {
    const r = await get('serial=SN-123').expect(200);
    expect(JSON.stringify(r.body)).not.toContain('10.0.0.5');
  });

  test('un reloj sin marcaje aún devuelve fechas nulas, no rompe', async () => {
    const app = bootApp({ 'SN-9': { ip: '10.0.0.9', lastSeen: '2026-08-04T18:00:00.000Z' } });
    const r = await request(app).get('/push-status?serial=SN-9').set('x-api-key', 'clave').expect(200);

    expect(r.body.last_event_at).toBeNull();
    expect(r.body.last_push_at).toBe('2026-08-04T18:00:00.000Z');
  });
});

describe('forma del contrato', () => {
  test('todo lo que arma el Bridge lo acepta el validador de la API', async () => {
    const app = bootApp(ESTADO);
    for (const qs of ['serial=SN-123', 'ip=10.0.0.5', 'serial=SN-NO-EXISTE']) {
      const r = await request(app).get(`/push-status?${qs}`).set('x-api-key', 'clave').expect(200);
      expect(validatePushStatusPayload(r.body)).toEqual({ ok: true });
      expect(r.body.contract_version).toBe(PUSH_STATUS_CONTRACT_VERSION);
    }
  });

  test('el validador rechaza versiones que no entiende', () => {
    const v = validatePushStatusPayload({ ...buildPushStatusPayload({ serial: 'X' }), contract_version: 99 });
    expect(v.ok).toBe(false);
  });

  test('el validador rechaza fechas inválidas y tipos equivocados', () => {
    expect(validatePushStatusPayload({ ...buildPushStatusPayload({ serial: 'X' }), last_push_at: 'ayer' }).ok).toBe(false);
    expect(validatePushStatusPayload({ ...buildPushStatusPayload({ serial: 'X' }), found: 1 }).ok).toBe(false);
    expect(validatePushStatusPayload(null).ok).toBe(false);
    expect(validatePushStatusPayload([]).ok).toBe(false);
  });

  test('buildPushStatusPayload marca found según haya datos', () => {
    expect(buildPushStatusPayload({}).found).toBe(false);
    expect(buildPushStatusPayload({ serial: 'X' }).found).toBe(true);
    expect(buildPushStatusPayload({}).matched_by).toBe('none');
  });
});
