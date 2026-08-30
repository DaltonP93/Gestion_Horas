/**
 * workdayAuditReadonly.test.js — El auditor no puede escribir.
 *
 * `scripts/workday-engine-audit.js` corre contra la base de PRODUCCIÓN. Su
 * garantía es que sólo lee, y una garantía que vive únicamente en un comentario
 * del encabezado se pierde en la primera edición apurada.
 *
 * Este test la vuelve mecánica: revisa el fuente y falla si aparece una
 * sentencia de escritura o cualquier referencia a ATT2000. Es grosero —mira
 * texto, no un AST— y esa es la idea: no pretende demostrar que el script es
 * correcto, sino frenar el cambio evidente que rompa la promesa.
 */

const fs = require('fs');
const path = require('path');

/**
 * Los tres scripts que corren contra la base de producción. Todos prometen lo
 * mismo y todos tienen que cumplirlo.
 */
const SCRIPTS = [
  'workday-engine-audit.js',
  'daily-summary-dryrun.js',
  'benchmark-marcadas-memory.js',
  'workday-config-preflight.js',
];

/** Quita comentarios: el encabezado NOMBRA las sentencias prohibidas. */
function sinComentarios(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe.each(SCRIPTS)('%s es de sólo lectura', (script) => {
  const fuente = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', script), 'utf8');
  const codigo = sinComentarios(fuente);

  test.each([
    ['INSERT', /\bINSERT\s+INTO\b/i],
    ['UPDATE', /\bUPDATE\s+\w/i],
    ['DELETE', /\bDELETE\s+FROM\b/i],
    ['REPLACE', /\bREPLACE\s+INTO\b/i],
    ['TRUNCATE', /\bTRUNCATE\b/i],
    ['DROP', /\bDROP\s+(TABLE|DATABASE)\b/i],
    ['ALTER', /\bALTER\s+TABLE\b/i],
  ])('no contiene ninguna sentencia %s', (_nombre, patron) => {
    expect(codigo).not.toMatch(patron);
  });

  test('no requiere el conector de ATT2000', () => {
    // ATT2000 tiene que quedar intacto, y la forma más segura de garantizarlo
    // es que el script ni siquiera sepa cómo conectarse. Se controlan los
    // `require` y las variables de entorno, no la palabra: el texto de ayuda
    // menciona ATT2000 justamente para prometer que no lo toca.
    expect(codigo).not.toMatch(/require\([^)]*att2000[^)]*\)/i);
    expect(codigo).not.toMatch(/require\(['"]mssql['"]\)/);
    expect(codigo).not.toMatch(/process\.env\.ATT/);
  });

  test('sus consultas son SELECT', () => {
    // El benchmark no consulta directamente: llama al reporte, que ya está
    // cubierto por sus propios tests. Por eso no se exige que tenga consultas
    // propias, sólo que las que tenga sean de lectura.
    for (const q of codigo.match(/sequelize\.query\(`([\s\S]*?)`/g) || []) {
      expect(q).toMatch(/SELECT/i);
    }
  });

  test('no expone valores de credenciales por consola', () => {
    // Se puede informar QUÉ archivo .env se usó; nunca lo que contiene.
    expect(codigo).not.toMatch(/process\.env\.(DB_PASSWORD|DB_USER|JWT_SECRET)/);
  });
});
