-- =============================================================
--  Sistema de Asistencia — Esquema de Base de Datos
--  Reemplazo de SisHoras
-- =============================================================

SET NAMES utf8mb4;
SET time_zone = '-03:00'; -- Paraguay (America/Asuncion) — coincide con api/config/database.js
-- IMPORTANTE: fijar también la zona por defecto del servidor MySQL para que
-- consultas fuera de la app (cron/CLI) usen la misma base horaria:
--   [mysqld] default-time-zone = '-03:00'   (my.cnf)  ó  SET GLOBAL time_zone='-03:00';

-- -------------------------------------------------------------
-- Departamentos
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  name       VARCHAR(100) NOT NULL,
  code       VARCHAR(20) UNIQUE,
  manager_id INT NULL,
  active     TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Horarios / Turnos
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedules (
  id              INT PRIMARY KEY AUTO_INCREMENT,
  name            VARCHAR(100) NOT NULL,
  check_in        TIME NOT NULL,
  check_out       TIME NOT NULL,
  tolerance_in    INT DEFAULT 10,   -- minutos de tolerancia de entrada
  tolerance_out   INT DEFAULT 10,   -- minutos antes de salida permitida
  work_days       VARCHAR(20) DEFAULT '1,2,3,4,5', -- convención heredada 1=Lun..7=Dom; la migración 046 la remapea a DAYOFWEEK (1=Dom..7=Sáb)
  active          TINYINT(1) DEFAULT 1,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Empleados
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
  id              INT PRIMARY KEY AUTO_INCREMENT,
  code            VARCHAR(20) UNIQUE NOT NULL,  -- código en el reloj ZKTeco
  employee_number VARCHAR(30) UNIQUE,
  first_name      VARCHAR(80) NOT NULL,
  last_name       VARCHAR(80) NOT NULL,
  email           VARCHAR(150) UNIQUE,
  phone           VARCHAR(20),
  department_id   INT,
  schedule_id     INT,
  position        VARCHAR(100),
  hire_date       DATE,
  status          ENUM('active','inactive','suspended') DEFAULT 'active',
  photo_url       VARCHAR(255),
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
  FOREIGN KEY (schedule_id)   REFERENCES schedules(id)   ON DELETE SET NULL,
  INDEX idx_code (code),
  INDEX idx_dept (department_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Usuarios del sistema (RH, Admins, Supervisores)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              INT PRIMARY KEY AUTO_INCREMENT,
  username        VARCHAR(60) UNIQUE NOT NULL,
  email           VARCHAR(150) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  full_name       VARCHAR(150),
  role            ENUM('admin','hr','supervisor','employee') DEFAULT 'hr',
  employee_id     INT NULL,  -- si el usuario es también empleado
  active          TINYINT(1) DEFAULT 1,
  last_login      DATETIME,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Relojes Biométricos ZKTeco
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  name        VARCHAR(100) NOT NULL,
  ip_address  VARCHAR(15)  NOT NULL,
  port        INT DEFAULT 4370,
  serial_no   VARCHAR(50),
  location    VARCHAR(150),
  status      ENUM('online','offline','error') DEFAULT 'offline',
  last_sync   DATETIME,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_ip (ip_address)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Registros de Marcaje (Fuente de verdad)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_logs (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  employee_id  INT NOT NULL,
  device_id    INT NULL,
  `timestamp`  DATETIME NOT NULL,
  type         ENUM('in','out','break_start','break_end','unknown') DEFAULT 'unknown',
  source       ENUM('device','mobile','manual') DEFAULT 'device',
  latitude     DECIMAL(10,8) NULL,   -- marcaje desde app móvil
  longitude    DECIMAL(11,8) NULL,
  accuracy     FLOAT NULL,           -- precisión GPS en metros
  raw_data     JSON NULL,            -- datos crudos del reloj
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id)   REFERENCES devices(id)   ON DELETE SET NULL,
  INDEX idx_emp_ts  (employee_id, `timestamp`),
  INDEX idx_ts      (`timestamp`),
  INDEX idx_date    ((DATE(`timestamp`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Resumen Diario (Calculado — se actualiza con cada marcaje)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_summary (
  id                INT PRIMARY KEY AUTO_INCREMENT,
  employee_id       INT NOT NULL,
  date              DATE NOT NULL,
  schedule_id       INT NULL,
  first_in          DATETIME NULL,
  last_out          DATETIME NULL,
  worked_minutes    INT DEFAULT 0,
  break_minutes     INT DEFAULT 0,
  late_minutes      INT DEFAULT 0,   -- minutos de retardo
  overtime_minutes  INT DEFAULT 0,   -- horas extra
  status            ENUM('present','absent','late','permission','holiday','weekend') DEFAULT 'absent',
  notes             TEXT NULL,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_emp_date (employee_id, date),
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  INDEX idx_date     (date),
  INDEX idx_status   (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Permisos y Ausencias
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS permissions (
  id           INT PRIMARY KEY AUTO_INCREMENT,
  employee_id  INT NOT NULL,
  type         ENUM('vacation','sick','personal','maternity','paternity','other') NOT NULL,
  date_from    DATE NOT NULL,
  date_to      DATE NOT NULL,
  reason       TEXT,
  status       ENUM('pending','approved','rejected') DEFAULT 'pending',
  approved_by  INT NULL,
  approved_at  DATETIME NULL,
  rejection_reason TEXT NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (approved_by) REFERENCES users(id)     ON DELETE SET NULL,
  INDEX idx_emp_dates (employee_id, date_from, date_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Días festivos / No laborables
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS holidays (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  name        VARCHAR(150) NOT NULL,
  date        DATE UNIQUE NOT NULL,
  type        ENUM('national','company','regional') DEFAULT 'national',
  active      TINYINT(1) DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Refresh Tokens (para JWT)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  user_id     INT NOT NULL,
  token_hash  VARCHAR(255) UNIQUE NOT NULL,
  expires_at  DATETIME NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================================
-- DATOS INICIALES
-- =============================================================

-- Horario estándar
INSERT INTO schedules (name, check_in, check_out, tolerance_in) VALUES
  ('Turno General (8am-5pm)',   '08:00:00', '17:00:00', 10),
  ('Turno Mañana (7am-3pm)',    '07:00:00', '15:00:00', 10),
  ('Turno Tarde (2pm-10pm)',    '14:00:00', '22:00:00', 10),
  ('Turno Noche (10pm-6am)',    '22:00:00', '06:00:00', 15),
  ('Medio Tiempo (9am-1pm)',    '09:00:00', '13:00:00', 10);

-- Departamento inicial
INSERT INTO departments (name, code) VALUES
  ('Recursos Humanos', 'RH'),
  ('Administración',   'ADMIN'),
  ('Operaciones',      'OPS'),
  ('Tecnología',       'TI');

-- Usuario administrador por defecto (password: Admin1234!)
INSERT INTO users (username, email, password_hash, full_name, role) VALUES
  ('admin', 'admin@empresa.com',
   '$2b$10$UdZP2jn7Zn.Tl/lJtxiDIe8CqSI/3GDMj33hLUATnCUX/ve4ZpTmy', -- Admin1234!
   'Administrador del Sistema', 'admin');

-- Días festivos México/Guatemala 2026 (agregar según país)
INSERT INTO holidays (name, date, type) VALUES
  ('Año Nuevo',              '2026-01-01', 'national'),
  ('Día del Trabajo',        '2026-05-01', 'national'),
  ('Independencia',          '2026-09-15', 'national'),
  ('Navidad',                '2026-12-25', 'national');
