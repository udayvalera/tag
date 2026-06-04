import '/socket.io/socket.io.js';
import { SceneDecorator, ensureCtxRoundRectSupport } from './render.js';
import { MOTION_LINES_SPRITE, PARTICLE_TUNING, PLAYER_COLLISION } from './game-config.js';

const socket = io();

const elementCache = new Map();

function elem(id) {
  let el = elementCache.get(id);
  if (!el) {
    el = document.getElementById(id);
    if (el) elementCache.set(id, el);
  }
  return el;
}

function setHidden(el, hidden) {
  if (!el) return;
  if (el.classList.contains('hidden') !== hidden) {
    el.classList.toggle('hidden', hidden);
  }
}

function setTextIfChanged(el, value) {
  if (!el) return;
  const next = String(value);
  if (el.textContent !== next) el.textContent = next;
}

function setHtmlIfChanged(el, value) {
  if (!el || el.innerHTML === value) return;
  el.innerHTML = value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// --- Latency / Ping Measurement ---
let lastPingSentAt = 0;
const pingSamples = [];
const MAX_PING_SAMPLES = 20;
const PING_INTERVAL_MS = 1000; // send ping every second
let displayedPing = null;

function sendLatencyPing() {
  lastPingSentAt = performance.now();
  socket.emit('latencyPing', { t: lastPingSentAt });
}

socket.on('latencyPong', ({ t }) => {
  const now = performance.now();
  const rtt = now - t; // client timestamp echoed back
  pingSamples.push(rtt);
  while (pingSamples.length > MAX_PING_SAMPLES) pingSamples.shift();
  const avg = pingSamples.reduce((a, b) => a + b, 0) / pingSamples.length;
  displayedPing = Math.round(avg);
  updateLatencyDisplay();
});

function updateLatencyDisplay() {
  const fpsEl = elem('fpsLatency');
  if (!fpsEl) return;
  const pingStr = displayedPing == null ? '--' : displayedPing;
  let cls = '';
  if (displayedPing != null) {
    if (displayedPing < 70) cls = 'good';
    else if (displayedPing < 140) cls = 'ok';
    else cls = 'bad';
  }
  const fpsText = fpsEl.dataset.fpsText || 'FPS --';
  setHtmlIfChanged(fpsEl, `${fpsText} <span class="meterDivider">/</span> PING <span class="pingValue ${cls}">${pingStr} ms</span>`);
}

setInterval(() => {
  if (socket.connected) sendLatencyPing();
}, PING_INTERVAL_MS);

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ensureCtxRoundRectSupport();
let scene = new SceneDecorator(canvas);
let lastBgTime = null; // background animation timestamp

// Enhanced visual constants
const ENHANCED_PARTICLES = true;
const SHOW_DEBUG_PLATFORMS = false; // Set to true for platform debugging
let SHOW_DEBUG_OVERLAY = false; // Toggle with F2

// Debug overlay element
const __debugDiv = document.createElement('div');
__debugDiv.id = 'debugOverlay';
__debugDiv.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:1500;font:10px monospace;background:rgba(0,0,0,0.6);color:#0f0;padding:6px 8px;max-width:340px;white-space:pre;line-height:1.25;pointer-events:none;';
__debugDiv.classList.add('hidden');
document.body.appendChild(__debugDiv);

window.addEventListener('keydown', e => {
  if (e.code === 'F2') {
    SHOW_DEBUG_OVERLAY = !SHOW_DEBUG_OVERLAY;
    __debugDiv.classList.toggle('hidden', !SHOW_DEBUG_OVERLAY);
  }
});

// UI elements
elem('createBtn').onclick = () => {
  const name = elem('playerName').value.trim() || 'Player';
  socket.emit('createRoom', { name }, ({ code }) => {
    showStatus(code);
  });
};

elem('joinBtn').onclick = () => {
  const code = elem('roomCode').value.trim().toUpperCase();
  const name = elem('playerName').value.trim() || 'Player';
  if (!code) return;
  socket.emit('joinRoom', { code, name }, (res) => {
    if (res?.error) alert(res.error); else showStatus(code);
  });
};

elem('backToMenu').onclick = () => {
  location.reload();
};

let gameState = {
  players: [],
  platforms: [],
  state: 'waiting',
  taggerId: null,
  gameStartAt: null,
  gameEndsAt: null,
  leaderId: null,
  serverTime: 0,
  powerUps: [],
  effects: {}
};
const DEFAULT_WORLD_WIDTH = 1600;
const DEFAULT_WORLD_HEIGHT = 720;
let world = {
  platforms: [],
  worldWidth: DEFAULT_WORLD_WIDTH,
  worldHeight: DEFAULT_WORLD_HEIGHT,
  version: null
};
let localId = null;
let inputSeq = 0;
let currentRoomCode = null;
const remoteHistory = new Map(); // playerId -> array of snapshots for interpolation
const BASE_INTERP_DELAY_MS = 80; // default render delay in ms (trimmed for snappier feel)
const MIN_INTERP_DELAY_MS = 45; // clamp for low-ping sessions so remotes stay <50ms behind
const MAX_REMOTE_EXTRAP_MS = 40; // allow gentle extrapolation when new snapshots haven't arrived
const MAX_HISTORY = 45;
const PLAYER_STATE_SEND_INTERVAL_MS = 1000 / 30;
const TAG_ATTEMPT_INTERVAL_MS = 140;

// Physics constants (must mirror server)
const BASE_SPEED = 220;
const TAGGER_SPEED_MULT = 1.08;
const GRAVITY = 1400;
const JUMP_VELOCITY = 720;
const PLAYER_HEIGHT = PLAYER_COLLISION.height;
const PLAYER_RADIUS = PLAYER_COLLISION.radius;

const localPlayer = {
  id: null,
  x: 0, y: 0, vx: 0, vy: 0, dir: 1, isTagger: false, isGrounded: false,
  color: null, headbandId: null,
  jumpHeld: false, canVariable: false, jumpStart: 0,
  lastGroundedTime: 0,
  bufferedJumpTime: 0
};
let predictionActive = false;
const smokePuffs = [];
const runSmokeLastAt = new Map();
const MAX_SMOKE_PUFFS = PARTICLE_TUNING.maxPuffs;
const SMOKE_FRAME_COUNT = MOTION_LINES_SPRITE.frameCount;
const RUN_SMOKE_INTERVAL_MS = PARTICLE_TUNING.runIntervalMs;
let lastRenderDelayMs = BASE_INTERP_DELAY_MS;
let serverClockOffsetMs = 0;
let hasServerClockOffset = false;
let lastPlayerStateSentAt = 0;
let lastTagAttemptAt = 0;

// Mirror advanced jump tuning (keep in sync with server where possible)
const JUMP_SUSTAIN_MS = 140;
const JUMP_LOW_GRAVITY_FACTOR = 0.55;
const JUMP_SHORT_HOP_FACTOR = 0.35;
const COYOTE_MS = 80;
const JUMP_BUFFER_MS = 90;

let lastPredictTime = null;
let lastInputTime = null;

function spawnSmokePuff({
  x,
  y,
  dir = 1,
  scale = MOTION_LINES_SPRITE.scale,
  life = 180,
  vx = 0,
  vy = 0,
  baseAlpha = MOTION_LINES_SPRITE.alpha
}) {
  if (!ENHANCED_PARTICLES) return;
  if (![x, y, scale, life, vx, vy, baseAlpha].every(Number.isFinite)) return;

  while (smokePuffs.length >= MAX_SMOKE_PUFFS) {
    smokePuffs.shift();
  }

  smokePuffs.push({ x, y, dir, scale, life, vx, vy, baseAlpha, t: 0 });
}

function spawnRunSmoke(id, player, now) {
  if (!ENHANCED_PARTICLES || !id || !player) return;

  const speed = Math.abs(player.vx ?? 0);
  const grounded = player.grounded ?? player.isGrounded;
  if (!grounded || speed < 60) {
    runSmokeLastAt.delete(id);
    return;
  }

  const last = runSmokeLastAt.get(id) ?? 0;
  if (now - last < RUN_SMOKE_INTERVAL_MS) return;
  runSmokeLastAt.set(id, now);

  const dir = player.dir || 1;
  spawnSmokePuff({
    x: player.x - dir * 16,
    y: player.y + 8,
    dir,
    scale: 0.98,
    life: 175,
    vx: -dir * 22,
    vy: 2,
    baseAlpha: 0.72
  });
}

function spawnJumpSmoke(x, y, dir) {
  spawnSmokePuff({
    x: x - (dir || 1) * 10,
    y: y + 6,
    dir,
    scale: 0.9,
    life: 155,
    vx: -(dir || 1) * 16,
    vy: 3,
    baseAlpha: 0.58
  });
}

function spawnLandingSmoke(x, y, dir) {
  const facing = dir || 1;
  spawnSmokePuff({
    x: x - facing * 11,
    y: y + 5,
    dir: facing,
    scale: 0.96,
    life: 170,
    vx: -facing * 15,
    vy: 1,
    baseAlpha: 0.62
  });
  spawnSmokePuff({
    x: x + facing * 8,
    y: y + 4,
    dir: -facing,
    scale: 0.8,
    life: 140,
    vx: facing * 12,
    vy: 1,
    baseAlpha: 0.46
  });
}

function spawnTagSmoke(x, y) {
  const pattern = [
    { dx: -18, dy: 7, dir: 1, scale: 0.98, vx: -58, vy: 10, baseAlpha: 0.66 },
    { dx: -5, dy: 15, dir: 1, scale: 0.82, vx: -32, vy: 18, baseAlpha: 0.5 },
    { dx: 12, dy: 9, dir: -1, scale: 0.96, vx: 48, vy: 12, baseAlpha: 0.62 },
    { dx: 5, dy: 24, dir: -1, scale: 0.8, vx: 22, vy: 24, baseAlpha: 0.46 }
  ];

  for (const puff of pattern) {
    spawnSmokePuff({
      x: x + puff.dx,
      y: y + puff.dy,
      dir: puff.dir,
      scale: puff.scale,
      life: 185,
      vx: puff.vx,
      vy: puff.vy,
      baseAlpha: puff.baseAlpha
    });
  }
}

function updateAndDrawSmoke(dt) {
  if (!ENHANCED_PARTICLES) return;
  const step = Math.min(dt || 1 / 60, 0.05);

  for (let i = smokePuffs.length - 1; i >= 0; i--) {
    const p = smokePuffs[i];
    p.t += step * 1000;
    const age = p.t / p.life;
    p.x += p.vx * step;
    p.y += p.vy * step;

    if (age >= 1) {
      smokePuffs.splice(i, 1);
      continue;
    }

    const frame = Math.min(SMOKE_FRAME_COUNT - 1, Math.floor(age * SMOKE_FRAME_COUNT));
    const fadeIn = Math.min(1, age / 0.12);
    const fadeOut = age > 0.62 ? Math.max(0, (1 - age) / 0.38) : 1;
    const alpha = fadeIn * fadeOut;
    scene.drawSmokePuff({ ...p, frame, alpha }, { x: 0, y: 0 });
  }
}

socket.on('connect', () => { localId = socket.id; });

socket.on('world', payload => {
  world = {
    platforms: Array.isArray(payload?.platforms) ? payload.platforms : [],
    worldWidth: payload?.worldWidth ?? DEFAULT_WORLD_WIDTH,
    worldHeight: payload?.worldHeight ?? DEFAULT_WORLD_HEIGHT,
    version: payload?.version ?? null
  };
  syncCanvasBackingSize();
  gameState.platforms = world.platforms;
});

function syncServerClock(serverTime) {
  if (typeof serverTime !== 'number') return;
  const sampleOffset = serverTime - performance.now();
  serverClockOffsetMs = hasServerClockOffset
    ? serverClockOffsetMs * 0.9 + sampleOffset * 0.1
    : sampleOffset;
  hasServerClockOffset = true;
}

function syncedServerNow(now = performance.now()) {
  return hasServerClockOffset ? now + serverClockOffsetMs : Date.now();
}

function getDerivedTiming(now = performance.now()) {
  const serverNow = syncedServerNow(now);
  let state = gameState.state || 'waiting';

  if (state === 'countdown' && gameState.gameStartAt && serverNow >= gameState.gameStartAt) {
    state = 'running';
  }
  if ((state === 'countdown' || state === 'running') && gameState.gameEndsAt && serverNow >= gameState.gameEndsAt) {
    state = 'ended';
  }

  return {
    state,
    countdownRemainingMs: state === 'countdown' && gameState.gameStartAt
      ? Math.max(0, gameState.gameStartAt - serverNow)
      : 0,
    gameRemainingMs: state === 'running' && gameState.gameEndsAt
      ? Math.max(0, gameState.gameEndsAt - serverNow)
      : 0,
    serverNow
  };
}

function applyDerivedState(state) {
  if (gameState.state === state) return;
  gameState.state = state;
  if (state !== 'ended') {
    const results = elem('results');
    if (results) results.dataset.filled = '';
  }
  syncHudState(state);
  updatePlayerList();
  updateStartButton();
}

function markCurrentTagger() {
  for (const player of gameState.players) {
    player.isTagger = player.id === gameState.taggerId;
  }
  if (localPlayer.id) {
    localPlayer.isTagger = localPlayer.id === gameState.taggerId;
  }
}

function getPlayerMeta(id) {
  return gameState.players.find(player => player.id === id);
}

function pushRemoteSnapshot(id, snapshot) {
  if (!id || id === localId) return;

  const meta = getPlayerMeta(id);
  if (!remoteHistory.has(id)) remoteHistory.set(id, []);
  const arr = remoteHistory.get(id);
  arr.push({
    t: snapshot.serverTime || gameState.serverTime || Date.now(),
    x: snapshot.x,
    y: snapshot.y,
    isTagger: id === gameState.taggerId,
    name: snapshot.name || meta?.name || 'Player',
    dir: snapshot.dir || meta?.dir || 1,
    vx: snapshot.vx ?? meta?.vx ?? 0,
    vy: snapshot.vy ?? meta?.vy ?? 0,
    color: snapshot.color || meta?.color,
    headbandId: snapshot.headbandId || meta?.headbandId,
    grounded: !!(snapshot.grounded ?? meta?.grounded)
  });
  while (arr.length > MAX_HISTORY) arr.shift();
}

function seedLocalPlayerFromRoomState(player) {
  if (!player) return;

  const firstSeedForSocket = localPlayer.id !== player.id;
  Object.assign(localPlayer, {
    id: player.id,
    color: player.color,
    headbandId: player.headbandId,
    isTagger: player.id === gameState.taggerId
  });

  if (firstSeedForSocket) {
    localPlayer.x = player.x;
    localPlayer.y = player.y;
    localPlayer.vx = player.vx ?? 0;
    localPlayer.vy = player.vy ?? 0;
    localPlayer.dir = player.dir || 1;
    localPlayer.isGrounded = !!player.grounded;
    localPlayer.canVariable = false;
    localPlayer.lastGroundedTime = performance.now();
    predictionActive = true;
  }
}

function handleRoomState(s) {
  if (!s || typeof s !== 'object') return;
  syncServerClock(s.serverTime);

  const players = Array.isArray(s.players)
    ? s.players.map(player => ({
      ...player,
      isTagger: player.id === s.taggerId
    }))
    : [];

  gameState = {
    ...gameState,
    ...s,
    players,
    platforms: world.platforms
  };
  markCurrentTagger();

  if (!window.__firstStateLogged) {
    console.log('[DEBUG:first-room-state]', {
      players: players.map(p => ({ id: p.id, x: p.x, y: p.y, grounded: p.grounded, tagger: p.isTagger })),
      platforms: gameState.platforms?.length,
      state: s.state,
      serverTime: s.serverTime
    });
    window.__firstStateLogged = true;
  }

  seedLocalPlayerFromRoomState(players.find(p => p.id === localId));

  const activeRemoteIds = new Set();
  for (const p of players) {
    if (p.id === localId) continue;
    activeRemoteIds.add(p.id);
    pushRemoteSnapshot(p.id, { ...p, serverTime: s.serverTime });
  }

  for (const id of remoteHistory.keys()) {
    if (!activeRemoteIds.has(id)) remoteHistory.delete(id);
  }

  const timing = getDerivedTiming();
  syncHudState(timing.state);
  updatePlayerList();
  updateStartButton();
}

socket.on('roomState', handleRoomState);

socket.on('playerState', update => {
  if (!update || update.id === localId) return;
  syncServerClock(update.serverTime);

  const player = getPlayerMeta(update.id);
  if (!player) return;

  player.x = update.x;
  player.y = update.y;
  player.vx = update.vx ?? 0;
  player.vy = update.vy ?? 0;
  player.dir = update.dir || player.dir || 1;
  player.grounded = !!update.grounded;
  player.isTagger = player.id === gameState.taggerId;

  pushRemoteSnapshot(update.id, {
    ...update,
    name: player.name,
    color: player.color,
    headbandId: player.headbandId
  });
});

socket.on('tag', ({ taggerId, serverTime }) => {
  syncServerClock(serverTime);
  gameState.taggerId = taggerId;
  markCurrentTagger();
  updatePlayerList();

  if (ENHANCED_PARTICLES) {
    const taggerPlayer = taggerId === localId ? localPlayer : gameState.players.find(p => p.id === taggerId);
    if (taggerPlayer) {
      spawnTagSmoke(taggerPlayer.x, taggerPlayer.y);
    }
  }
});

socket.on('effectApplied', ({ playerId, effect, serverTime }) => {
  syncServerClock(serverTime);
  if (!playerId || !effect) return;

  const player = getPlayerMeta(playerId);
  if (player) {
    player.effects = Array.isArray(player.effects) ? player.effects : [];
    player.effects.push(effect);
  }
  gameState.effects = {
    ...(gameState.effects || {}),
    [playerId]: [...(gameState.effects?.[playerId] || []), effect]
  };
});

socket.on('roomClosed', ({ reason } = {}) => {
  currentRoomCode = null;
  applyDerivedState('ended');
  setHidden(elem('gameOver'), false);
  setHtmlIfChanged(elem('results'), `<div class="result-item">Room closed${reason ? `: ${escapeHtml(reason)}` : ''}</div>`);
  elem('results').dataset.filled = '1';
});

socket.on('playerLeft', ({ id }) => {
  // Remove from history
  remoteHistory.delete(id);
  runSmokeLastAt.delete(id);
});

function showStatus(code) {
  currentRoomCode = code;
  setHidden(elem('menu'), true);
  setHidden(elem('statusBar'), false);
  const roomLabel = elem('roomLabel');
  if (roomLabel) roomLabel.dataset.roomCode = code;
  setTextIfChanged(roomLabel, 'ROOM ' + code);
  setHidden(elem('playerList'), false);
  syncHudState(gameState.state);
}

// Input handling
const keys = {};
let justPressedJump = false;
let justReleasedJump = false;
let pendingPredictJumpPressed = false;
let pendingPredictJumpReleased = false;

window.addEventListener('keydown', e => {
  if (!keys[e.code]) {
    if (isJumpKey(e.code)) {
      justPressedJump = true;
      pendingPredictJumpPressed = true;
    }
  }
  keys[e.code] = true;

  if (isJumpKey(e.code) || e.code.startsWith('Arrow') || e.code === 'KeyA' || e.code === 'KeyD') {
    if (!predictionActive && localPlayer.id) {
      predictionActive = true;
      lastPredictTime = performance.now();
    }
  }
  sendInput();
});

window.addEventListener('keyup', e => {
  if (isJumpKey(e.code)) {
    justReleasedJump = true;
    pendingPredictJumpReleased = true;
  }
  keys[e.code] = false;
  sendInput();
});

function isJumpKey(code) {
  return code === 'Space' || code === 'ArrowUp' || code === 'KeyW';
}

function sendInput() {
  const jumpHeld = !!(keys['Space'] || keys['ArrowUp'] || keys['KeyW']);
  const now = performance.now();

  // Approx dt since last input for prediction step (fallback ~16ms)
  lastInputTime = now;

  if (jumpHeld && !predictionActive && localPlayer.id) predictionActive = true;

  justPressedJump = false;
  justReleasedJump = false;
}

function compactNumber(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function sendLocalPlayerState(now) {
  if (!currentRoomCode || !localPlayer.id || !socket.connected) return;
  if (now - lastPlayerStateSentAt < PLAYER_STATE_SEND_INTERVAL_MS) return;

  lastPlayerStateSentAt = now;
  socket.emit('playerState', {
    x: compactNumber(localPlayer.x),
    y: compactNumber(localPlayer.y),
    vx: compactNumber(localPlayer.vx),
    vy: compactNumber(localPlayer.vy),
    dir: localPlayer.dir < 0 ? -1 : 1,
    grounded: !!localPlayer.isGrounded,
    seq: ++inputSeq,
    clientTime: compactNumber(now)
  });
}

function maybeEmitTagAttempt(renderedPlayers, now, state) {
  if (state !== 'running') return;
  if (!localPlayer.id || gameState.taggerId !== localPlayer.id) return;
  if (!socket.connected || now - lastTagAttemptAt < TAG_ATTEMPT_INTERVAL_MS) return;

  const tagRadiusSq = PLAYER_COLLISION.tagRadius * PLAYER_COLLISION.tagRadius;
  for (const [targetId, remotePlayer] of renderedPlayers) {
    const dx = remotePlayer.x - localPlayer.x;
    const dy = remotePlayer.y - localPlayer.y;
    if (dx * dx + dy * dy <= tagRadiusSq) {
      lastTagAttemptAt = now;
      socket.emit('tagPlayer', {
        targetId,
        clientTime: compactNumber(now)
      });
      return;
    }
  }
}

// Render loop
function draw(now = performance.now()) {
  requestAnimationFrame(draw);
  frameCount++;
  const timing = getDerivedTiming(now);
  applyDerivedState(timing.state);
  const { players, taggerId } = gameState;
  const { state, countdownRemainingMs, gameRemainingMs } = timing;
  const platforms = world.platforms.length ? world.platforms : (gameState.platforms || []);
  const dtBg = lastBgTime ? Math.min((now - lastBgTime) / 1000, 0.05) : 1 / 60;
  lastBgTime = now;

  scene.update(dtBg);
  scene.drawBackground();
  syncHudState(state);

  if (localPlayer.id) {
    updateLocalPrediction(dtBg, platforms, state);
    sendLocalPlayerState(now);
  }

  // Debug platform rendering
  if (SHOW_DEBUG_PLATFORMS) {
    ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
    ctx.lineWidth = 2;
    for (const plat of platforms) {
      const topY = canvas.height - (plat.y + plat.h);
      ctx.strokeRect(plat.x, topY, plat.w, plat.h);
    }
  }

  // Draw platforms
  if (Array.isArray(platforms) && platforms.length) {
    try {
      scene.drawPlatforms(platforms);
    } catch (err) {
      console.error('drawPlatforms error', err);
    }
  } else {
    // Fallback visual if no platforms present
    ctx.fillStyle = 'rgba(255,0,0,0.25)';
    ctx.fillRect(0, canvas.height - 50, canvas.width, 10);
    ctx.fillStyle = '#f00';
    ctx.font = '12px monospace';
    ctx.fillText('NO PLATFORMS RECEIVED', 20, 40);
  }

  // Enhanced player rendering with interpolation (with light extrapolation)
  const serverNow = hasServerClockOffset
    ? now + serverClockOffsetMs
    : (gameState.serverTime || Date.now());
  const desiredDelay = displayedPing != null
    ? Math.min(BASE_INTERP_DELAY_MS, Math.max(MIN_INTERP_DELAY_MS, displayedPing + 10))
    : BASE_INTERP_DELAY_MS;
  const renderTime = serverNow - desiredDelay;
  lastRenderDelayMs = desiredDelay;
  const rendered = new Map();

  for (const p of players) {
    if (p.id === localId) continue;
    const hist = remoteHistory.get(p.id);
    if (!hist || !hist.length) continue;

    let prev = hist[0];
    let next = hist[hist.length - 1];

    for (let i = 0; i < hist.length - 1; i++) {
      const current = hist[i];
      const following = hist[i + 1];
      if (current.t <= renderTime && renderTime <= following.t) {
        prev = current;
        next = following;
        break;
      }
    }

    let sample = next;
    let ix, iy, dir, vx, vy, name, isTagger, color, headbandId, grounded;

    if (renderTime > next.t) {
      const deltaMs = Math.min(renderTime - next.t, MAX_REMOTE_EXTRAP_MS);
      const ratio = deltaMs / 1000;
      ix = next.x + (next.vx ?? 0) * ratio;
      iy = next.y + (next.vy ?? 0) * ratio;
      dir = next.dir || 1;
      vx = next.vx ?? 0;
      vy = next.vy ?? 0;
      name = next.name;
      isTagger = next.isTagger;
      color = next.color;
      headbandId = next.headbandId;
      grounded = next.grounded;
    } else if (renderTime < prev.t || prev === next) {
      sample = prev;
      ix = sample.x;
      iy = sample.y;
      dir = sample.dir || 1;
      vx = sample.vx ?? 0;
      vy = sample.vy ?? 0;
      name = sample.name;
      isTagger = sample.isTagger;
      color = sample.color;
      headbandId = sample.headbandId;
      grounded = sample.grounded;
    } else {
      const span = Math.max(next.t - prev.t, 1);
      const alpha = Math.min(1, Math.max(0, (renderTime - prev.t) / span));
      ix = prev.x + (next.x - prev.x) * alpha;
      iy = prev.y + (next.y - prev.y) * alpha;
      dir = alpha < 0.5 ? (prev.dir || 1) : (next.dir || 1);
      vx = (prev.vx ?? 0) + ((next.vx ?? 0) - (prev.vx ?? 0)) * alpha;
      vy = (prev.vy ?? 0) + ((next.vy ?? 0) - (prev.vy ?? 0)) * alpha;
      name = alpha < 0.5 ? prev.name : next.name;
      isTagger = alpha < 0.5 ? prev.isTagger : next.isTagger;
      color = alpha < 0.5 ? prev.color : next.color;
      headbandId = alpha < 0.5 ? prev.headbandId : next.headbandId;
      grounded = alpha < 0.5 ? prev.grounded : next.grounded;
    }

    const clampedX = Math.max(0, Math.min(world.worldWidth, ix));
    const clampedY = Math.max(0, iy);

    rendered.set(p.id, {
      x: clampedX,
      y: clampedY,
      name,
      isTagger: p.id === taggerId,
      dir,
      vx,
      vy,
      color,
      headbandId,
      grounded
    });
  }

  maybeEmitTagAttempt(rendered, now, state);

  for (const [id, rp] of rendered) {
    spawnRunSmoke(id, rp, now);
  }

  const lpServer = localPlayer.id ? players.find(p => p.id === localId) : null;
  if (localPlayer.id) {
    spawnRunSmoke(localId, {
      x: localPlayer.x,
      y: localPlayer.y,
      dir: localPlayer.dir,
      vx: localPlayer.vx,
      vy: localPlayer.vy,
      grounded: localPlayer.isGrounded
    }, now);
  }

  updateAndDrawSmoke(dtBg);

  // Draw remote players
  for (const p of players) {
    if (p.id === localId) continue;
    const rp = rendered.get(p.id);
    if (!rp) continue;

    // Main player render
    scene.drawPlayer(
      {
        x: rp.x,
        y: rp.y,
        name: rp.name,
        isTagger: rp.isTagger,
        dir: rp.dir,
        vx: rp.vx,
        vy: rp.vy,
        color: rp.color,
        headbandId: rp.headbandId,
        grounded: rp.grounded
      },
      { x: 0, y: 0 },
      false,
      rp.isTagger
    );
  }

  // Local player rendering
  if (localPlayer.id) {
    const color = lpServer?.color || localPlayer.color;
    const headbandId = lpServer?.headbandId || localPlayer.headbandId;

    // Main local player render
    scene.drawPlayer(
      {
        x: localPlayer.x,
        y: localPlayer.y,
        name: lpServer?.name || 'You',
        isTagger: localPlayer.isTagger,
        dir: localPlayer.dir,
        vx: localPlayer.vx,
        vy: localPlayer.vy,
        color: color,
        headbandId,
        grounded: localPlayer.isGrounded
      },
      { x: 0, y: 0 },
      true,
      localPlayer.isTagger
    );
  }

  // Enhanced UI overlays
  if (state === 'countdown') {
    const cd = Math.ceil(countdownRemainingMs / 1000);
    setHidden(elem('countdown'), false);
    const taggerName = players.find(p => p.id === taggerId)?.name || '';
    const cdNum = elem('countdown-number');
    const cdText = elem('countdown-text');
    const cdTagger = elem('countdown-tagger');
    setTextIfChanged(cdNum, cd);
    setTextIfChanged(cdText, 'READY');
    setHtmlIfChanged(cdTagger, `IT <span class="tagger-name">${escapeHtml(taggerName)}</span>`);
  } else {
    setHidden(elem('countdown'), true);
  }

  if (state === 'running') {
    const timeLeft = (gameRemainingMs / 1000).toFixed(1);
    setHtmlIfChanged(elem('timer'), `TIME ${timeLeft}s`);
    const taggerName = players.find(p => p.id === taggerId)?.name || 'Nobody';
    setHtmlIfChanged(elem('tagger'), `IT ${escapeHtml(taggerName)}`);
  }

  if (state === 'ended') {
    setHidden(elem('gameOver'), false);
    if (!elem('results').dataset.filled) {
      const sorted = [...players].sort((a, b) => {
        // Sort by some metric - final tagger first, then alphabetical
        if (a.id === taggerId) return -1;
        if (b.id === taggerId) return 1;
        return a.name.localeCompare(b.name);
      });

      setHtmlIfChanged(elem('results'), sorted.map((p, index) =>
        `<div class="result-item">
          ${index + 1}. ${escapeHtml(p.name)}
          ${p.id === taggerId ? '<span class="final-tagger">FINAL IT</span>' : ''}
        </div>`
      ).join(''));
      elem('results').dataset.filled = '1';
    }
  }

  // Debug overlay update
  if (SHOW_DEBUG_OVERLAY) {
    const lp = gameState.players.find(p => p.id === localId);
    __debugDiv.textContent = [
      `STATE: ${state}`,
      `PLAYERS: ${gameState.players.length} (rendered remotes: ${[...remoteHistory.keys()].length})`,
      `PLATFORMS: ${platforms?.length ?? 0}`,
      lp ? `LOCAL META x:${lp.x.toFixed(1)} y:${lp.y.toFixed(1)} vy:${(lp.vy || 0).toFixed(1)} g:${lp.grounded}` : 'LOCAL META: none',
      localPlayer.id ? `LOCAL x:${localPlayer.x.toFixed(1)} y:${localPlayer.y.toFixed(1)} g:${localPlayer.isGrounded}` : 'LOCAL: none',
      `TAGGER: ${gameState.taggerId || 'none'}`,
      `PING: ${displayedPing ?? '--'} ms`,
      `RENDER DELAY: ${lastRenderDelayMs.toFixed(1)} ms`,
      'F2 toggle debug'
    ].join('\n');
  }
}

function updateLocalPrediction(dt, platforms, state) {
  if (state === 'countdown') {
    localPlayer.vx = 0;
    localPlayer.vy = 0;
    pendingPredictJumpPressed = false;
    pendingPredictJumpReleased = false;
    localPlayer.bufferedJumpTime = 0;
    syncLocalPlayerMetadata();
    return;
  }

  const wasGrounded = localPlayer.isGrounded;

  // Horizontal movement
  const left = keys['ArrowLeft'] || keys['KeyA'];
  const right = keys['ArrowRight'] || keys['KeyD'];
  const speed = BASE_SPEED * (localPlayer.isTagger ? TAGGER_SPEED_MULT : 1);
  localPlayer.vx = (left ? -speed : 0) + (right ? speed : 0);
  if (left) localPlayer.dir = -1;
  else if (right) localPlayer.dir = 1;

  // Track jump hold state
  localPlayer.jumpHeld = !!(keys['Space'] || keys['ArrowUp'] || keys['KeyW']);

  const nowMs = performance.now();
  if (localPlayer.isGrounded) localPlayer.lastGroundedTime = nowMs;

  // Jump input handling with coyote time and buffering
  if (pendingPredictJumpPressed) {
    // attempt jump (coyote)
    if (localPlayer.isGrounded || (nowMs - localPlayer.lastGroundedTime) <= COYOTE_MS) {
      localPlayer.vy = JUMP_VELOCITY;
      localPlayer.jumpStart = nowMs;
      localPlayer.canVariable = true;
      localPlayer.isGrounded = false;
      spawnJumpSmoke(localPlayer.x, localPlayer.y, localPlayer.dir);
    } else {
      localPlayer.bufferedJumpTime = nowMs;
    }
  }

  if (localPlayer.bufferedJumpTime && (nowMs - localPlayer.bufferedJumpTime) <= JUMP_BUFFER_MS) {
    if (localPlayer.isGrounded || (nowMs - localPlayer.lastGroundedTime) <= COYOTE_MS) {
      localPlayer.vy = JUMP_VELOCITY;
      localPlayer.jumpStart = nowMs;
      localPlayer.canVariable = true;
      localPlayer.isGrounded = false;
      localPlayer.bufferedJumpTime = 0;
      spawnJumpSmoke(localPlayer.x, localPlayer.y, localPlayer.dir);
    }
  }

  // Variable jump height control
  if (localPlayer.vy > 0 && localPlayer.canVariable) {
    const elapsed = nowMs - localPlayer.jumpStart;
    if (!localPlayer.jumpHeld) {
      // early release short hop
      localPlayer.vy *= JUMP_SHORT_HOP_FACTOR;
      localPlayer.canVariable = false;
    } else if (elapsed <= JUMP_SUSTAIN_MS) {
      localPlayer.vy -= GRAVITY * JUMP_LOW_GRAVITY_FACTOR * dt;
    } else {
      localPlayer.vy -= GRAVITY * dt;
      localPlayer.canVariable = false;
    }
  } else {
    localPlayer.vy -= GRAVITY * dt;
    if (localPlayer.vy <= 0) localPlayer.canVariable = false;
  }

  // Position integration
  localPlayer.x += localPlayer.vx * dt;
  localPlayer.y += localPlayer.vy * dt;

  // Collision detection (approximate mirror of server)
  localPlayer.isGrounded = false;
  for (const plat of platforms) {
    const topSurface = plat.y + plat.h;
    const underside = plat.y;
    const overlapX = (localPlayer.x + PLAYER_RADIUS) > plat.x && (localPlayer.x - PLAYER_RADIUS) < (plat.x + plat.w);

    // Landing detection
    if (overlapX && localPlayer.vy <= 0 && (localPlayer.y < topSurface) && (localPlayer.y > topSurface - 120)) {
      // approximate previous y to check crossing
      const prevY = localPlayer.y - localPlayer.vy * dt;
      if (prevY >= topSurface && localPlayer.y < topSurface) {
        localPlayer.y = topSurface;
        localPlayer.vy = 0;
        localPlayer.isGrounded = true;
        localPlayer.canVariable = false;
        if (!wasGrounded) spawnLandingSmoke(localPlayer.x, localPlayer.y, localPlayer.dir);
        continue;
      }
    }

    // Ceiling collision
    if (overlapX && localPlayer.vy > 0) {
      const headPrev = (localPlayer.y - localPlayer.vy * dt) + PLAYER_HEIGHT;
      const headNow = localPlayer.y + PLAYER_HEIGHT;
      if (headPrev <= underside && headNow > underside) {
        localPlayer.y = underside - PLAYER_HEIGHT;
        localPlayer.vy = 0;
        localPlayer.canVariable = false;
      }
    }
  }

  if (localPlayer.isGrounded) localPlayer.vy = 0;

  // World bounds
  if (localPlayer.x < 0) localPlayer.x = 0;
  if (localPlayer.x > world.worldWidth) localPlayer.x = world.worldWidth;
  if (localPlayer.y < 40) { // ground clamp fallback
    localPlayer.y = 40;
    localPlayer.vy = 0;
    localPlayer.isGrounded = true;
    localPlayer.canVariable = false;
    if (!wasGrounded) spawnLandingSmoke(localPlayer.x, localPlayer.y, localPlayer.dir);
  }

  // Reset one-shot prediction flags locally AFTER using them.
  pendingPredictJumpPressed = false;
  pendingPredictJumpReleased = false;
  syncLocalPlayerMetadata();
}

function syncLocalPlayerMetadata() {
  const player = getPlayerMeta(localPlayer.id);
  if (!player) return;

  player.x = localPlayer.x;
  player.y = localPlayer.y;
  player.vx = localPlayer.vx;
  player.vy = localPlayer.vy;
  player.dir = localPlayer.dir;
  player.grounded = localPlayer.isGrounded;
  player.isTagger = localPlayer.id === gameState.taggerId;
}

// Start game button (leader only)
elem('startGameBtn').onclick = () => {
  if (!gameState.leaderId || gameState.leaderId !== localId) return;
  const roomLabel = elem('roomLabel');
  const code = roomLabel?.dataset.roomCode || roomLabel?.textContent.replace(/^ROOM\s+/, '');
  socket.emit('startGame', { code }, (res) => {
    if (res?.error) alert(res.error);
  });
};

function updateStartButton() {
  const btn = elem('startGameBtn');
  const visible = gameState.state === 'waiting' && gameState.leaderId === localId && gameState.players.length >= 2;
  setHidden(btn, !visible);
}

let lastPlayerListKey = '';
let lastHudState = '';
let playerListExpanded = true;

function isGameplayHudState(state) {
  return state === 'countdown' || state === 'running';
}

function applyPlayerListHudState() {
  const wrap = elem('playerList');
  if (!wrap) return;
  const state = gameState.state || document.body.dataset.gameState || 'waiting';
  const expanded = state === 'waiting' || playerListExpanded;
  wrap.classList.toggle('expanded', expanded);
  wrap.classList.toggle('collapsed', !expanded);
  wrap.classList.toggle('gameplay', isGameplayHudState(state));
}

function setPlayerListExpanded(expanded) {
  const shouldExpand = gameState.state === 'waiting' || !!expanded;
  if (playerListExpanded === shouldExpand) return;
  playerListExpanded = shouldExpand;
  lastPlayerListKey = '';
  applyPlayerListHudState();
  updatePlayerList();
}

function syncHudState(state) {
  const normalized = state || 'waiting';
  if (document.body.dataset.gameState !== normalized) {
    document.body.dataset.gameState = normalized;
  }

  if (lastHudState !== normalized) {
    if (normalized === 'waiting') {
      playerListExpanded = true;
    } else if (isGameplayHudState(normalized) || normalized === 'ended') {
      playerListExpanded = false;
    }
    lastHudState = normalized;
    lastPlayerListKey = '';
  }

  applyPlayerListHudState();
}

function updatePlayerList() {
  const wrap = elem('playerList');
  if (!wrap) return;
  const { players, taggerId, leaderId } = gameState;
  const key = JSON.stringify({
    players: players.map(p => [p.id, p.name, p.color, p.headbandId]),
    taggerId,
    leaderId,
    localId,
    state: gameState.state,
    playerListExpanded
  });
  if (key === lastPlayerListKey) return;
  lastPlayerListKey = key;
  applyPlayerListHudState();

  const rows = players.map(p => {
    const badges = [];
    if (p.id === leaderId) badges.push('<span class="leaderBadge">LEAD</span>');
    if (p.id === taggerId) badges.push('<span class="tagBadge">IT</span>');
    if (p.id === localId) badges.push('<span class="selfBadge">YOU</span>');

    const rowClass = p.id === leaderId ? 'leader' : '';
    const playerColor = p.color || '#95a5a6';

    return `
      <div class="playerRow ${rowClass}">
        <span style="flex:1; color: ${playerColor}; font-weight: bold;">${escapeHtml(p.name)}</span>
        ${badges.join(' ')}
      </div>
    `;
  }).join('');

  const taggerName = players.find(p => p.id === taggerId)?.name;
  const meta = taggerName ? `IT ${escapeHtml(taggerName)}` : 'WAITING';
  const expanded = gameState.state === 'waiting' || playerListExpanded;

  setHtmlIfChanged(wrap, `
    <button class="playerListToggle" type="button" aria-expanded="${expanded ? 'true' : 'false'}">
      <span class="playerListTitle">RUNNERS (${players.length})</span>
      <span class="playerListMeta">${meta}</span>
    </button>
    <div class="playerListRows">
      ${rows}
    </div>
  `);
}

elem('playerList')?.addEventListener('click', e => {
  const toggle = e.target.closest('.playerListToggle');
  if (!toggle || gameState.state === 'waiting') return;
  setPlayerListExpanded(!playerListExpanded);
});

function syncCanvasBackingSize() {
  const nextWidth = world.worldWidth || DEFAULT_WORLD_WIDTH;
  const nextHeight = world.worldHeight || DEFAULT_WORLD_HEIGHT;
  if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
    canvas.width = nextWidth;
    canvas.height = nextHeight;
    scene = new SceneDecorator(canvas);
  }
}

// CSS handles responsive visual scaling; the backing store stays in world units.
window.addEventListener('resize', syncCanvasBackingSize);

// Prevent context menu on canvas
canvas.addEventListener('contextmenu', e => e.preventDefault());

// Focus management
window.addEventListener('focus', () => {
  // Resume audio or other focus-related features if needed
});

window.addEventListener('blur', () => {
  // Pause or handle window blur if needed
});

// Performance monitoring (optional)
let frameCount = 0;
let lastFPSUpdate = performance.now();
const fpsElement = document.createElement('div');
fpsElement.id = 'fpsLatency';
fpsElement.dataset.fpsText = 'FPS --';
fpsElement.innerHTML = 'FPS -- <span class="meterDivider">/</span> PING <span class="pingValue">-- ms</span>';
document.body.appendChild(fpsElement);

setInterval(() => {
  const now = performance.now();
  if (now - lastFPSUpdate >= 1000) {
    const fps = Math.round((frameCount * 1000) / (now - lastFPSUpdate));
    fpsElement.dataset.fpsText = `FPS ${fps}`;
    // refresh combined display preserving current ping
    const pingSpan = fpsElement.querySelector('.pingValue');
    const currentPing = pingSpan ? pingSpan.textContent.replace(/[^0-9-]/g, '') : (displayedPing == null ? '--' : displayedPing);
    const pingStr = displayedPing == null ? currentPing : displayedPing;
    let cls = '';
    if (displayedPing != null) {
      if (displayedPing < 70) cls = 'good';
      else if (displayedPing < 140) cls = 'ok';
      else cls = 'bad';
    }
    setHtmlIfChanged(fpsElement, `${fpsElement.dataset.fpsText} <span class="meterDivider">/</span> PING <span class="pingValue ${cls}">${pingStr} ms</span>`);
    frameCount = 0;
    lastFPSUpdate = now;
  }
}, 100);

let renderLoopStarted = false;

// Initialize game
function initGame() {
  // Preload any assets if needed
  // Set initial canvas properties
  canvas.style.imageRendering = 'pixelated';
  canvas.style.imageRendering = '-moz-crisp-edges';
  canvas.style.imageRendering = 'crisp-edges';

  // Start the main render loop
  if (!renderLoopStarted) {
    renderLoopStarted = true;
    requestAnimationFrame(draw);
  }
}

// Start the game when DOM is loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGame);
} else {
  initGame();
}

// Export for testing (optional)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    gameState,
    localPlayer,
    updateLocalPrediction,
    spawnSmokePuff,
    updateAndDrawSmoke
  };
}
