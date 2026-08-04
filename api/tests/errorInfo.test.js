/**
 * Serialización segura de errores.
 *
 * Origen: los logs de producción mostraban `Error cargando schedules HR: {}` y
 * `Error cron courses due: {}` — sin message, sin code y sin stack, por lo que
 * no había forma de saber qué había fallado.
 */
const { serializeError, serializeErrorPublic, safeErrorCode, redactSecrets, redactStrict } =
  require('../src/utils/errorInfo');

describe('serializeError', () => {
  test('Error estándar: conserva name, message, code y stack', () => {
    const err = Object.assign(new Error('conexión rechazada'), {
      code: 'ECONNREFUSED', errno: -111, syscall: 'connect',
    });
    const s = serializeError(err);

    expect(s.name).toBe('Error');
    expect(s.message).toBe('conexión rechazada');
    expect(s.code).toBe('ECONNREFUSED');
    expect(s.errno).toBe(-111);
    expect(s.syscall).toBe('connect');
    expect(s.error_code).toBe('ECONNREFUSED');
    expect(s.stack).toContain('Error: conexión rechazada');
  });

  test('nunca devuelve un objeto vacío, que era el síntoma original', () => {
    for (const entrada of [new Error('x'), 'texto', 42, null, undefined, {}, { a: 1 }]) {
      const s = serializeError(entrada);
      expect(Object.keys(s).length).toBeGreaterThan(0);
      expect(s.message).toBeDefined();
      expect(s.error_code).toBeDefined();
    }
  });

  test('objeto que no es Error', () => {
    const s = serializeError({ algo: 'raro' });
    expect(s.error_code).toBe('UNKNOWN_ERROR');
    expect(s.message).toBe('(sin mensaje)');
  });

  test('string lanzado directamente', () => {
    const s = serializeError('se rompió todo');
    expect(s.message).toBe('se rompió todo');
    expect(s.error_code).toBe('NON_ERROR_THROWN');
  });

  test('null / undefined no explotan', () => {
    expect(serializeError(null).error_code).toBe('UNKNOWN_ERROR');
    expect(serializeError(undefined).message).toBe('(sin error)');
  });

  test('error de Sequelize/MySQL: rescata code, errno y sqlState del parent', () => {
    const parent = Object.assign(new Error('Deadlock found when trying to get lock'), {
      code: 'ER_LOCK_DEADLOCK', errno: 1213, sqlState: '40001',
      sqlMessage: 'Deadlock found when trying to get lock; try restarting transaction',
      sql: 'UPDATE daily_summary SET worked_minutes=? WHERE employee_id=?',
    });
    const err = Object.assign(new Error('Deadlock'), { name: 'SequelizeDatabaseError', parent });
    const s = serializeError(err);

    expect(s.error_code).toBe('ER_LOCK_DEADLOCK');
    expect(s.errno).toBe(1213);
    expect(s.sqlState).toBe('40001');
    expect(s.sqlMessage).toContain('Deadlock found');
  });

  test('nunca serializa el SQL ni los parámetros', () => {
    const err = Object.assign(new Error('falló'), {
      sql: "INSERT INTO employees (documento) VALUES ('1234567')",
      parameters: ['1234567'],
      body: { password: 'x' },
      config: { headers: { Authorization: 'Bearer abc' } },
    });
    const json = JSON.stringify(serializeError(err));

    expect(json).not.toContain('INSERT INTO');
    expect(json).not.toContain('1234567');
    expect(json).not.toContain('Bearer abc');
    expect(json).not.toContain('parameters');
  });

  test('sigue la cadena de cause sin recursión infinita', () => {
    const raiz = Object.assign(new Error('socket cerrado'), { code: 'EPIPE' });
    const medio = new Error('fallo de transporte', { cause: raiz });
    const top = new Error('no se pudo sincronizar', { cause: medio });
    const s = serializeError(top);

    expect(s.cause.message).toBe('fallo de transporte');
    expect(s.cause.cause.message).toBe('socket cerrado');
    expect(s.cause.cause.error_code).toBe('EPIPE');
    expect(s.cause.cause.stack).toBeUndefined();       // stack sólo en el nivel superior
  });

  test('una cadena circular termina', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(() => JSON.stringify(serializeError(a))).not.toThrow();
  });

  test('serializeErrorPublic no incluye stack', () => {
    const s = serializeErrorPublic(new Error('x'));
    expect(s.stack).toBeUndefined();
    expect(s.message).toBe('x');
  });
});

