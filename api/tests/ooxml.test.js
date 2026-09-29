/**
 * ooxml.test.js — validación del paquete real DOCX/XLSX (utils/ooxml).
 *
 * Positivos generados por herramientas reales (DOCX de LibreOffice Writer
 * versionado en tests/fixtures/ooxml; XLSX de ExcelJS). Negativos construidos
 * a partir de ellos: nombres correctos con contenido inválido, cabecera local
 * corrupta, CRC, entrada ilegible/truncada, macros por contenido, DOCTYPE,
 * rutas peligrosas, duplicados y límites del lector. Parser XML estricto:
 * caracteres prohibidos (literales y referenciados), prefijos no declarados,
 * normalización de atributos y reglas OPC/macros sobre valores interpretados.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { validateOoxmlPackage, readZip, scanXml, LIMITS } = require('../src/utils/ooxml');
const { makeZip, centralEntries, dataOffset } = require('./helpers/zipTools');

const DOCX = fs.readFileSync(path.join(__dirname, 'fixtures', 'ooxml', 'sintetico-libreoffice.docx'));
let XLSX;
beforeAll(async () => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Hoja').addRow(['sintético', 1]);
  XLSX = Buffer.from(await wb.xlsx.writeBuffer());
});

/** Reconstruye el DOCX (STORE) aplicando `mutate(entries: Map)`. */
function rebuild(src, mutate, opts) {
  const m = new Map(readZip(src));
  mutate(m);
  return makeZip([...m.entries()], opts);
}
const expectReject = (buf, re) => expect(() => validateOoxmlPackage(buf)).toThrow(re);

describe('positivos reales', () => {
  test('DOCX generado por LibreOffice Writer → docx', () => {
    expect(validateOoxmlPackage(DOCX)).toBe('docx');
  });
  test('XLSX generado por ExcelJS → xlsx', () => {
    expect(validateOoxmlPackage(XLSX)).toBe('xlsx');
  });
  test('DOCX reempaquetado (STORE y DEFLATE) sigue siendo válido', () => {
    expect(validateOoxmlPackage(rebuild(DOCX, () => {}))).toBe('docx');
    expect(validateOoxmlPackage(rebuild(DOCX, () => {}, { deflate: true }))).toBe('docx');
  });
});

describe('nombres correctos, contenido inválido', () => {
  test('[Content_Types].xml y word/document.xml con texto que no es XML', () => {
    expectReject(makeZip({ '[Content_Types].xml': 'no soy xml', 'word/document.xml': 'tampoco' }), /XML mal formado/);
  });
  test('document.xml no XML dentro del paquete real', () => {
    expectReject(rebuild(DOCX, (m) => m.set('word/document.xml', Buffer.from('texto plano'))), /XML mal formado/);
  });
  test('document.xml con etiquetas sin cerrar', () => {
    expectReject(rebuild(DOCX, (m) => m.set('word/document.xml', Buffer.from('<w:document xmlns:w="x"><w:body>'))), /XML mal formado/);
  });
  test('una parte secundaria corrupta también rechaza (styles.xml)', () => {
    expectReject(rebuild(DOCX, (m) => m.set('word/styles.xml', Buffer.from('<a><b></a>'))), /XML mal formado/);
  });
  test('DOCTYPE/ENTITY (referencias externas) → rechazo sin resolverlas', () => {
    const xxe = '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">&x;</w:document>';
    expectReject(rebuild(DOCX, (m) => m.set('word/document.xml', Buffer.from(xxe))), /DOCTYPE/);
  });
  test('raíz de la parte principal que no corresponde al tipo', () => {
    const wrong = '<?xml version="1.0"?><x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>';
    expectReject(rebuild(DOCX, (m) => m.set('word/document.xml', Buffer.from(wrong))), /Parte principal inválida/);
  });
  test('sin relación officeDocument', () => {
    const rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';
    expectReject(rebuild(DOCX, (m) => m.set('_rels/.rels', Buffer.from(rels))), /Parte principal no declarada/);
  });
  test('tipo de contenido de otro formato (plantilla dotx) → no admitido', () => {
    expectReject(rebuild(DOCX, (m) => {
      const ct = m.get('[Content_Types].xml').toString().replace(
        'wordprocessingml.document.main+xml', 'wordprocessingml.template.main+xml');
      m.set('[Content_Types].xml', Buffer.from(ct));
    }), /Tipo de documento no admitido/);
  });
  test('parte sin tipo de contenido declarado', () => {
    expectReject(rebuild(DOCX, (m) => m.set('word/extra.bin', Buffer.from('x'))), /sin tipo de contenido/);
  });
});

