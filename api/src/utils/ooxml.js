'use strict';

/**
 * ooxml.js — validación del PAQUETE real de un DOCX/XLSX subido.
 *
 * No alcanza con que el directorio central nombre las partes esperadas: se
 * lee el contenedor ZIP completo con límites de recursos y se valida el
 * paquete OPC por su contenido.
 *
 *  1. ZIP: EOCD único y coherente (sin ZIP64, sin multi-disco), cada entrada
 *     del directorio central tiene su cabecera local en el offset declarado
 *     con el mismo nombre/método/flags/tamaños; entradas sin solaparse; sin
 *     cifrado; métodos STORE o DEFLATE; descompresión con tope de salida y
 *     CRC-32 verificado; límites de entradas, tamaño por entrada, total y
 *     ratio de compresión; nombres sin rutas absolutas, `..`, `\` ni NUL y
 *     sin duplicados.
 *  2. XML: todas las partes .xml/.rels deben estar bien formadas. Se rechaza
 *     cualquier DOCTYPE/ENTITY (no se resuelven referencias externas: el
 *     verificador no expande entidades salvo las cinco predefinidas y las
 *     numéricas).
 *  3. OPC: `[Content_Types].xml` y `_rels/.rels` válidos; la relación
 *     `officeDocument` apunta a la parte principal, cuyo tipo de contenido
 *     decide DOCX o XLSX; su elemento raíz y namespace deben corresponder.
 *     Toda parte tiene tipo declarado y todo Override apunta a una parte real.
 *  4. Macros por contenido: tipos de contenido macroEnabled/vbaProject,
 *     relaciones de proyecto VBA o binarios OLE/CFB con un proyecto VBA
 *     dentro → rechazo, sin importar cómo se llamen las partes.
 *
 * Todo error se informa como `OoxmlError` (el llamador responde 400).
 */

const zlib = require('zlib');

const LIMITS = Object.freeze({
  maxEntries: 2000,
  maxNameLength: 512,
  maxEntryUncompressed: 32 * 1024 * 1024,
  maxTotalUncompressed: 64 * 1024 * 1024,
  maxRatio: 150,              // sólo se aplica a entradas grandes (ver abajo)
  ratioMinBytes: 1024 * 1024,
});

class OoxmlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OoxmlError';
  }
}
const bad = (m) => new OoxmlError(m);

// ── 1. Lector ZIP ─────────────────────────────────────────────────────────

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD_LOCATOR = 0x07064b50;

function findEocd(buf) {
  if (buf.length < 22) throw bad('ZIP truncado');
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) return i;
    }
  }
  throw bad('ZIP sin directorio central válido');
}

function checkName(name) {
  if (!name || name.length > LIMITS.maxNameLength) throw bad('Nombre de entrada inválido');
  if (name.includes('\0') || name.includes('\\')) throw bad('Nombre de entrada inválido');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw bad('Nombre de entrada inválido');
  if (name.split('/').some((s) => s === '..' || s === '.')) throw bad('Nombre de entrada inválido');
}

/**
 * Lee y valida el ZIP completo. Devuelve Map<nombre, Buffer> (sin directorios).
 * @param {Buffer} buf
 */
