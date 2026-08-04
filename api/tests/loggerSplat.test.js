/**
 * El logger no puede perder el error.
 *
 * Síntoma en producción: `Error cargando schedules HR: {}`. Winston, sin un
 * formato que rescate los argumentos extra, descarta el segundo parámetro de
 * `logger.error('mensaje:', err.message)` — el patrón usado en decenas de
 * llamadas del código.
 */
const Transport = require('winston-transport');
const logger = require('../src/config/logger');

const capturado = [];
class Captura extends Transport {
  log(info, next) { capturado.push(info); next(); }
}

let captura;
beforeAll(() => { captura = new Captura({ level: 'silly' }); logger.add(captura); });
afterAll(() => { logger.remove(captura); });
beforeEach(() => { capturado.length = 0; });

const ultimo = () => capturado[capturado.length - 1];

describe('argumentos extra', () => {
  test('un string como segundo argumento ya no se pierde', () => {
    logger.error('Error cargando schedules HR:', 'connect ECONNREFUSED');

    expect(ultimo().message).toBe('Error cargando schedules HR: connect ECONNREFUSED');
  });

  test('no quedan claves por carácter (lo que hacía splat() a secas)', () => {
    logger.error('Error cron courses due:', 'timeout');
    const info = ultimo();

    expect(info['0']).toBeUndefined();
    expect(info['1']).toBeUndefined();
  });

  test('un Error como segundo argumento queda serializado y con código', () => {
    const err = Object.assign(new Error('MySQL no responde'), { code: 'ECONNREFUSED', errno: -111 });
    logger.error('Error cron courses due:', err);
    const info = ultimo();

    expect(info.error_code).toBe('ECONNREFUSED');
    expect(info.error.message).toBe('MySQL no responde');
    expect(info.error.errno).toBe(-111);
    expect(info.error.stack).toBeTruthy();
  });

  test('varios extras: se anexan los primitivos y se conservan los objetos', () => {
    logger.info('sincronizado', 42, 'registros', { job: 'hr_sync' });
    const info = ultimo();

    expect(info.message).toBe('sincronizado 42 registros');
    expect(info.job).toBe('hr_sync');
  });

  test('undefined y null no rompen el formato', () => {
    expect(() => logger.error('Error x:', undefined)).not.toThrow();
    expect(() => logger.error('Error y:', null)).not.toThrow();
  });

  test('los placeholders printf siguen funcionando', () => {
    logger.info('procesados %d de %d', 3, 10);
    expect(ultimo().message).toBe('procesados 3 de 10');
  });

  test('un objeto como metadata sigue llegando entero', () => {
    logger.error('❌ Cron falló', { job: 'backup', duration_ms: 120, result: 'error' });
    const info = ultimo();

    expect(info.job).toBe('backup');
    expect(info.duration_ms).toBe(120);
  });
});

describe('higiene', () => {
  test('los secretos del mensaje no llegan al transporte', () => {
    logger.error('login falló con password=SuperSecreta1 y token eyJhbG.eyJzdWI.firma');
    const json = JSON.stringify(ultimo());

    expect(json).not.toContain('SuperSecreta1');
    expect(json).not.toContain('eyJhbG.eyJzdWI.firma');
  });

  test('no queda una copia cruda del stack junto a la serializada', () => {
    const err = new Error('con password=Secreta9 adentro');
    logger.error('falló:', err);
    const json = JSON.stringify(ultimo());

    expect(json).not.toContain('Secreta9');
  });

  test('las direcciones útiles para operar se conservan', () => {
    logger.info('Bridge escuchando en 127.0.0.1:8081');
    expect(ultimo().message).toContain('127.0.0.1:8081');
  });
});
