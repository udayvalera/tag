import '/socket.io/socket.io.js';
import { SceneDecorator, ensureCtxRoundRectSupport } from './render.js';

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
  const fpsText = fpsEl.dataset.fpsText || 'FPS: --';
  setHtmlIfChanged(fpsEl, `${fpsText} | PING: <span class="pingValue ${cls}">${pingStr} ms</span>`);
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
  countdownRemainingMs: 0,
  gameRemainingMs: 0,
  leaderId: null,
  serverTime: 0
};
let world = {
  platforms: [],
  worldWidth: 1600,
  worldHeight: 720,
  version: null
};
let localId = null;
let inputSeq = 0;
const pendingInputs = []; // inputs not yet confirmed by server
const remoteHistory = new Map(); // playerId -> array of snapshots for interpolation
const BASE_INTERP_DELAY_MS = 80; // default render delay in ms (trimmed for snappier feel)
const MIN_INTERP_DELAY_MS = 45; // clamp for low-ping sessions so remotes stay <50ms behind
const MAX_REMOTE_EXTRAP_MS = 40; // allow gentle extrapolation when new snapshots haven't arrived
const MAX_HISTORY = 45;

// Physics constants (must mirror server)
const BASE_SPEED = 220;
const TAGGER_SPEED_MULT = 1.08;
const GRAVITY = 1400;
const JUMP_VELOCITY = 720;
const PLAYER_HEIGHT = 36;
const PLAYER_RADIUS = PLAYER_HEIGHT / 2;

const localPlayer = {
  id: null,
  x: 0, y: 0, vx: 0, vy: 0, dir: 1, isTagger: false, isGrounded: false,
  jumpHeld: false, canVariable: false, jumpStart: 0,
  lastGroundedTime: 0,
  bufferedJumpTime: 0
};
let predictionActive = false; // remain false until user moves / jumps to avoid idle flicker
const smokePuffs = [];
const runSmokeLastAt = new Map();
const MAX_SMOKE_PUFFS = 24;
const SMOKE_FRAME_COUNT = 8;
const RUN_SMOKE_INTERVAL_MS = 90;
let lastRenderDelayMs = BASE_INTERP_DELAY_MS;
let latestAuthoritativeLocal = null;
let serverClockOffsetMs = 0;
let hasServerClockOffset = false;

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
  scale = 1.35,
  life = 280,
  vx = 0,
  vy = 0
}) {
  if (!ENHANCED_PARTICLES) return;
  if (![x, y, scale, life, vx, vy].every(Number.isFinite)) return;

  while (smokePuffs.length >= MAX_SMOKE_PUFFS) {
    smokePuffs.shift();
  }

  smokePuffs.push({ x, y, dir, scale, life, vx, vy, t: 0 });
}

function spawnRunSmoke(id, player, now) {
  if (!ENHANCED_PARTICLES || !id || !player) return;

  const speed = Math.abs(player.vx ?? 0);
  const grounded = player.grounded ?? player.isGrounded;
  if (!grounded || speed < 45) {
    runSmokeLastAt.delete(id);
    return;
  }

  const last = runSmokeLastAt.get(id) ?? 0;
  if (now - last < RUN_SMOKE_INTERVAL_MS) return;
  runSmokeLastAt.set(id, now);

  const dir = player.dir || 1;
  spawnSmokePuff({
    x: player.x - dir * 20,
    y: player.y + 2,
    dir,
    scale: 1.15,
    life: 250,
    vx: -dir * 24,
    vy: 8
  });
}

function spawnJumpSmoke(x, y, dir) {
  spawnSmokePuff({
    x,
    y: y + 2,
    dir,
    scale: 1.65,
    life: 300,
    vx: -(dir || 1) * 10,
    vy: 12
  });
}

function spawnLandingSmoke(x, y, dir) {
  spawnSmokePuff({
    x,
    y: y + 2,
    dir,
    scale: 1.75,
    life: 320,
    vx: -(dir || 1) * 8,
    vy: 10
  });
}

