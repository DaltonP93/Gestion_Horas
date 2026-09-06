const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const logger = require('../config/logger');

let io;

function initSocket(server) {
  // Construir lista de orígenes permitidos: permite http y https del mismo dominio
  const rawOrigin = process.env.FRONTEND_URL || 'http://localhost:3000';
  const allowedOrigins = Array.from(new Set([
    rawOrigin,
    rawOrigin.replace(/^http:\/\//,  'https://'),
    rawOrigin.replace(/^https:\/\//, 'http://'),
    'http://localhost:3000',
    'https://localhost:3000',
    'http://sishoras.saa.com.py',
    'https://sishoras.saa.com.py',
  ]));

  io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true
    },
    // Permite WebSocket y polling como fallback
    transports: ['websocket', 'polling'],
  });

  // Middleware de autenticación para WebSocket
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Token requerido'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      socket.user = decoded;
      next();
    } catch {
      next(new Error('Token inválido'));
    }
  });

  io.on('connection', (socket) => {
    logger.info(`Socket conectado: ${socket.id} | Usuario: ${socket.user?.username}`);

    // Unir al usuario a su sala según rol
    socket.join(`role:${socket.user.role}`);
    socket.join(`user:${socket.user.id}`);

    socket.on('disconnect', () => {
      logger.info(`Socket desconectado: ${socket.id}`);
    });
  });

  logger.info('✅ Socket.io listo');
  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.io no inicializado');
  return io;
}

// Roles que pueden ver el feed en vivo de marcajes (dashboard/asistencia).
// Los empleados NO lo reciben: verían marcajes de otros compañeros.
const ATTENDANCE_ROLES = [
  'super_admin', 'admin', 'gth', 'hr',
  'coordinator', 'manager', 'gestor', 'supervisor',
];

/**
 * Emite un evento de marcaje solo a las salas de roles de gestión (y, si se
 * indica, a la sala personal del usuario dueño del marcaje), en vez de a
 * TODOS los sockets. Evita la fuga de datos de asistencia entre empleados.
 */
function emitAttendance(event, ownerUserId = null) {
  if (!io) return;
  let target = io.to(ATTENDANCE_ROLES.map(r => `role:${r}`));
  if (ownerUserId) target = target.to(`user:${ownerUserId}`);
  target.emit('attendance:new', event);
}

module.exports = { initSocket, getIO, emitAttendance, get io() { return io; } };
