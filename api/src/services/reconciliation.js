/**
 * reconciliation.js
 * Job nocturno que compara attendance_logs (MySQL) vs CHECKINOUT (att2000)
 * y registra las discrepancias en reconciliation_report.
 *
 * Se ejecuta si RECONCILIATION_CRON está configurado en .env.
 * Default recomendado: "30 3 * * *" — 3:30 AM.
 */

const cron = require('node-cron');
const { cronCallback } = require('../utils/cronRunner');
const { serializeError, safeErrorCode } = require('../utils/errorInfo');
const { parseCivilDate, civilDateISO } = require('../utils/civilDate');
const { HttpError } = require('../utils/asyncHandler');
const { sequelize } = require('../config/database');
const logger = require('../config/logger');

async function runReconciliation(dateStr) {
  const raw = dateStr || new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  // Validación estricta ANTES de tocar cualquier base (en especial att2000):
  // `date` llega desde POST /api/sync/reconcile y antes se interpolaba crudo en
  // la consulta a SQL Server (inyección hacia una fuente READ-ONLY). Sólo se
  // admite una fecha civil real. Para una cadena se exige que sea EXACTAMENTE
  // 'YYYY-MM-DD' (sin sufijos): así un payload como "2026-01-01'; DROP TABLE…"
  // se rechaza en vez de aceptarse por su prefijo. El resultado se normaliza a
  // 'YYYY-MM-DD' canónico y luego viaja parametrizado.
  let parsed = null;
  if (raw instanceof Date) {
    parsed = parseCivilDate(raw);
  } else if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
    parsed = parseCivilDate(raw.trim());
  }
  if (!parsed) {
    throw new HttpError(400, 'Fecha inválida: se espera formato YYYY-MM-DD (fecha civil real)');
  }
  const date = civilDateISO(parsed);
  logger.info(`🔍 Reconciliación att2000 vs MySQL para ${date}...`);

  // Contar en MySQL
  const [[mysqlRow]] = await sequelize.query(`
    SELECT COUNT(*) AS cnt FROM attendance_logs
    WHERE DATE(timestamp) = ?
  `, { replacements: [date] });

  // Contar en att2000
  let att2000Count = 0;
  let diff = { missingInMysql: [], missingInAtt2000: [] };
  try {
    const { queryAtt2000 } = require('../config/att2000');
    // Formatear la hora en cada motor (wall-clock local) para comparar sin que
    // los drivers reinterpreten la zona: MySQL y SQL Server guardan la hora
    // local de Paraguay; convertir a Date en JS producía un desfase de 3 h que
    // marcaba TODOS los marcajes como diferentes.
    // Parametrizado: `date` viaja como parámetro nombrado (@date) — nunca
    // interpolado en el texto SQL. Sigue siendo una lectura (SELECT): att2000
    // es ESTRICTAMENTE READ-ONLY.
    const att2000Rows = await queryAtt2000(`
      SELECT USERID, CONVERT(varchar(19), CHECKTIME, 120) AS ts FROM CHECKINOUT
      WHERE CAST(CHECKTIME AS DATE) = @date
    `, { date });
    att2000Count = att2000Rows.length;

    // Comparar: marcajes en att2000 que no estén en MySQL (por user code + hora)
    const [mysqlLogs] = await sequelize.query(`
      SELECT e.code, DATE_FORMAT(al.timestamp, '%Y-%m-%d %H:%i:%s') AS ts
      FROM attendance_logs al
      JOIN employees e ON al.employee_id = e.id
      WHERE DATE(al.timestamp) = ?
    `, { replacements: [date] });

    const norm = (s) => String(s || '').replace('T', ' ').slice(0, 19);
    const mysqlSet = new Set(mysqlLogs.map(r => `${r.code}|${norm(r.ts)}`));
    const attSet = new Set(att2000Rows.map(r => `${r.USERID}|${norm(r.ts)}`));

    for (const k of attSet) if (!mysqlSet.has(k)) diff.missingInMysql.push(k);
    for (const k of mysqlSet) if (!attSet.has(k)) diff.missingInAtt2000.push(k);
  } catch (err) {
    logger.error(`Reconciliación: att2000 inaccesible — ${err.message}`);
    return { date, error: err.message };
  }

  const summary = {
    date,
    mysqlCount: mysqlRow.cnt,
    att2000Count,
    missingInMysql: diff.missingInMysql.length,
    missingInAtt2000: diff.missingInAtt2000.length,
    samplesMissingInMysql: diff.missingInMysql.slice(0, 10),
    samplesMissingInAtt2000: diff.missingInAtt2000.slice(0, 10),
  };

  // Persistir en tabla reconciliation_report (si existe)
  try {
    await sequelize.query(`
      INSERT INTO reconciliation_report (report_date, mysql_count, att2000_count,
        missing_in_mysql, missing_in_att2000, samples_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        mysql_count = VALUES(mysql_count),
        att2000_count = VALUES(att2000_count),
        missing_in_mysql = VALUES(missing_in_mysql),
        missing_in_att2000 = VALUES(missing_in_att2000),
        samples_json = VALUES(samples_json),
        created_at = NOW()
    `, { replacements: [
      date, summary.mysqlCount, summary.att2000Count,
      summary.missingInMysql, summary.missingInAtt2000,
      JSON.stringify({
        mysql: summary.samplesMissingInMysql,
        att2000: summary.samplesMissingInAtt2000
      })
    ]});
  } catch (e) {
    logger.warn(`reconciliation_report no existe aún — saltando persistencia: ${e.message}`);
  }

  logger.info(`✅ Reconciliación ${date}: MySQL=${summary.mysqlCount}, att2000=${summary.att2000Count}, ` +
              `faltan en MySQL=${summary.missingInMysql}, faltan en att2000=${summary.missingInAtt2000}`);
  return summary;
}

let _job = null;
function startReconciliationCron() {
  const expr = process.env.RECONCILIATION_CRON;
  if (!expr) return;
  if (_job) _job.stop();
  try {
    _job = cron.schedule(expr, cronCallback('reconciliacion', () => runReconciliation()));
    logger.info(`📅 Cron reconciliación activo: ${expr}`);
  } catch (err) {
    logger.error('No se pudo registrar RECONCILIATION_CRON', {
      job: 'reconciliacion', result: 'error',
      error_code: safeErrorCode(err), error: serializeError(err, { stage: 'register' }),
    });
  }
}

module.exports = { runReconciliation, startReconciliationCron };
