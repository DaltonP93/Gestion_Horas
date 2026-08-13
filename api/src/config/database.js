const { Sequelize } = require('sequelize');
const logger = require('./logger');

/**
 * Offset fijo con el que el driver interpreta las columnas DATETIME.
 *
 * Se exporta porque quien lee una hora de la base tiene que poder deshacer
 * exactamente esta misma conversión para recuperar la hora de pared guardada
 * (ver utils/dbTime.js). Mientras el valor viva sólo dentro del objeto de
 * configuración, cualquier formateo tiene que adivinarlo.
 *
 * OJO: no es equivalente a la zona `America/Asuncion`. Paraguay observó
 * horario de verano hasta el 2024-10-06 y estuvo en UTC-4 durante los
 * inviernos anteriores; este offset es fijo. Esa discrepancia es el origen
 * del desfase histórico documentado en docs/auditoria-reportes.md, y no se
 * resuelve acá.
 */
const DB_TIMEZONE = '-03:00';

const sequelize = new Sequelize(
  process.env.DB_NAME || 'asistencia',
  process.env.DB_USER || 'root',
  process.env.DB_PASSWORD ?? '',
  {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    dialect: 'mysql',
    timezone: DB_TIMEZONE,
    logging: msg => logger.debug(msg),
    pool: {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    define: {
      underscored: true,
      timestamps: true
    }
  }
);

module.exports = { sequelize, DB_TIMEZONE };
