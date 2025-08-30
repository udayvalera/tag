import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { customAlphabet } from 'nanoid';

const nanoid = customAlphabet('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 6);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

app.use(express.static('public'));

// --- Game Constants ---
const GAME_DURATION_MS = 120_000; // configurable
const PRE_GAME_COUNTDOWN_MS = 3000;
const TICK_RATE = 60; // server authoritative tick in Hz
const TAG_COOLDOWN_MS = 2000; // cooldown between two same players tagging each other again
const TAGGER_SPEED_MULT = 1.08; // slight edge
const BASE_SPEED = 220; // units per second
// Tuned jump: increase vertical reach so players can climb successive platforms naturally.
// With JUMP_VELOCITY 720 and GRAVITY 1400 => apex time ~0.51s, total airtime ~1.02s, height gain ~185.
// Platform vertical gaps require ~174 max step, so this gives slight buffer without feeling floaty.
const JUMP_VELOCITY = 720; // units/s
const GRAVITY = 1400; // units/s^2 (slightly higher for a crisp fall)
const PLAYER_HEIGHT = 36; // approximate diameter used for head collisions
const PLAYER_RADIUS = PLAYER_HEIGHT / 2; // for horizontal overlap tests
// Advanced jump tuning
const JUMP_SUSTAIN_MS = 140; // window to sustain upward velocity (low gravity phase)
const JUMP_LOW_GRAVITY_FACTOR = 0.55; // fraction of gravity applied while holding jump in sustain window
const JUMP_SHORT_HOP_FACTOR = 0.35; // velocity multiplier on early release
const COYOTE_MS = 80; // grace period after leaving ground to still jump
const JUMP_BUFFER_MS = 90; // buffer window for jump pressed slightly before landing

// Simple platform layout (x, y, width, height). y=0 is ground baseline.
const PLATFORMS = [
  // ground
  { x: 0, y: 0, w: 1600, h: 40 },
  // middle main spawn platform
  { x: 300, y: 240, w: 1000, h: 30 },
  { x: 100, y: 420, w: 400, h: 24 },
  { x: 1100, y: 420, w: 400, h: 24 },
  { x: 600, y: 560, w: 400, h: 24 }
];

function defaultPlayerState(id, name) {
  return {
    id,
    name: name?.substring(0,16) || 'Player',
    x: 800, // center spawn horizontally on middle platform
    y: 270, // slightly above middle platform surface for gravity settle
    vx: 0,
    vy: 0,
    dir: 1,
    isGrounded: false,
    inputs: { left: false, right: false, jump: false },
    isTagger: false,
    lastTagTime: 0,
    scoreTimeTaggedMs: 0, // cumulative time being tagger (lower is better maybe) or we can invert
  // jump / platformer auxiliary state
  jumpHeld: false,
  jumpStartTime: 0,
  canVariableJump: false,
  lastGroundedTime: Date.now(),
  bufferedJumpTime: 0,
  lastReceivedInputSeq: 0,
  lastProcessedInputSeq: 0,
  };
}

class GameRoom {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.createdAt = Date.now();
    this.state = 'waiting'; // waiting | countdown | running | ended
    this.gameStartAt = null;
    this.countdownStartAt = null;
    this.lastTick = Date.now();
    this.lastBroadcast = 0;
    this.taggerId = null;
    this.lastTagPairCooldown = new Map(); // key: `${a}|${b}` sorted
  }

  addPlayer(socket, name) {
    const player = defaultPlayerState(socket.id, name);
    this.players.set(socket.id, player);
  // assign leader if none
  if (!this.leaderId) this.leaderId = socket.id;
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.players.size < 2 && this.state === 'running') {
      this.endGame();
    }
    // reassign leader if needed
    if (this.leaderId === id) {
      const first = this.players.keys().next();
      this.leaderId = first && !first.done ? first.value : null;
      if (this.leaderId) io.to(this.code).emit('leaderChanged', { leaderId: this.leaderId });
    }
  }

  startCountdown() {
    if (this.state !== 'waiting' && this.state !== 'ended') return;
    if (this.players.size < 2) return; // need at least 2 players
    this.state = 'countdown';
    this.countdownStartAt = Date.now();
    // reset tagger flags
    for (const p of this.players.values()) p.isTagger = false;
    // choose random tagger
    const ids = Array.from(this.players.keys());
    this.taggerId = ids[Math.floor(Math.random()*ids.length)];
    const p = this.players.get(this.taggerId);
    if (p) p.isTagger = true;
  }

  startGame() {
    this.state = 'running';
    this.gameStartAt = Date.now();
  }

  endGame() {
    if (this.state === 'ended') return;
    this.state = 'ended';
  }

  updatePhysics(dt) {
    // basic platformer physics
  for (const player of this.players.values()) {
      // freeze movement during countdown
      if (this.state === 'countdown') {
        player.vx = 0; player.vy = 0; continue;
      }
      const speed = BASE_SPEED * (player.isTagger ? TAGGER_SPEED_MULT : 1);
      let ax = 0;
      if (player.inputs.left) { ax -= speed; player.dir = -1; }
      if (player.inputs.right) { ax += speed; player.dir = 1; }
      player.vx = ax; // instant accel for simplicity
      const now = Date.now();
      // record last grounded time early (value from previous frame)
      if (player.isGrounded) player.lastGroundedTime = now;

      // Jump buffering & coyote logic
      if (player.inputs.jumpPressed) {
        if (player.isGrounded || (now - player.lastGroundedTime) <= COYOTE_MS) {
          // start jump immediately
          player.vy = JUMP_VELOCITY;
          player.jumpStartTime = now;
          player.canVariableJump = true;
          player.isGrounded = false;
        } else {
          player.bufferedJumpTime = now; // store for later
        }
      }
      // If landing soon after buffered press
      if (player.bufferedJumpTime && (now - player.bufferedJumpTime) <= JUMP_BUFFER_MS) {
        if (player.isGrounded || (now - player.lastGroundedTime) <= COYOTE_MS) {
          player.vy = JUMP_VELOCITY;
          player.jumpStartTime = now;
          player.canVariableJump = true;
          player.isGrounded = false;
          player.bufferedJumpTime = 0;
        }
      }

      // Apply gravity with variable jump sustain
      if (player.vy > 0 && player.canVariableJump) {
        const held = player.jumpHeld; // provided by input events
        const elapsed = now - player.jumpStartTime;
        if (player.inputs.jumpReleased) {
          // early release short hop
            player.vy *= JUMP_SHORT_HOP_FACTOR;
            player.canVariableJump = false;
        } else if (held && elapsed <= JUMP_SUSTAIN_MS) {
          // reduced gravity while holding
          player.vy -= GRAVITY * JUMP_LOW_GRAVITY_FACTOR * dt;
        } else {
          // full gravity now
          player.vy -= GRAVITY * dt;
          if (elapsed > JUMP_SUSTAIN_MS || !held) player.canVariableJump = false;
        }
      } else {
        // normal gravity (descending or cannot variable)
        player.vy -= GRAVITY * dt;
        if (player.vy <= 0) player.canVariableJump = false; // once we start falling, stop sustain
      }

      // integrate
  const prevY = player.y;
  const prevVy = player.vy;
  player.x += player.vx * dt;
  player.y += player.vy * dt;

      // simple world bounds
      if (player.x < 0) player.x = 0;
      if (player.x > 1600) player.x = 1600;

      // collision with platforms (AABB feet)
      player.isGrounded = false;
      for (const plat of PLATFORMS) {
        const topSurface = plat.y + plat.h; // y where feet rest
        const underside = plat.y; // bottom of platform for ceiling checks
        // horizontal overlap using player radius for better edge solidity
        const overlapX = (player.x + PLAYER_RADIUS) > plat.x && (player.x - PLAYER_RADIUS) < (plat.x + plat.w);
        const feetY = player.y;
        // Landing (moving downward crossing through topSurface)
        const crossingDown = overlapX && prevY >= topSurface && feetY < topSurface && prevVy <= 0;
        if (crossingDown) {
          player.y = topSurface;
          player.vy = 0;
          player.isGrounded = true;
          player.canVariableJump = false; // landing ends variable phase
          continue; // skip ceiling check for same frame/platform
        }
        // Ceiling (moving up: head passes underside)
        const headPrev = prevY + PLAYER_HEIGHT;
        const headNow = player.y + PLAYER_HEIGHT;
        const crossingUpInto = overlapX && prevVy > 0 && headPrev <= underside && headNow > underside;
        if (crossingUpInto) {
          player.y = underside - PLAYER_HEIGHT; // place head just below underside
          player.vy = 0; // cancel upward motion
          player.canVariableJump = false; // hitting ceiling ends sustain
        }
      }
      // If grounded ensure no sinking due to gravity accumulation rounding
      if (player.isGrounded) {
        player.vy = 0;
      }

    // clear one-shot inputs
    player.inputs.jumpPressed = false;
    player.inputs.jumpReleased = false;
    player.inputs.jump = false; // legacy flag safe to keep false now
    // mark processed inputs
    player.lastProcessedInputSeq = player.lastReceivedInputSeq;
    }
  }

  processTagging() {
    if (this.state !== 'running') return;
    const tagger = this.players.get(this.taggerId);
    if (!tagger) return;
    for (const player of this.players.values()) {
      if (player.id === tagger.id) continue;
      const dx = player.x - tagger.x;
      const dy = player.y - tagger.y;
      const distSq = dx*dx + dy*dy;
      if (distSq < 40*40) { // tag radius 40 units
        const key = this.cooldownKey(tagger.id, player.id);
        const last = this.lastTagPairCooldown.get(key) || 0;
        const now = Date.now();
        if (now - last >= TAG_COOLDOWN_MS) {
          // transfer tag
          tagger.isTagger = false;
          player.isTagger = true;
          this.taggerId = player.id;
          this.lastTagPairCooldown.set(key, now);
          io.to(this.code).emit('tag', { taggerId: this.taggerId });
        }
      }
    }
  }

  cooldownKey(a, b) { return [a,b].sort().join('|'); }

  tick() {
    const now = Date.now();
    const dt = (now - this.lastTick)/1000;
    this.lastTick = now;

    if (this.state === 'countdown') {
      if (now - this.countdownStartAt >= PRE_GAME_COUNTDOWN_MS) this.startGame();
    }
    if (this.state === 'running') {
      const elapsed = now - this.gameStartAt;
      if (elapsed >= GAME_DURATION_MS) {
        this.endGame();
      } else {
        // accumulate tagger score time
        if (this.taggerId) {
          const tagger = this.players.get(this.taggerId);
          if (tagger) tagger.scoreTimeTaggedMs += (now - (this._prevTickTime || now));
        }
      }
    }

    this.updatePhysics(dt);
    this.processTagging();

    // broadcast at 20 Hz to balance bandwidth
    if (now - this.lastBroadcast > 50) {
      this.broadcastState();
      this.lastBroadcast = now;
    }
    this._prevTickTime = now;
  }

  broadcastState() {
    const payload = {
      serverTime: Date.now(),
      state: this.state,
      countdownRemainingMs: this.state === 'countdown' ? Math.max(0, PRE_GAME_COUNTDOWN_MS - (Date.now()-this.countdownStartAt)) : 0,
      gameRemainingMs: this.state === 'running' ? Math.max(0, GAME_DURATION_MS - (Date.now()-this.gameStartAt)) : 0,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        dir: p.dir,
        isTagger: p.isTagger,
        vx: p.vx,
        vy: p.vy,
        lastProcessedInputSeq: p.lastProcessedInputSeq,
      })),
      taggerId: this.taggerId,
      platforms: PLATFORMS,
  leaderId: this.leaderId,
    };
    io.to(this.code).emit('state', payload);
  }
}

