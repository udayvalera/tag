import {
  PLAYER_COLLISION,
  arePlayerBodiesWithinRange,
  getHeadbandByIndex,
  playerBodyDistanceSq
} from './public/game-config.js';

export const GAME_DURATION_MS = 120_000;
export const PRE_GAME_COUNTDOWN_MS = 3000;
export const MAX_PLAYERS_PER_ROOM = 8;
export const PLAYER_STATE_MIN_INTERVAL_MS = 30;
export const TAG_ATTEMPT_MIN_INTERVAL_MS = 120;
export const TAG_VALIDATION_GRACE_PX = 96;
export const ENDED_ROOM_TTL_MS = 10 * 60 * 1000;
export const ROOM_CLEANUP_INTERVAL_MS = 60 * 1000;
export const MAX_ABS_VELOCITY = 2400;
export const EFFECT_DEFAULT_MS = 8000;
export const TAG_RADIUS = PLAYER_COLLISION.tagRadius;
export const TAG_SEPARATION_RADIUS = TAG_RADIUS + 4;

export const PLATFORMS = [
  { x: 0, y: 0, w: 1600, h: 40 },
  { x: 200, y: 180, w: 200, h: 30 },
  { x: 500, y: 220, w: 300, h: 30 },
  { x: 950, y: 180, w: 200, h: 30 },
  { x: 100, y: 360, w: 180, h: 24 },
  { x: 400, y: 400, w: 150, h: 24 },
  { x: 700, y: 360, w: 150, h: 24 },
  { x: 1000, y: 400, w: 180, h: 24 },
  { x: 1300, y: 360, w: 180, h: 24 },
  { x: 300, y: 540, w: 200, h: 24 },
  { x: 750, y: 580, w: 300, h: 24 },
  { x: 450, y: 300, w: 100, h: 24 },
  { x: 550, y: 340, w: 100, h: 24 },
  { x: 650, y: 380, w: 100, h: 24 },
  { x: 850, y: 480, w: 120, h: 24 },
  { x: 1150, y: 520, w: 120, h: 24 }
];

export const WORLD_PAYLOAD = Object.freeze({
  version: 1,
  worldWidth: 1600,
  worldHeight: 720,
  platforms: PLATFORMS
});

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

export function defaultPlayerState(id, name) {
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

function noopEmit() {}

export class GameRoom {
  constructor(code, emitToRoom = noopEmit) {
    this.code = code;
    this.emitToRoom = emitToRoom;
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

    for (const key of this.blockedContactPairs) {
      if (this.cooldownKeyHasPlayer(key, id)) this.blockedContactPairs.delete(key);
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
    this.tryAutoTagForAcceptedPlayer(player, now);

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
    if (!this.isRunningAt(now)) return { error: 'Game is not running' };
    if (!tagger || !target || senderId === targetId) return { error: 'Invalid target' };
    if (senderId !== this.taggerId) return { error: 'Only current tagger can tag' };
    if (now - tagger.lastTagAttemptAt < TAG_ATTEMPT_MIN_INTERVAL_MS) return { error: 'Tag rate limited' };

    tagger.lastTagAttemptAt = now;
    this.refreshTagContactBlocks();

    const key = this.cooldownKey(senderId, targetId);
    if (this.blockedContactPairs.has(key)) return { error: 'Players must separate before re-tagging' };
    if (!this.isLooseTagValid(tagger, target)) return { error: 'Players are too far apart' };

    this.applyTag(senderId, targetId, now);
    return { ok: true };
  }

  tryAutoTagForAcceptedPlayer(player, now) {
    if (!this.isRunningAt(now) || !this.taggerId || !player) return false;

    if (player.id === this.taggerId) {
      const target = this.findNearestAutoTagTarget(player);
      if (!target) return false;
      this.applyTag(player.id, target.id, now);
      return true;
    }

    const tagger = this.players.get(this.taggerId);
    if (!tagger) return false;
    const key = this.cooldownKey(tagger.id, player.id);
    if (this.blockedContactPairs.has(key)) return false;
    if (!this.isStrictTagValid(tagger, player)) return false;

    this.applyTag(tagger.id, player.id, now);
    return true;
  }

  findNearestAutoTagTarget(tagger) {
    let nearestTarget = null;
    let nearestDistanceSq = Infinity;
    const tagRadiusSq = TAG_RADIUS * TAG_RADIUS;

    for (const target of this.players.values()) {
      if (target.id === tagger.id) continue;
      const key = this.cooldownKey(tagger.id, target.id);
      if (this.blockedContactPairs.has(key)) continue;

      const distanceSq = playerBodyDistanceSq(tagger, target);
      if (distanceSq <= tagRadiusSq && distanceSq < nearestDistanceSq) {
        nearestDistanceSq = distanceSq;
        nearestTarget = target;
      }
    }

    return nearestTarget;
  }

  applyTag(taggerId, targetId, now = Date.now()) {
    this.setTagger(targetId);
    this.blockedContactPairs.add(this.cooldownKey(taggerId, targetId));
    this.updatedAt = now;

    this.emitToRoom('tag', {
      taggerId: targetId,
      taggedById: taggerId,
      serverTime: now
    });
  }

  isRunningAt(now) {
    return this.state === 'running'
      && this.gameStartAt !== null
      && this.gameEndsAt !== null
      && now >= this.gameStartAt
      && now < this.gameEndsAt;
  }

  isStrictTagValid(tagger, target) {
    return arePlayerBodiesWithinRange(tagger, target, TAG_RADIUS);
  }

  isLooseTagValid(tagger, target) {
    return arePlayerBodiesWithinRange(tagger, target, TAG_RADIUS + TAG_VALIDATION_GRACE_PX);
  }

  refreshTagContactBlocks() {
    const separationRadiusSq = TAG_SEPARATION_RADIUS * TAG_SEPARATION_RADIUS;

    for (const key of this.blockedContactPairs) {
      const pair = this.playersForCooldownKey(key);
      if (!pair) {
        this.blockedContactPairs.delete(key);
        continue;
      }

      if (playerBodyDistanceSq(pair.a, pair.b) > separationRadiusSq) {
        this.blockedContactPairs.delete(key);
      }
    }
  }

  cooldownKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  cooldownKeyHasPlayer(key, id) {
    const separatorIndex = key.indexOf('|');
    if (separatorIndex === -1) return key === id;
    return key.slice(0, separatorIndex) === id || key.slice(separatorIndex + 1) === id;
  }

  playersForCooldownKey(key) {
    const separatorIndex = key.indexOf('|');
    if (separatorIndex === -1) return null;

    const playerA = this.players.get(key.slice(0, separatorIndex));
    const playerB = this.players.get(key.slice(separatorIndex + 1));
    return playerA && playerB ? { a: playerA, b: playerB } : null;
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

    this.emitToRoom('effectApplied', {
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
    this.emitToRoom('roomState', this.roomStatePayload());
  }
}
