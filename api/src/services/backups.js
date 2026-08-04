/**
 * backups.js
 * Backups automáticos de MySQL via mysqldump.
 *
 * - Ejecuta mysqldump y comprime el volcado a <BACKUP_DIR>/asistencia_<ts>.sql.gz
 * - Mantiene retención (BACKUP_RETENTION_DAYS, default 14 días)
 * - Cron configurable con BACKUP_CRON (default '0 2 * * *' — 2 AM diario)
 *
 * Garantías del pipeline (ver runBackup):
 * - Se escribe a un temporal y se renombra al final: nunca queda un .sql.gz a medias.
 * - Una sola finalización: el resultado lo fija el primer fallo, y la limpieza corre una vez.
 * - Ningún error escapa como excepción asincrónica: todos los streams tienen dueño.
 */
const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { PassThrough } = require('stream');
const cron   = require('node-cron');
const logger = require('../config/logger');

const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups'));
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '14', 10);
const MYSQLDUMP_BIN = process.env.MYSQLDUMP_BIN || 'mysqldump';
const TIMEOUT_MS = parseInt(process.env.BACKUP_TIMEOUT_MS || String(30 * 60 * 1000), 10);
const KILL_GRACE_MS = parseInt(process.env.BACKUP_KILL_GRACE_MS || '5000', 10);
const STDERR_MAX_BYTES = 8 * 1024;      // stderr de mysqldump: se retiene sólo la cola
const STDERR_LOG_CHARS = 300;           // y sólo un extracto llega al log
const TEMP_SWEEP_MS = 24 * 60 * 60 * 1000;

const TEMP_RE = /^\.asistencia_.*\.part$/;
const BACKUP_RE = /^asistencia_.*\.sql\.gz$/;

/** Códigos estables y seguros: no contienen rutas, credenciales ni texto del motor. */
const BACKUP_ERROR_CODES = Object.freeze({
  ALREADY_RUNNING: 'BACKUP_ALREADY_RUNNING',
  DIR_UNWRITABLE:  'BACKUP_DIR_UNWRITABLE',
  SPAWN_FAILED:    'BACKUP_SPAWN_FAILED',
  DUMP_FAILED:     'BACKUP_DUMP_FAILED',
  DUMP_SIGNALED:   'BACKUP_DUMP_SIGNALED',
  COMPRESS_FAILED: 'BACKUP_COMPRESS_FAILED',
  WRITE_FAILED:    'BACKUP_WRITE_FAILED',
  WRITE_DENIED:    'BACKUP_WRITE_DENIED',
  DISK_FULL:       'BACKUP_DISK_FULL',
  TRUNCATED:       'BACKUP_TRUNCATED',
  EMPTY_OUTPUT:    'BACKUP_EMPTY_OUTPUT',
  MISSING_OUTPUT:  'BACKUP_MISSING_OUTPUT',
  RENAME_FAILED:   'BACKUP_RENAME_FAILED',
  TIMEOUT:         'BACKUP_TIMEOUT',
  CANCELLED:       'BACKUP_CANCELLED',
  UNKNOWN:         'BACKUP_UNKNOWN',
});

class BackupError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    this.stage = details.stage || 'unknown';
    this.exit_code = details.exit_code ?? null;
    this.signal = details.signal ?? null;
    this.stderr_excerpt = details.stderr_excerpt || '';
    if (details.cause) this.cause = details.cause;
  }
}

// Seams de test: permiten inyectar fallos de compresión/escritura sin tocar el disco real.
let _hooks = { createGzip: null, createWriteStream: null };
function __setTestHooks(h) { _hooks = { createGzip: null, createWriteStream: null, ...(h || {}) }; }
const makeGzip = () => (_hooks.createGzip || zlib.createGzip)();
const makeWriteStream = (p, o) => (_hooks.createWriteStream || fs.createWriteStream)(p, o);

let _job = null;
let _active = null;      // promesa del backup en curso (single-flight)
let _activeCancel = null; // cancelador del backup en curso

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Sólo el nombre del archivo: la ruta del servidor no va a los logs. */
function sanitizePath(p) {
  return p ? path.basename(p) : '';
}

/**
 * Redacta credenciales, hosts y direcciones del texto de error del motor.
 * Se conservan únicamente las líneas de diagnóstico de las herramientas
 * (mysqldump:/ERROR/gzip:), nunca contenido SQL del volcado.
 */
