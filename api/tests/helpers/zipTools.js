'use strict';

/**
 * zipTools.js — construcción y manipulación de ZIP sintéticos para los tests
 * de validación OOXML (no se usa en producción).
 */

const zlib = require('zlib');

/**
 * ZIP con las entradas dadas. entries: { nombre: Buffer|string } o array de
 * [nombre, contenido]. opts.deflate = true comprime con DEFLATE.
 */
function makeZip(entries, { deflate = false } = {}) {
  const list = Array.isArray(entries) ? entries : Object.entries(entries);
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of list) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const stored = deflate ? zlib.deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const nm = Buffer.from(name);
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(stored.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(stored.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nm, stored); centrals.push(ch, nm);
    offset += 30 + nm.length + stored.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(list.length, 8); eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Entradas del directorio central: [{ name, method, csize, usize, localOffset }]. */
function centralEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < n; k += 1) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    out.push({
      name: buf.slice(p + 46, p + 46 + nameLen).toString('utf8'),
      method: buf.readUInt16LE(p + 10),
      csize: buf.readUInt32LE(p + 20),
      usize: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Offset donde empiezan los datos de la entrada `name`. */
function dataOffset(buf, name) {
  const e = centralEntries(buf).find((x) => x.name === name);
  const o = e.localOffset;
  return o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
}

module.exports = { makeZip, centralEntries, dataOffset };
