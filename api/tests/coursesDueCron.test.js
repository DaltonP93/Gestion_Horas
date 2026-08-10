/**
 * Cron `capacitaciones_vencimiento` frente a la deriva de esquema.
 *
 * Error de producción que lo motiva (2026-08-10 08:00 America/Asuncion):
 *     ER_BAD_FIELD_ERROR   sqlState: 42S22   Unknown column '***'
 *
 * La consulta filtraba por `ca.status NOT IN ('completed','cancelled')`.
 * `course_assignments` no tiene esa columna y nunca la tuvo: la migración 028
 * la creó con diez columnas y el estado de completitud vive en `completed_at`.
 *
 * Lo confuso del caso —y lo que estos tests fijan— es que `status` parece
 * existir desde tres lugares distintos:
 *   · el índice `idx_emp_status (employee_id, completed_at)` de la propia 028;
 *   · el alias calculado `AS status` del CASE en GET /courses/:id/progress;
 *   · la columna `status` REAL de `employees`, que la misma consulta joinea.
 * Ninguno de los tres es una columna de course_assignments.
 */

const mockLogs = { info: [], warn: [], error: [] };
jest.mock('../src/config/logger', () => ({
  info:  (msg, meta) => mockLogs.info.push({ msg, meta }),
  warn:  (msg, meta) => mockLogs.warn.push({ msg, meta }),
  error: (msg, meta) => mockLogs.error.push({ msg, meta }),
}));

const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({ sequelize: { query: (...a) => mockQuery(...a) } }));

const mockSendMail = jest.fn();
jest.mock('../src/services/emailService', () => ({
  sendMail: (...a) => mockSendMail(...a),
  buildReportEmailHtml: () => '<html></html>',
}));

const mockTareas = [];
jest.mock('node-cron', () => ({
  validate: () => true,
  schedule: (expr, fn) => { const t = { expr, fn, stop: jest.fn() }; mockTareas.push(t); return t; },
}));

const fs = require('fs');
const path = require('path');
const { startCoursesDueCron } = require('../src/services/scheduler');

const MIGRACIONES = path.join(__dirname, '..', '..', 'database', 'migrations');
const SCHEDULER = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'scheduler.js'), 'utf8');

/** Cuerpo del cron de capacitaciones, ya programado. */
function cuerpoDelCron() {
  mockTareas.length = 0;
  startCoursesDueCron();
  expect(mockTareas).toHaveLength(1);
  return mockTareas[0].fn;
}