function sanitizeStderr(raw) {
  if (!raw) return '';
  const lines = String(raw)
    .split(/\r?\n/)
    .filter(l => /^\s*(mysqldump:|gzip:|ERROR\b)/i.test(l));
  if (!lines.length) return '';
  // El corte es POR LÍNEA: una comilla en la primera no puede tapar el
  // diagnóstico de las siguientes.
  return lines.map(redactQuoted).join(' | ')
    .replace(/\b(pass(word)?|pwd)\s*[=:]\s*\S+/gi, 'password=***')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '***.***.***.***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, STDERR_LOG_CHARS);
}

/**
 * Borra todo literal entrecomillado del texto de diagnóstico.
 *
 * mysqldump mete ahí justo lo que no puede salir en un log: 'usuario'@'host',
 * el hostname de «Unknown MySQL server host 'db.interna'» y el SQL entero de
 * «Couldn't execute 'SHOW FIELDS FROM ...'». Los códigos numéricos, que son
 * lo que sirve para diagnosticar, quedan a la izquierda del corte.
 *
 * Se corta en la primera comilla de APERTURA en vez de emparejar comillas:
 * MySQL las anida y las desbalancea con naturalidad —el bug #70907 produce
 * `Couldn't execute 'show table status like 'uc\_%''`— y cualquier intento de
 * emparejar cierra en la comilla interna y deja el identificador a la vista.
 *
 * La comilla simple no abre literal si es un apóstrofo entre letras, para que
 * "Couldn't execute" no corte en la palabra equivocada.
 */
function firstQuoteIndex(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === '`') return i;
    if (c === "'") {
      const prev = i > 0 ? s[i - 1] : '';
      const next = i + 1 < s.length ? s[i + 1] : '';
      const esApostrofo = /\p{L}/u.test(prev) && /\p{L}/u.test(next);
      if (!esApostrofo) return i;
    }
  }
  return -1;
}

function redactQuoted(text) {
  const s = String(text);
  const q = firstQuoteIndex(s);
  return q === -1 ? s : `${s.slice(0, q).trimEnd()} '***'`;
}

function classifyStreamError(err, stage) {
  const code = err && err.code;
  if (code === 'ENOSPC') return BACKUP_ERROR_CODES.DISK_FULL;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return BACKUP_ERROR_CODES.WRITE_DENIED;
  if (stage === 'compress') return BACKUP_ERROR_CODES.COMPRESS_FAILED;
  if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'EPIPE') return BACKUP_ERROR_CODES.TRUNCATED;
  return BACKUP_ERROR_CODES.WRITE_FAILED;
}

/** Un error de zlib llega con `err.errno` negativo y sin syscall de fs. */
function isCompressError(err) {
  if (!err) return false;
  if (typeof err.code === 'string' && err.code.startsWith('Z_')) return true;
  return err.name === 'ZlibError' || /zlib/i.test(err.message || '');
}

function ensureBackupDir() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  } catch (err) {
    throw new BackupError(BACKUP_ERROR_CODES.DIR_UNWRITABLE, 'No se pudo preparar el directorio de backups', {
      stage: 'prepare', cause: err,
    });
  }
}

async function safeUnlink(p) {
  try { await fsp.unlink(p); return true; }
  catch (err) { if (err && err.code !== 'ENOENT') return false; return false; }
}

/**
 * Ejecuta un backup completo. Se resuelve sólo si:
 * mysqldump terminó con código 0, el pipeline cerró, el archivo existe y pesa > 0.
 *
 * @param {{ signal?: AbortSignal }} opts
 */
async function runBackup(opts = {}) {
  if (_active) {
    throw new BackupError(BACKUP_ERROR_CODES.ALREADY_RUNNING, 'Ya hay un backup en curso', { stage: 'init' });
  }
  const p = _runBackupOnce(opts);
  _active = p;
  try { return await p; }
  finally { _active = null; _activeCancel = null; }
}

