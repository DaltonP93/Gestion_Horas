#!/usr/bin/env node
'use strict';

/**
 * zk-raw-state-pilot-compare.js — compara el CORTE COMÚN de dos salidas del
 * piloto aislado de estados (zk-raw-state-pilot.js con el mismo --cutoff y la
 * misma PILOT_CORTE_CLAVE). Sólo lee los dos JSON: no abre conexiones.
 *
 *   node scripts/zk-raw-state-pilot-compare.js piloto-<ID>-1.json piloto-<ID>-2.json
 *
 * Imprime { resultado, motivo, delta_registros }:
 *   igual          el conjunto anterior al corte es el mismo en las dos corridas;
 *   distinto       difiere: una marca alterada, borrada o nueva con la hora del
 *                  reloj atrasada más que el margen (las posteriores no cuentan);
 *   no_comparable  falta algo para comparar (resultado no ok, otro corte, otra
 *                  clave, otro formato, otra zona de decodificación o sin huella).
 *
 * Códigos de salida: 0 igual · 1 distinto · 3 no comparable · 2 entrada inválida.
 */
const fs = require('fs');
const { compararCortes } = require('../src/services/zkPilot/corte');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function main(argv) {
  const files = argv.slice(2);
  const a = files.length === 2 ? readJson(files[0]) : null;
  const b = files.length === 2 ? readJson(files[1]) : null;
  if (!a || !b) {
    process.stdout.write(`${JSON.stringify({ resultado: 'entrada_invalida', motivo: null, delta_registros: null })}\n`);
    return 2;
  }
  const out = compararCortes(a, b);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return { igual: 0, distinto: 1 }[out.resultado] ?? 3;
}

process.exit(main(process.argv));
