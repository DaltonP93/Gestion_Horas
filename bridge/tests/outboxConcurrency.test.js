/**
 * Exclusión entre consumidores REALES (procesos, no objetos).
 *
 * Este archivo existe porque una prueba de mutación lo dejó en evidencia: se
 * podía quitar entera la transacción de `claimBatch` y los 37 tests del otro
 * archivo seguían pasando. No era un descuido de esos tests — es que la
 * garantía no se puede probar dentro de un proceso: better-sqlite3 es síncrono
 * y JavaScript de un solo hilo, así que dos "consumidores" en el mismo proceso
 * corren uno después del otro y jamás se interleavean.
 *
 * La garantía que justifica usar SQLite en vez de un archivo es que DOS
 * PROCESOS no se lleven la misma marcación. Para probarla hay que levantar dos
 * procesos.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createOutbox } = require('../src/outbox');
const { buildEvent } = require('../../contracts/punchContractV1');

let dir, dbPath;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sishoras-outbox-conc-'));
  dbPath = path.join(dir, 'outbox.db');
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

function marcacion(i) {
  const r = buildEvent({
    device_id: 7,
    device_user_id: String(2000 + i),
    occurred_at: `2026-03-11T09:${String(i % 60).padStart(2, '0')}:00-03:00`,
    event_type: 'in',
  });
  if (!r.ok) throw new Error('fixture inválido');
  return r.event;
}

/** Programa hijo: reclama un lote y escribe los event_id que se llevó. */
const HIJO = `
const path = require('path');
const { createOutbox } = require(process.argv[2]);
const o = createOutbox({ BRIDGE_OUTBOX_ENABLED: 'true', BRIDGE_OUTBOX_PATH: process.argv[3] });
const abierto = o.open();
if (!abierto.ok) { console.log(JSON.stringify({ error: abierto.error_code })); process.exit(0); }
// Espera activa hasta la marca de tiempo, para que los dos hijos entren juntos.
const arranque = Number(process.argv[5]);
while (Date.now() < arranque) { /* girar */ }
const r = o.claimBatch({ limit: Number(process.argv[4]) });
console.log(JSON.stringify({ ids: (r.events || []).map(e => e.event_id) }));
o.close();
`;

function reclamarEnProcesos({ cuantos = 2, limit = 10 }) {
  const script = path.join(dir, 'hijo.js');
  fs.writeFileSync(script, HIJO);
  const modulo = require.resolve('../src/outbox');
  const arranque = Date.now() + 400;   // margen para que ambos estén listos

  // Se lanzan en paralelo de verdad y se espera a todos.
  const { spawn } = require('child_process');
  const promesas = [];
  for (let i = 0; i < cuantos; i++) {
    promesas.push(new Promise((resolve) => {
      const p = spawn(process.execPath, [script, modulo, dbPath, String(limit), String(arranque)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      p.stdout.on('data', d => { out += d; });
      p.stderr.on('data', d => { err += d; });
      p.on('close', () => resolve({ out: out.trim(), err: err.trim() }));
    }));
  }
  return Promise.all(promesas);
}

describe('dos procesos concurrentes', () => {
  jest.setTimeout(30000);

  test('no se llevan la misma marcación', async () => {
    const o = createOutbox({ BRIDGE_OUTBOX_ENABLED: 'true', BRIDGE_OUTBOX_PATH: dbPath });
    expect(o.open().ok).toBe(true);
    for (let i = 1; i <= 40; i++) o.enqueue(marcacion(i));
    o.close();

    const resultados = await reclamarEnProcesos({ cuantos: 2, limit: 40 });

    const todos = [];
    for (const r of resultados) {
      expect(r.out).toBeTruthy();               // el hijo no murió
      const parsed = JSON.parse(r.out);
      expect(parsed.error).toBeUndefined();
      todos.push(...parsed.ids);
    }

    // La garantía: ninguna marcación reclamada dos veces.
    expect(new Set(todos).size).toBe(todos.length);
    // Y entre los dos se llevaron todo, sin perder ninguna.
    expect(todos).toHaveLength(40);
  });

  test('el estado final es coherente: nada queda en pending', async () => {
    const o = createOutbox({ BRIDGE_OUTBOX_ENABLED: 'true', BRIDGE_OUTBOX_PATH: dbPath });
    o.open();
    for (let i = 1; i <= 20; i++) o.enqueue(marcacion(i));
    o.close();

    await reclamarEnProcesos({ cuantos: 3, limit: 20 });

    const verificador = createOutbox({ BRIDGE_OUTBOX_ENABLED: 'true', BRIDGE_OUTBOX_PATH: dbPath });
    verificador.open();
    const s = verificador.stats();

    expect(s.by_status.pending).toBe(0);
    expect(s.by_status.sending).toBe(20);
    expect(s.total).toBe(20);
    verificador.close();
  });

  test('el archivo queda íntegro después del acceso concurrente', async () => {
    const o = createOutbox({ BRIDGE_OUTBOX_ENABLED: 'true', BRIDGE_OUTBOX_PATH: dbPath });
    o.open();
    for (let i = 1; i <= 15; i++) o.enqueue(marcacion(i));
    o.close();

    await reclamarEnProcesos({ cuantos: 3, limit: 15 });

    // `integrity_check` es la comprobación propia de SQLite: si el acceso
    // concurrente hubiera corrompido páginas, acá se ve.
    const salida = execFileSync(process.execPath, ['-e', `
      const D = require(${JSON.stringify(require.resolve('better-sqlite3'))});
      const db = new D(${JSON.stringify(dbPath)});
      console.log(db.pragma('integrity_check', { simple: true }));
      db.close();
    `], { encoding: 'utf8' }).trim();

    expect(salida).toBe('ok');
  });
});