function readZip(buf) {
  if (!Buffer.isBuffer(buf)) throw bad('ZIP inválido');
  const eocd = findEocd(buf);
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_EOCD_LOCATOR) throw bad('ZIP64 no admitido');
  const diskNo = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesDisk = buf.readUInt16LE(eocd + 8);
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (diskNo !== 0 || cdDisk !== 0 || entriesDisk !== entries) throw bad('ZIP multi-volumen no admitido');
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw bad('ZIP64 no admitido');
  if (entries === 0 || entries > LIMITS.maxEntries) throw bad('Cantidad de entradas fuera de rango');
  if (cdOffset + cdSize !== eocd) throw bad('Directorio central incoherente');

  const list = [];
  const seen = new Set();
  let p = cdOffset;
  for (let n = 0; n < entries; n += 1) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== SIG_CENTRAL) throw bad('Directorio central corrupto');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const diskStart = buf.readUInt16LE(p + 34);
    const localOffset = buf.readUInt32LE(p + 42);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > eocd) throw bad('Directorio central corrupto');
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    checkName(name);
    const key = name.toLowerCase();
    if (seen.has(key)) throw bad('Entradas duplicadas');
    seen.add(key);
    if (diskStart !== 0) throw bad('ZIP multi-volumen no admitido');
    if (flags & 0x0001 || flags & 0x0040) throw bad('ZIP cifrado no admitido');
    if (method !== 0 && method !== 8) throw bad('Método de compresión no admitido');
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) throw bad('ZIP64 no admitido');
    if (usize > LIMITS.maxEntryUncompressed) throw bad('Entrada demasiado grande');
    if (usize >= LIMITS.ratioMinBytes && usize / Math.max(csize, 1) > LIMITS.maxRatio) throw bad('Ratio de compresión sospechoso');
    list.push({ name, flags, method, crc, csize, usize, localOffset });
    p = end;
  }
  if (p !== eocd) throw bad('Directorio central incoherente');

  // Cabeceras locales: en el offset declarado, coherentes y sin solaparse.
  const byOffset = [...list].sort((a, b) => a.localOffset - b.localOffset);
  let total = 0;
  const out = new Map();
  for (let i = 0; i < byOffset.length; i += 1) {
    const e = byOffset[i];
    const o = e.localOffset;
    if (o + 30 > cdOffset || buf.readUInt32LE(o) !== SIG_LOCAL) throw bad('Cabecera local corrupta');
    const lFlags = buf.readUInt16LE(o + 6);
    const lMethod = buf.readUInt16LE(o + 8);
    const lCrc = buf.readUInt32LE(o + 14);
    const lCsize = buf.readUInt32LE(o + 18);
    const lUsize = buf.readUInt32LE(o + 22);
    const lNameLen = buf.readUInt16LE(o + 26);
    const lExtraLen = buf.readUInt16LE(o + 28);
    if (lMethod !== e.method || (lFlags & 0x0049) !== (e.flags & 0x0049)) throw bad('Cabecera local incoherente');
    if (o + 30 + lNameLen > cdOffset) throw bad('Cabecera local corrupta');
    const lName = buf.slice(o + 30, o + 30 + lNameLen).toString('utf8');
    if (lName !== e.name) throw bad('Cabecera local incoherente');
    if (!(e.flags & 0x0008) && (lCrc !== e.crc || lCsize !== e.csize || lUsize !== e.usize)) {
      throw bad('Cabecera local incoherente');
    }
    const dataStart = o + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + e.csize;
    const limit = i + 1 < byOffset.length ? byOffset[i + 1].localOffset : cdOffset;
    if (dataEnd > limit) throw bad('Entradas solapadas o truncadas');

    total += e.usize;
    if (total > LIMITS.maxTotalUncompressed) throw bad('Contenido descomprimido demasiado grande');
    if (e.name.endsWith('/')) {
      if (e.usize !== 0) throw bad('Entrada de directorio inválida');
      continue;
    }
    const raw = buf.slice(dataStart, dataEnd);
    let data;
    if (e.method === 0) {
      if (raw.length !== e.usize) throw bad('Entrada ilegible');
      data = raw;
    } else {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(e.usize, 1) });
      } catch {
        throw bad('Entrada ilegible');
      }
      if (data.length !== e.usize) throw bad('Entrada ilegible');
    }
    if ((zlib.crc32(data) >>> 0) !== (e.crc >>> 0)) throw bad('CRC inválido');
    out.set(e.name, data);
  }
  return out;
}

// ── 2. Verificador XML (sin DOCTYPE ni entidades externas) ────────────────

