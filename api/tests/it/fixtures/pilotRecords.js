'use strict';

/**
 * pilotRecords.js — marcaciones SINTÉTICAS del piloto de estados y el agregado
 * esperado, calculado a mano (no con el código bajo prueba).
 *
 * 7 usuarios sintéticos (7001…7007), dos días hábiles más una marca en el
 * futuro y dos registros de relleno. Los bytes de estado/verificación son
 * arbitrarios: el agregado los CUENTA, no los interpreta.
 */
const USERS = ['7001', '7002', '7003', '7004', '7005', '7006'];
const DAYS = ['2026-10-01', '2026-10-02'];
const pad = (n) => String(n).padStart(2, '0');

function buildRecords() {
  const out = [];
  let sn = 11;
  USERS.forEach((uid, u) => {
    const userSn = sn++;
    const verifyOut = u % 2 === 0 ? 1 : 15;   // 7001/7003/7005 → 1; 7002/7004/7006 → 15
    DAYS.forEach((day) => {
      out.push({ deviceUserId: uid, userSn, wall: `${day} 07:${pad(50 + u)}:10`, punchByte: 0, verifyByte: 1 });
      if (uid === '7001' && day === DAYS[0]) {
        out.push({ deviceUserId: uid, userSn, wall: `${day} 12:30:00`, punchByte: 4, verifyByte: 1 });
        out.push({ deviceUserId: uid, userSn, wall: `${day} 13:30:00`, punchByte: 5, verifyByte: 1 });
      }
      out.push({ deviceUserId: uid, userSn, wall: `${day} 17:${pad(u)}:00`, punchByte: 1, verifyByte: verifyOut });
      if (uid === '7002' && day === DAYS[0]) {
        // Duplicado exacto (mismo usuario y hora): el reloj puede repetirlo.
        out.push({ deviceUserId: uid, userSn, wall: `${day} 17:${pad(u)}:00`, punchByte: 1, verifyByte: verifyOut });
      }
    });
  });
  out.push({ deviceUserId: '7007', userSn: sn++, wall: '2026-10-02 03:15:00', punchByte: 2, verifyByte: 4 });
  out.push({ deviceUserId: '7003', userSn: 13, wall: '2099-06-01 10:00:00', punchByte: 0, verifyByte: 1 });
  // Relleno del buffer: sin usuario, y fecha 2000-01-01.
  out.push({ deviceUserId: '', userSn: 0, wall: '2000-01-01 00:00:00', punchByte: 0, verifyByte: 0 });
  out.push({ deviceUserId: '7008', userSn: 30, wall: '2000-01-01 00:00:00', punchByte: 0, verifyByte: 0 });
  return out;
}

const RECORDS = buildRecords();
const USER_IDS = [...USERS, '7007', '7008'];

/** Agregado esperado para RECORDS leído completo en formato tcp40 (umbral de supresión 5). */
const EXPECTED_TCP40 = {
  registros: 31,
  basura: 2,
  validos: 29,
  captura: { ok: 31, no_disponible: 0, longitud_inesperada: 0, otro: 0 },
  validos_sin_captura: 0,
  formatos: {
    tcp40: {
      validos: 29,
      zkPunchState: { 0: 13, 1: 13, 2: 1, 4: 1, 5: 1 },
      zkVerify: { 1: 21, 15: 7, 4: 1 },
      combinaciones: { '0/1': 13, '1/1': 6, '1/15': 7, '4/1': 1, '5/1': 1, '2/4': 1 },
    },
  },
  fechas: { primera: '2026-10-01', ultima: '2099-06-01', dias_con_marcas: 3 },
  futuras: 1,
  duplicados_usuario_hora: 1,
  usuarios_distintos: 7,
  umbral_supresion: 5,
  por_hora: {
    '03': { 2: '<5' },
    '07': { 0: 12 },
    10: { 0: '<5' },
    12: { 4: '<5' },
    13: { 5: '<5' },
    17: { 1: 13 },
  },
  patrones_dia: { patrones: { '0,1': 10 }, suprimidos: { patrones: 4, dias: 4 } },
  bytes_estimados: { valor: 4 + 31 * 40, es_estimacion: true, metodo: 'tamano_por_registro_decodificado', registros_sin_longitud: 0 },
};

/** Muchas marcas (más de un bloque de 65.472 bytes en TCP) para lecturas por bloques/truncadas. */
function manyRecords(n) {
  return Array.from({ length: n }, (_, i) => ({
    deviceUserId: String(8000 + (i % 40)),
    userSn: 1 + (i % 40),
    wall: `2026-09-${pad(1 + (i % 28))} ${pad(6 + (i % 12))}:${pad(i % 60)}:00`,
    punchByte: i % 2,
    verifyByte: 1,
  }));
}

module.exports = { RECORDS, USER_IDS, EXPECTED_TCP40, manyRecords };
