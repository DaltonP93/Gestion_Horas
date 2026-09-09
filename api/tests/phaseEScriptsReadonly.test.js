'use strict';

/**
 * phaseEScriptsReadonly.test.js — red de regresión estática (barata) que
 * protege que los scripts read-only de FASE E NO adquieran una escritura ni una
 * dependencia de att2000 por descuido antes del rollout.
 *
 * Extiende el patrón de `migrateStatusReadonly.test.js` (un solo script) a todos
 * los lectores del rollout. No EJECUTA los scripts: inspecciona su fuente.
 *
 * Qué asegura por script:
 *   1. No contiene una sentencia de ESCRITURA/DDL ejecutable
 *      (INSERT/UPDATE/DELETE/REPLACE/TRUNCATE/ALTER/DROP, o un CREATE TABLE real
 *       con definición). Menciones descriptivas en comentarios o console.log no
 *      cuentan (se ignoran comentarios y se exige forma de sentencia real).
 *   2. No importa ningún módulo de att2000 ni referencia su tabla `CHECKINOUT`
 *      (att2000 es estrictamente READ-ONLY y estos lectores no deben tocarla).
 */

const fs = require('fs');
const path = require('path');

const SCRIPTS = [
  'workday-config-preflight.js',
  'workday-config-impact-audit.js',
  'daily-summary-dryrun.js',
  'workday-engine-audit.js',
  'check-schema-drift.js',
  'phase-e-preflight.js',
];

// Quita comentarios de línea y de bloque para no marcar menciones descriptivas
// ("CREATE TABLE IF NOT EXISTS)." dentro de un comentario, p. ej.).
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // no toca "http://"
}

// Sentencias de escritura/DDL con forma REAL (evita falsos positivos por texto):
//   - UPDATE <tabla> SET …            (no "UPDATE" suelto en prosa)
//   - INSERT/REPLACE INTO <tabla>
//   - DELETE FROM <tabla>
//   - TRUNCATE [TABLE] <tabla>
//   - ALTER/DROP TABLE <tabla>
//   - CREATE TABLE [IF NOT EXISTS] <tabla> (  ← con paréntesis de definición
const WRITE_PATTERNS = [
  /\bUPDATE\s+`?\w+`?\s+SET\b/i,
  /\b(?:INSERT|REPLACE)\s+INTO\s+`?\w+`?/i,
  /\bDELETE\s+FROM\s+`?\w+`?/i,
  /\bTRUNCATE\s+(?:TABLE\s+)?`?\w+`?/i,
  /\b(?:ALTER|DROP)\s+TABLE\s+`?\w+`?/i,
  /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?\w+`?\s*\(/i,
];

// Meta-test: el guard tiene DIENTES (detecta escrituras reales) y NO marca las
// menciones descriptivas — si esto se rompe, el resto del guard no vale nada.
describe('WRITE_PATTERNS — cobertura del detector', () => {
  const matchesAny = (s) => WRITE_PATTERNS.some((re) => re.test(s));
  test('detecta sentencias de escritura/DDL reales', () => {
    for (const s of [
      "INSERT INTO daily_summary (a) VALUES (1)",
      "UPDATE daily_summary SET status = 'x'",
      'DELETE FROM attendance_logs WHERE id = 1',
      'REPLACE INTO t (a) VALUES (1)',
      'TRUNCATE TABLE t',
      'ALTER TABLE t ADD COLUMN c INT',
      'DROP TABLE t',
      'CREATE TABLE IF NOT EXISTS schema_migrations (id INT)',
    ]) {
      expect(matchesAny(s)).toBe(true);
    }
  });
  test('NO marca menciones descriptivas (comentarios / console.log)', () => {
    for (const s of [
      '// aparece "CREATE TABLE IF NOT EXISTS)." en un comentario',
      "console.log('con CREATE TABLE IF NOT EXISTS — es la única que ejecuta')",
      'SELECT * FROM INFORMATION_SCHEMA.COLUMNS',
      'const updated = rows.length; // update contador local',
    ]) {
      expect(matchesAny(s)).toBe(false);
    }
  });
});

describe('scripts read-only de FASE E — guard estático', () => {
  for (const name of SCRIPTS) {
    describe(name, () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', name), 'utf8');
      const code = stripComments(src);

      test('no contiene una sentencia de escritura/DDL ejecutable', () => {
        for (const re of WRITE_PATTERNS) {
          const m = code.match(re);
          expect(m ? `${name}: ${m[0]}` : null).toBeNull();
        }
      });

      test('no importa att2000 ni referencia CHECKINOUT', () => {
        expect(src).not.toMatch(/require\(\s*['"][^'"]*att2000/i);
        expect(src).not.toMatch(/\bCHECKINOUT\b/);
      });
    });
  }
});
