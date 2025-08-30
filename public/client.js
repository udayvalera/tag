import '/socket.io/socket.io.js';
const socket = io();

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

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

let gameState = { players:[], platforms:[], state:'waiting', taggerId:null, countdownRemainingMs:0, gameRemainingMs:0, leaderId:null, serverTime:0 };
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

const localPlayer = { id:null, x:0,y:0,vx:0,vy:0,dir:1,isTagger:false,isGrounded:false,jumpHeld:false,canVariable:false,jumpStart:0, lastGroundedTime:0, bufferedJumpTime:0 };
let predictionActive = false; // remain false until user moves / jumps to avoid idle flicker

// Mirror advanced jump tuning (keep in sync with server where possible)
const JUMP_SUSTAIN_MS = 140;
const JUMP_LOW_GRAVITY_FACTOR = 0.55;
const JUMP_SHORT_HOP_FACTOR = 0.35;
const COYOTE_MS = 80;
const JUMP_BUFFER_MS = 90;

socket.on('connect', () => { localId = socket.id; });

socket.on('state', s => {
  gameState = s;
  updatePlayerList(); updateStartButton();
  // Find local authoritative player
  const authoritative = s.players.find(p=>p.id===localId);
  if (authoritative) {
    if (!localPlayer.id) Object.assign(localPlayer, { id: authoritative.id });
    if (!predictionActive) {
      // Before any local input, trust server completely (no partial corrections that cause flicker)
      localPlayer.x = authoritative.x;
      localPlayer.y = authoritative.y;
      localPlayer.vx = authoritative.vx||0;
      localPlayer.vy = authoritative.vy||0;
    } else {
      // Active prediction: soft reconcile
      const dx = authoritative.x - localPlayer.x;
      if (Math.abs(dx) > 6) localPlayer.x += dx * 0.3;
      const dy = authoritative.y - localPlayer.y;
      if (Math.abs(dy) > 12) { // slightly larger threshold for vertical
        localPlayer.y += dy * 0.3;
        localPlayer.vy = authoritative.vy || localPlayer.vy;
      }
    }
    localPlayer.isTagger = authoritative.isTagger;
  }
  const now = performance.now();
  // store remote snapshots
  for (const p of s.players) {
    if (p.id === localId) continue;
    if (!remoteHistory.has(p.id)) remoteHistory.set(p.id, []);
    const arr = remoteHistory.get(p.id);
    arr.push({ t: s.serverTime, x:p.x, y:p.y, isTagger:p.isTagger, name:p.name });
    while (arr.length > MAX_HISTORY) arr.shift();
  }
});
socket.on('tag', ({ taggerId }) => { gameState.taggerId = taggerId; flashTag(); });
socket.on('playerLeft', () => {});

function showStatus(code) {
  elem('menu').classList.add('hidden');
  elem('statusBar').classList.remove('hidden');
  elem('roomLabel').textContent = 'Room: ' + code;
  elem('playerList').classList.remove('hidden');
}

function flashTag() {
  const el = document.createElement('div');
  el.className = 'overlay';
  el.style.fontSize = '72px';
  el.style.color = '#ff9800';
  el.textContent = 'TAG!';
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 600);
}