describe('redacción de secretos', () => {
  test('contraseña, token y JWT', () => {
    const t = redactSecrets(
      'falló con password=SuperSecreta123 token=abc123def api_key: XYZ y jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIx.k9fLm'
    );
    expect(t).not.toContain('SuperSecreta123');
    expect(t).not.toContain('abc123def');
    expect(t).not.toContain('XYZ');
    expect(t).not.toContain('eyJhbGciOiJIUzI1');
    expect(t).toContain('***');
  });

  test('cabecera Authorization', () => {
    expect(redactSecrets('Authorization: Bearer eyJabc.def.ghi')).not.toContain('eyJabc');
    expect(redactSecrets('usa Basic YWRtaW46YWRtaW4xMjM=')).not.toContain('YWRtaW46');
  });

  test('cadena de conexión', () => {
    const t = redactSecrets('no conecta a mysql://sishoras:Clave123@db.interna:3306/asistencia');
    expect(t).not.toContain('Clave123');
    expect(t).not.toContain('sishoras');
    expect(t).toContain('mysql://***@***');
  });

  test('un secreto dentro del mensaje del error se redacta al serializar', () => {
    const s = serializeError(new Error('login falló con password=Hola1234'));
    expect(s.message).not.toContain('Hola1234');
    expect(s.stack).not.toContain('Hola1234');
  });

  test('las IPs se conservan en texto normal: son el dato útil de operación', () => {
    expect(redactSecrets('conectando a 127.0.0.1:8081')).toContain('127.0.0.1:8081');
  });

  test('redactStrict sí borra identidades y direcciones', () => {
    const t = redactStrict("Access denied for user 'sishoras'@'10.20.30.40'");
    expect(t).not.toContain('sishoras');
    expect(t).not.toContain('10.20.30.40');
  });

  test('sqlMessage con datos de fila va con redacción dura', () => {
    const parent = Object.assign(new Error('dup'), {
      code: 'ER_DUP_ENTRY',
      sqlMessage: "Duplicate entry 'juan.perez@empresa.com' for key 'email' desde 10.0.0.9",
    });
    const s = serializeError(Object.assign(new Error('dup'), { parent }));
    expect(s.sqlMessage).not.toContain('10.0.0.9');
  });
});

describe('safeErrorCode', () => {
  test('usa el code cuando es una constante segura', () => {
    expect(safeErrorCode({ code: 'ECONNREFUSED' })).toBe('ECONNREFUSED');
    expect(safeErrorCode({ code: 'ER_LOCK_DEADLOCK' })).toBe('ER_LOCK_DEADLOCK');
  });

  test('no propaga texto libre como código', () => {
    expect(safeErrorCode({ code: 'algo raro con espacios' })).toBe('UNKNOWN_ERROR');
    expect(safeErrorCode({ code: "'; DROP TABLE x; --" })).toBe('UNKNOWN_ERROR');
  });

  test('deriva del nombre de Sequelize cuando no hay code', () => {
    expect(safeErrorCode({ name: 'SequelizeConnectionError' })).toBe('SEQUELIZE_CONNECTION_ERROR');
  });

  test('code numérico', () => {
    expect(safeErrorCode({ code: -4058 })).toBe('ERRNO_4058');
  });

  test('entradas basura', () => {
    expect(safeErrorCode(null)).toBe('UNKNOWN_ERROR');
    expect(safeErrorCode('texto')).toBe('UNKNOWN_ERROR');
  });
});