describe('coherencia del contenedor', () => {
  test('cabecera local corrupta de word/document.xml (directorio central intacto)', () => {
    const buf = Buffer.from(DOCX);
    const e = centralEntries(buf).find((x) => x.name === 'word/document.xml');
    buf.writeUInt32LE(0xdeadbeef, e.localOffset);
    expectReject(buf, /Cabecera local/);
  });
  test('nombre en la cabecera local distinto del directorio central', () => {
    const buf = Buffer.from(rebuild(DOCX, () => {}));
    const e = centralEntries(buf).find((x) => x.name === 'word/document.xml');
    buf.write('W', e.localOffset + 30); // 'word/...' → 'Word/...'
    expectReject(buf, /Cabecera local incoherente/);
  });
  test('CRC alterado (STORE: un byte cambiado)', () => {
    const buf = Buffer.from(rebuild(DOCX, () => {}));
    const off = dataOffset(buf, 'word/document.xml');
    buf[off + 10] ^= 0x01;
    expectReject(buf, /CRC inválido|XML mal formado/);
  });
  test('entrada DEFLATE ilegible (flujo comprimido corrupto)', () => {
    const buf = Buffer.from(rebuild(DOCX, () => {}, { deflate: true }));
    const e = centralEntries(buf).find((x) => x.name === 'word/document.xml');
    const off = dataOffset(buf, 'word/document.xml');
    buf.fill(0xff, off, off + Math.min(e.csize, 40));
    expectReject(buf, /Entrada ilegible|CRC inválido/);
  });
  test('ZIP truncado (sin fin de directorio)', () => {
    expectReject(DOCX.subarray(0, DOCX.length - 30), /directorio central|truncado/);
  });
  test('entradas truncadas: datos más cortos que lo declarado', () => {
    const buf = Buffer.from(rebuild(DOCX, () => {}));
    const cut = centralEntries(buf).find((x) => x.name === 'word/document.xml');
    // Se declara un tamaño comprimido mayor que el real en el directorio central.
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    let p = buf.readUInt32LE(eocd + 16);
    for (;;) {
      const nameLen = buf.readUInt16LE(p + 28);
      if (buf.slice(p + 46, p + 46 + nameLen).toString() === cut.name) { buf.writeUInt32LE(cut.csize + 100000, p + 20); break; }
      p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    expectReject(buf, /incoherente|solapadas|truncadas/);
  });
  test('nombres peligrosos y duplicados', () => {
    expectReject(rebuild(DOCX, (m) => m.set('../evil.xml', Buffer.from('<a/>'))), /Nombre de entrada inválido/);
    expectReject(rebuild(DOCX, (m) => m.set('/abs.xml', Buffer.from('<a/>'))), /Nombre de entrada inválido/);
    const entries = [...readZip(DOCX).entries()];
    expectReject(makeZip([...entries, ['WORD/document.xml', entries.find(([n]) => n === 'word/document.xml')[1]]]), /duplicadas/);
  });
  test('ZIP cifrado (bit 0) → rechazo', () => {
    const buf = Buffer.from(rebuild(DOCX, () => {}));
    for (const e of centralEntries(buf)) buf.writeUInt16LE(1, e.localOffset + 6);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    let p = buf.readUInt32LE(eocd + 16);
    while (buf.readUInt32LE(p) === 0x02014b50) {
      buf.writeUInt16LE(1, p + 8);
      p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    expectReject(buf, /cifrado/);
  });
});

describe('macros por contenido (no por nombre)', () => {
  test('tipo de contenido macroEnabled en la parte principal (docm renombrado)', () => {
    expectReject(rebuild(DOCX, (m) => {
      const ct = m.get('[Content_Types].xml').toString().replace(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
        'application/vnd.ms-word.document.macroEnabled.main+xml');
      m.set('[Content_Types].xml', Buffer.from(ct));
    }), /macros/);
  });
  test('relación de proyecto VBA con nombre inocuo', () => {
    expectReject(rebuild(DOCX, (m) => {
      const r = m.get('word/_rels/document.xml.rels').toString().replace('</Relationships>',
        '<Relationship Id="rIdX" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="media/foto.png"/></Relationships>');
      m.set('word/_rels/document.xml.rels', Buffer.from(r));
      m.set('word/media/foto.png', Buffer.from('x'));
      const ct = m.get('[Content_Types].xml').toString().replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>');
      m.set('[Content_Types].xml', Buffer.from(ct));
    }), /macros/);
  });
  test('binario OLE/CFB con proyecto VBA escondido bajo otro nombre y tipo', () => {
    const cfb = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64), Buffer.from('_VBA_PROJECT', 'utf16le'), Buffer.alloc(64)]);
    expectReject(rebuild(DOCX, (m) => {
      m.set('word/media/imagen1.jpeg', cfb);
      const ct = m.get('[Content_Types].xml').toString().replace('</Types>', '<Default Extension="jpeg" ContentType="image/jpeg"/></Types>');
      m.set('[Content_Types].xml', Buffer.from(ct));
    }), /macros/);
  });
  test('un OLE embebido SIN VBA no se rechaza por ser CFB', () => {
    const cfb = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(200)]);
    expect(validateOoxmlPackage(rebuild(DOCX, (m) => {
      m.set('word/embeddings/oleObject1.bin', cfb);
      const ct = m.get('[Content_Types].xml').toString().replace('</Types>', '<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/></Types>');
      m.set('[Content_Types].xml', Buffer.from(ct));
    }))).toBe('docx');
  });
});

