#!/usr/bin/env node
'use strict';

/**
 * diagnose-company-links.js — Diagnóstico de SOLO LECTURA de los vínculos
 * sede ↔ empresa ↔ centro de costo.
 *
 *   node scripts/diagnose-company-links.js            # resumen legible
 *   node scripts/diagnose-company-links.js --json     # salida JSON
 *   node scripts/diagnose-company-links.js --limit 20 # filas de sedes/departamentos por hallazgo (default 50)
 *
 * Reporta:
 *   1. Sedes sin empresa (`branches.company_id IS NULL`), con cuántos
 *      empleados tiene cada una.
 *   2. Departamentos cuyo centro de costo pertenece a una empresa DISTINTA de
 *      la empresa de su sede. Aparte, los casos INDETERMINADOS (el centro de
 *      costo o la sede no tienen empresa, o la sede no existe): no se pueden
 *      comparar y se listan sin clasificarlos.
 *   3. Empleados en sedes sin empresa: SÓLO conteos agregados por sede y
 *      estado. Aparte, los mismos conteos para empleados cuya sede no existe
 *      (`employees.branch_id` no tiene FK).
 *
 * GARANTÍAS:
 *   - Sólo SELECT, dentro de una transacción READ ONLY que termina en ROLLBACK:
 *     el servidor rechaza cualquier escritura en esa sesión.
 *   - No corrige nada: sin backfill, sin asociaciones fabricadas. Asociar una
 *     sede a una empresa es una decisión del dueño de los datos.
 *   - No imprime datos personales: ni nombres ni ids ni códigos de empleados.
 *     De los empleados sólo salen conteos agregados por sede y estado; de
 *     sedes y departamentos, sus ids/códigos organizacionales.
 *   - Si el esquema de FASE F (migración 076) no está aplicado, lo informa y
 *     termina sin error: sin `branches.company_id` no hay vínculo que evaluar.
 *
 * Conexión: variables DB_* del entorno (o .env), nunca credenciales en el repo.
 */

const REQUIRED_COLUMNS = [
  ['branches', 'company_id'],
  ['departments', 'cost_center_id'],
  ['cost_centers', 'company_id'],
];

async function rows(conn, sql, params = []) {
  const [r] = await conn.query(sql, params);
  return r;
}

async function schemaState(conn) {
  const found = await rows(conn, `
    SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND (${REQUIRED_COLUMNS.map(() => '(TABLE_NAME = ? AND COLUMN_NAME = ?)').join(' OR ')})`,
  REQUIRED_COLUMNS.flat());
  const have = new Set(found.map((r) => `${r.t}.${r.c}`));
  const missing = REQUIRED_COLUMNS.map(([t, c]) => `${t}.${c}`).filter((k) => !have.has(k));
  return { applied: missing.length === 0, missing };
}

/**
 * Ejecuta el diagnóstico con una conexión mysql2/promise ya abierta. No abre
 * transacciones: eso lo hace `main` (READ ONLY + ROLLBACK). Exportado para la
 * prueba de integración.
 */
