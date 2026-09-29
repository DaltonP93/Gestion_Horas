/**
 * employeeDocumentsUpload.test.js — carga de documentos de empleados (HTTP real).
 *
 * Router REAL montado como en index.js, authenticate/authorize/
 * requirePermission/enforceEmployeeScope REALES, multer real y archivos reales
 * en un UPLOAD_DIR temporal. Sólo la base está simulada (datos sintéticos).
 *
 *   - el tipo lo decide el CONTENIDO (extensión y MIME declarados no bastan);
 *   - PDF sin terminador, imagen truncada, ZIP truncado, ZIP que no es OOXML
 *     y paquetes con macros → 400 sin archivo;
 *   - PDF, PNG, DOCX y XLSX legítimos → 201 con la extensión y el MIME reales;
 *   - autorización (rol, capacidad, id, existencia) ANTES de escribir en disco;
 *   - fallo del SELECT o del INSERT → sin huérfanos; los archivos previos de
 *     otros registros no se tocan.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sishoras-docs-'));
process.env.UPLOAD_DIR = TMP;
process.env.JWT_SECRET = 'test-secret-employee-docs-0123456789';

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { sequelize } = require('../src/config/database');
const audit = require('../src/services/audit');

const DOC_DIR = path.join(TMP, 'employee-documents');
const USERS = {
  1: { id: 1, username: 'hr1', role: 'hr', active: 1, employee_id: null },
  7: { id: 7, username: 'emp7', role: 'employee', active: 1, employee_id: 100 },
  9: { id: 9, username: 'gth9', role: 'gth', active: 1, employee_id: null },
};
const EMPLOYEES = { 100: { id: 100, department_id: 1 } };
let inserts;
let failOn; // RegExp: la próxima query que coincida lanza

function installDb() {
  sequelize.query.mockImplementation(async (sql, opts = {}) => {
    const rp = opts.replacements || [];
    if (failOn && failOn.test(sql)) { failOn = null; throw new Error('ER_LOCK_WAIT_TIMEOUT'); }
    if (/FROM users WHERE id = \? LIMIT 1/.test(sql)) { const u = USERS[rp[0]]; return [u ? [u] : []]; }
    if (/FROM user_permissions/.test(sql)) {
      // gth9 con denegación explícita de empleados.update
      return [rp[0] === 9 ? [{ module: 'empleados', can_view: 1, can_create: 0, can_update: 0, can_delete: 0 }] : []];
    }
    if (/SELECT department_id FROM employees WHERE id = \?/.test(sql)) { const e = EMPLOYEES[rp[0]]; return [e ? [e] : []]; }
    if (/SELECT id FROM employees WHERE id = \? LIMIT 1/.test(sql)) { const e = EMPLOYEES[rp[0]]; return [e ? [{ id: e.id }] : []]; }
    if (/INSERT INTO employee_documents/.test(sql)) { inserts.push(rp); return [{ insertId: 50 + inserts.length }]; }
    return [[]];
  });
}

let server; let base;
const token = (id) => jwt.sign({ id, role: USERS[id].role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
const docFiles = () => fs.readdirSync(DOC_DIR).sort();

function post(empId, userId, { buf, name, type, fields = {} } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (buf) fd.append('file', new Blob([buf], { type }), name);
  return fetch(`${base}/api/employees/${empId}/documents`, {
    method: 'POST',
    headers: userId ? { Authorization: `Bearer ${token(userId)}` } : {},
    body: fd,
  });
}

// ── Generadores de archivos sintéticos ────────────────────────────────────
const PDF_OK = Buffer.from(`%PDF-1.7\n${'x'.repeat(200)}\n%%EOF\n`);
const PDF_TRUNC = Buffer.from(`%PDF-1.7\n${'x'.repeat(200)}\n`);
const png = () => sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();

/** ZIP mínimo (método STORE) con las entradas dadas. */
function makeZip(entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const nm = Buffer.from(name);
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nm, data); centrals.push(ch, nm);
    offset += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  const n = Object.keys(entries).length;
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(n, 8); eocd.writeUInt16LE(n, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
const DOCX = () => makeZip({ '[Content_Types].xml': CT, '_rels/.rels': '<r/>', 'word/document.xml': '<w:document/>' });
const DOCM = () => makeZip({ '[Content_Types].xml': CT, 'word/document.xml': '<w:document/>', 'word/vbaProject.bin': 'VBA' });
const NOT_OOXML = () => makeZip({ 'hola.txt': 'no soy un documento' });
async function realXlsx() {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Hoja').addRow(['sintético', 1]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

beforeAll(async () => {
  installDb();
  const app = express();
  app.use(express.json());
  app.use('/api/employees/:id/documents', require('../src/routes/employeeDocuments'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: 'Error' }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});
beforeEach(() => {
  inserts = [];
  failOn = null;
  installDb();
  audit.log.mockClear();
  // Archivo de un registro EXISTENTE: nunca debe tocarse.
  fs.writeFileSync(path.join(DOC_DIR, 'doc_1_previo.pdf'), PDF_OK);
  for (const f of docFiles()) if (f !== 'doc_1_previo.pdf') fs.unlinkSync(path.join(DOC_DIR, f));
});

describe('contenido', () => {
  test.each([
    ['texto presentado como PDF (extensión y MIME de PDF)', () => Buffer.from('esto es texto plano, no un PDF '.repeat(10)), 'cert.pdf', 'application/pdf'],
    ['PDF sin terminador %%EOF', () => PDF_TRUNC, 'cert.pdf', 'application/pdf'],
    ['PNG truncado', async () => (await png()).subarray(0, 40), 'foto.png', 'image/png'],
    ['ZIP truncado presentado como DOCX', () => DOCX().subarray(0, 60), 'c.docx', MIME_DOCX],
    ['ZIP que no es OOXML presentado como DOCX', NOT_OOXML, 'c.docx', MIME_DOCX],
    ['paquete con macros presentado como DOCX', DOCM, 'c.docx', MIME_DOCX],
    ['texto con MIME de XLSX', () => Buffer.from('a,b,c\n1,2,3\n'), 'x.xlsx', MIME_XLSX],
  ])('%s → 400, sin archivo nuevo ni INSERT', async (_n, make, name, type) => {
    const r = await post(100, 1, { buf: await make(), name, type });
    expect(r.status).toBe(400);
    expect(docFiles()).toEqual(['doc_1_previo.pdf']);
    expect(inserts).toHaveLength(0);
    expect(audit.log).not.toHaveBeenCalled();
  });

  test.each([
    ['PDF', () => PDF_OK, 'cert.pdf', 'application/pdf', 'pdf', 'application/pdf'],
    ['PNG', png, 'foto.png', 'image/png', 'png', 'image/png'],
    ['DOCX', DOCX, 'contrato.docx', MIME_DOCX, 'docx', MIME_DOCX],
    ['XLSX (generado con exceljs)', realXlsx, 'planilla.xlsx', MIME_XLSX, 'xlsx', MIME_XLSX],
    ['PNG declarado como PDF: manda el contenido', png, 'raro.pdf', 'application/pdf', 'png', 'image/png'],
  ])('%s legítimo → 201 con extensión y MIME reales', async (_n, make, name, type, ext, mime) => {
    const r = await post(100, 1, { buf: await make(), name, type, fields: { category: 'contract' } });
    expect(r.status).toBe(201);
    const created = docFiles().filter((f) => f !== 'doc_1_previo.pdf');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(new RegExp(`^doc_\\d+_[0-9a-f]{16}\\.${ext}$`));
    expect(inserts).toHaveLength(1);
    expect(inserts[0][5]).toBe(`employee-documents/${created[0]}`); // path
    expect(inserts[0][7]).toBe(mime);                                // mime detectado
    expect(inserts[0][4]).toBe(name);                                // nombre original sólo como metadato
  });

  test('categoría o período inválidos → 400 y se retira el archivo recién subido', async () => {
    expect((await post(100, 1, { buf: PDF_OK, name: 'a.pdf', type: 'application/pdf', fields: { category: 'zzz' } })).status).toBe(400);
    expect((await post(100, 1, { buf: PDF_OK, name: 'a.pdf', type: 'application/pdf', fields: { category: 'payslip', period: '2026-13' } })).status).toBe(400);
    expect(docFiles()).toEqual(['doc_1_previo.pdf']);
  });

  test('MIME declarado fuera de la lista → 400 sin escribir', async () => {
    const r = await post(100, 1, { buf: PDF_OK, name: 'a.exe', type: 'application/x-msdownload' });
    expect(r.status).toBe(400);
    expect(docFiles()).toEqual(['doc_1_previo.pdf']);
  });
});

describe('autorización previa (nada se escribe en disco)', () => {
  test.each([
    ['sin token', 100, null, 401],
    ['employee (rol no autorizado)', 100, 7, 403],
    ['gth con denegación explícita de empleados.update', 100, 9, 403],
    ['empleado inexistente', 999, 1, 404],
    ["id no canónico '1e2'", '1e2', 1, 400],
  ])('%s → HTTP esperado, sin escritura', async (_n, emp, user, status) => {
    const r = await post(emp, user, { buf: PDF_OK, name: 'a.pdf', type: 'application/pdf' });
    expect(r.status).toBe(status);
    expect(docFiles()).toEqual(['doc_1_previo.pdf']);
    expect(inserts).toHaveLength(0);
  });
});

describe('fallas de base', () => {
  test('falla el SELECT del empleado → 5xx, sin archivo (el control corre antes de multer)', async () => {
    failOn = /SELECT id FROM employees WHERE id = \? LIMIT 1/;
    const r = await post(100, 1, { buf: PDF_OK, name: 'a.pdf', type: 'application/pdf' });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(docFiles()).toEqual(['doc_1_previo.pdf']);
  });

  test('falla el INSERT → 500 genérico, se retira SÓLO el archivo nuevo; el previo sigue', async () => {
    failOn = /INSERT INTO employee_documents/;
    const r = await post(100, 1, { buf: await png(), name: 'foto.png', type: 'image/png' });
    expect(r.status).toBe(500);
    expect(await r.text()).not.toMatch(/ER_LOCK/);
    expect(docFiles()).toEqual(['doc_1_previo.pdf']);
    expect(fs.readFileSync(path.join(DOC_DIR, 'doc_1_previo.pdf')).equals(PDF_OK)).toBe(true);
    expect(audit.log).not.toHaveBeenCalled();
  });
});