describe('límites del lector', () => {
  test('demasiadas entradas', () => {
    const many = Array.from({ length: LIMITS.maxEntries + 1 }, (_, i) => [`x/${i}.txt`, 'a']);
    expectReject(makeZip(many), /Cantidad de entradas/);
  });
  test('ratio de compresión sospechoso (bomba)', () => {
    expectReject(rebuild(DOCX, (m) => m.set('word/media/zeros.txt', Buffer.alloc(8 * 1024 * 1024)), { deflate: true }), /Ratio de compresión/);
  });
  test('entrada que excede el tamaño máximo', () => {
    const big = Buffer.alloc(LIMITS.maxEntryUncompressed + 1, 1);
    const zip = makeZip([['word/media/big.txt', big]]);
    expectReject(zip, /demasiado grande/);
  });
  test('la descompresión tiene tope: un usize falso no infla sin límite', () => {
    // Se declara un tamaño descomprimido menor que el real: inflate corta en el tope.
    const buf = Buffer.from(rebuild(DOCX, () => {}, { deflate: true }));
    const e = centralEntries(buf).find((x) => x.name === 'word/document.xml');
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    let p = buf.readUInt32LE(eocd + 16);
    for (;;) {
      const nameLen = buf.readUInt16LE(p + 28);
      if (buf.slice(p + 46, p + 46 + nameLen).toString() === e.name) { buf.writeUInt32LE(10, p + 24); break; }
      p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    buf.writeUInt32LE(10, e.localOffset + 22);
    expectReject(buf, /Entrada ilegible|CRC/);
  });
});

describe('verificador XML', () => {
  const ok = (s) => expect(() => scanXml(Buffer.from(s))).not.toThrow();
  const ko = (s) => expect(() => scanXml(Buffer.from(s))).toThrow();
  test('acepta XML bien formado con declaración, comentarios, CDATA y entidades predefinidas', () => {
    ok('<?xml version="1.0" encoding="UTF-8"?><!-- c --><a x="1" y=\'2\'><b>&lt;&amp;&#65;&#x42;</b><![CDATA[<raw>]]><c/></a>');
  });
  test.each([
    ['sin raíz', ''], ['dos raíces', '<a/><b/>'], ['cierre cruzado', '<a><b></a></b>'],
    ['atributo duplicado', '<a x="1" x="2"/>'], ['entidad desconocida', '<a>&foo;</a>'],
    ['& suelto', '<a>a & b</a>'], ['texto fuera de la raíz', 'x<a/>'], ['comentario con --', '<a><!-- a -- b --></a>'],
    ['DOCTYPE', '<!DOCTYPE a><a/>'], ['UTF-8 inválido', Buffer.from([0x3c, 0x61, 0x3e, 0xff, 0x3c, 0x2f, 0x61, 0x3e])],
  ])('rechaza %s', (_n, s) => (Buffer.isBuffer(s) ? expect(() => scanXml(s)).toThrow() : ko(s)));
});

describe('parser XML estricto (XML 1.0 + Namespaces)', () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const ok = (x) => expect(() => scanXml(Buffer.from(x))).not.toThrow();
  const ko = (x, re = /XML mal formado/) => expect(() => scanXml(Buffer.from(x))).toThrow(re);

  test.each([
    ['NUL literal', `<w:t ${W}>a\u0000b</w:t>`],
    ['referencia decimal a NUL', `<w:t ${W}>a&#0;b</w:t>`],
    ['referencia hexadecimal a U+0001', `<w:t ${W}>a&#x1;b</w:t>`],
    ['referencia a U+FFFE', `<w:t ${W}>&#xFFFE;</w:t>`],
    ['carácter de control literal en un atributo', `<w:t ${W} w:x="a\u0001b"/>`],
    ['referencia a NUL dentro de un atributo', '<a x="&#0;"/>'],
    ['prefijo de elemento no declarado', `<w:t ${W}><n:x/></w:t>`],
    ['prefijo de atributo no declarado', `<w:t ${W} n:x="1"/>`],
    ['prefijo de la raíz no declarado', '<w:document/>'],
    ['atributo duplicado por nombre expandido', '<a xmlns:p="urn:x" xmlns:q="urn:x" p:v="1" q:v="2"/>'],
    ['< dentro de un atributo', '<a x="<"/>'],
  ])('rechaza %s', (_n, x) => ko(x));

  test('rechaza DOCTYPE aunque no declare entidades, y un subconjunto interno', () => {
    ko('<!DOCTYPE a><a/>', /DOCTYPE/);
    ko('<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>', /DOCTYPE/);
  });
  test('sólo XML 1.0 y codificación declarada coherente con los bytes', () => {
    ko('<?xml version="1.1"?><a>&#x1;</a>', /Versión XML/);
    ko('<?xml version="1.0" encoding="UTF-16"?><a/>', /Codificación/);
    ko('<?xml version="1.0" encoding="ISO-8859-1"?><a/>', /Codificación/);
    ok('<?xml version="1.0" encoding="utf-8" standalone="yes"?><a/>');
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<?xml version="1.0" encoding="UTF-16"?><a/>', 'utf16le')]);
    expect(() => scanXml(u16)).not.toThrow();
  });
  test('entrega nombres locales con namespace resuelto y atributos normalizados', () => {
    const seen = [];
    const { root } = scanXml(Buffer.from(
      '<p:R xmlns:p="urn:r" xmlns:o="urn:o" T="a&#101;&amp;&lt;b" o:X="otro"><p:C Id="&#x72;1"/></p:R>'),
    (el, depth) => seen.push([el.name, el.uri, { ...el.attrs }, depth]));
    expect(root).toMatchObject({ name: 'R', uri: 'urn:r' });
    expect(seen).toEqual([['R', 'urn:r', { T: 'ae&<b' }, 0], ['C', 'urn:r', { Id: 'r1' }, 1]]);
  });
});