async function diagnoseCompanyLinks(conn, { limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 10000));
  const schema = await schemaState(conn);
  if (!schema.applied) return { schema, findings: null };

  const branchesWithoutCompany = await rows(conn, `
    SELECT b.id, b.code, b.active,
           (SELECT COUNT(*) FROM employees e WHERE e.branch_id = b.id) AS employees
      FROM branches b
     WHERE b.company_id IS NULL
     ORDER BY b.id`);

  const departmentMismatch = await rows(conn, `
    SELECT d.id, d.code, d.active, d.branch_id,
           b.company_id AS branch_company_id,
           d.cost_center_id, cc.company_id AS cost_center_company_id
      FROM departments d
      JOIN cost_centers cc ON cc.id = d.cost_center_id
      JOIN branches b      ON b.id  = d.branch_id
     WHERE b.company_id IS NOT NULL AND cc.company_id IS NOT NULL
       AND cc.company_id <> b.company_id
     ORDER BY d.id`);

  const departmentIndeterminate = await rows(conn, `
    SELECT d.id, d.code, d.active, d.branch_id,
           (b.id IS NULL) AS branch_missing,
           b.company_id AS branch_company_id,
           d.cost_center_id, cc.company_id AS cost_center_company_id
      FROM departments d
      JOIN cost_centers cc  ON cc.id = d.cost_center_id
      LEFT JOIN branches b  ON b.id  = d.branch_id
     WHERE b.id IS NULL OR b.company_id IS NULL OR cc.company_id IS NULL
     ORDER BY d.id`);

  const employeesByBranch = await rows(conn, `
    SELECT e.branch_id, e.status, COUNT(*) AS n
      FROM employees e
      JOIN branches b ON b.id = e.branch_id
     WHERE b.company_id IS NULL
     GROUP BY e.branch_id, e.status
     ORDER BY e.branch_id, e.status`);
  const employeesOrphanByBranch = await rows(conn, `
    SELECT e.branch_id, e.status, COUNT(*) AS n
      FROM employees e
      LEFT JOIN branches b ON b.id = e.branch_id
     WHERE b.id IS NULL
     GROUP BY e.branch_id, e.status
     ORDER BY e.branch_id, e.status`);

  const num = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));
  const sum = (list) => list.reduce((a, r) => a + Number(r.n), 0);
  // Conteo agregado: sólo sede, estado y cantidad (nunca ids de empleados).
  const countRow = (r) => ({ branch_id: r.branch_id == null ? null : Number(r.branch_id), status: r.status, n: Number(r.n) });
  return {
    schema,
    findings: {
      branches_without_company: { total: branchesWithoutCompany.length, rows: branchesWithoutCompany.slice(0, lim).map(num) },
      departments_cost_center_company_mismatch: { total: departmentMismatch.length, rows: departmentMismatch.slice(0, lim).map(num) },
      departments_cost_center_company_indeterminate: { total: departmentIndeterminate.length, rows: departmentIndeterminate.slice(0, lim).map(num) },
      employees_in_branch_without_company: { total: sum(employeesByBranch), by_branch_status: employeesByBranch.map(countRow) },
      employees_with_missing_branch: { total: sum(employeesOrphanByBranch), by_branch_status: employeesOrphanByBranch.map(countRow) },
    },
  };
}

function printHuman(result) {
  if (!result.findings) {
    console.log(`Esquema FASE F no aplicado (faltan: ${result.schema.missing.join(', ')}). Sin vínculo sede↔empresa que evaluar.`);
    return;
  }
  const f = result.findings;
  const section = (title, block, cols) => {
    console.log(`\n${title}: ${block.total}`);
    for (const r of block.rows) console.log('  ' + cols.map((c) => `${c}=${r[c]}`).join('  '));
  };
  section('1. Sedes sin empresa', f.branches_without_company, ['id', 'code', 'active', 'employees']);
  section('2. Departamentos con centro de costo de OTRA empresa que su sede', f.departments_cost_center_company_mismatch,
    ['id', 'code', 'branch_id', 'branch_company_id', 'cost_center_id', 'cost_center_company_id']);
  section('2b. Departamentos con centro de costo INDETERMINADOS (sede o centro sin empresa, o sede inexistente)',
    f.departments_cost_center_company_indeterminate, ['id', 'code', 'branch_id', 'branch_missing', 'branch_company_id', 'cost_center_id', 'cost_center_company_id']);
  const emp = f.employees_in_branch_without_company;
  console.log(`\n3. Empleados en sedes sin empresa: ${emp.total}`);
  for (const r of emp.by_branch_status) console.log(`  branch_id=${r.branch_id}  status=${r.status}  n=${r.n}`);
  const orphan = f.employees_with_missing_branch;
  console.log(`\n3b. Empleados cuya sede no existe: ${orphan.total}`);
  for (const r of orphan.by_branch_status) console.log(`  branch_id=${r.branch_id}  status=${r.status}  n=${r.n}`);
  console.log('\nSólo lectura: no se modificó nada. Las asociaciones faltantes las decide el dueño de los datos.');
}

async function main() {
  require('dotenv').config();
  const mysql = require('mysql2/promise');
  const argv = process.argv.slice(2);
  const li = argv.indexOf('--limit');
  const limit = li >= 0 ? argv[li + 1] : 50;
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  try {
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    await conn.query('START TRANSACTION READ ONLY');
    const result = await diagnoseCompanyLinks(conn, { limit });
    await conn.query('ROLLBACK');
    if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // Sin detalles de conexión en la salida.
    console.error(`Error en el diagnóstico: ${err.code || err.name}`);
    process.exit(1);
  });
}

module.exports = { diagnoseCompanyLinks, schemaState };
