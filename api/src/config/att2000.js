/**
 * att2000.js
 * Conexión a la base de datos SQL Server del
 * ZKTeco Fingerprint Attendance System (att2000).
 *
 * ATT2000 ES ESTRICTAMENTE READ-ONLY.
 *
 * Este conector expone ÚNICAMENTE operaciones de lectura (importar datos al
 * MySQL propio). La capacidad de escritura fue eliminada a propósito: att2000
 * vive en el entorno ADVENTISTA y es la base fuente, no un destino. No debe
 * existir ningún camino de INSERT/UPDATE/DELETE sobre CHECKINOUT ni ninguna
 * otra tabla de att2000 desde Gestion_Horas. `attendanceReadonly.test.js`
 * verifica que este módulo no contiene DML ejecutable ni exporta un writer.
 *
 * Variables necesarias en .env:
 *   ATT_HOST=ADVENTISTA       (nombre o IP del servidor SQL Server)
 *   ATT_PORT=1433
 *   ATT_USER=sa
 *   ATT_PASSWORD=tu_password
 *   ATT_DATABASE=att2000
 */

const sql = require('mssql');
const logger = require('./logger');

const config = {
  server:   process.env.ATT_HOST     || 'ADVENTISTA',
  port:     parseInt(process.env.ATT_PORT || '1433'),
  user:     process.env.ATT_USER     || 'sa',
  password: process.env.ATT_PASSWORD || '',
  database: process.env.ATT_DATABASE || 'att2000',
  options: {
    encrypt:                false,  // false para red local/interna
    trustServerCertificate: true,   // para SQL Server con cert autofirmado
    enableArithAbort:       true,
  },
  pool: {
    max: 5,
    min: 0,
    idleTimeoutMillis: 30000
  },
  connectionTimeout: 15000,
  requestTimeout:    30000,
};

let pool = null;
let poolHost = null;  // host con el que se creó el pool actual

async function getAtt2000() {
  const currentHost = process.env.ATT_HOST || 'ADVENTISTA';

  // Si el host cambió, cerrar el pool viejo y reconectar
  if (pool && poolHost !== currentHost) {
    logger.info(`🔄 Host att2000 cambió (${poolHost} → ${currentHost}), reconectando...`);
    try { await pool.close(); } catch {}
    pool = null; poolHost = null;
  }

  if (pool && pool.connected) return pool;

  try {
    // Reconstruir config con los env vars actuales (pueden haber cambiado en runtime)
    const runtimeConfig = {
      ...config,
      server:   process.env.ATT_HOST     || 'ADVENTISTA',
      port:     parseInt(process.env.ATT_PORT || '1433'),
      user:     process.env.ATT_USER     || 'sa',
      password: process.env.ATT_PASSWORD ?? '',
      database: process.env.ATT_DATABASE || 'att2000',
    };
    pool = await new sql.ConnectionPool(runtimeConfig).connect();
    poolHost = runtimeConfig.server;
    logger.info(`✅ Conectado a SQL Server att2000 (${poolHost})`);
    return pool;
  } catch (err) {
    pool = null; poolHost = null;
    logger.error('❌ Error conectando a att2000:', err.message);
    throw err;
  }
}

// Resetear pool (llamar cuando cambian los parámetros de conexión)
function resetPool() {
  if (pool) { try { pool.close(); } catch {} }
  pool = null; poolHost = null;
  _columnsCache.clear();
  logger.info('🔄 Pool att2000 reseteado');
}

// ─── Introspección de schema ─────────────────────────────────────
// Cache en memoria: 'USERINFO' → Set(['USERID','Name',...])
const _columnsCache = new Map();

async function getTableColumns(table) {
  if (_columnsCache.has(table)) return _columnsCache.get(table);
  const db = await getAtt2000();
  const r = await db.request().input('t', sql.VarChar, table).query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t
  `);
  // Case-insensitive match (SQL Server devuelve el casing real)
  const cols = new Set(r.recordset.map(x => x.COLUMN_NAME));
  _columnsCache.set(table, cols);
  logger.info(`📋 ${table}: ${cols.size} columnas — ${[...cols].join(', ')}`);
  return cols;
}

// Devuelve la expresión SQL para una columna: si existe → "<prefix>COL", si no → "NULL AS COL"
function pickCol(colsSet, name, { prefix = '', alias = name } = {}) {
  // Match case-insensitive
  const real = [...colsSet].find(c => c.toLowerCase() === name.toLowerCase());
  return real ? `${prefix}${real} AS ${alias}` : `NULL AS ${alias}`;
}

async function queryAtt2000(sqlText, params = {}) {
  const db = await getAtt2000();
  const request = db.request();
  for (const [key, val] of Object.entries(params)) {
    request.input(key, val);
  }
  const result = await request.query(sqlText);
  return result.recordset;
}

async function testAtt2000Connection() {
  try {
    const rows = await queryAtt2000('SELECT COUNT(*) AS total FROM CHECKINOUT');
    logger.info(`✅ att2000 OK — Total marcajes: ${rows[0].total}`);
    return { ok: true, totalRecords: rows[0].total };
  } catch (err) {
    logger.error('❌ att2000 test fallido:', err.message);
    return { ok: false, error: err.message };
  }
}

// La escritura hacia att2000 fue ELIMINADA a propósito (att2000 es READ-ONLY).
// Antes existía `writeCheckinOut`, que hacía INSERT sobre CHECKINOUT. No se
// reemplaza por un stub tolerante: el conector simplemente no expone ninguna
// operación de escritura, para que no haya forma de invocarla por descuido.

module.exports = { getAtt2000, queryAtt2000, testAtt2000Connection, resetPool, getTableColumns, pickCol };