function spawnTagSmoke(x, y) {
  const pattern = [
    { dx: -24, dy: 4, dir: 1, scale: 1.15, vx: -80, vy: 26 },
    { dx: -10, dy: 8, dir: 1, scale: 1.35, vx: -42, vy: 40 },
    { dx: 8, dy: 10, dir: -1, scale: 1.45, vx: 44, vy: 44 },
    { dx: 24, dy: 5, dir: -1, scale: 1.15, vx: 82, vy: 28 },
    { dx: 0, dy: 20, dir: 1, scale: 1.25, vx: 0, vy: 72 },
    { dx: -2, dy: -2, dir: -1, scale: 1.55, vx: 0, vy: 18 }
  ];

  for (const puff of pattern) {
    spawnSmokePuff({
      x: x + puff.dx,
      y: y + puff.dy,
      dir: puff.dir,
      scale: puff.scale,
      life: 300,
      vx: puff.vx,
      vy: puff.vy
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
    const alpha = age > 0.78 ? Math.max(0, (1 - age) / 0.22) : 1;
    scene.drawSmokePuff({ ...p, frame, alpha }, { x: 0, y: 0 });
  }
}

socket.on('connect', () => { localId = socket.id; });

socket.on('world', payload => {
  world = {
    platforms: Array.isArray(payload?.platforms) ? payload.platforms : [],
    worldWidth: payload?.worldWidth ?? 1600,
    worldHeight: payload?.worldHeight ?? 720,
    version: payload?.version ?? null
  };
  gameState.platforms = world.platforms;
});

socket.on('state', s => {
  if (typeof s.serverTime === 'number') {
    const sampleOffset = s.serverTime - performance.now();
    serverClockOffsetMs = hasServerClockOffset
      ? serverClockOffsetMs * 0.9 + sampleOffset * 0.1
      : sampleOffset;
    hasServerClockOffset = true;
  }

  gameState = {
    ...s,
    platforms: Array.isArray(s.platforms) ? s.platforms : world.platforms
  };

  if (!window.__firstStateLogged) {
    console.log('[DEBUG:first-state]', {
      players: s.players.map(p => ({ id: p.id, x: p.x, y: p.y, grounded: p.grounded, tagger: p.isTagger })),
      platforms: gameState.platforms?.length,
      state: s.state,
      serverTime: s.serverTime
    });
    window.__firstStateLogged = true;
  }
  updatePlayerList();
  updateStartButton();

  const authoritative = s.players.find(p => p.id === localId);
  if (authoritative) {
    if (!localPlayer.id) {
      Object.assign(localPlayer, {
        id: authoritative.id,
        color: authoritative.color
      });
    }

    latestAuthoritativeLocal = {
      x: authoritative.x,
      y: authoritative.y,
      vx: authoritative.vx ?? 0,
      vy: authoritative.vy ?? 0,
      dir: authoritative.dir || 1,
      isTagger: !!authoritative.isTagger,
      grounded: !!authoritative.grounded,
      color: authoritative.color
    };

    localPlayer.isTagger = latestAuthoritativeLocal.isTagger;
    localPlayer.color = latestAuthoritativeLocal.color;

    if (!predictionActive) {
      // Before any local input, trust server completely (no partial corrections that cause flicker)
      localPlayer.x = latestAuthoritativeLocal.x;
      localPlayer.y = latestAuthoritativeLocal.y;
      localPlayer.vx = latestAuthoritativeLocal.vx;
      localPlayer.vy = latestAuthoritativeLocal.vy;
      localPlayer.dir = latestAuthoritativeLocal.dir;
      localPlayer.isGrounded = latestAuthoritativeLocal.grounded;
    }
  }

  const activeRemoteIds = new Set();
  for (const p of s.players) {
    if (p.id === localId) continue;
    activeRemoteIds.add(p.id);
    if (!remoteHistory.has(p.id)) remoteHistory.set(p.id, []);
    const arr = remoteHistory.get(p.id);
    arr.push({
      t: s.serverTime,
      x: p.x,
      y: p.y,
      isTagger: p.isTagger,
      name: p.name,
      dir: p.dir || 1,
      vx: p.vx ?? 0,
      vy: p.vy ?? 0,
      color: p.color,
      grounded: !!p.grounded
    });
    while (arr.length > MAX_HISTORY) arr.shift();
  }

  for (const id of remoteHistory.keys()) {
    if (!activeRemoteIds.has(id)) remoteHistory.delete(id);
  }
});

socket.on('tag', ({ taggerId }) => {
  gameState.taggerId = taggerId;
  if (ENHANCED_PARTICLES) {
    const taggerPlayer = gameState.players.find(p => p.id === taggerId);
    if (taggerPlayer) {
      spawnTagSmoke(taggerPlayer.x, taggerPlayer.y);
    }
  }
});

socket.on('playerLeft', ({ id }) => {
  // Remove from history
  remoteHistory.delete(id);
  runSmokeLastAt.delete(id);
});

function showStatus(code) {
  setHidden(elem('menu'), true);
  setHidden(elem('statusBar'), false);
  setTextIfChanged(elem('roomLabel'), 'Room: ' + code);
  setHidden(elem('playerList'), false);
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
  const payload = {
    left: !!(keys['ArrowLeft'] || keys['KeyA']),
    right: !!(keys['ArrowRight'] || keys['KeyD']),
    jump: jumpHeld,
    jumpPressed: justPressedJump,
    jumpReleased: justReleasedJump,
    seq: ++inputSeq
  };

  // Approx dt since last input for prediction step (fallback ~16ms)
  const dt = lastInputTime ? (now - lastInputTime) / 1000 : 0.016;
  payload.dt = dt;
  lastInputTime = now;

  // Predict locally immediately
  socket.emit('input', {
    left: payload.left,
    right: payload.right,
    jump: payload.jump,
    jumpPressed: payload.jumpPressed,
    jumpReleased: payload.jumpReleased,
    seq: payload.seq,
  });

  justPressedJump = false;
  justReleasedJump = false;
}

// Render loop
function draw(now = performance.now()) {
  requestAnimationFrame(draw);
  frameCount++;
  const { players, state, countdownRemainingMs, gameRemainingMs, taggerId } = gameState;
  const platforms = world.platforms.length ? world.platforms : (gameState.platforms || []);
  const dtBg = lastBgTime ? Math.min((now - lastBgTime) / 1000, 0.05) : 1 / 60;
  lastBgTime = now;

  scene.update(dtBg);
  scene.drawBackground();

  if (localPlayer.id && predictionActive) {
    updateLocalPrediction(dtBg, platforms);
    reconcileLocalPlayer(dtBg);
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
    let ix, iy, dir, vx, vy, name, isTagger, color, grounded;

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
      grounded = alpha < 0.5 ? prev.grounded : next.grounded;
    }

    const clampedX = Math.max(0, Math.min(world.worldWidth, ix));
    const clampedY = Math.max(0, iy);

    rendered.set(p.id, {
      x: clampedX,
      y: clampedY,
      name,
      isTagger,
      dir,
      vx,
      vy,
      color,
      grounded
    });
  }

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
      grounded: lpServer?.grounded ?? localPlayer.isGrounded
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
        grounded: rp.grounded
      },
      { x: 0, y: 0 },
      false,
      rp.isTagger
    );
  }

  // Local player rendering
  if (localPlayer.id) {
    const color = lpServer?.color;

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
        grounded: lpServer?.grounded ?? localPlayer.isGrounded
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
    setTextIfChanged(cdText, 'GET READY!');
    setHtmlIfChanged(cdTagger, `Tagger: <span class="tagger-name">${escapeHtml(taggerName)}</span>`);
  } else {
    setHidden(elem('countdown'), true);
  }

  if (state === 'running') {
    const timeLeft = (gameRemainingMs / 1000).toFixed(1);
    setHtmlIfChanged(elem('timer'), `⏰ ${timeLeft}s`);
    const taggerName = players.find(p => p.id === taggerId)?.name || 'Nobody';
    setHtmlIfChanged(elem('tagger'), `🏷️ ${escapeHtml(taggerName)}`);
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
          ${p.id === taggerId ? '<span class="final-tagger">🏆 FINAL TAGGER</span>' : ''}
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
      lp ? `LOCAL AUTH x:${lp.x.toFixed(1)} y:${lp.y.toFixed(1)} vy:${(lp.vy || 0).toFixed(1)} g:${lp.grounded}` : 'LOCAL AUTH: none',
      localPlayer.id ? `LOCAL PRED x:${localPlayer.x.toFixed(1)} y:${localPlayer.y.toFixed(1)} g:${localPlayer.isGrounded}` : 'LOCAL PRED: none',
      `TAGGER: ${gameState.taggerId || 'none'}`,
      `PING: ${displayedPing ?? '--'} ms`,
      `RENDER DELAY: ${lastRenderDelayMs.toFixed(1)} ms`,
      'F2 toggle debug'
    ].join('\n');
  }
}

