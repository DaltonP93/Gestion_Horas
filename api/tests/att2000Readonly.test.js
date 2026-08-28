/**
 * att2000Readonly.test.js — att2000 es ESTRICTAMENTE READ-ONLY.
 *
 * Regla absoluta del proyecto: Gestion_Horas NUNCA escribe en att2000 (la base
 * fuente SQL Server del entorno ADVENTISTA). No alcanza con que un env flag esté
 * en false: no debe existir NINGÚN camino de escritura.
 *
 * Estos tests inspeccionan el fuente —no una base real— para garantizar que:
 *   - el conector no contiene DML ejecutable sobre CHECKINOUT ni exporta un
 *     writer;
 *   - ningún consumidor conserva una llamada de escritura ni el viejo flag
 *     ATT2000_WRITE_ENABLED.
 *
 * Es un test de forma a propósito: la única forma de romper la garantía es
 * volver a introducir el código, y eso lo detecta acá antes de cualquier deploy.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('att2000 es read-only: sin DML ni writer', () => {
  test('el conector no tiene DML sobre CHECKINOUT', () => {
    const src = read('config/att2000.js');
    expect(src).not.toMatch(/INSERT\s+INTO\s+CHECKINOUT/i);
    expect(src).not.toMatch(/UPDATE\s+CHECKINOUT/i);
    expect(src).not.toMatch(/DELETE\s+FROM\s+CHECKINOUT/i);
    // Ni un writer genérico esperando ser cableado.
    expect(src).not.toMatch(/function\s+writeCheckinOut/);
  });

  test('el conector NO exporta ninguna operación de escritura', () => {
    const mod = require('../src/config/att2000');
    expect(mod.writeCheckinOut).toBeUndefined();
    // Sólo lectura/introspección expuesta.
    expect(typeof mod.queryAtt2000).toBe('function');
    expect(typeof mod.testAtt2000Connection).toBe('function');
    for (const clave of Object.keys(mod)) {
      expect(clave).not.toMatch(/write|insert|update|delete|push/i);
    }
  });

  test('ningún consumidor conserva una escritura a att2000 ni el flag viejo', () => {
    for (const rel of [
      'controllers/attendanceController.js',
      'services/zktecoReader.js',
      'routes/sync.js',
    ]) {
      const src = read(rel);
      expect(src).not.toMatch(/ATT2000_WRITE_ENABLED/);
      // No debe quedar una INVOCACIÓN de writeCheckinOut (un comentario que
      // explique su eliminación sí puede nombrarla, pero no `writeCheckinOut(`).
      expect(src).not.toMatch(/writeCheckinOut\s*\(/);
    }
  });
});
