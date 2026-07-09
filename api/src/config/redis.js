const { createClient } = require('redis');
const logger = require('./logger');

let client;
let subscriber;
let streamConsumer;

// Configuración del stream durable de marcajes.
const STREAM_KEY   = 'stream:attendance';
const STREAM_GROUP = 'api';
const STREAM_CONSUMER = `api-${process.pid}`;
// Durabilidad opcional vía Redis Streams. Apagado por defecto: el pipeline
// sigue usando pub/sub. Al activarlo (ATTENDANCE_STREAM_ENABLED=true), los
// marcajes se consumen del stream con consumer-group + ACK, y los eventos que
// llegaron mientras la API estaba caída se recuperan al reiniciar.
const STREAM_ENABLED = process.env.ATTENDANCE_STREAM_ENABLED === 'true';

async function processMessage(payload) {
  const data = JSON.parse(payload);
  const { processAttendanceEvent } = require('../controllers/attendanceController');
  await processAttendanceEvent(data);
}

// Bucle del consumer-group: recupera pendientes (XAUTOCLAIM) y luego bloquea
// esperando nuevos. Tolerante a errores: nunca tumba el proceso.
async function runStreamConsumer(url) {
  streamConsumer = createClient({ url });
  streamConsumer.on('error', err => logger.error('Redis stream consumer error:', err));
  await streamConsumer.connect();

  // Crear el grupo si no existe, empezando en '$' (solo mensajes NUEVOS a
  // partir de ahora). Así, al activar streams por primera vez, no se
  // reprocesa el backlog retenido en el stream (que el bridge ya venía
  // escribiendo en modo pub/sub) evitando recalcular resúmenes y reemitir
  // socket/webhook/alertas de marcajes viejos. La durabilidad ante caídas se
  // mantiene: una vez creado el grupo, los mensajes posteriores no ackeados se
  // recuperan con XAUTOCLAIM / XREADGROUP '>'.
  try {
    await streamConsumer.xGroupCreate(STREAM_KEY, STREAM_GROUP, '$', { MKSTREAM: true });
  } catch (err) {
    if (!String(err.message).includes('BUSYGROUP')) throw err;
  }

  // 1) Recuperar mensajes pendientes (no-ackeados) de una ejecución previa.
  try {
    let cursor = '0';
    for (let i = 0; i < 1000; i++) {
      const claimed = await streamConsumer.xAutoClaim(
        STREAM_KEY, STREAM_GROUP, STREAM_CONSUMER, 60000, cursor, { COUNT: 100 }
      );
      const messages = claimed?.messages || [];
      for (const m of messages) {
        if (!m) continue;
        try { await processMessage(m.message.payload); await streamConsumer.xAck(STREAM_KEY, STREAM_GROUP, m.id); }
        catch (e) { logger.error('Error reprocesando marcaje pendiente:', e.message); }
      }
      cursor = claimed?.nextId || '0';
      if (cursor === '0' || messages.length === 0) break;
    }
  } catch (err) {
    logger.error('Error en recuperación de pendientes del stream:', err.message);
  }

  logger.info(`✅ Consumer de marcajes por stream activo (${STREAM_KEY}/${STREAM_GROUP})`);

  // 2) Bucle principal: leer nuevos con bloqueo.
  while (true) {
    try {
      const res = await streamConsumer.xReadGroup(
        STREAM_GROUP, STREAM_CONSUMER,
        [{ key: STREAM_KEY, id: '>' }],
        { COUNT: 20, BLOCK: 5000 }
      );
      if (!res) continue; // timeout, reintentar
      for (const stream of res) {
        for (const m of stream.messages) {
          try { await processMessage(m.message.payload); await streamConsumer.xAck(STREAM_KEY, STREAM_GROUP, m.id); }
          catch (e) { logger.error('Error procesando marcaje del stream:', e.message); }
        }
      }
    } catch (err) {
      logger.error('Error en bucle del stream (reintenta en 2s):', err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function initRedis() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  client = createClient({ url });
  subscriber = createClient({ url });

  client.on('error', err => logger.error('Redis error:', err));
  subscriber.on('error', err => logger.error('Redis subscriber error:', err));

  await client.connect();
  await subscriber.connect();

  if (STREAM_ENABLED) {
    // Durabilidad: consumir marcajes del stream (no del pub/sub).
    runStreamConsumer(url).catch(err => logger.error('Stream consumer no arrancó:', err.message));
  } else {
    // Modo clásico: pub/sub del canal de marcajes del Bridge ZKTeco.
    await subscriber.subscribe('attendance:new', async (message) => {
      try {
        await processMessage(message);
      } catch (err) {
        logger.error('Error procesando evento de asistencia:', err);
      }
    });
  }

  await subscriber.subscribe('device:status', async (message) => {
    try {
      const data = JSON.parse(message);
      const { io } = require('../socket/socketServer');
      io.emit('device:status', data);
    } catch (err) {
      logger.error('Error en device:status:', err);
    }
  });

  // Alertas del Bridge (heartbeat perdido / recuperado)
  await subscriber.subscribe('device:alert', async (message) => {
    try {
      const data = JSON.parse(message);
      const { getIO } = require('../socket/socketServer');
      try { getIO().to('role:admin').to('role:gestor').emit('device:alert', data); } catch {}
      logger.warn(`🚨 device:alert — ${data.type} SN=${data.sn} (${data.ip})`);
    } catch (err) {
      logger.error('Error en device:alert:', err);
    }
  });

  return client;
}

function getRedis() {
  if (!client) throw new Error('Redis no inicializado');
  return client;
}

module.exports = { initRedis, getRedis };