const rooms = new Map();

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

io.on('connection', socket => {
  socket.on('createRoom', ({ name }, cb) => {
    const room = createRoom();
    socket.join(room.code);
    room.addPlayer(socket, name);
    cb?.({ code: room.code });
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    const room = getRoom(code);
    if (!room) return cb?.({ error: 'Room not found'});
    socket.join(code);
    room.addPlayer(socket, name);
    cb?.({ ok: true });
  });

  socket.on('startGame', ({ code }, cb) => {
    const room = getRoom(code);
    if (!room) return cb?.({ error: 'Room not found' });
    if (room.leaderId !== socket.id) return cb?.({ error: 'Only leader can start' });
    room.startCountdown();
    cb?.({ ok: true });
  });

  socket.on('input', ({ left, right, jump, jumpPressed, jumpReleased, seq }) => {
    for (const room of rooms.values()) {
      const player = room.players.get(socket.id);
      if (player) {
        if (typeof left === 'boolean') player.inputs.left = left;
        if (typeof right === 'boolean') player.inputs.right = right;
        if (typeof jump === 'boolean') { player.jumpHeld = jump; }
        if (jumpPressed) player.inputs.jumpPressed = true;
        if (jumpReleased) player.inputs.jumpReleased = true;
        if (typeof seq === 'number' && seq > player.lastReceivedInputSeq) player.lastReceivedInputSeq = seq;
      }
    }
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      if (room.players.has(socket.id)) {
        room.removePlayer(socket.id);
        io.to(room.code).emit('playerLeft', { id: socket.id });
      }
    }
  });
});

// main game loop
setInterval(() => {
  for (const room of rooms.values()) {
    room.tick();
    if (room.state === 'ended') {
      // could auto clean after some time
    }
  }
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log('Server listening on :' + PORT + ' (rooms: ' + rooms.size + ')'));
