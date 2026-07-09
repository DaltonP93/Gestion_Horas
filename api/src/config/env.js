/**
 * env.js — Validación de configuración al arranque.
 *
 * Falla rápido y con un mensaje claro si falta una variable crítica o tiene un
 * valor inseguro, en vez de arrancar y romper por request en runtime.
 *
 * En NODE_ENV=production se exigen los secretos (JWT, BD). En desarrollo se
 * permiten defaults locales para no fricción, pero se avisa.
 */
const Joi = require('joi');

const isProd = process.env.NODE_ENV === 'production';

// En producción los secretos son obligatorios; en dev se permite ausencia.
const requiredInProd = (schema) => (isProd ? schema.required() : schema.optional());

const schema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().port().default(4000),

  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().port().default(3306),
  DB_NAME: Joi.string().default('asistencia'),
  DB_USER: Joi.string().default('root'),
  DB_PASSWORD: requiredInProd(Joi.string().min(1)),

  // Un JWT_SECRET débil permite forjar tokens: se exige longitud mínima en prod.
  JWT_SECRET: isProd
    ? Joi.string().min(32).required()
    : Joi.string().default('dev_jwt_secret_change_me'),
  JWT_REFRESH_SECRET: isProd
    ? Joi.string().min(32).required()
    : Joi.string().default('dev_refresh_secret_change_me'),

  REDIS_URL: Joi.string().default('redis://localhost:6379'),
  FRONTEND_URL: Joi.string().uri().default('http://localhost:3000'),

  // Claves de servicios internos (obligatorias en prod si se usan).
  BRIDGE_API_KEY: requiredInProd(Joi.string().min(16)),
  ANALYTICS_API_KEY: requiredInProd(Joi.string().min(16)),
  ANALYTICS_URL: Joi.string().uri().default('http://localhost:5000'),
})
  .unknown(true); // no bloquear otras variables del entorno

const { error, value } = schema.validate(process.env, { abortEarly: false });

if (error) {
  // eslint-disable-next-line no-console
  console.error('❌ Configuración de entorno inválida:');
  for (const d of error.details) console.error(`   - ${d.message}`);
  console.error('Revisá el archivo .env (ver .env.example).');
  process.exit(1);
}

module.exports = { env: value, isProd };
