-- =============================================================
-- Migración 067: repositorio de documentos personales del empleado.
--
-- Guarda documentos que RR.HH. sube a la ficha del empleado (recibos
-- de sueldo, contratos, certificados, otros). El empleado los descarga
-- desde su portal (self-service) siempre que `visible_to_employee = 1`
-- y el documento pertenezca a su propio empleado.
--
-- El binario NO vive en la BD: guardamos `filename` y `path` relativos
-- al UPLOAD_DIR (mismo mecanismo que las fotos de perfil).
--
-- Idempotente vía IF NOT EXISTS.
-- =============================================================

CREATE TABLE IF NOT EXISTS employee_documents (
  id                   INT PRIMARY KEY AUTO_INCREMENT,
  employee_id          INT NOT NULL,
  category             ENUM('payslip','contract','certificate','other') NOT NULL DEFAULT 'other',
  period               VARCHAR(10) NULL,   -- 'YYYY-MM' para recibos, opcional
  title                VARCHAR(200) NOT NULL,
  filename             VARCHAR(255) NOT NULL,
  path                 VARCHAR(500) NOT NULL,
  size_bytes           INT NOT NULL DEFAULT 0,
  mime                 VARCHAR(100) NULL,
  uploaded_by          INT NULL,
  uploaded_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  visible_to_employee  TINYINT(1) NOT NULL DEFAULT 1,
  note                 VARCHAR(500) NULL,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)     ON DELETE SET NULL,
  INDEX idx_doc_emp        (employee_id, uploaded_at DESC),
  INDEX idx_doc_emp_cat    (employee_id, category, period),
  INDEX idx_doc_visible    (employee_id, visible_to_employee)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SELECT 'Migración 067 aplicada: employee_documents' AS info;
