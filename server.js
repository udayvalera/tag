import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { customAlphabet } from 'nanoid';
import {
  ENDED_ROOM_TTL_MS,
  GameRoom,
  ROOM_CLEANUP_INTERVAL_MS,
  WORLD_PAYLOAD
} from './game-room.js';

const nanoid = customAlphabet('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 6);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

const noCacheHtml = 'no-store, no-cache, must-revalidate';
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', noCacheHtml);
  }
  next();
});

app.use(express.static('public', {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', noCacheHtml);
    }
  }
}));

const rooms = new Map();
const socketRoomCodes = new Map();

function createRoom() {
  let code;
  do { code = nanoid(); } while (rooms.has(code));
  const room = new GameRoom(code, (event, payload) => {
    io.to(code).emit(event, payload);
  });
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(code);
}

function getSocketRoom(socketId) {
  const code = socketRoomCodes.get(socketId);
  return code ? rooms.get(code) : null;
}

function emitWorld(socket) {
  socket.emit('world', WORLD_PAYLOAD);
}

function deleteRoom(code, reason = 'cleanup') {
  const room = rooms.get(code);
  if (!room) return;

  room.clearTimers();
  rooms.delete(code);
  for (const playerId of room.players.keys()) {
    socketRoomCodes.delete(playerId);
  }

  io.to(code).emit('roomClosed', { reason });
  io.in(code).socketsLeave(code);
}

function leaveCurrentRoom(socket, reason = 'left') {
  const code = socketRoomCodes.get(socket.id);
  if (!code) return;

  socketRoomCodes.delete(socket.id);
  socket.leave(code);

  const room = rooms.get(code);
  if (!room) return;

  room.removePlayer(socket.id);
  if (room.players.size === 0) {
    deleteRoom(code, 'empty');
    return;
  }

  socket.to(code).emit('playerLeft', { id: socket.id, reason });
  room.broadcastRoomState();
}

// Socket.IO protocol:
// - roomState: low-frequency lifecycle + metadata snapshot for create/join/start/tag/leave.
// - playerState: compact client-owned kinematic update, accepted at about 30 Hz and relayed to peers.
// - tag: server-owned contact transition detected from accepted playerState.
// - tagPlayer/tag: compatibility path for current tagger contact proposals.
// - claimPowerup/effectApplied: future shared-event path for server-approved pickups and timed effects.
io.on('connection', socket => {
  socket.on('createRoom', ({ name } = {}, cb) => {
    leaveCurrentRoom(socket, 'switch-room');

    const room = createRoom();
    socket.join(room.code);
    socketRoomCodes.set(socket.id, room.code);
    room.addPlayer(socket, name);
    emitWorld(socket);
    cb?.({ code: room.code });
    room.broadcastRoomState();
  });

  socket.on('joinRoom', ({ code, name } = {}, cb) => {
    const normalizedCode = String(code || '').trim().toUpperCase();
    const room = getRoom(normalizedCode);
    if (!room) return cb?.({ error: 'Room not found' });
    if (!room.canJoin()) return cb?.({ error: 'Room is full' });

    leaveCurrentRoom(socket, 'switch-room');
    socket.join(normalizedCode);
    socketRoomCodes.set(socket.id, normalizedCode);
    room.addPlayer(socket, name);
    emitWorld(socket);
    cb?.({ ok: true });
    room.broadcastRoomState();
  });

  socket.on('startGame', ({ code } = {}, cb) => {
    const mappedCode = socketRoomCodes.get(socket.id);
    const normalizedCode = String(code || mappedCode || '').trim().toUpperCase();
    if (!mappedCode || mappedCode !== normalizedCode) return cb?.({ error: 'Not in that room' });

    const room = getRoom(normalizedCode);
    if (!room) return cb?.({ error: 'Room not found' });
    if (room.leaderId !== socket.id) return cb?.({ error: 'Only leader can start' });

    const result = room.startCountdown();
    cb?.(result);
  });

  socket.on('playerState', payload => {
    const room = getSocketRoom(socket.id);
    if (!room) return;

    const accepted = room.acceptPlayerState(socket.id, payload);
    if (!accepted) return;

    socket.to(room.code).emit('playerState', {
      id: socket.id,
      x: accepted.x,
      y: accepted.y,
      vx: accepted.vx,
      vy: accepted.vy,
      dir: accepted.dir,
      grounded: accepted.grounded,
      seq: accepted.seq,
      clientTime: accepted.clientTime,
      serverTime: accepted.serverTime
    });
  });

  socket.on('tagPlayer', ({ targetId } = {}, cb) => {
    const room = getSocketRoom(socket.id);
    if (!room) return cb?.({ error: 'Not in a room' });

    const result = room.tryTag(socket.id, String(targetId || ''));
    cb?.(result);
  });

  socket.on('claimPowerup', ({ id } = {}, cb) => {
    const room = getSocketRoom(socket.id);
    if (!room) return cb?.({ error: 'Not in a room' });

    cb?.(room.claimPowerUp(socket.id, id));
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket, 'disconnect');
  });

  // Lightweight latency echo (client sends timestamp, we immediately echo it back)
  socket.on('latencyPing', ({ t } = {}) => {
    socket.emit('latencyPong', { t });
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.state === 'ended') {
      const inactiveSince = Math.max(room.endedAt || 0, room.updatedAt || 0);
      if (inactiveSince && now - inactiveSince >= ENDED_ROOM_TTL_MS) {
        deleteRoom(code, 'ended-ttl');
      }
    }
  }
}, ROOM_CLEANUP_INTERVAL_MS);

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
httpServer.listen(PORT, HOST, () => console.log('Server listening on ' + HOST + ':' + PORT + ' (rooms: ' + rooms.size + ')'));
