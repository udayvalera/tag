import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { customAlphabet } from 'nanoid';
import { PLAYER_COLLISION, getHeadbandByIndex } from './public/game-config.js';

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

// --- Game Constants ---
const GAME_DURATION_MS = 120_000;
const PRE_GAME_COUNTDOWN_MS = 3000;
const MAX_PLAYERS_PER_ROOM = 8;
const PLAYER_STATE_MIN_INTERVAL_MS = 30;
const TAG_ATTEMPT_MIN_INTERVAL_MS = 120;
const TAG_VALIDATION_GRACE_PX = 96;
const ENDED_ROOM_TTL_MS = 10 * 60 * 1000;
const ROOM_CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_ABS_VELOCITY = 2400;
const EFFECT_DEFAULT_MS = 8000;
const TAG_RADIUS = PLAYER_COLLISION.tagRadius;

const PLATFORMS = [
  // Ground platform
  { x: 0, y: 0, w: 1600, h: 40 },

  // Lower level platforms
  { x: 200, y: 180, w: 200, h: 30 },
  { x: 500, y: 220, w: 300, h: 30 },
  { x: 950, y: 180, w: 200, h: 30 },

  // Middle level platforms
  { x: 100, y: 360, w: 180, h: 24 },
  { x: 400, y: 400, w: 150, h: 24 },
  { x: 700, y: 360, w: 150, h: 24 },
  { x: 1000, y: 400, w: 180, h: 24 },
  { x: 1300, y: 360, w: 180, h: 24 },

  // Upper level platforms
  { x: 300, y: 540, w: 200, h: 24 },
  { x: 750, y: 580, w: 300, h: 24 },

  // Diagonal platforms (approximated with multiple small platforms)
  { x: 450, y: 300, w: 100, h: 24 },
  { x: 550, y: 340, w: 100, h: 24 },
  { x: 650, y: 380, w: 100, h: 24 },

  // Additional platforms to fill in gaps
  { x: 850, y: 480, w: 120, h: 24 },
  { x: 1150, y: 520, w: 120, h: 24 }
];

const WORLD_PAYLOAD = {
  version: 1,
  worldWidth: 1600,
  worldHeight: 720,
  platforms: PLATFORMS
};

const WORLD_MIN_X = 0;
const WORLD_MAX_X = WORLD_PAYLOAD.worldWidth;
const WORLD_MIN_Y = 0;
const WORLD_MAX_Y = WORLD_PAYLOAD.worldHeight + 360;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeName(name) {
  return name?.substring(0, 16) || 'Player';
}

function defaultPlayerState(id, name) {
  const now = Date.now();
  return {
    id,
    name: sanitizeName(name),
    x: 800,
    y: 270,
    vx: 0,
    vy: 0,
    dir: 1,
    grounded: false,
    isTagger: false,
    color: null,
    headbandId: null,
    effects: [],
    lastSeq: 0,
    lastAcceptedStateAt: 0,
    lastTagAttemptAt: 0,
    lastStateAt: now
  };
}