/** Espera a que el runJob disparado por el callback termine. */
async function correr() {
  cuerpoDelCron()();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

/** Error tal como lo entrega Sequelize sobre mysql2 ante columna ausente. */
function errorColumnaAusente(columna = 'status') {
  const driver = new Error(`Unknown column '${columna}' in 'where clause'`);
  driver.code = 'ER_BAD_FIELD_ERROR';
  driver.errno = 1054;
  driver.sqlState = '42S22';
  driver.sqlMessage = `Unknown column '${columna}' in 'where clause'`;
  const wrapper = new Error(driver.message);
  wrapper.name = 'SequelizeDatabaseError';
  wrapper.parent = driver;
  wrapper.original = driver;
  return wrapper;
}

function asignacion(over = {}) {
  return {
    assignment_id: 1, employee_id: 7,
    employee_name: 'Ana Giménez', employee_email: 'ana@example.com',
    course_title: 'Seguridad e higiene', due_date: '2026-08-12', days_left: 2,
    ...over,
  };
}

beforeEach(() => {
  mockLogs.info.length = 0; mockLogs.warn.length = 0; mockLogs.error.length = 0;
  mockTareas.length = 0;
  mockQuery.mockReset();
  mockSendMail.mockReset();
  mockSendMail.mockResolvedValue({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
describe('el esquema real de course_assignments (migración 028)', () => {
  const SQL_028 = fs.readFileSync(path.join(MIGRACIONES, '028_courses.sql'), 'utf8');

  /** Columnas declaradas en un CREATE TABLE de la 028. */
  function columnasDe(tabla) {
    const cuerpo = SQL_028.match(
      new RegExp(`CREATE TABLE IF NOT EXISTS ${tabla}\\s*\\(([\\s\\S]*?)\\n\\)\\s*ENGINE`));
    expect(cuerpo).toBeTruthy();
    return cuerpo[1]
      .split('\n')
      .map(l => l.trim())
      .filter(l => /^[a-z_]+\s+[A-Z]/.test(l))          // "nombre TIPO ..."
      .map(l => l.split(/\s+/)[0]);
  }

  test('completed_at existe: es el estado de completitud', () => {
    expect(columnasDe('course_assignments')).toContain('completed_at');
  });

  test('status NO existe — es la columna que reventaba el cron', () => {
    expect(columnasDe('course_assignments')).not.toContain('status');
  });

  test('la única aparición de "status" en la 028 es un nombre de índice', () => {
    // `INDEX idx_emp_status (employee_id, completed_at)`: se llama "status"
    // pero está construido sobre completed_at. De ahí salió la confusión.
    const apariciones = SQL_028.split('\n').filter(l => l.includes('status'));
    expect(apariciones).toHaveLength(1);
    expect(apariciones[0]).toMatch(/INDEX\s+idx_emp_status\s*\(employee_id,\s*completed_at\)/);
  });

  test('ninguna migración agrega status a course_assignments después', () => {
    // Si alguien la agrega de verdad, este test cae y hay que revisar la
    // consulta del cron — no al revés.
    for (const f of fs.readdirSync(MIGRACIONES).filter(x => x.endsWith('.sql'))) {
      const sql = fs.readFileSync(path.join(MIGRACIONES, f), 'utf8');
      expect(sql).not.toMatch(/ALTER TABLE\s+course_assignments[\s\S]{0,120}ADD\s+(COLUMN\s+)?status/i);
    }
  });

  test('"cancelled" nunca fue vocabulario de capacitaciones', () => {
    // Existe en permisos (011), onboarding (035) y sync jobs (064). La
    // consulta rota lo tomó prestado de ahí.
    expect(SQL_028).not.toContain('cancelled');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('la consulta del cron sólo pide columnas que existen', () => {
  /** La consulta del cron, extraída del fuente. */
  const consulta = (() => {
    const m = SCHEDULER.match(/SELECT \* FROM \([\s\S]*?LIMIT 200\s*\n\s*`/);
    expect(m).toBeTruthy();
    return m[0];
  })();

  test('no volvió a aparecer ca.status', () => {
    expect(consulta).not.toMatch(/ca\.status/);
  });

  test('no volvió a aparecer el valor inventado "cancelled"', () => {
    expect(consulta).not.toContain('cancelled');
  });

  test('filtra pendientes por completed_at IS NULL', () => {
    expect(consulta).toMatch(/ca\.completed_at IS NULL/);
  });

  test('cada columna pedida existe en su tabla', () => {
    // El chequeo cruza (alias → tabla) contra el DDL real. Que una columna
    // exista en OTRA tabla no alcanza: `status` existe en `employees` y eso
    // es justamente lo que hacía verosímil el bug.
    const ddl = {
      ca: new Set(['id','course_id','employee_id','assigned_by','assigned_at',
                   'due_date','completed_at','score','certificate_url','notes']),
      c:  new Set(['id','title','description','category','duration_hours',
                   'mandatory','valid_until','resource_url','active','created_by','created_at']),
      e:  new Set(['id','code','employee_number','first_name','last_name','email','phone',
                   'department_id','schedule_id','position','hire_date','status',
                   'photo_url','created_at','updated_at']),
      u:  new Set(['id','username','email','password_hash','full_name','role',
                   'employee_id','active','last_login','created_at']),
    };

    const refs = [...consulta.matchAll(/\b(ca|c|e|u)\.([a-z_]+)\b/g)];
    expect(refs.length).toBeGreaterThan(8);

    const invalidas = refs
      .map(([, alias, col]) => ({ alias, col }))
      .filter(({ alias, col }) => !ddl[alias].has(col))
      .map(({ alias, col }) => `${alias}.${col}`);

    expect(invalidas).toEqual([]);
  });

  test('employees.status existe, y aun así no se usa como estado del curso', () => {
    // Guarda contra la "corrección" tentadora: cambiar ca.status por e.status
    // compila y no falla en runtime, pero filtra por el estado del EMPLEADO.
    expect(consulta).not.toMatch(/e\.status/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('corrida exitosa', () => {
  test('con vencimientos, envía un correo por asignación', async () => {
    mockQuery.mockResolvedValueOnce([[
      asignacion({ assignment_id: 1, employee_email: 'ana@example.com' }),
      asignacion({ assignment_id: 2, employee_email: 'luis@example.com', days_left: 0 }),
    ]]);

    await correr();

    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(mockLogs.error).toHaveLength(0);
    expect(mockLogs.info.some(l => l.meta?.result === 'ok')).toBe(true);
  });

  test('registra la cantidad enviada como processed', async () => {
    mockQuery.mockResolvedValueOnce([[asignacion(), asignacion({ assignment_id: 2 })]]);

    await correr();

    const ok = mockLogs.info.find(l => l.meta?.result === 'ok');
    expect(ok.meta.processed).toBe(2);
  });

  test('distingue vencida de por vencer en el asunto', async () => {
    mockQuery.mockResolvedValueOnce([[
      asignacion({ assignment_id: 1, days_left: -1 }),
      asignacion({ assignment_id: 2, days_left: 0, employee_email: 'b@example.com' }),
    ]]);

    await correr();

    const asuntos = mockSendMail.mock.calls.map(([a]) => a.subject);
    expect(asuntos[0]).toMatch(/vencida/i);
    expect(asuntos[1]).toMatch(/vence hoy/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('cero vencimientos', () => {
  test('no envía correos y no es error', async () => {
    mockQuery.mockResolvedValueOnce([[]]);

    await correr();

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockLogs.error).toHaveLength(0);
    expect(mockLogs.info.some(l => l.meta?.result === 'ok')).toBe(true);
  });

  test('processed queda en 0, no en null', async () => {
    mockQuery.mockResolvedValueOnce([[]]);

    await correr();

    expect(mockLogs.info.find(l => l.meta?.result === 'ok').meta.processed).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('no duplicar notificaciones', () => {
  test('la consulta devuelve una fila por asignación aunque haya dos cuentas', async () => {
    // `users.employee_id` no tiene UNIQUE: un empleado con dos usuarios activos
    // duplicaba la fila por el LEFT JOIN y recibía el mismo aviso dos veces.
    // La subconsulta escalar elige una sola cuenta.
    expect(SCHEDULER).toMatch(/SELECT u\.email[\s\S]{0,260}ORDER BY u\.id\s*\n?\s*LIMIT 1/);
    expect(SCHEDULER).not.toMatch(/LEFT JOIN users u ON u\.employee_id = e\.id AND u\.active = 1/);
  });

  test('la elección de cuenta es determinística', async () => {
    // Sin ORDER BY, dos corridas podrían elegir cuentas distintas y mandar el
    // aviso a un correo diferente cada mañana.
    const sub = SCHEDULER.match(/SELECT u\.email[\s\S]*?LIMIT 1\)/)[0];
    expect(sub).toMatch(/ORDER BY u\.id/);
  });

  test('un empleado con dos asignaciones distintas sí recibe dos avisos', async () => {
    mockQuery.mockResolvedValueOnce([[
      asignacion({ assignment_id: 1, course_title: 'Seguridad' }),
      asignacion({ assignment_id: 2, course_title: 'Compliance' }),
    ]]);

    await correr();

    expect(mockSendMail).toHaveBeenCalledTimes(2);
    const asuntos = mockSendMail.mock.calls.map(([a]) => a.subject);
    expect(asuntos[0]).not.toBe(asuntos[1]);
  });

  test('los cursos dados de baja no generan recordatorios', () => {
    // DELETE /courses/:id es borrado lógico (active = 0). Sin este filtro el
    // cron seguía avisando de cursos eliminados.
    expect(SCHEDULER).toMatch(/c\.active = 1/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('columna ausente en runtime', () => {
  test('ER_BAD_FIELD_ERROR se registra como error, no se silencia', async () => {
    mockQuery.mockRejectedValueOnce(errorColumnaAusente());

    await correr();

    expect(mockLogs.error).toHaveLength(1);
    expect(mockLogs.error[0].meta.result).toBe('error');
    expect(mockLogs.error[0].meta.error_code).toBe('ER_BAD_FIELD_ERROR');
  });

  test('no se confunde con "módulo no instalado"', async () => {
    // Una tabla ausente es un estado tolerable; una columna ausente en una
    // tabla que existe es deriva y tiene que doler.
    const { isMissingTableError } = require('../src/utils/schemaState');
    expect(isMissingTableError(errorColumnaAusente())).toBe(false);

    mockQuery.mockRejectedValueOnce(errorColumnaAusente());
    await correr();

    expect(mockLogs.warn.some(w => w.meta?.reason === 'table_missing')).toBe(false);
  });

  test('no se envía ningún correo si la consulta falla', async () => {
    mockQuery.mockRejectedValueOnce(errorColumnaAusente());

    await correr();

    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('un error del cron no derriba la API', () => {
  const fallas = [
    ['columna ausente',  errorColumnaAusente()],
    ['tabla ausente',    Object.assign(new Error("Table 'x' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', sqlState: '42S02' })],
    ['acceso denegado',  Object.assign(new Error('Access denied'), { code: 'ER_ACCESS_DENIED_ERROR', sqlState: '28000' })],
    ['conexión perdida', Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' })],
    ['error sin código', new Error('algo raro')],
  ];

  test.each(fallas)('%s: el callback no lanza', async (_n, err) => {
    mockQuery.mockRejectedValueOnce(err);

    await expect(correr()).resolves.toBeUndefined();
    expect(mockLogs.error).toHaveLength(1);
  });

  test('ninguna promesa queda sin manejar', async () => {
    const sinManejar = [];
    const captura = (r) => sinManejar.push(r);
    process.on('unhandledRejection', captura);

    mockQuery.mockRejectedValueOnce(errorColumnaAusente());
    await correr();
    mockQuery.mockReset();
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    await correr();

    await new Promise(r => setImmediate(r));
    process.off('unhandledRejection', captura);

    expect(sinManejar).toEqual([]);
  });

  test('un envío que falla no aborta el resto de la tanda', async () => {
    mockQuery.mockResolvedValueOnce([[
      asignacion({ assignment_id: 1 }),
      asignacion({ assignment_id: 2, employee_email: 'b@example.com' }),
    ]]);
    mockSendMail.mockRejectedValueOnce(new Error('SMTP caído'));
    mockSendMail.mockResolvedValueOnce({ ok: true });

    await correr();

    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(mockLogs.error).toHaveLength(0);
  });

  test('registrar el cron nunca lanza, ni con node-cron roto', () => {
    const cron = require('node-cron');
    const original = cron.schedule;
    cron.schedule = () => { throw new Error('node-cron roto'); };
    try {
      expect(() => startCoursesDueCron()).not.toThrow();
      expect(mockLogs.error.some(l => l.meta?.job === 'capacitaciones_vencimiento')).toBe(true);
    } finally {
      cron.schedule = original;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('estado de la migración 028', () => {
  test('028 es la única migración que define las tablas de capacitaciones', () => {
    const definen = fs.readdirSync(MIGRACIONES)
      .filter(f => f.endsWith('.sql'))
      .filter(f => /CREATE TABLE IF NOT EXISTS (courses|course_assignments)\s*\(/
        .test(fs.readFileSync(path.join(MIGRACIONES, f), 'utf8')));

    expect(definen).toEqual(['028_courses.sql']);
  });

  test('no se agregó una migración 072 que invente la columna status', () => {
    // El esquema siempre estuvo bien: el que estaba mal era el filtro. Crear
    // `status` para que la consulta rota funcione dejaría esquema muerto que
    // nadie escribe y un estado que ninguna ruta mantiene.
    for (const f of fs.readdirSync(MIGRACIONES).filter(x => x.endsWith('.sql'))) {
      const sql = fs.readFileSync(path.join(MIGRACIONES, f), 'utf8');
      expect(sql).not.toMatch(/course_assignments[\s\S]{0,200}\bstatus\s+(ENUM|VARCHAR)/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('el detector de deriva ahora mira columnas', () => {
  const DRIFT = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'check-schema-drift.js'), 'utf8');

  test('consulta information_schema.COLUMNS, no sólo TABLES', () => {
    // Producción informaba "✅ Sin deriva" mientras el cron fallaba con 42S22:
    // el check sólo comparaba nombres de tabla.
    expect(DRIFT).toContain('information_schema.COLUMNS');
  });

  test('la lista de columnas críticas es curada, no derivada del DDL', () => {
    expect(DRIFT).toContain('COLUMNAS_CRITICAS');
    // Corta a propósito: si crece sin control se vuelve el comparador genérico
    // frágil que se quiso evitar.
    const bloque = DRIFT.match(/const COLUMNAS_CRITICAS = \[([\s\S]*?)\n\];/);
    expect(bloque).toBeTruthy();
    const entradas = bloque[1].match(/\{\s*tabla:/g) || [];
    expect(entradas.length).toBeGreaterThan(0);
    expect(entradas.length).toBeLessThanOrEqual(25);
  });

  test('verifica el par (tabla, columna) junto, no el nombre suelto', () => {
    // `status` existe en employees; preguntarse sólo "¿existe una columna
    // status?" habría contestado que sí mientras el cron seguía roto.
    expect(DRIFT).toMatch(/\$\{c\.tabla\.toLowerCase\(\)\}\.\$\{c\.columna\.toLowerCase\(\)\}/);
  });

  test('cada columna crítica declara quién la usa', () => {
    const bloque = DRIFT.match(/const COLUMNAS_CRITICAS = \[([\s\S]*?)\n\];/)[1];
    const tablas = (bloque.match(/\{\s*tabla:/g) || []).length;
    const usos   = (bloque.match(/usadaPor:/g) || []).length;
    expect(usos).toBe(tablas);
  });

  test('cubre las columnas que rompieron el cron de capacitaciones', () => {
    expect(DRIFT).toMatch(/tabla: 'course_assignments',\s*columna: 'completed_at'/);
    expect(DRIFT).toMatch(/tabla: 'courses',\s*columna: 'active'/);
  });

  test('sale con código 1 también cuando sólo faltan columnas', () => {
    expect(DRIFT).toMatch(/process\.exitCode = \(faltantes\.length \|\| columnas\.length\) \? 1 : 0/);
  });

  test('no reporta columnas de tablas que directamente no existen', () => {
    // Ya las reporta el chequeo de tablas; repetirlas es ruido.
    expect(DRIFT).toMatch(/if \(!existentes\.has\(c\.tabla\.toLowerCase\(\)\)\) continue;/);
  });

  test('advierte contra crear la columna sin revisar la consulta', () => {
    expect(DRIFT).toMatch(/esquema muerto|el error real intacto/);
  });
});