const NAME = '[A-Za-z_][A-Za-z0-9_.\\-]*(?::[A-Za-z_][A-Za-z0-9_.\\-]*)?';
const RE_START = new RegExp(`<(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/?)>`, 'y');
const RE_ATTR = new RegExp(`(${NAME})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, 'g');
const RE_END = new RegExp(`</(${NAME})\\s*>`, 'y');
const RE_ENTITY = /&(?:lt|gt|amp|quot|apos|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});/y;

function decodeText(buf) {
  try {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(buf.slice(2));
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(buf.slice(2));
    const s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  } catch {
    throw bad('Codificación XML inválida');
  }
}

function checkEntities(s) {
  let i = s.indexOf('&');
  while (i !== -1) {
    RE_ENTITY.lastIndex = i;
    if (!RE_ENTITY.test(s)) throw bad('XML mal formado');
    i = s.indexOf('&', RE_ENTITY.lastIndex);
  }
}

/**
 * Verifica que el XML esté bien formado. `onStart(name, attrs, depth)` recibe
 * cada elemento de apertura (attrs: objeto). Devuelve { root: {name, attrs} }.
 * @param {Buffer} buf
 */
function scanXml(buf, onStart) {
  const s = decodeText(buf);
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw bad('DOCTYPE/ENTITY no admitido');
  const stack = [];
  let root = null;
  let rootClosed = false;
  let i = 0;
  if (s.startsWith('<?xml')) {
    const e = s.indexOf('?>');
    if (e === -1) throw bad('XML mal formado');
    i = e + 2;
  }
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const text = s.slice(i, lt === -1 ? s.length : lt);
    if (text.length) {
      if (stack.length === 0 && /\S/.test(text)) throw bad('XML mal formado');
      if (text.includes('>') && /\]\]>/.test(text)) throw bad('XML mal formado');
      checkEntities(text);
    }
    if (lt === -1) break;
    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4);
      if (e === -1 || s.slice(lt + 4, e).includes('--')) throw bad('XML mal formado');
      i = e + 3;
    } else if (s.startsWith('<![CDATA[', lt)) {
      if (stack.length === 0) throw bad('XML mal formado');
      const e = s.indexOf(']]>', lt + 9);
      if (e === -1) throw bad('XML mal formado');
      i = e + 3;
    } else if (s.startsWith('<?', lt)) {
      const e = s.indexOf('?>', lt + 2);
      if (e === -1 || /^xml[\s?]/i.test(s.slice(lt + 2, lt + 6))) throw bad('XML mal formado');
      i = e + 2;
    } else if (s.startsWith('</', lt)) {
      RE_END.lastIndex = lt;
      const m = RE_END.exec(s);
      if (!m || stack.pop() !== m[1]) throw bad('XML mal formado');
      if (stack.length === 0) rootClosed = true;
      i = RE_END.lastIndex;
    } else {
      RE_START.lastIndex = lt;
      const m = RE_START.exec(s);
      if (!m) throw bad('XML mal formado');
      if (rootClosed) throw bad('XML mal formado');
      const attrs = {};
      RE_ATTR.lastIndex = 0;
      let a;
      while ((a = RE_ATTR.exec(m[2])) !== null) {
        if (Object.prototype.hasOwnProperty.call(attrs, a[1])) throw bad('XML mal formado');
        const v = a[2] !== undefined ? a[2] : a[3];
        checkEntities(v);
        attrs[a[1]] = v;
      }
      if (!root) root = { name: m[1], attrs };
      if (onStart) onStart(m[1], attrs, stack.length);
      if (m[3] !== '/') stack.push(m[1]);
      else if (stack.length === 0) rootClosed = true;
      i = RE_START.lastIndex;
    }
  }
  if (!root || stack.length || !rootClosed) throw bad('XML mal formado');
  return { root };
}

const localName = (n) => (n.includes(':') ? n.split(':')[1] : n);
const prefixOf = (n) => (n.includes(':') ? n.split(':')[0] : null);
function nsOf(root) {
  const p = prefixOf(root.name);
  return root.attrs[p ? `xmlns:${p}` : 'xmlns'] || null;
}

// ── 3/4. Paquete OPC ──────────────────────────────────────────────────────

const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_OFFICE_DOC = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
]);
const KINDS = {
  docx: {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    root: 'document',
    ns: ['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'],
  },
  xlsx: {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    root: 'workbook',
    ns: ['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'],
  },
};
const CFB_SIG = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
// Todo proyecto VBA dentro de un contenedor CFB tiene el stream _VBA_PROJECT.
const VBA_MARKERS = [Buffer.from('_VBA_PROJECT', 'utf16le')];

const isMacroType = (t) => /macroenabled|vbaproject|vbadata/i.test(t || '');
const isMacroRel = (t) => /\/(vbaProject|wordVbaData|vbaProjectSignature|vbaData)$/i.test(t || '');

function resolveTarget(target, baseDir) {
  if (!target) return null;
  let t = target.split('#')[0].split('?')[0];
  try { t = decodeURIComponent(t); } catch { return null; }
  const parts = (t.startsWith('/') ? t.slice(1) : `${baseDir}${t}`).split('/');
  const outParts = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!outParts.length) return null; outParts.pop(); } else outParts.push(seg);
  }
  return outParts.join('/');
}

/**
 * Valida el paquete y devuelve 'docx' | 'xlsx'. Lanza OoxmlError si no.
 * @param {Buffer} buf  contenido completo del archivo
 */
function validateOoxmlPackage(buf) {
  const entries = readZip(buf);
  const names = [...entries.keys()];

  // Todas las partes XML deben estar bien formadas.
  for (const n of names) {
    // (Las partes VML heredadas no son XML estricto: se validan sólo por CRC/tipo.)
    if (/\.(xml|rels)$/i.test(n)) scanXml(entries.get(n));
  }

  // [Content_Types].xml
  const ct = entries.get('[Content_Types].xml');
  if (!ct) throw bad('Falta [Content_Types].xml');
  const defaults = new Map();
  const overrides = new Map();
  const ctRoot = scanXml(ct, (name, attrs, depth) => {
    if (depth !== 1) return;
    if (localName(name) === 'Default' && attrs.Extension && attrs.ContentType) defaults.set(attrs.Extension.toLowerCase(), attrs.ContentType);
    if (localName(name) === 'Override' && attrs.PartName && attrs.ContentType) overrides.set(attrs.PartName.replace(/^\//, '').toLowerCase(), attrs.ContentType);
  }).root;
  if (localName(ctRoot.name) !== 'Types' || nsOf(ctRoot) !== NS_CT) throw bad('[Content_Types].xml inválido');
  const typeOf = (part) => overrides.get(part.toLowerCase())
    || defaults.get((part.split('.').pop() || '').toLowerCase()) || null;

  for (const [part] of overrides) {
    if (!names.some((n) => n.toLowerCase() === part)) throw bad('Override sin parte');
  }
  for (const n of names) {
    if (n === '[Content_Types].xml' || n.endsWith('/')) continue;
    const t = typeOf(n);
    if (!t) throw bad('Parte sin tipo de contenido');
    if (isMacroType(t)) throw bad('Documento con macros no permitido');
  }
  for (const t of [...defaults.values(), ...overrides.values()]) {
    if (isMacroType(t)) throw bad('Documento con macros no permitido');
  }

  // Relaciones (todas): macros y relación principal.
  let mainPart = null;
  let officeRels = 0;
  for (const n of names) {
    if (!/(^|\/)_rels\/[^/]*\.rels$/i.test(n)) continue;
    const baseDir = n.replace(/_rels\/[^/]*\.rels$/i, '');
    const relRoot = scanXml(entries.get(n), (name, attrs, depth) => {
      if (depth !== 1 || localName(name) !== 'Relationship') return;
      if (isMacroRel(attrs.Type)) throw bad('Documento con macros no permitido');
      if (n === '_rels/.rels' && REL_OFFICE_DOC.has(attrs.Type)) {
        officeRels += 1;
        if (attrs.TargetMode === 'External') throw bad('Parte principal externa no admitida');
        mainPart = resolveTarget(attrs.Target, baseDir);
      }
    }).root;
    if (localName(relRoot.name) !== 'Relationships' || nsOf(relRoot) !== NS_REL) throw bad('Relaciones inválidas');
  }
  if (!entries.has('_rels/.rels')) throw bad('Faltan las relaciones del paquete');
  if (officeRels !== 1 || !mainPart) throw bad('Parte principal no declarada');
  const mainName = names.find((x) => x.toLowerCase() === mainPart.toLowerCase());
  if (!mainName) throw bad('Parte principal ausente');

  const mainType = typeOf(mainName);
  const kind = Object.keys(KINDS).find((k) => KINDS[k].contentType === mainType);
  if (!kind) throw bad('Tipo de documento no admitido');
  const mainRoot = scanXml(entries.get(mainName)).root;
  if (localName(mainRoot.name) !== KINDS[kind].root || !KINDS[kind].ns.includes(nsOf(mainRoot))) {
    throw bad('Parte principal inválida');
  }

  // Binarios OLE/CFB con proyecto VBA (por contenido, sin mirar el nombre).
  for (const data of entries.values()) {
    if (data.length >= 8 && data.slice(0, 8).equals(CFB_SIG) && VBA_MARKERS.some((m) => data.includes(m))) {
      throw bad('Documento con macros no permitido');
    }
  }
  return kind;
}

module.exports = { validateOoxmlPackage, readZip, scanXml, OoxmlError, LIMITS, KINDS };
