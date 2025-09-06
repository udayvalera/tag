import '/socket.io/socket.io.js';
import { SceneDecorator, ensureCtxRoundRectSupport } from './render.js';

const socket = io();

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
  const avg = pingSamples.reduce((a,b)=>a+b,0)/pingSamples.length;
  displayedPing = Math.round(avg);
  updateLatencyDisplay();
});

function updateLatencyDisplay() {
  const fpsEl = document.getElementById('fpsLatency');
  if (!fpsEl) return;
  const pingStr = displayedPing == null ? '--' : displayedPing;
  let cls = '';
  if (displayedPing != null) {
    if (displayedPing < 70) cls = 'good';
    else if (displayedPing < 140) cls = 'ok';
    else cls = 'bad';
  }
  const fpsText = fpsEl.dataset.fpsText || 'FPS: --';
  fpsEl.innerHTML = `${fpsText} | PING: <span class="pingValue ${cls}">${pingStr} ms</span>`;
}

setInterval(() => {
  if (socket.connected) sendLatencyPing();
}, PING_INTERVAL_MS);

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ensureCtxRoundRectSupport();
const scene = new SceneDecorator(canvas);
let lastBgTime = null; // background animation timestamp

// Enhanced visual constants
const ENHANCED_PARTICLES = true;
const SHOW_DEBUG_PLATFORMS = false; // Set to true for platform debugging

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

function elem(id){ return document.getElementById(id); }

let gameState = { 
  players:[], 
  platforms:[], 
  state:'waiting', 
  taggerId:null, 
  countdownRemainingMs:0, 
  gameRemainingMs:0, 
  leaderId:null, 
  serverTime:0 
};
let localId = null;
let inputSeq = 0;
const pendingInputs = []; // inputs not yet confirmed by server
const remoteHistory = new Map(); // playerId -> array of snapshots for interpolation
const INTERP_DELAY_MS = 110; // render this much in past
const MAX_HISTORY = 30;

// Physics constants (must mirror server)
const BASE_SPEED = 220;
const TAGGER_SPEED_MULT = 1.08;
const GRAVITY = 1400;
const JUMP_VELOCITY = 720;
const PLAYER_HEIGHT = 36;
const PLAYER_RADIUS = PLAYER_HEIGHT/2;

const localPlayer = { 
  id:null, 
  x:0,y:0,vx:0,vy:0,dir:1,isTagger:false,isGrounded:false,
  jumpHeld:false,canVariable:false,jumpStart:0, 
  lastGroundedTime:0, 
  bufferedJumpTime:0 
};
let predictionActive = false; // remain false until user moves / jumps to avoid idle flicker
const dustParticles = [];

// Mirror advanced jump tuning (keep in sync with server where possible)
const JUMP_SUSTAIN_MS = 140;
const JUMP_LOW_GRAVITY_FACTOR = 0.55;
const JUMP_SHORT_HOP_FACTOR = 0.35;
const COYOTE_MS = 80;
const JUMP_BUFFER_MS = 90;

let lastPredictTime = null;
let lastInputTime = null;

// Enhanced dust system
function spawnDust(x, y, color) {
  if (!ENHANCED_PARTICLES) return;
  
  const count = 3;
  for (let i = 0; i < count; i++) {
    dustParticles.push({
      x: x + (Math.random() * 12 - 6),
      y: y + (Math.random() * 6 - 3),
      vx: (Math.random() * 40 - 20) * (Math.random() > 0.5 ? 1 : -1),
      vy: Math.random() * 50 + 30,
      life: 300 + Math.random() * 100,
      t: 0,
      c: color,
      r: 3 + Math.random() * 4
    });
  }
}

