'use strict';

/**
 * diagnoseCompanyLinksReadonly.test.js — el diagnóstico de vínculos
 * sede ↔ empresa es de SOLO LECTURA y no imprime datos personales.
 *
 * Inspección del fuente (sin base). La ejecución real contra MySQL, con
 * contadores de escritura del servidor, está en
 * tests/it/companyLinksDiagnostic.it.test.js.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'diagnose-company-links.js'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('diagnose-company-links.js', () => {
  test('sin sentencias de escritura ni DDL', () => {
    for (const re of [
      /\bUPDATE\s+`?\w+`?\s+SET\b/i,
      /\b(?:INSERT|REPLACE)\s+INTO\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bTRUNCATE\b/i,
      /\b(?:ALTER|DROP|CREATE)\s+(?:TABLE|INDEX|PROCEDURE|VIEW|TRIGGER)\b/i,
      /\bCALL\s+\w+/i,
    ]) expect(CODE).not.toMatch(re);
  });

  test('corre dentro de una transacción READ ONLY que termina en ROLLBACK (nunca COMMIT)', () => {
    expect(CODE).toMatch(/SET SESSION TRANSACTION READ ONLY/);
    expect(CODE).toMatch(/START TRANSACTION READ ONLY/);
    expect(CODE).toMatch(/'ROLLBACK'/);
    expect(CODE).not.toMatch(/COMMIT/i);
  });

  test('no selecciona columnas de datos personales', () => {
    expect(CODE).not.toMatch(/first_name|last_name|full_name|email|document_number|ips_number|salary|phone|address/i);
  });

  test('no toca att2000', () => {
    expect(CODE).not.toMatch(/att2000|CHECKINOUT/i);
  });
});

describe('esquema FASE F no aplicado', () => {
  test('lo informa y no consulta ninguna otra tabla', async () => {
    const { diagnoseCompanyLinks } = require('../scripts/diagnose-company-links');
    const seen = [];
    const conn = { query: async (sql) => { seen.push(sql); return [[{ t: 'departments', c: 'cost_center_id' }]]; } };
    const r = await diagnoseCompanyLinks(conn);
    expect(r).toEqual({ schema: { applied: false, missing: ['branches.company_id', 'cost_centers.company_id'] }, findings: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/information_schema\.COLUMNS/);
  });
});
