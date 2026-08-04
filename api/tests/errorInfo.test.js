/**
 * Serialización segura de errores.
 *
 * Origen: los logs de producción mostraban `Error cargando schedules HR: {}` y
 * `Error cron courses due: {}` — sin message, sin code y sin stack, por lo que
 * no había forma de saber qué había fallado.
 */
const { serializeError, serializeErrorPublic, safeErrorCode, redactSecrets, redactStrict, isDbShaped } =
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

// ── Hallazgos de la revisión de Codex sobre el PR ────────────────
describe('errores de base: redacción dura también en message', () => {
  test('el message de un duplicado no filtra el valor de la fila', () => {
    const parent = Object.assign(new Error("Duplicate entry 'juan.perez@empresa.com' for key 'employees.email'"), {
      code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000',
      sqlMessage: "Duplicate entry 'juan.perez@empresa.com' for key 'employees.email'",
    });
    const err = Object.assign(new Error("Validation error: Duplicate entry 'juan.perez@empresa.com'"), {
      name: 'SequelizeUniqueConstraintError', parent,
    });
    const json = JSON.stringify(serializeError(err));

    expect(json).not.toContain('juan.perez');
    expect(json).not.toContain('empresa.com');
    expect(json).toContain('1062');
    expect(json).toContain('23000');
  });

  test('comillas anidadas de MySQL no dejan fragmentos (bug #70907)', () => {
    // El emparejado ingenuo cerraba en la comilla interna y dejaba el
    // identificador de la tabla a la vista.
    const t = redactStrict("Couldn't execute 'show table status like 'uc\\_secreta%''");

    expect(t).not.toContain('uc\\_secreta');
    expect(t).not.toContain('show table status');
    expect(t).toContain("Couldn't execute");
  });

  test("un valor con apóstrofo tampoco se escapa", () => {
    const t = redactStrict("Duplicate entry 'O'Brien' for key 'name'");
    expect(t).not.toContain('Brien');
    expect(t).toBe("Duplicate entry '***'");
  });

  test('el apóstrofo de una contracción no corta antes de tiempo', () => {
    const t = redactStrict("Table 'asistencia.empleados' doesn't exist");
    expect(t).toBe("Table '***'");
  });

  test('un correo sin comillas también se enmascara', () => {
    expect(redactStrict('no se pudo notificar a juan.perez@empresa.com')).toContain('***@***');
  });

  test('la cadena de cause hereda la redacción dura', () => {
    const raiz = Object.assign(new Error("Duplicate entry 'secreto@x.com' for key 'email'"), {
      code: 'ER_DUP_ENTRY', sqlState: '23000',
    });
    const top = Object.assign(new Error('no se pudo guardar el empleado'), {
      name: 'SequelizeUniqueConstraintError', cause: raiz,
    });
    const json = JSON.stringify(serializeError(top));

    expect(json).not.toContain('secreto@x.com');
  });

  test('un error de red NO recibe redacción dura: la IP sigue visible', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8081'), { code: 'ECONNREFUSED' });
    expect(serializeError(err).message).toContain('127.0.0.1:8081');
  });

  test('isDbShaped reconoce las formas habituales', () => {
    expect(isDbShaped({ sqlState: '23000' })).toBe(true);
    expect(isDbShaped({ name: 'SequelizeDatabaseError' })).toBe(true);
    expect(isDbShaped({ code: 'ER_LOCK_DEADLOCK' })).toBe(true);
    expect(isDbShaped({ parent: { sqlMessage: 'x' } })).toBe(true);
    expect(isDbShaped({ code: 'ECONNREFUSED' })).toBe(false);
    expect(isDbShaped(null)).toBe(false);
  });
});

describe('segunda tanda de Codex', () => {
  test('una causa primitiva hereda la redacción dura del padre', () => {
    const err = Object.assign(new Error('no se pudo guardar'), {
      name: 'SequelizeUniqueConstraintError',
      sqlState: '23000',
      cause: "Duplicate entry 'secreto@ejemplo.com' for key 'employees.email'",
    });
    const json = JSON.stringify(serializeError(err));

    expect(json).not.toContain('secreto@ejemplo.com');
    expect(json).toContain('Duplicate entry');
  });

  test('una causa primitiva de un error normal NO se sobre-redacta', () => {
    const err = new Error('falló el bridge');
    err.cause = 'timeout contra 127.0.0.1:8081';
    expect(JSON.stringify(serializeError(err))).toContain('127.0.0.1:8081');
  });
});

describe('secretos en JSON (hallazgo de Codex)', () => {
  test('claves entrecomilladas también se redactan', () => {
    const t = redactSecrets('HTTP 401: {"password":"Secreta1","token":"abc.def","apiKey":"XYZ"}');

    expect(t).not.toContain('Secreta1');
    expect(t).not.toContain('abc.def');
    expect(t).not.toContain('XYZ');
  });

  test('comillas simples y camelCase', () => {
    expect(redactSecrets("{'accessKey': 'AKIA123', 'sessionId': 'abc'}")).not.toContain('AKIA123');
  });

  test('los campos no sensibles del JSON sobreviven', () => {
    expect(redactSecrets('{"status":"error","user":"juan","password":"x"}')).toContain('"status"');
  });

  test('el error real de hrSourceSync no filtra el cuerpo', () => {
    // runSync lanza `HTTP ${status}: ${body.slice(0,200)}`
    const s = serializeError(new Error('HTTP 401: {"error":"unauthorized","token":"eyJhbG.eyJzdWI.firma"}'));
    expect(JSON.stringify(s)).not.toContain('eyJhbG.eyJzdWI.firma');
  });
});

describe('nombres OAuth en el redactor', () => {
  test('las variantes camelCase y snake_case de token se redactan', () => {
    const t = redactSecrets('HTTP 401: {"accessToken":"AAA","refreshToken":"BBB","id_token":"CCC","access_token":"DDD"}');

    for (const v of ['AAA', 'BBB', 'CCC', 'DDD']) expect(t).not.toContain(v);
  });

  test('clientSecret, apiKey y privateKey', () => {
    const t = redactSecrets('{"clientSecret":"S1","apiKey":"S2","privateKey":"S3","sessionToken":"S4"}');
    for (const v of ['S1', 'S2', 'S3', 'S4']) expect(t).not.toContain(v);
  });

  test('los campos inocentes siguen visibles', () => {
    const t = redactSecrets('{"status":"error","user":"juan","tokenCount":3}');
    expect(t).toContain('"status"');
    expect(t).toContain('juan');
  });

  test('el redactor no se cuelga con un cuerpo largo', () => {
    const t0 = Date.now();
    redactSecrets('x'.repeat(50000) + '{"accessToken":"AAA"}');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