function reconcileLocalPlayer(dt) {
  const auth = latestAuthoritativeLocal;
  if (!auth || !predictionActive) return;

  localPlayer.isTagger = auth.isTagger;
  localPlayer.color = auth.color;

  const dx = auth.x - localPlayer.x;
  const dy = auth.y - localPlayer.y;

  if (Math.abs(dx) > 160 || Math.abs(dy) > 220) {
    localPlayer.x = auth.x;
    localPlayer.y = auth.y;
    localPlayer.vx = auth.vx;
    localPlayer.vy = auth.vy;
    localPlayer.dir = auth.dir;
    localPlayer.isGrounded = auth.grounded;
    localPlayer.canVariable = false;
    return;
  }

  const correction = 1 - Math.exp(-10 * Math.min(dt, 0.05));
  localPlayer.x += dx * correction;
  localPlayer.y += dy * correction;

  const movingHorizontally = keys['ArrowLeft'] || keys['KeyA'] || keys['ArrowRight'] || keys['KeyD'];
  if (!movingHorizontally) {
    localPlayer.vx = auth.vx;
    localPlayer.dir = auth.dir;
  }

  if (Math.abs(dy) < 4 && auth.grounded) {
    localPlayer.isGrounded = true;
    localPlayer.vy = auth.vy;
    localPlayer.canVariable = false;
  }
}