async function _runBackupOnce(opts = {}) {
  const startedAt = Date.now();
  const filename  = `asistencia_${timestamp()}.sql.gz`;
  const finalPath = path.join(BACKUP_DIR, filename);
  const tmpPath   = path.join(
    BACKUP_DIR,
    `.${filename}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`
  );

  ensureBackupDir();

  // ── Estado de finalización única ──────────────────────────────
  // El primer fallo gana; los eventos posteriores (close tras error,
  // callbacks repetidos de un stream roto) no pueden pisarlo ni volver
  // a disparar la limpieza.
  let failure = null;
  let cleaned = false;
  const fail = (err) => { if (!failure) failure = err; };

  let cancelled = false;
  let timedOut  = false;
  let child = null;
  let timeoutTimer = null;
  let killTimer = null;

  const killChild = (signal) => {
    if (!child) return;
    // OJO: no usar child.killed — se pone en true en cuanto la señal se ENVÍA,
    // no cuando el proceso muere. Si mysqldump ignora o atrapa el SIGTERM, ese
    // guard bloquearía la escalada a SIGKILL y el backup quedaría colgado
    // esperando 'close' para siempre. Lo único que dice "ya terminó" es tener
    // exitCode o signalCode.
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill(signal); } catch { /* el proceso ya no existe */ }
  };
  const killEscalating = () => {
    killChild('SIGTERM');
    if (killTimer) return;
    killTimer = setTimeout(() => killChild('SIGKILL'), KILL_GRACE_MS);
    if (killTimer.unref) killTimer.unref();
  };

  const onAbort = () => { cancelled = true; killEscalating(); };
  const signal = opts.signal;

  try {
    // ── spawn ───────────────────────────────────────────────────
    const env = { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD || '' };
    const dumpArgs = [
      '-h', process.env.DB_HOST || 'localhost',
      '-P', String(process.env.DB_PORT || 3306),
      '-u', process.env.DB_USER || 'root',
      '--single-transaction', '--quick', '--lock-tables=false',
      '--routines', '--triggers', '--events',
      process.env.DB_NAME || 'asistencia',
    ];

    try {
      child = spawn(MYSQLDUMP_BIN, dumpArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      throw new BackupError(BACKUP_ERROR_CODES.SPAWN_FAILED, 'No se pudo iniciar mysqldump', {
        stage: 'spawn', cause: err,
      });
    }

    _activeCancel = (reason) => { cancelled = reason || true; killEscalating(); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    // ── stderr acotado: un mysqldump ruidoso no puede inflar la memoria ──
    let stderrBuf = '';
    let stderrBytes = 0;
    child.stderr.on('data', (d) => {
      stderrBytes += d.length;
      stderrBuf = (stderrBuf + d.toString()).slice(-STDERR_MAX_BYTES);
    });
    // stdout/stderr con dueño: sin esto, un EPIPE se emite sin listener y
    // termina en uncaughtException (que es lo que tiraba la API).
    child.stderr.on('error', () => {});
    child.stdout.on('error', () => {});

    const exitInfo = new Promise((resolve, reject) => {
      child.once('error', (err) => reject(new BackupError(
        BACKUP_ERROR_CODES.SPAWN_FAILED, 'mysqldump no pudo ejecutarse', { stage: 'spawn', cause: err }
      )));
      child.once('close', (code, sig) => resolve({ code, signal: sig }));
    });

    // ── pipeline: mysqldump → contador → gzip → temporal ─────────
    // El contador mide el volcado SIN comprimir: gzip de cero bytes igual
    // pesa ~20 bytes de cabecera, así que "archivo > 0" no alcanza para
    // distinguir un backup real de uno vacío.
    let rawBytes = 0;
    const counter = new PassThrough();
    counter.on('data', (c) => { rawBytes += c.length; });
    const gzip = makeGzip();
    const out  = makeWriteStream(tmpPath, { flags: 'wx' });
    // Dueño permanente del 'error': si un stream lo emite tarde (después de
    // que pipeline soltó sus listeners), no puede escalar a uncaughtException.
    counter.on('error', () => {});
    gzip.on('error', () => {});
    out.on('error', () => {});
    // pipeline() es el único que cierra estos streams: nadie llama end()
    // ni destroy() por su cuenta, así que no hay escrituras post-cierre.
    const pipePromise = pipeline(child.stdout, counter, gzip, out);
    // Si la escritura muere, mysqldump se queda sin lector: se lo baja en vez
    // de esperar a que note el EPIPE por sí solo.
    pipePromise.then(null, () => killEscalating());

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killEscalating();
    }, TIMEOUT_MS);
    if (timeoutTimer.unref) timeoutTimer.unref();

    const [pipeRes, exitRes] = await Promise.allSettled([pipePromise, exitInfo]);
    clearTimeout(timeoutTimer); timeoutTimer = null;
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }

    const pipeErr = pipeRes.status === 'rejected' ? pipeRes.reason : null;
    const stderrExcerpt = sanitizeStderr(stderrBuf);

    // ── precedencia de fallos ────────────────────────────────────
    if (cancelled) {
      fail(new BackupError(BACKUP_ERROR_CODES.CANCELLED, 'Backup cancelado', { stage: 'cancel' }));
    } else if (timedOut) {
      fail(new BackupError(BACKUP_ERROR_CODES.TIMEOUT, `Backup excedió ${TIMEOUT_MS} ms`, { stage: 'dump' }));
    } else if (exitRes.status === 'rejected') {
      fail(exitRes.reason);
    } else if (pipeErr && (isCompressError(pipeErr) || !['ERR_STREAM_PREMATURE_CLOSE', 'EPIPE'].includes(pipeErr.code))) {
      // Fallo real de compresión o de escritura: es la causa raíz, aunque
      // mysqldump también haya muerto (por EPIPE) a consecuencia.
      const stage = isCompressError(pipeErr) ? 'compress' : 'write';
      fail(new BackupError(classifyStreamError(pipeErr, stage), 'Falló la escritura del backup', {
        stage, cause: pipeErr, stderr_excerpt: stderrExcerpt,
      }));
    } else if (exitRes.value && exitRes.value.signal) {
      fail(new BackupError(BACKUP_ERROR_CODES.DUMP_SIGNALED, 'mysqldump terminado por señal', {
        stage: 'dump', signal: exitRes.value.signal, stderr_excerpt: stderrExcerpt,
      }));
    } else if (exitRes.value && exitRes.value.code !== 0) {
      fail(new BackupError(BACKUP_ERROR_CODES.DUMP_FAILED, 'mysqldump terminó con error', {
        stage: 'dump', exit_code: exitRes.value.code, stderr_excerpt: stderrExcerpt,
      }));
    } else if (pipeErr) {
      fail(new BackupError(BACKUP_ERROR_CODES.TRUNCATED, 'El volcado se cortó antes de terminar', {
        stage: 'write', cause: pipeErr, stderr_excerpt: stderrExcerpt,
      }));
    }

    if (failure) throw failure;

    // ── verificación: existe y pesa > 0 ─────────────────────────
    let stat;
    try {
      stat = await fsp.stat(tmpPath);
    } catch (err) {
      throw new BackupError(BACKUP_ERROR_CODES.MISSING_OUTPUT, 'El archivo de backup no existe al finalizar', {
        stage: 'verify', cause: err,
      });
    }
    if (!stat.size || !rawBytes) {
      throw new BackupError(BACKUP_ERROR_CODES.EMPTY_OUTPUT, 'El backup quedó vacío', {
        stage: 'verify', stderr_excerpt: stderrExcerpt,
      });
    }

    // ── publicación atómica ─────────────────────────────────────
    try {
      await fsp.rename(tmpPath, finalPath);
    } catch (err) {
      throw new BackupError(BACKUP_ERROR_CODES.RENAME_FAILED, 'No se pudo publicar el backup', {
        stage: 'finalize', cause: err,
      });
    }

    return {
      filename,
      path: finalPath,
      size: stat.size,
      created_at: new Date(),
      duration_ms: Date.now() - startedAt,
      raw_bytes: rawBytes,
      stderr_bytes: stderrBytes,
    };
  } catch (err) {
    const e = err instanceof BackupError
      ? err
      : new BackupError(BACKUP_ERROR_CODES.UNKNOWN, err && err.message ? err.message : 'Fallo desconocido', {
          stage: 'unknown', cause: err,
        });
    e.duration_ms = Date.now() - startedAt;
    e.file = filename;
    // Limpieza idempotente: sólo el primer camino de salida borra el temporal.
    if (!cleaned) {
      cleaned = true;
      e.temp_removed = await safeUnlink(tmpPath);
    }
    throw e;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    if (signal) { try { signal.removeEventListener('abort', onAbort); } catch { /* noop */ } }
  }
}