function drawDust() {
  if (!ENHANCED_PARTICLES) return;
  
  for (let i = dustParticles.length - 1; i >= 0; i--) {
    const p = dustParticles[i];
    p.t += 16;
    const age = p.t / p.life;
    p.x += p.vx * 0.016;
    p.y += p.vy * 0.016;
    
    if (age >= 1) {
      dustParticles.splice(i, 1);
      continue;
    }
    
    // Enhanced dust with glow
    const alpha = (1 - age) * 0.4;
    const size = p.r * (1 - age * 0.7);
    
    // Glow effect
    const gradient = ctx.createRadialGradient(p.x, canvas.height - p.y, 0, p.x, canvas.height - p.y, size * 2);
    const rgb = hexToRgb(p.c);
    gradient.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`);
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(p.x, canvas.height - p.y, size * 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 128, g: 128, b: 128 };
}

function drawSpeedLines(x, y, direction) {
  const count = 5;
  const lineLength = 20;
  
  ctx.globalAlpha = 0.6;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  
  for (let i = 0; i < count; i++) {
    const offsetX = (Math.random() - 0.5) * 20;
    const offsetY = (Math.random() - 0.5) * 20;
    
    ctx.beginPath();
    const startX = x - direction * (lineLength + i * 5) + offsetX;
    const startY = y + offsetY;
    ctx.moveTo(startX, startY);
    ctx.lineTo(startX + direction * lineLength, startY);
    ctx.stroke();
  }
  
  ctx.globalAlpha = 1;
}

socket.on('connect', () => { localId = socket.id; });

socket.on('state', s => {
  gameState = s;
  updatePlayerList(); 
  updateStartButton();
  
  // Find local authoritative player
  const authoritative = s.players.find(p => p.id === localId);
  if (authoritative) {
    if (!localPlayer.id) {
      Object.assign(localPlayer, { 
        id: authoritative.id,
        color: authoritative.color 
      });
    }
    
    if (!predictionActive) {
      // Before any local input, trust server completely (no partial corrections that cause flicker)
      localPlayer.x = authoritative.x;
      localPlayer.y = authoritative.y;
      localPlayer.vx = authoritative.vx || 0;
      localPlayer.vy = authoritative.vy || 0;
      localPlayer.dir = authoritative.dir || 1;
      localPlayer.isGrounded = authoritative.grounded || false;
    } else {
      // Active prediction: soft reconcile
      const dx = authoritative.x - localPlayer.x;
      if (Math.abs(dx) > 6) localPlayer.x += dx * 0.3;
      const dy = authoritative.y - localPlayer.y;
      if (Math.abs(dy) > 12) { // slightly larger threshold for vertical
        localPlayer.y += dy * 0.3;
        localPlayer.vy = authoritative.vy || localPlayer.vy;
      }
      localPlayer.isTagger = authoritative.isTagger;
      localPlayer.dir = authoritative.dir || 1;
      localPlayer.isGrounded = authoritative.grounded || false;
    }
  }
  
  const now = performance.now();
  // store remote snapshots
  for (const p of s.players) {
    if (p.id === localId) continue;
    if (!remoteHistory.has(p.id)) remoteHistory.set(p.id, []);
    const arr = remoteHistory.get(p.id);
    arr.push({ 
      t: s.serverTime, 
      x: p.x, 
      y: p.y, 
      isTagger: p.isTagger, 
      name: p.name,
      dir: p.dir || 1,
      vx: p.vx || 0,
      vy: p.vy || 0,
      color: p.color
    });
    while (arr.length > MAX_HISTORY) arr.shift();
  }
});

socket.on('tag', ({ taggerId }) => { 
  gameState.taggerId = taggerId; 
  // Enhanced visual feedback for tag event
  if (ENHANCED_PARTICLES) {
    // Create explosion of particles at tagger position
    const taggerPlayer = gameState.players.find(p => p.id === taggerId);
    if (taggerPlayer) {
      for (let i = 0; i < 20; i++) {
        dustParticles.push({
          x: taggerPlayer.x + (Math.random() - 0.5) * 40,
          y: taggerPlayer.y + (Math.random() - 0.5) * 40,
          vx: (Math.random() - 0.5) * 200,
          vy: (Math.random() - 0.5) * 200,
          life: 500,
          t: 0,
          c: '#ff6b6b',
          r: 2 + Math.random() * 3
        });
      }
    }
  }
});

socket.on('playerLeft', ({ id }) => {
  // Remove from history
  remoteHistory.delete(id);
});

function showStatus(code) {
  elem('menu').classList.add('hidden');
  elem('statusBar').classList.remove('hidden');
  elem('roomLabel').textContent = 'Room: ' + code;
  elem('playerList').classList.remove('hidden');
}

// Input handling
const keys = {};
let justPressedJump = false;
let justReleasedJump = false;

window.addEventListener('keydown', e => {
  if (!keys[e.code]) {
    if (isJumpKey(e.code)) {
      justPressedJump = true;
      // Visual feedback for jump
      if (localPlayer.id && ENHANCED_PARTICLES && localPlayer.isGrounded) {
        spawnDust(localPlayer.x, localPlayer.y, localPlayer.color || '#95a5a6');
      }
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
  if (isJumpKey(e.code)) justReleasedJump = true;
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
  const dt = lastInputTime ? (now - lastInputTime)/1000 : 0.016;
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
function draw() {
  requestAnimationFrame(draw);
  const { players, platforms, state, countdownRemainingMs, gameRemainingMs, taggerId } = gameState;
  const now = performance.now();
  const dtBg = lastBgTime ? (now - lastBgTime) / 1000 : 0;
  lastBgTime = now;
  
  scene.update(dtBg);
  scene.drawBackground();

  // Lightweight local horizontal prediction (no vertical) for responsiveness
  if (localPlayer.id && predictionActive) {
    const now = performance.now();
    if (!lastPredictTime) lastPredictTime = now;
    let dt = (now - lastPredictTime)/1000;
    if (dt > 0.05) dt = 0.05; // clamp large frame gaps
    lastPredictTime = now;
    updateLocalPrediction(dt, platforms);
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
  scene.drawPlatforms(platforms);

  // Draw enhanced dust system
  drawDust();

  // Enhanced player rendering with interpolation
  const renderTime = (gameState.serverTime || Date.now()) - INTERP_DELAY_MS;
  const rendered = new Map();
  
  for (const p of players) {
    if (p.id === localId) continue;
    const hist = remoteHistory.get(p.id);
    if (!hist || hist.length < 2) continue;
    
    // find surrounding frames
    let a = hist[0], b = hist[hist.length-1];
    for (let i = 0; i < hist.length-1; i++) {
      if (hist[i].t <= renderTime && hist[i+1].t >= renderTime) { 
        a = hist[i]; 
        b = hist[i+1]; 
        break; 
      }
    }
    const span = b.t - a.t || 1;
    const t = Math.min(1, Math.max(0, (renderTime - a.t)/span));
    const ix = a.x + (b.x - a.x) * t;
    const iy = a.y + (b.y - a.y) * t;
    
    rendered.set(p.id, { 
      x: ix, 
      y: iy, 
      name: a.name, 
      isTagger: a.isTagger,
      dir: a.dir || 1,
      vx: a.vx || 0,
      vy: a.vy || 0,
      color: a.color
    });
  }

  // Draw remote players with motion effects
  for (const p of players) {
    if (p.id === localId) continue;
    const rp = rendered.get(p.id);
    if (!rp) continue;
    
    // Motion blur/trail effect for moving players
    if (ENHANCED_PARTICLES && Math.abs(rp.vx) > 20) {
      ctx.globalAlpha = 0.3;
      const trailX = rp.x - rp.dir * 8;
      scene.drawPlayer(
        { 
          x: trailX, 
          y: rp.y, 
          name: rp.name, 
          isTagger: rp.isTagger, 
          dir: rp.dir, 
          vx: rp.vx, 
          vy: rp.vy, 
          color: rp.color 
        }, 
        { x: 0, y: 0 }, 
        false, 
        rp.isTagger
      );
      ctx.globalAlpha = 1;
    }
    
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
        color: rp.color 
      }, 
      { x: 0, y: 0 }, 
      false, 
      rp.isTagger
    );
  }

  // Local player rendering with enhanced effects
  if (localPlayer.id) {
    const lpServer = players.find(p => p.id === localId);
    const color = lpServer?.color;
    
    // Local player trail effect
    if (ENHANCED_PARTICLES && Math.abs(localPlayer.vx) > 20) {
      ctx.globalAlpha = 0.2;
      const trailX = localPlayer.x - localPlayer.dir * 8;
      scene.drawPlayer(
        { 
          x: trailX, 
          y: localPlayer.y, 
          name: lpServer?.name || 'You', 
          isTagger: localPlayer.isTagger, 
          dir: localPlayer.dir, 
          vx: localPlayer.vx, 
          vy: localPlayer.vy, 
          color: color 
        }, 
        { x: 0, y: 0 }, 
        true, 
        localPlayer.isTagger
      );
      ctx.globalAlpha = 1;
    }
    
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
        color: color 
      }, 
      { x: 0, y: 0 }, 
      true, 
      localPlayer.isTagger
    );
    
    // Enhanced dust spawning for local player
    if (lpServer?.grounded && Math.abs(localPlayer.vx) > 30) {
      if (Math.random() < 0.4) {
        spawnDust(localPlayer.x, localPlayer.y - 8, color || '#95a5a6');
      }
    }
    
    // Speed lines effect for fast movement
    if (ENHANCED_PARTICLES && Math.abs(localPlayer.vx) > 100) {
      drawSpeedLines(localPlayer.x, localPlayer.y, localPlayer.dir);
    }
    
    // Jump particles
    if (justPressedJump && localPlayer.vy > 0 && ENHANCED_PARTICLES) {
      spawnDust(localPlayer.x, localPlayer.y, color || '#95a5a6');
    }
  }

  // Enhanced UI overlays
  if (state === 'countdown') {
    const cd = Math.ceil(countdownRemainingMs / 1000);
    elem('countdown').classList.remove('hidden');
    const taggerName = players.find(p => p.id === taggerId)?.name || '';
    elem('countdown-number').textContent = cd;
    elem('.countdown-text').textContent = 'GET READY!';
    elem('.countdown-tagger').innerHTML = `Tagger: <span class="tagger-name">${taggerName}</span>`;
  } else {
    elem('countdown').classList.add('hidden');
  }

  if (state === 'running') {
    const timeLeft = (gameRemainingMs / 1000).toFixed(1);
    elem('timer').innerHTML = `⏰ ${timeLeft}s`;
    const taggerName = players.find(p => p.id === taggerId)?.name || 'Nobody';
    elem('tagger').innerHTML = `🏷️ ${taggerName}`;
  }

  if (state === 'ended') {
    elem('gameOver').classList.remove('hidden');
    if (!elem('results').dataset.filled) {
      const sorted = [...players].sort((a, b) => {
        // Sort by some metric - final tagger first, then alphabetical
        if (a.id === taggerId) return -1;
        if (b.id === taggerId) return 1;
        return a.name.localeCompare(b.name);
      });
      
      elem('results').innerHTML = sorted.map((p, index) => 
        `<div class="result-item">
          ${index + 1}. ${p.name}
          ${p.id === taggerId ? '<span class="final-tagger">🏆 FINAL TAGGER</span>' : ''}
        </div>`
      ).join('');
      elem('results').dataset.filled = '1';
    }
  }
}

draw();

function updateLocalPrediction(dt, platforms) {
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
  if (justPressedJump) {
    // attempt jump (coyote)
    if (localPlayer.isGrounded || (nowMs - localPlayer.lastGroundedTime) <= COYOTE_MS) {
      localPlayer.vy = JUMP_VELOCITY;
      localPlayer.jumpStart = nowMs;
      localPlayer.canVariable = true;
      localPlayer.isGrounded = false;
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
        // Spawn landing dust
        if (ENHANCED_PARTICLES) {
          spawnDust(localPlayer.x, localPlayer.y, localPlayer.color || '#95a5a6');
        }
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
  if (localPlayer.x > 1600) localPlayer.x = 1600;
  if (localPlayer.y < 40) { // ground clamp fallback
    localPlayer.y = 40; 
    localPlayer.vy = 0; 
    localPlayer.isGrounded = true; 
    localPlayer.canVariable = false;
  }

  // Reset one-shot jump detection flags locally AFTER using them
  justPressedJump = false;
  justReleasedJump = false;
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
  if (gameState.state === 'waiting' && gameState.leaderId === localId && gameState.players.length >= 2) {
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
  }
}

function updatePlayerList() {
  const wrap = elem('playerList');
  if (!wrap) return;
  const { players, taggerId, leaderId } = gameState;
  
  wrap.innerHTML = `<h3>👥 PLAYERS (${players.length})</h3>`;
  
  players.forEach(p => {
    const badges = [];
    if (p.id === leaderId) badges.push('<span class="leaderBadge">👑 LEADER</span>');
    if (p.id === taggerId) badges.push('<span class="tagBadge">🏷️ TAGGER</span>');
    if (p.id === localId) badges.push('<span class="selfBadge">⭐ YOU</span>');
    
    const rowClass = p.id === leaderId ? 'leader' : '';
    const playerColor = p.color || '#95a5a6';
    
    wrap.innerHTML += `
      <div class="playerRow ${rowClass}">
        <span style="flex:1; color: ${playerColor}; font-weight: bold;">${p.name}</span>
        ${badges.join(' ')}
      </div>
    `;
  });
}

// Enhanced status updates
function updateStatusBar() {
  if (gameState.state === 'running') {
    const timeLeft = (gameState.gameRemainingMs / 1000).toFixed(1);
    if (elem('timer')) elem('timer').innerHTML = `⏰ ${timeLeft}s`;
    
    const taggerName = gameState.players.find(p => p.id === gameState.taggerId)?.name || 'Nobody';
    if (elem('tagger')) elem('tagger').innerHTML = `🏷️ ${taggerName}`;
  }
}

// Game state change handler
socket.on('state', () => {
  updateStatusBar();
});

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
  frameCount++;
  if (now - lastFPSUpdate >= 1000) {
    const fps = Math.round((frameCount * 1000) / (now - lastFPSUpdate));
    fpsElement.dataset.fpsText = `FPS: ${fps}`;
    // refresh combined display preserving current ping
    const pingSpan = fpsElement.querySelector('.pingValue');
    const currentPing = pingSpan ? pingSpan.textContent.replace(/[^0-9-]/g,'') : (displayedPing==null?'--':displayedPing);
    const pingStr = displayedPing == null ? currentPing : displayedPing;
    let cls = '';
    if (displayedPing != null) {
      if (displayedPing < 70) cls = 'good';
      else if (displayedPing < 140) cls = 'ok';
      else cls = 'bad';
    }
    fpsElement.innerHTML = `${fpsElement.dataset.fpsText} | PING: <span class="pingValue ${cls}">${pingStr} ms</span>`;
    frameCount = 0;
    lastFPSUpdate = now;
  }
}, 100);

// Initialize game
function initGame() {
  // Preload any assets if needed
  // Set initial canvas properties
  canvas.style.imageRendering = 'pixelated';
  canvas.style.imageRendering = '-moz-crisp-edges';
  canvas.style.imageRendering = 'crisp-edges';
  
  // Start the main render loop
  draw();
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
    spawnDust,
    drawDust
  };
}