function updateLocalPrediction(dt, platforms) {
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
}

// Start game button (leader only)
elem('startGameBtn').onclick = () => {
  if (!gameState.leaderId || gameState.leaderId !== localId) return;
  socket.emit('startGame', { code: elem('roomLabel').textContent.split(': ')[1] }, (res) => {
    if (res?.error) alert(res.error);
  });
};

function updateStartButton() {
  const btn = elem('startGameBtn');
  const visible = gameState.state === 'waiting' && gameState.leaderId === localId && gameState.players.length >= 2;
  setHidden(btn, !visible);
}

let lastPlayerListKey = '';

function updatePlayerList() {
  const wrap = elem('playerList');
  if (!wrap) return;
  const { players, taggerId, leaderId } = gameState;
  const key = JSON.stringify({
    players: players.map(p => [p.id, p.name, p.color]),
    taggerId,
    leaderId,
    localId
  });
  if (key === lastPlayerListKey) return;
  lastPlayerListKey = key;

  const rows = players.map(p => {
    const badges = [];
    if (p.id === leaderId) badges.push('<span class="leaderBadge">👑 LEADER</span>');
    if (p.id === taggerId) badges.push('<span class="tagBadge">🏷️ TAGGER</span>');
    if (p.id === localId) badges.push('<span class="selfBadge">⭐ YOU</span>');

    const rowClass = p.id === leaderId ? 'leader' : '';
    const playerColor = p.color || '#95a5a6';

    return `
      <div class="playerRow ${rowClass}">
        <span style="flex:1; color: ${playerColor}; font-weight: bold;">${escapeHtml(p.name)}</span>
        ${badges.join(' ')}
      </div>
    `;
  }).join('');

  setHtmlIfChanged(wrap, `<h3>👥 PLAYERS (${players.length})</h3>${rows}`);
}

// Window resize handler for responsive canvas
window.addEventListener('resize', () => {
  // Maintain aspect ratio or adjust canvas size if needed
  const rect = canvas.getBoundingClientRect();
  if (rect.width !== canvas.width || rect.height !== canvas.height) {
    canvas.width = rect.width;
    canvas.height = rect.height;
    // Reinitialize scene if canvas size changes
    scene = new SceneDecorator(canvas);
  }
});

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
fpsElement.style.cssText = 'position:fixed;top:10px;right:10px;color:#fff;font-size:12px;z-index:1000;pointer-events:none;text-shadow:1px 1px 0 #000;font-family:monospace;';
fpsElement.dataset.fpsText = 'FPS: --';
fpsElement.innerHTML = 'FPS: -- | PING: <span class="pingValue">-- ms</span>';
document.body.appendChild(fpsElement);

setInterval(() => {
  const now = performance.now();
  if (now - lastFPSUpdate >= 1000) {
    const fps = Math.round((frameCount * 1000) / (now - lastFPSUpdate));
    fpsElement.dataset.fpsText = `FPS: ${fps}`;
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
    setHtmlIfChanged(fpsElement, `${fpsElement.dataset.fpsText} | PING: <span class="pingValue ${cls}">${pingStr} ms</span>`);
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
