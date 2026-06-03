import { DEFAULT_HEADBAND, HEADBAND_PALETTE, RUNNER_SPRITE, getHeadbandById } from './game-config.js';

const ATLAS = {
  platformTile: { x: 99, y: 71, w: 160, h: 85 },
  tree: { x: 390, y: 540, w: 293, h: 335 },
  bush: { x: 79, y: 675, w: 286, h: 181 },
  flowerPink: { x: 772, y: 718, w: 101, h: 150 },
  flowerYellow: { x: 966, y: 718, w: 98, h: 150 },
  pillar: { x: 1162, y: 659, w: 104, h: 210 },
  crate: { x: 1385, y: 732, w: 139, h: 143 }
};

const DECORATIONS = [
  { sprite: 'tree', x: 130, baseY: 40, w: 86, h: 104, layer: 'behind' },
  { sprite: 'bush', x: 285, baseY: 40, w: 80, h: 48, layer: 'behind' },
  { sprite: 'flowerPink', x: 1180, baseY: 40, w: 22, h: 33, layer: 'front' },
  { sprite: 'flowerYellow', x: 1500, baseY: 40, w: 24, h: 34, layer: 'front' },
  { sprite: 'tree', x: 300, baseY: 210, w: 72, h: 88, layer: 'behind' },
  { sprite: 'pillar', x: 560, baseY: 250, w: 28, h: 56, layer: 'behind' },
  { sprite: 'flowerYellow', x: 720, baseY: 250, w: 22, h: 32, layer: 'front' },
  { sprite: 'flowerPink', x: 225, baseY: 384, w: 22, h: 32, layer: 'front' },
  { sprite: 'tree', x: 965, baseY: 210, w: 70, h: 86, layer: 'behind' },
  { sprite: 'bush', x: 1065, baseY: 430, w: 58, h: 36, layer: 'behind' },
  { sprite: 'tree', x: 1415, baseY: 384, w: 70, h: 86, layer: 'behind' },
  { sprite: 'crate', x: 1460, baseY: 384, w: 32, h: 32, layer: 'front' },
  { sprite: 'crate', x: 1495, baseY: 384, w: 32, h: 32, layer: 'front' },
  { sprite: 'flowerPink', x: 560, baseY: 424, w: 21, h: 31, layer: 'front' },
  { sprite: 'flowerYellow', x: 1050, baseY: 424, w: 22, h: 32, layer: 'front' },
  { sprite: 'bush', x: 985, baseY: 604, w: 54, h: 34, layer: 'behind' },
  { sprite: 'tree', x: 835, baseY: 604, w: 68, h: 84, layer: 'behind' }
];

export class SceneDecorator {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.timeStart = performance.now();

    this.playerSprites = new Map();
    this.playerSpriteFrameWidth = RUNNER_SPRITE.frameWidth;
    this.playerSpriteFrameHeight = RUNNER_SPRITE.frameHeight;
    this.playerSpriteScale = RUNNER_SPRITE.scale;
    this.loadPlayerSprites();

    this.smokeSprite = new Image();
    this.smokeSpriteLoaded = false;
    this.smokeSprite.onload = () => {
      this.smokeSpriteLoaded = true;
    };
    this.smokeSprite.src = new URL('./assets/plumber-smoke-sprite.png', import.meta.url).href;
    this.smokeSpriteFrameWidth = 32;
    this.smokeSpriteFrameHeight = 32;
    this.smokeSpriteFrameCount = 8;

    this.backgroundImage = new Image();
    this.backgroundImageLoaded = false;
    this.backgroundImage.onload = () => {
      this.backgroundImageLoaded = true;
      this.backgroundCacheKey = '';
    };
    this.backgroundImage.src = new URL('./assets/sunny-arcade-background.png', import.meta.url).href;

    this.mapAtlas = new Image();
    this.mapAtlasLoaded = false;
    this.mapAtlas.onload = () => {
      this.mapAtlasLoaded = true;
      this.platformCacheKey = '';
    };
    this.mapAtlas.src = new URL('./assets/sunny-arcade-map-atlas.png', import.meta.url).href;

