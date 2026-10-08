'use strict';

/**
 * readChild.js — UNA lectura del reloj, en un proceso propio.
 *
 * El proceso principal del piloto lanza uno por intento y espera su
 * TERMINACIÓN antes de reintentar o liberar el lock: matar el proceso cierra
 * de verdad el socket con el reloj (Promise.race sólo deja de esperar).
 *
 * Reglas de este proceso:
 *   - La captura del estado crudo se instala ANTES de cargar cualquier otra
 *     cosa; si node-zklib ya estaba cargado (captura tardía) o la instalación
 *     falló, responde 'captura' y termina SIN conectar al reloj.
 *   - No carga base de datos, Redis, configuración ni caminos de importación;
 *     recibe sólo los parámetros de conexión por el canal IPC (nunca por
 *     argumentos ni variables de entorno) y devuelve sólo el agregado.
 *   - Nunca vive más que su límite: se termina sola al vencer `limiteMs`, y
 *     también si el proceso principal desaparece (canal IPC cerrado).
 *   - Sólo usa los comandos de lectura de node-zklib (conectar, liberar
 *     buffer, pedir marcaciones, salir): no deshabilita, borra ni configura.
 *   - Corre en UTC (el padre no le pasa la zona): la hora de pared sale exacta,
 *     sin horas inexistentes. Si la zona no lo garantiza, no se conecta.
 *   - Con un corte común (`msg.corte`), agrega el bloque `corte`: conteos y una
 *     huella con la clave recibida por IPC (nunca registros ni la clave).
 */
const zkRawCapture = require('../zkRawCapture');

const captureStatus = zkRawCapture.install();

const path = require('path');
const { openZK } = require('../zkClient');
const { aggregateRecords, cutoffBlock, classifyReadError, decodingZoneOk } = require('./aggregate');
const { pyDateTimeStr } = require('../zkRecordShape');

const FORBIDDEN = [
  ['src', 'services', 'zktecoReader.js'], ['src', 'services', 'deviceLock.js'], ['src', 'services', 'audit.js'],
  ['src', 'config', 'database.js'], ['node_modules', 'sequelize'], ['node_modules', 'mysql2'], ['node_modules', 'redis'],
].map((p) => path.join(...p));

function isolationOk() {
  return !Object.keys(require.cache).some((f) => FORBIDDEN.some((x) => f.includes(x)));
}

function captureOk() {
  return captureStatus.installed && captureStatus.loadedBefore.length === 0 && !captureStatus.error;
}

function sendAndExit(msg, code) {
  try {
    process.send(msg, () => process.exit(code));
  } catch {
    process.exit(code);
  }
}

let started = false;
process.on('disconnect', () => process.exit(10));
// Ctrl+Z llega a todo el grupo: el hijo nunca queda suspendido con la sesión del reloj abierta.
process.on('SIGTSTP', () => process.exit(12));
process.on('message', async (msg) => {
  if (!msg || msg.type !== 'leer' || started) return;
  started = true;
  setTimeout(() => process.exit(9), Number(msg.limiteMs) || 1000);

  if (!captureOk() || !isolationOk() || !decodingZoneOk()) {
    sendAndExit({ type: 'captura', ok: false }, 3);
    return;
  }

  const t0 = Date.now();
  let zk = null;
  let res = null;
  let error = null;
  try {
    zk = await openZK(msg.reloj);
    res = await zk.getAttendances();
  } catch (e) {
    error = e;
  }
  if (zk) { try { await zk.disconnect(); } catch { /* el proceso termina igual */ } }

  const records = res && Array.isArray(res.data) ? res.data : [];
  zkRawCapture.markMissing(records);
  const truncated = !error && !!(res && res.err);
  const nowPy = pyDateTimeStr(new Date());
  const agregado = aggregateRecords(records, { nowPy });
  if (msg.corte && typeof msg.corte.hasta === 'string') {
    agregado.corte = cutoffBlock(records, { hasta: msg.corte.hasta, clave: msg.corte.clave || null, nowPy });
  }
  sendAndExit({
    type: 'resultado',
    estado: error ? 'error' : (truncated ? 'truncada' : 'completa'),
    codigo: error ? classifyReadError(error) : (truncated ? 'lectura_incompleta' : null),
    duracion_ms: Date.now() - t0,
    agregado,
  }, 0);
});