class GameRoom {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.powerUps = new Map();
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
    this.state = 'waiting';
    this.countdownStartAt = null;
    this.gameStartAt = null;
    this.gameEndsAt = null;
    this.endedAt = null;
    this.taggerId = null;
    this.leaderId = null;
    this.blockedContactPairs = new Set();
    this._colorIndex = 0;
    this._startTimer = null;
    this._endTimer = null;
  }

  addPlayer(socket, name) {
    const player = defaultPlayerState(socket.id, name);
    const headband = getHeadbandByIndex(this._colorIndex);
    player.color = headband.color;
    player.headbandId = headband.id;
    this._colorIndex++;

    this.players.set(socket.id, player);
    if (!this.leaderId) this.leaderId = socket.id;
    this.updatedAt = Date.now();
    return player;
  }

  removePlayer(id) {
    const removed = this.players.delete(id);
    if (!removed) return false;

    if (this.leaderId === id) {
      const first = this.players.keys().next();
      this.leaderId = first && !first.done ? first.value : null;
    }

    if (this.taggerId === id) {
      const nextTagger = this.players.keys().next();
      this.setTagger(nextTagger && !nextTagger.done ? nextTagger.value : null);
    }

    for (const key of Array.from(this.blockedContactPairs)) {
      if (key.split('|').includes(id)) this.blockedContactPairs.delete(key);
    }

    if (this.players.size < 2 && this.state === 'countdown') {
      this.cancelCountdown();
    } else if (this.players.size < 2 && this.state === 'running') {
      this.endGame(Date.now());
    }

    this.updatedAt = Date.now();
    return true;
  }

  canJoin() {
    return this.players.size < MAX_PLAYERS_PER_ROOM;
  }

  setTagger(id) {
    this.taggerId = id || null;
    for (const player of this.players.values()) {
      player.isTagger = player.id === this.taggerId;
    }
  }

  startCountdown() {
    if (this.state !== 'waiting' && this.state !== 'ended') {
      return { error: 'Game already started' };
    }
    if (this.players.size < 2) {
      return { error: 'Need at least 2 players' };
    }

    this.clearTimers();
    const now = Date.now();
    this.state = 'countdown';
    this.countdownStartAt = now;
    this.gameStartAt = now + PRE_GAME_COUNTDOWN_MS;
    this.gameEndsAt = this.gameStartAt + GAME_DURATION_MS;
    this.endedAt = null;
    this.blockedContactPairs.clear();

    const ids = Array.from(this.players.keys());
    this.setTagger(ids[Math.floor(Math.random() * ids.length)]);
    this.updatedAt = now;

    this._startTimer = setTimeout(() => {
      this.startRunning();
    }, Math.max(0, this.gameStartAt - Date.now()));

    this.broadcastRoomState();
    return { ok: true };
  }

  startRunning() {
    if (this.state !== 'countdown') return;
    if (this.players.size < 2) {
      this.cancelCountdown();
      return;
    }

    this.state = 'running';
    this.updatedAt = Date.now();
    this.broadcastRoomState();
    this._endTimer = setTimeout(() => {
      this.endGame(this.gameEndsAt);
    }, Math.max(0, this.gameEndsAt - Date.now()));
  }

  cancelCountdown() {
    this.clearTimers();
    this.state = 'waiting';
    this.countdownStartAt = null;
    this.gameStartAt = null;
    this.gameEndsAt = null;
    this.setTagger(null);
    this.updatedAt = Date.now();
  }

  endGame(endedAt = Date.now()) {
    if (this.state === 'ended') return;
    this.clearTimers();
    this.state = 'ended';
    this.endedAt = endedAt;
    if (!this.gameEndsAt || this.gameEndsAt > endedAt) this.gameEndsAt = endedAt;
    this.updatedAt = Date.now();
    this.broadcastRoomState();
  }

  clearTimers() {
    if (this._startTimer) clearTimeout(this._startTimer);
    if (this._endTimer) clearTimeout(this._endTimer);
    this._startTimer = null;
    this._endTimer = null;
  }

  acceptPlayerState(id, rawState) {
    const player = this.players.get(id);
    if (!player || !rawState || typeof rawState !== 'object') return null;

    const now = Date.now();
    if (now - player.lastAcceptedStateAt < PLAYER_STATE_MIN_INTERVAL_MS) return null;

    const seq = finiteNumber(rawState.seq);
    if (seq !== null && seq <= player.lastSeq) return null;

    const x = finiteNumber(rawState.x);
    const y = finiteNumber(rawState.y);
    const vx = finiteNumber(rawState.vx);
    const vy = finiteNumber(rawState.vy);
    if (x === null || y === null || vx === null || vy === null) return null;

    const dirValue = finiteNumber(rawState.dir);
    const dir = dirValue === null
      ? player.dir
      : (dirValue < 0 ? -1 : 1);
    const groundedRaw = rawState.grounded ?? rawState.isGrounded;
    const grounded = typeof groundedRaw === 'boolean' ? groundedRaw : player.grounded;

    player.x = clamp(x, WORLD_MIN_X, WORLD_MAX_X);
    player.y = clamp(y, WORLD_MIN_Y, WORLD_MAX_Y);
    player.vx = clamp(vx, -MAX_ABS_VELOCITY, MAX_ABS_VELOCITY);
    player.vy = clamp(vy, -MAX_ABS_VELOCITY, MAX_ABS_VELOCITY);
    player.dir = dir;
    player.grounded = grounded;
    player.lastAcceptedStateAt = now;
    player.lastStateAt = now;
    if (seq !== null) player.lastSeq = seq;
    this.updatedAt = now;

    this.refreshTagContactBlocks();

    return {
      x: player.x,
      y: player.y,
      vx: player.vx,
      vy: player.vy,
      dir: player.dir,
      grounded: player.grounded,
      seq: player.lastSeq,
      clientTime: finiteNumber(rawState.clientTime),
      serverTime: now
    };
  }

  tryTag(senderId, targetId) {
    const now = Date.now();
    const tagger = this.players.get(senderId);
    const target = this.players.get(targetId);
    if (this.state !== 'running') return { error: 'Game is not running' };
    if (!tagger || !target || senderId === targetId) return { error: 'Invalid target' };
    if (senderId !== this.taggerId) return { error: 'Only current tagger can tag' };
    if (now < this.gameStartAt || now >= this.gameEndsAt) return { error: 'Outside game time' };
    if (now - tagger.lastTagAttemptAt < TAG_ATTEMPT_MIN_INTERVAL_MS) return { error: 'Tag rate limited' };

    tagger.lastTagAttemptAt = now;
    this.refreshTagContactBlocks();

    const key = this.cooldownKey(senderId, targetId);
    if (this.blockedContactPairs.has(key)) return { error: 'Players must separate before re-tagging' };
    if (!this.isLooseTagValid(tagger, target)) return { error: 'Players are too far apart' };

    this.setTagger(targetId);
    this.blockedContactPairs.add(key);
    this.updatedAt = now;

    io.to(this.code).emit('tag', {
      taggerId: targetId,
      taggedById: senderId,
      serverTime: now
    });

    return { ok: true };
  }

  isLooseTagValid(tagger, target) {
    const maxDistance = TAG_RADIUS + TAG_VALIDATION_GRACE_PX;
    const dx = target.x - tagger.x;
    const dy = target.y - tagger.y;
    return dx * dx + dy * dy <= maxDistance * maxDistance;
  }

  refreshTagContactBlocks() {
    for (const key of Array.from(this.blockedContactPairs)) {
      const [a, b] = key.split('|');
      const playerA = this.players.get(a);
      const playerB = this.players.get(b);
      if (!playerA || !playerB) {
        this.blockedContactPairs.delete(key);
        continue;
      }

      const dx = playerB.x - playerA.x;
      const dy = playerB.y - playerA.y;
      const separationRadius = TAG_RADIUS + 4;
      if (dx * dx + dy * dy > separationRadius * separationRadius) {
        this.blockedContactPairs.delete(key);
      }
    }
  }

  cooldownKey(a, b) {
    return [a, b].sort().join('|');
  }

  claimPowerUp(playerId, rawPowerUpId) {
    const player = this.players.get(playerId);
    const powerUpId = String(rawPowerUpId || '');
    const powerUp = this.powerUps.get(powerUpId);
    const now = Date.now();

    if (!player) return { error: 'Player not found' };
    if (!powerUp || powerUp.claimedBy || (powerUp.expiresAt && powerUp.expiresAt <= now)) {
      return { error: 'Power-up unavailable' };
    }

    powerUp.claimedBy = playerId;
    const effect = {
      type: powerUp.type,
      startedAt: now,
      expiresAt: now + EFFECT_DEFAULT_MS,
      params: powerUp.params || {}
    };

    player.effects = player.effects.filter(existing => !existing.expiresAt || existing.expiresAt > now);
    player.effects.push(effect);
    this.updatedAt = now;

    io.to(this.code).emit('effectApplied', {
      playerId,
      effect,
      expiresAt: effect.expiresAt,
      serverTime: now
    });
    this.broadcastRoomState();

    return { ok: true, effect };
  }

  roomStatePayload() {
    const now = Date.now();
    return {
      serverTime: now,
      state: this.state,
      gameStartAt: this.gameStartAt,
      gameEndsAt: this.gameEndsAt,
      players: Array.from(this.players.values()).map(player => this.serializePlayer(player, now)),
      taggerId: this.taggerId,
      leaderId: this.leaderId,
      powerUps: Array.from(this.powerUps.values()),
      effects: Object.fromEntries(Array.from(this.players.values()).map(player => [
        player.id,
        player.effects.filter(effect => !effect.expiresAt || effect.expiresAt > now)
      ]))
    };
  }

  serializePlayer(player, now = Date.now()) {
    return {
      id: player.id,
      name: player.name,
      x: player.x,
      y: player.y,
      dir: player.dir,
      isTagger: player.isTagger,
      vx: player.vx,
      vy: player.vy,
      color: player.color,
      headbandId: player.headbandId,
      grounded: player.grounded,
      effects: player.effects.filter(effect => !effect.expiresAt || effect.expiresAt > now)
    };
  }

  broadcastRoomState() {
    io.to(this.code).emit('roomState', this.roomStatePayload());
  }
}

const rooms = new Map();
const socketRoomCodes = new Map();

function createRoom() {
  let code;
  do { code = nanoid(); } while (rooms.has(code));
  const room = new GameRoom(code);
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
// - tagPlayer/tag: current tagger proposes contact; server verifies same-room/current-tagger/loose range.
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