    this.backgroundCanvas = document.createElement('canvas');
    this.platformCanvas = document.createElement('canvas');
    this.backgroundCacheKey = '';
    this.platformCacheKey = '';
  }

  loadPlayerSprites() {
    for (const headband of HEADBAND_PALETTE) {
      const entry = {
        headband,
        image: new Image(),
        loaded: false,
      };
      entry.image.onload = () => {
        entry.loaded = true;
      };
      entry.image.src = new URL(`./assets/runner/${headband.asset}`, import.meta.url).href;
      this.playerSprites.set(headband.id, entry);
    }
  }

  getPlayerSpriteEntry(headbandId) {
    const headband = getHeadbandById(headbandId);
    return this.playerSprites.get(headband.id) || this.playerSprites.get(DEFAULT_HEADBAND.id);
  }

  getPlayerDrawWidth() {
    return this.playerSpriteFrameWidth * this.playerSpriteScale;
  }

  getPlayerDrawHeight() {
    return this.playerSpriteFrameHeight * this.playerSpriteScale;
  }

  update() {}

  drawBackground() {
    this.ensureBackgroundCache();
    this.ctx.drawImage(this.backgroundCanvas, 0, 0);
  }

  ensureBackgroundCache() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const key = `${w}x${h}`;
    if (this.backgroundCacheKey === key) return;

    const canvas = this.backgroundCanvas;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    if (this.backgroundImageLoaded && this.backgroundImage.naturalWidth > 0) {
      const previousSmoothing = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      this.drawCoverImage(ctx, this.backgroundImage, 0, 0, w, h);
      ctx.imageSmoothingEnabled = previousSmoothing;
    } else {
      this.drawFallbackBackground(ctx, w, h);
    }

    this.backgroundCacheKey = key;
  }

  drawCoverImage(ctx, image, x, y, w, h) {
    const iw = image.naturalWidth || image.width;
    const ih = image.naturalHeight || image.height;
    const scale = Math.max(w / iw, h / ih);
    const sw = Math.round(w / scale);
    const sh = Math.round(h / scale);
    const sx = Math.max(0, Math.floor((iw - sw) / 2));
    const sy = Math.max(0, Math.floor((ih - sh) / 2));
    ctx.drawImage(image, sx, sy, sw, sh, x, y, w, h);
  }

  drawFallbackBackground(ctx, w, h) {
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, '#3b96f1');
    bgGrad.addColorStop(1, '#5bd7e6');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(67, 141, 222, 0.28)';
    for (let x = -80; x < w; x += 260) {
      ctx.fillRect(x, h - 180, 58, 180);
      ctx.fillRect(x + 70, h - 130, 170, 24);
      for (let pillar = 0; pillar < 5; pillar++) {
        ctx.fillRect(x + 90 + pillar * 26, h - 130, 10, 120);
      }
    }

    ctx.fillStyle = 'rgba(106, 221, 122, 0.35)';
    for (let x = 30; x < w; x += 230) {
      ctx.beginPath();
      ctx.arc(x, h - 14, 42, Math.PI, 0);
      ctx.fill();
    }
  }

  drawPlatforms(platforms) {
    if (!Array.isArray(platforms) || !platforms.length) return;
    this.ensurePlatformCache(platforms);
    this.ctx.drawImage(this.platformCanvas, 0, 0);
  }

  ensurePlatformCache(platforms) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const key = `${w}x${h}|${platforms.map(p => `${p.x},${p.y},${p.w},${p.h}`).join(';')}`;
    if (this.platformCacheKey === key) return;

    const canvas = this.platformCanvas;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const previousSmoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;

    this.drawDecorations(ctx, 'behind');

    for (const plat of platforms) {
      this.drawArcadePlatform(ctx, plat, h);
    }

    this.drawDecorations(ctx, 'front');
    ctx.imageSmoothingEnabled = previousSmoothing;

    this.platformCacheKey = key;
  }

  drawArcadePlatform(ctx, plat, canvasHeight) {
    const topY = Math.round(canvasHeight - (plat.y + plat.h));
    const visualHeight = Math.max(28, Math.min(44, plat.h + 8));

    if (this.mapAtlasLoaded && this.mapAtlas.naturalWidth > 0) {
      this.drawTiledAtlasRegion(ctx, ATLAS.platformTile, plat.x, topY, plat.w, visualHeight);
      return;
    }

    this.drawFallbackPlatform(ctx, plat.x, topY, plat.w, visualHeight);
  }

  drawTiledAtlasRegion(ctx, region, x, y, w, h) {
    const scale = h / region.h;
    const destTileWidth = Math.max(24, Math.round(region.w * scale));

    for (let offset = 0; offset < w; offset += destTileWidth) {
      const dw = Math.min(destTileWidth, w - offset);
      const sw = Math.max(1, Math.round(dw / scale));
      ctx.drawImage(
        this.mapAtlas,
        region.x,
        region.y,
        sw,
        region.h,
        Math.round(x + offset),
        y,
        dw,
        h
      );
    }
  }

  drawFallbackPlatform(ctx, x, y, w, h) {
    ctx.fillStyle = '#1fd95d';
    ctx.fillRect(x, y, w, Math.max(8, Math.round(h * 0.32)));
    ctx.fillStyle = '#ff2f86';
    ctx.fillRect(x, y + Math.round(h * 0.32), w, h - Math.round(h * 0.32));
    ctx.fillStyle = '#0eba4c';
    for (let px = x + 8; px < x + w; px += 22) {
      ctx.fillRect(px, y + Math.round(h * 0.26), 10, 4);
    }
    ctx.fillStyle = '#ff70ad';
    ctx.fillRect(x, y + Math.round(h * 0.42), w, 3);
  }

  drawDecorations(ctx, layer) {
    if (!this.mapAtlasLoaded || this.mapAtlas.naturalWidth <= 0) return;

    for (const item of DECORATIONS) {
      if (item.layer !== layer) continue;
      this.drawAtlasSprite(ctx, ATLAS[item.sprite], item.x, item.baseY, item.w, item.h);
    }
  }

  drawAtlasSprite(ctx, region, x, baseY, w, h) {
    const y = Math.round(this.canvas.height - baseY - h + 2);
    ctx.drawImage(
      this.mapAtlas,
      region.x,
      region.y,
      region.w,
      region.h,
      Math.round(x - w / 2),
      y,
      w,
      h
    );
  }

  drawSmokePuff(puff, camera = { x: 0, y: 0 }) {
    if (!this.smokeSpriteLoaded || this.smokeSprite.naturalWidth <= 0) return;

    const ctx = this.ctx;
    const sw = this.smokeSpriteFrameWidth;
    const sh = this.smokeSpriteFrameHeight;
    const frame = Math.max(0, Math.min(this.smokeSpriteFrameCount - 1, puff.frame | 0));
    const scale = puff.scale ?? 1.35;
    const dw = Math.round(sw * scale);
    const dh = Math.round(sh * scale);
    const baseX = Math.round((puff.x ?? 0) - (camera.x ?? 0));
    const baseY = Math.round(this.canvas.height - (puff.y ?? 0));
    const alpha = Math.max(0, Math.min(1, puff.alpha ?? 1));

    ctx.save();
    ctx.translate(baseX, baseY);
    if ((puff.dir ?? 1) < 0) ctx.scale(-1, 1);
    ctx.globalAlpha = alpha;

    const previousSmoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.smokeSprite,
      frame * sw,
      0,
      sw,
      sh,
      -dw / 2,
      -dh,
      dw,
      dh
    );
    ctx.imageSmoothingEnabled = previousSmoothing;

    ctx.restore();
  }

  drawPlayer(p, camera, isLocal, tagger) {
    const ctx = this.ctx;
    const baseX = p.x - camera.x;
    const baseY = this.canvas.height - p.y;
    const t = (performance.now() - this.timeStart) / 1000;
    const runSpeed = Math.abs(p.vx ?? 0);
    const grounded = p.grounded ?? p.isGrounded ?? Math.abs(p.vy ?? 0) < 40;
    const bob = grounded
      ? (runSpeed > 10 ? Math.sin(t * 15) * 2 : Math.sin(t * 3) * 1)
      : 0;

    const headband = getHeadbandById(p.headbandId);
    const mainColor = p.color || headband.color || DEFAULT_HEADBAND.color;
    let glowColor = mainColor;
    if (tagger) {
      glowColor = '#ff0055';
    } else if (isLocal) {
      glowColor = '#00ff00';
    }

    ctx.save();
    ctx.translate(baseX, baseY + bob);
    if (p.dir < 0) ctx.scale(-1, 1);

    const spriteEntry = this.getPlayerSpriteEntry(p.headbandId);
    if (spriteEntry?.loaded && spriteEntry.image.naturalWidth > 0) {
      this.drawSpritePlayer(p, t, grounded, runSpeed, isLocal, tagger, glowColor, spriteEntry);
    } else {
      this.drawFallbackPlayer(mainColor);
    }

    ctx.restore();

    ctx.save();
    ctx.translate(baseX, baseY + bob);
    const drawHeight = this.getPlayerDrawHeight();
    if (tagger) {
      ctx.fillStyle = '#ff0055';
      ctx.font = '10px "Press Start 2P"';
      ctx.textAlign = 'center';
      ctx.fillText('IT', 0, -drawHeight - 10 - Math.abs(Math.sin(t * 10) * 5));
    }

    ctx.fillStyle = '#fff';
    ctx.font = '8px "Press Start 2P"';
    ctx.textAlign = 'center';
    ctx.fillText(p.name || '', 0, -drawHeight - 24);
    ctx.restore();
  }

  getPlayerSpriteFrame(p, t, grounded, runSpeed) {
    const vy = p.vy ?? 0;
    if (!grounded && vy > 40) return 4;
    if (!grounded && vy < -40) return 5;
    if (!grounded) return vy >= 0 ? 4 : 5;
    if (runSpeed > 20) return 1 + (Math.floor(t * 12) % 3);
    return 0;
  }

  drawSpritePlayer(p, t, grounded, runSpeed, isLocal, tagger, glowColor, spriteEntry) {
    const ctx = this.ctx;
    const frame = this.getPlayerSpriteFrame(p, t, grounded, runSpeed);
    const sw = this.playerSpriteFrameWidth;
    const sh = this.playerSpriteFrameHeight;
    const scale = this.playerSpriteScale;
    const dw = sw * scale;
    const dh = sh * scale;

    if (tagger || isLocal) {
      ctx.strokeStyle = tagger ? '#ff0055' : glowColor;
      ctx.lineWidth = tagger ? 3 : 2;
      ctx.globalAlpha = tagger ? 0.9 : 0.55;
      ctx.beginPath();
      ctx.ellipse(0, -dh / 2, dw * 0.68, dh * 0.62, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const previousSmoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      spriteEntry.image,
      frame * sw,
      0,
      sw,
      sh,
      -dw / 2,
      -dh,
      dw,
      dh
    );
    ctx.imageSmoothingEnabled = previousSmoothing;
  }

  drawFallbackPlayer(mainColor) {
    const ctx = this.ctx;

    ctx.fillStyle = '#062f3a';

    ctx.beginPath();
    ctx.roundRect(-14, -31, 28, 29, 6);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(-12, -30);
    ctx.lineTo(-12, -39);
    ctx.lineTo(-4, -30);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(3, -30);
    ctx.lineTo(11, -39);
    ctx.lineTo(13, -30);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = mainColor;
    ctx.beginPath();
    ctx.roundRect(-17, -28, 34, 8, 4);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-15, -25);
    ctx.lineTo(-22, -20);
    ctx.lineTo(-18, -15);
    ctx.lineTo(-13, -20);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(-5, -18, 6, 7, 0, 0, Math.PI * 2);
    ctx.ellipse(7, -18, 6, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#050708';
    ctx.beginPath();
    ctx.arc(-3, -19, 1.8, 0, Math.PI * 2);
    ctx.arc(9, -19, 1.8, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.roundRect(-3, -10, 7, 4, 2);
    ctx.fill();
  }
}

export function ensureCtxRoundRectSupport() {
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
      if (w < 2 * r) r = w / 2;
      if (h < 2 * r) r = h / 2;
      this.beginPath();
      this.moveTo(x + r, y);
      this.arcTo(x + w, y, x + w, y + h, r);
      this.arcTo(x + w, y + h, x, y + h, r);
      this.arcTo(x, y + h, x, y, r);
      this.arcTo(x, y, x + w, y, r);
      this.closePath();
      return this;
    };
  }
}
