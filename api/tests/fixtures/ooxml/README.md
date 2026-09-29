# Fixtures OOXML sintéticos

- `sintetico-libreoffice.docx` — DOCX válido generado por **LibreOffice Writer 24.2**
  a partir de `sintetico.html` (texto sintético, sin datos personales):

  ```bash
  soffice --headless --norestore --convert-to 'docx:MS Word 2007 XML' sintetico.html
  ```

  SHA-256: `c19302f6f8a8914d9d00ef7ae098533f5c75ab057f8225a466eebb6210222707`

Los XLSX de prueba se generan en el propio test con ExcelJS. Las variantes
inválidas (contenido no XML, cabecera local corrupta, CRC, macros, límites) se
construyen en el test a partir de este archivo.
