const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Sistema de Asistencia — API',
      version: '1.0.0',
      description: `
## Sistema de Gestión de Asistencia y Recursos Humanos

API REST para el sistema de asistencia biométrica que reemplaza SisHoras.
Se conecta directamente a los relojes ZKTeco y a la base de datos att2000.

### Autenticación
Todos los endpoints (excepto \`/api/auth/login\`) requieren un **JWT Bearer Token**.

\`\`\`
Authorization: Bearer <token>
\`\`\`

### Roles disponibles
- \`admin\`      — Acceso total
- \`hr\`         — Recursos Humanos (gestión de empleados y reportes)
- \`supervisor\` — Ver reportes de su departamento
- \`employee\`   — Solo sus propios datos y marcaje móvil

### Integración con otros sistemas
Usa la clave API en el header \`X-API-Key\` para acceso de sistema a sistema
sin necesidad de usuario/contraseña.

### Webhooks
Registra una URL en \`/api/webhooks\` para recibir marcajes en tiempo real.
      `,
      contact: {
        name: 'Soporte Técnico',
        email: 'soporte@empresa.com'
      }
    },
    servers: [
      { url: 'http://localhost:4000', description: 'Desarrollo local' },
      { url: 'https://asistencia.empresa.com', description: 'Producción' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Token JWT obtenido en POST /api/auth/login'
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'Clave API para integración sistema a sistema'
        }
      },
      schemas: {
        Employee: {
          type: 'object',
          properties: {
            id:              { type: 'integer', example: 1 },
            code:            { type: 'string', example: '1089', description: 'Código en el reloj ZKTeco' },
            employee_number: { type: 'string', example: 'EMP-001' },
            first_name:      { type: 'string', example: 'Juan' },
            last_name:       { type: 'string', example: 'García' },
            full_name:       { type: 'string', example: 'Juan García' },
            email:           { type: 'string', example: 'jgarcia@empresa.com' },
            department:      { type: 'string', example: 'Operaciones' },
            schedule:        { type: 'string', example: 'Turno General (8am-5pm)' },
            check_in:        { type: 'string', example: '08:00:00' },
            check_out:       { type: 'string', example: '17:00:00' },
            status:          { type: 'string', enum: ['active','inactive','suspended'] }
          }
        },
        AttendanceLog: {
          type: 'object',
          properties: {
            id:            { type: 'integer' },
            employee_id:   { type: 'integer' },
            employee_name: { type: 'string', example: 'Juan García' },
            timestamp:     { type: 'string', format: 'date-time' },
            type:          { type: 'string', enum: ['in','out','break_start','break_end','unknown'] },
            source:        { type: 'string', enum: ['device','mobile','manual'] },
            device_name:   { type: 'string', example: 'Reloj Comedor' },
            latitude:      { type: 'number', example: 14.6349 },
            longitude:     { type: 'number', example: -90.5069 }
          }
        },
        DailySummary: {
          type: 'object',
          properties: {
            employee_id:      { type: 'integer' },
            employee_name:    { type: 'string' },
            date:             { type: 'string', format: 'date' },
            first_in:         { type: 'string', format: 'date-time' },
            last_out:         { type: 'string', format: 'date-time' },
            worked_minutes:   { type: 'integer', example: 480 },
            late_minutes:     { type: 'integer', example: 15 },
            overtime_minutes: { type: 'integer', example: 30 },
            // Todos los valores que puede devolver daily_summary.status vía los
            // endpoints de integración (que publican ds.status directo). Incluye
            // 'weekend' (ya en el ENUM base) y 'non_working'/'unconfigured', que
            // el motor persiste con la migración 074 aplicada. El contrato debe
            // listarlos para que un cliente de nómina generado desde OpenAPI no
            // rechace una respuesta válida.
            status: {
              type: 'string',
              enum: ['present','absent','late','permission','holiday','weekend','non_working','unconfigured'],
              description: "Estado del día. 'non_working' (descanso por configuración, p. ej. un martes libre) y 'unconfigured' (sin configuración ni marcajes; NO es ausencia) requieren la migración 074."
            }
          }
        },
        DashboardStats: {
          type: 'object',
          properties: {
            total_employees: { type: 'integer', example: 450 },
            present:         { type: 'integer', example: 380 },
            late:            { type: 'integer', example: 25 },
            absent:          { type: 'integer', example: 45 },
            on_permission:   { type: 'integer', example: 5 }
          }
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Mensaje de error' }
          }
        }
      }
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Auth',        description: 'Autenticación y sesiones' },
      { name: 'Employees',   description: 'Gestión de empleados' },
      { name: 'Attendance',  description: 'Marcajes y asistencia en tiempo real' },
      { name: 'Reports',     description: 'Reportes y estadísticas' },
      { name: 'Devices',     description: 'Gestión de relojes ZKTeco' },
      { name: 'Schedules',   description: 'Horarios y turnos' },
      { name: 'Permissions', description: 'Permisos y ausencias' },
      { name: 'Sync',        description: 'Sincronización con att2000 (SQL Server)' },
      { name: 'Webhooks',    description: 'Notificaciones a sistemas externos' },
      { name: 'Integration', description: 'Endpoints especiales para integraciones' },
    ]
  },
  apis: ['./src/routes/*.js', './src/controllers/*.js'],
};

module.exports = swaggerJsdoc(options);