/** Cancela el backup en curso (apagado del servicio). No falla si no hay ninguno. */
function cancelActiveBackup(reason = 'shutdown') {
  if (!_activeCancel) return false;
  _activeCancel(reason);
  return true;
}

async function runBackupWithUpload(opts = {}) {
  const result = await runBackup(opts);
  // Upload off-site (no bloqueante — falla silenciosa si no hay config)
  try {
    const { uploadBackup } = require('./backupUpload');
    const uploadResult = await uploadBackup(result.path, result.filename);
    result.upload = uploadResult;
  } catch (err) {
    logger.warn('Backup off-site falló (local OK)', { error_code: 'BACKUP_UPLOAD_FAILED', message: err && err.message });
    result.upload_error = err && err.message ? err.message : 'upload falló';
  }
  return result;
}

async function purgeOldBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return 0;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = await fsp.readdir(BACKUP_DIR);
  let removed = 0;
  for (const f of files) {
    if (!BACKUP_RE.test(f)) continue;
    const fp = path.join(BACKUP_DIR, f);
    // Un archivo ilegible no puede abortar la purga del resto.
    try {
      const st = await fsp.stat(fp);
      if (st.mtimeMs < cutoff) { await fsp.unlink(fp); removed++; }
    } catch { /* desaparecido o sin permisos: se ignora */ }
  }
  return removed;
}