describe('OPC y macros sobre valores ya interpretados', () => {
  const setPart = (name, fn) => (m) => m.set(name, Buffer.from(fn(m.get(name).toString('utf8'))));

  test('Target con referencia numérica equivalente a word/document.xml → docx', () => {
    expect(validateOoxmlPackage(rebuild(DOCX, setPart('_rels/.rels',
      (x) => x.replace('Target="word/document.xml"', 'Target="word/docum&#101;nt.xml"'))))).toBe('docx');
  });
  test('Type de la relación principal escrito con referencias → se reconoce', () => {
    expect(validateOoxmlPackage(rebuild(DOCX, setPart('_rels/.rels',
      (x) => x.replace('/relationships/officeDocument"', '/relationships/offic&#x65;Document"'))))).toBe('docx');
  });
  test('tipo macroEnabled escrito con referencias → rechazo por macros', () => {
    expectReject(rebuild(DOCX, setPart('[Content_Types].xml', (x) => x.replace(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
      'application/vnd.ms-word.document.macroEnabl&#101;d.main+xml'))), /macros/);
  });
  test('relación vbaProject escrita con referencias → rechazo por macros', () => {
    expectReject(rebuild(DOCX, setPart('word/_rels/document.xml.rels', (x) => x.replace('</Relationships>',
      '<Relationship Id="rVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaPr&#111;ject" Target="vbaProject.bin"/></Relationships>'))), /macros/);
  });
  test('TargetMode External escrito con referencias → rechazo', () => {
    expectReject(rebuild(DOCX, setPart('_rels/.rels', (x) => x.replace(
      'Target="word/document.xml"', 'Target="word/document.xml" TargetMode="Ext&#101;rnal"'))), /externa/);
  });
  test('raíz de la parte principal con otro prefijo ligado al namespace correcto → docx', () => {
    expect(validateOoxmlPackage(rebuild(DOCX, (m) => m.set('word/document.xml', Buffer.from(
      '<?xml version="1.0"?><x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:body/></x:document>'))))).toBe('docx');
  });
  test('raíz "document" en un namespace ajeno → parte principal inválida', () => {
    expectReject(rebuild(DOCX, (m) => m.set('word/document.xml', Buffer.from(
      '<?xml version="1.0"?><w:document xmlns:w="urn:otro"><w:body/></w:document>'))), /Parte principal inválida/);
  });
  test('Default/Override fuera del namespace de tipos de contenido no cuentan', () => {
    expectReject(rebuild(DOCX, setPart('[Content_Types].xml', (x) => x
      .replace('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types" xmlns:z="urn:z">')
      .replace(/<Override /g, '<z:Override '))), /sin tipo de contenido|Tipo de documento/);
  });
});