// Input
const keys = {};
let justPressedJump = false;
let justReleasedJump = false;
window.addEventListener('keydown', e => {
  if (!keys[e.code]) {
    if (isJumpKey(e.code)) justPressedJump = true;
  }
  keys[e.code] = true;
  if (isJumpKey(e.code) || e.code.startsWith('Arrow') || e.code === 'KeyA' || e.code === 'KeyD') {
    if (!predictionActive && localPlayer.id) {
      predictionActive = true; // enable prediction after first control input
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

function isJumpKey(code) { return code === 'Space' || code === 'ArrowUp' || code === 'KeyW'; }

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
  // We now do continuous frame-based horizontal prediction instead (see draw loop)
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

let lastInputTime = null;

// Removed detailed per-input prediction; using lightweight frame-based horizontal smoothing.

// Render loop
let lastPredictTime = null;
function draw() {
  requestAnimationFrame(draw);
  const { players, platforms, state, countdownRemainingMs, gameRemainingMs, taggerId } = gameState;
  ctx.clearRect(0,0,canvas.width, canvas.height);

  // Lightweight local horizontal prediction (no vertical) for responsiveness
  if (localPlayer.id && predictionActive) {
    const now = performance.now();
    if (!lastPredictTime) lastPredictTime = now;
    let dt = (now - lastPredictTime)/1000;
    if (dt > 0.05) dt = 0.05; // clamp large frame gaps
    lastPredictTime = now;
    updateLocalPrediction(dt, platforms);
  }

  // simple sky gradient already background via CSS; draw platforms
  for (const p of platforms) { ctx.fillStyle = '#4caf50'; ctx.fillRect(p.x, canvas.height - (p.y + p.h), p.w, p.h); }

  // players
  // Interpolated remote players & predicted local
  const renderTime = (gameState.serverTime || Date.now()) - INTERP_DELAY_MS;
  // Prepare map for remote positions
  const rendered = new Map();
  for (const p of players) {
    if (p.id === localId) continue;
    const hist = remoteHistory.get(p.id);
    if (!hist || hist.length < 2) continue;
    // find surrounding frames
    let a = hist[0], b = hist[hist.length-1];
    for (let i=0;i<hist.length-1;i++) {
      if (hist[i].t <= renderTime && hist[i+1].t >= renderTime) { a = hist[i]; b = hist[i+1]; break; }
    }
    const span = b.t - a.t || 1;
    const t = Math.min(1, Math.max(0, (renderTime - a.t)/span));
    const ix = a.x + (b.x - a.x) * t;
    const iy = a.y + (b.y - a.y) * t;
    rendered.set(p.id, { x: ix, y: iy, name: a.name, isTagger: a.isTagger });
  }
  // Draw remote players
  for (const p of players) {
    if (p.id === localId) continue;
    const rp = rendered.get(p.id);
    if (!rp) continue;
    drawPlayer(rp.x, rp.y, p.id === taggerId, rp.name, false);
  }
  // Draw local predicted player last for clarity
  if (localPlayer.id) drawPlayer(localPlayer.x, localPlayer.y, localPlayer.isTagger, players.find(p=>p.id===localId)?.name||'You', true);

  // UI overlays
  if (state === 'countdown') {
  const cd = Math.ceil(countdownRemainingMs/1000);
  elem('countdown').classList.remove('hidden');
  elem('countdown').innerHTML = `<div style="font-size:160px; line-height:1;">${cd}</div><div style="font-size:40px; color:#ff9800;">Get Ready!</div><div style="font-size:22px; color:#444; margin-top:14px;">Tagger: <span style="color:#ff3d00;">${players.find(p=>p.id===taggerId)?.name||''}</span></div>`;
  } else {
    elem('countdown').classList.add('hidden');
  }

  if (state === 'running') {
    elem('timer').textContent = 'Time: ' + (gameRemainingMs/1000).toFixed(1);
    elem('tagger').textContent = 'Tagger: ' + (players.find(p=>p.id===taggerId)?.name || '');
  }

  if (state === 'ended') {
    elem('gameOver').classList.remove('hidden');
    if (!elem('results').dataset.filled) {
      const sorted = [...players]; // could sort by scoreTimeTaggedMs
      elem('results').innerHTML = sorted.map(p=>`<div>${p.name} ${p.id===taggerId?'(Last Tagger)':''}</div>`).join('');
      elem('results').dataset.filled = '1';
    }
  }
}

draw();

function drawPlayer(x, y, isTagger, name, isSelf) {
  const size = 36;
  ctx.fillStyle = isTagger ? '#ff3d00' : (isSelf ? '#2196f3' : '#ffffff');
  ctx.beginPath();
  ctx.arc(x, canvas.height - (y + size/2), size/2, 0, Math.PI*2);
  ctx.fill();
  ctx.fillStyle = '#000';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(name, x, canvas.height - (y + size + 12));
  if (isTagger) { ctx.fillStyle='#ffeb3b'; ctx.fillText('IT', x, canvas.height - (y - 10)); }
}

function updateLocalPrediction(dt, platforms) {
  // Horizontal
  const left = keys['ArrowLeft'] || keys['KeyA'];
  const right = keys['ArrowRight'] || keys['KeyD'];
  const speed = BASE_SPEED * (localPlayer.isTagger ? TAGGER_SPEED_MULT : 1);
  localPlayer.vx = (left?-speed:0) + (right?speed:0);
  if (left) localPlayer.dir = -1; else if (right) localPlayer.dir = 1;
  // Track jump hold
  localPlayer.jumpHeld = !!(keys['Space'] || keys['ArrowUp'] || keys['KeyW']);

  const nowMs = performance.now();
  if (localPlayer.isGrounded) localPlayer.lastGroundedTime = nowMs;
  // Interpret recent input flags (these were sent already but we use local detection again)
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
  // Variable jump sustain
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

  // Integrate
  localPlayer.x += localPlayer.vx * dt;
  localPlayer.y += localPlayer.vy * dt;

  // Collision (approx mirror of server)
  localPlayer.isGrounded = false;
  for (const plat of platforms) {
    const topSurface = plat.y + plat.h;
    const underside = plat.y;
    const overlapX = (localPlayer.x + PLAYER_RADIUS) > plat.x && (localPlayer.x - PLAYER_RADIUS) < (plat.x + plat.w);
    // Landing
    if (overlapX && localPlayer.vy <= 0 && (localPlayer.y < topSurface) && (localPlayer.y > topSurface - 120)) { // descending within reasonable range
      // approximate previous y to check crossing
      const prevY = localPlayer.y - localPlayer.vy * dt;
      if (prevY >= topSurface && localPlayer.y < topSurface) {
        localPlayer.y = topSurface;
        localPlayer.vy = 0;
        localPlayer.isGrounded = true;
        localPlayer.canVariable = false;
        continue;
      }
    }
    // Ceiling
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
    localPlayer.y = 40; localPlayer.vy = 0; localPlayer.isGrounded = true; localPlayer.canVariable = false;
  }

  // Reset one-shot jump detection flags locally AFTER using them
  justPressedJump = false;
  justReleasedJump = false; // we could use for variable logic; currently only early release uses jumpHeld check
}

// Start game button (leader only)
elem('startGameBtn').onclick = () => {
  if (!gameState.leaderId || gameState.leaderId !== localId) return;
  socket.emit('startGame', { code: elem('roomLabel').textContent.split(': ')[1] }, (res)=>{
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
  wrap.innerHTML = `<h3>Players (${players.length})</h3>` + players.map(p => {
    const badges = [];
    if (p.id === leaderId) badges.push('<span class="leaderBadge">LEADER</span>');
    if (p.id === taggerId) badges.push('<span class="tagBadge">TAGGER</span>');
    if (p.id === localId) badges.push('<span class="selfBadge">YOU</span>');
    return `<div class="playerRow ${p.id===leaderId?'leader':''}"><span style="flex:1;">${p.name}</span>${badges.join(' ')}</div>`;
  }).join('');
}