/** Barre temporales huérfanos (proceso muerto por SIGKILL a mitad de un backup). */
async function purgeStaleTemps(maxAgeMs = TEMP_SWEEP_MS) {
  if (!fs.existsSync(BACKUP_DIR)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  let files = [];
  try { files = await fsp.readdir(BACKUP_DIR); } catch { return 0; }
  for (const f of files) {
    if (!TEMP_RE.test(f)) continue;
    try {
      const st = await fsp.stat(path.join(BACKUP_DIR, f));
      if (st.mtimeMs < cutoff) { await fsp.unlink(path.join(BACKUP_DIR, f)); removed++; }
    } catch { /* ignorado */ }
  }
  return removed;
}

async function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  const files = await fsp.readdir(BACKUP_DIR);
  const out = [];
  for (const f of files) {
    if (!BACKUP_RE.test(f)) continue;
    try {
      const st = await fsp.stat(path.join(BACKUP_DIR, f));
      out.push({ filename: f, size: st.size, created_at: st.mtime });
    } catch { /* borrado entre readdir y stat */ }
  }
  return out.sort((a, b) => b.created_at - a.created_at);
}

/** Log estructurado del fallo: código estable, sin credenciales ni rutas del servidor. */
function logBackupFailure(err, extra = {}) {
  const e = err || {};
  logger.error('❌ Backup automático falló', {
    job: 'db_backup',
    error_code: e.code || BACKUP_ERROR_CODES.UNKNOWN,
    message: e.message || 'sin mensaje',
    stage: e.stage || 'unknown',
    exit_code: e.exit_code ?? null,
    signal: e.signal ?? null,
    duration_ms: e.duration_ms ?? null,
    file: sanitizePath(e.file),
    temp_removed: e.temp_removed ?? null,
    detail: e.stderr_excerpt || undefined,
    ...extra,
  });
}

/**
 * Corrida programada. No rechaza nunca: el cron no sabe esperar promesas,
 * así que cualquier escape terminaría en unhandledRejection.
 */
async function runScheduledBackup() {
  const startedAt = Date.now();
  try {
    logger.info('🗄️  Iniciando backup automático de BD...');
    const result = await runBackupWithUpload();
    let purged = 0, temps = 0;
    try {
      purged = await purgeOldBackups();
      temps  = await purgeStaleTemps();
    } catch (err) {
      logger.warn('Purga de backups falló', { job: 'db_backup', message: err && err.message });
    }
    logger.info(`✅ Backup OK: ${result.filename} (${(result.size/1024/1024).toFixed(2)} MB). Purgados: ${purged}`, {
      job: 'db_backup', duration_ms: result.duration_ms, size: result.size, purged, temps_removed: temps,
    });
    return { ok: true, result };
  } catch (err) {
    logBackupFailure(err, { duration_ms: err && err.duration_ms != null ? err.duration_ms : Date.now() - startedAt });
    return { ok: false, error_code: (err && err.code) || BACKUP_ERROR_CODES.UNKNOWN };
  }
}

function startBackupCron() {
  const expr = process.env.BACKUP_CRON || '0 2 * * *'; // 2 AM diario
  if (process.env.BACKUP_DISABLED === '1') {
    logger.info('⏸️  Backups automáticos deshabilitados (BACKUP_DISABLED=1)');
    return;
  }
  if (!cron.validate(expr)) {
    logger.warn(`Expresión cron inválida para backups: ${expr}`);
    return;
  }
  if (_job) _job.stop();
  // El callback es sincrónico a propósito: node-cron no espera la promesa,
  // y runScheduledBackup ya absorbe todos los errores.
  _job = cron.schedule(expr, () => { void runScheduledBackup(); },
    { timezone: process.env.CRON_TZ || 'America/Asuncion' });
  logger.info(`📅 Cron de backups activo: ${expr}, retención ${RETENTION_DAYS} días, dir ${BACKUP_DIR}`);
}

function stopBackupCron({ cancelRunning = true } = {}) {
  if (_job) { _job.stop(); _job = null; }
  if (cancelRunning) cancelActiveBackup('shutdown');
}

module.exports = {
  BACKUP_DIR,
  BACKUP_ERROR_CODES,
  BackupError,
  runBackup,
  runBackupWithUpload,
  runScheduledBackup,
  purgeOldBackups,
  purgeStaleTemps,
  listBackups,
  startBackupCron,
  stopBackupCron,
  cancelActiveBackup,
  sanitizeStderr,
  sanitizePath,
  __setTestHooks,
};
