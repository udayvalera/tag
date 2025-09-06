// Enhanced pixel-art rendering with stunning indie effects
export class SceneDecorator {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pixelsPerUnit = 1; // For pixel art scaling
    this.timeStart = performance.now();
    this.initBackground();
  // Simplified background: only clouds + birds
  this.initClouds();
  this.initBirds();
  }

  // Utility to validate numeric inputs (avoid NaN / Infinity in canvas API)
  isFiniteNumber(v) { return typeof v === 'number' && isFinite(v); }

  safeCreateRadialGradient(ctx, x0, y0, r0, x1, y1, r1) {
    if (![x0,y0,r0,x1,y1,r1].every(this.isFiniteNumber)) return null;
    if (r0 < 0 || r1 < 0) return null;
    try {
      return ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
    } catch (e) {
      console.warn('safeCreateRadialGradient skipped invalid params', {x0,y0,r0,x1,y1,r1});
      return null;
    }
  }

  initBackground() {
  // Light blue peaceful sky gradient
  const ctx = this.ctx;
  const g = ctx.createLinearGradient(0, 0, 0, this.canvas.height);
  g.addColorStop(0, '#bdeaff');
  g.addColorStop(1, '#e6f9ff');
  this.skyGradient = g;
  }

  createPixelPattern() {
    const patternCanvas = document.createElement('canvas');
    patternCanvas.width = 4;
    patternCanvas.height = 4;
    const pctx = patternCanvas.getContext('2d');
    
    // Create a subtle pixel noise pattern
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 4; y++) {
        const alpha = Math.random() > 0.7 ? 0.02 : 0;
        pctx.fillStyle = `rgba(255,255,255,${alpha})`;
        pctx.fillRect(x, y, 1, 1);
      }
    }
    
    return this.ctx.createPattern(patternCanvas, 'repeat');
  }

  // Parallax removed (kept empty to avoid downstream errors)
  initParallax() { this.parallaxLayers = []; }

  initClouds() { this.clouds = Array.from({ length: 10 }, () => this.spawnCloud()); }

  spawnCloud() {
    return {
      x: Math.random() * this.canvas.width,
      y: 50 + Math.random() * 160,
      speed: 8 + Math.random() * 16,
      scale: 0.5 + Math.random() * 1.0,
      puffSeed: Math.random(),
      tint: 0
    };
  }

  initBirds() {
    this.birds = Array.from({ length: 6 }, () => this.spawnBird());
  }

  spawnBird() {
    return {
      x: Math.random() * this.canvas.width,
      y: 80 + Math.random() * 180,
      speed: 40 + Math.random() * 40,
      flap: Math.random() * Math.PI * 2,
      scale: 0.8 + Math.random() * 0.6,
      dir: Math.random() > 0.5 ? 1 : -1
    };
  }

  initParticles() {
    this.sparkles = [];
    this.floatingLeaves = [];
    this.dustMotes = [];
  }

  initWeather() {
    this.rainIntensity = 0;
    this.rainParticles = [];
    this.lightningTimer = 0;
    this.lightningActive = false;
  }

  update(dt) {
    const t = (performance.now() - this.timeStart) / 1000;
    this.updateClouds(dt);
    this.updateBirds(dt);
    this.bobOffset = Math.sin(t * 2) * 2; // retained for player bobbing
  }

  updateClouds(dt) {
    for (const c of this.clouds) {
      c.x += c.speed * dt;
      if (c.x - 150 * c.scale > this.canvas.width) {
        // recycle
        Object.assign(c, this.spawnCloud(), { x: -200 });
      }
    }
  }

  updateBirds(dt) {
    for (const b of this.birds) {
      b.x += b.speed * dt * b.dir;
      b.flap += dt * 6;
      if (b.x < -50 || b.x > this.canvas.width + 50) {
        Object.assign(b, this.spawnBird(), { x: b.dir === 1 ? -60 : this.canvas.width + 60, dir: b.dir });
      }
    }
  }

  updateSparkles(dt) {
    // Add new sparkles occasionally
    if (Math.random() < 0.02) {
      this.sparkles.push({
        x: Math.random() * this.canvas.width,
        y: Math.random() * this.canvas.height * 0.6,
        vx: (Math.random() - 0.5) * 10,
        vy: (Math.random() - 0.5) * 10,
        life: 1.0,
        maxLife: 3 + Math.random() * 2,
        size: 2 + Math.random() * 3,
        color: `hsl(${Math.random() * 60 + 200}, 70%, 60%)`
      });
    }

    // Update existing sparkles
    for (let i = this.sparkles.length - 1; i >= 0; i--) {
      const sparkle = this.sparkles[i];
      sparkle.x += sparkle.vx * dt;
      sparkle.y += sparkle.vy * dt;
      sparkle.life -= dt;
      
      if (sparkle.life <= 0) {
        this.sparkles.splice(i, 1);
      } else {
        sparkle.vx *= 0.98;
        sparkle.vy *= 0.98;
      }
    }
  }

  updateFloatingLeaves(dt) {
    if (Math.random() < 0.005) {
      this.floatingLeaves.push({
        x: Math.random() * this.canvas.width,
        y: -20,
        vx: (Math.random() - 0.5) * 5,
        vy: 20 + Math.random() * 10,
        rotation: 0,
        rotSpeed: (Math.random() - 0.5) * 2,
        life: 1.0,
        maxLife: 5 + Math.random() * 3,
        color: ['#e17055', '#d63031', '#fdcb6e'][Math.floor(Math.random() * 3)]
      });
    }

    for (let i = this.floatingLeaves.length - 1; i >= 0; i--) {
      const leaf = this.floatingLeaves[i];
      leaf.x += leaf.vx * dt;
      leaf.y += leaf.vy * dt;
      leaf.rotation += leaf.rotSpeed * dt;
      leaf.life -= dt / leaf.maxLife;

      if (leaf.y > this.canvas.height || leaf.life <= 0) {
        this.floatingLeaves.splice(i, 1);
      }
    }
  }

  updateDustMotes(dt) {
    if (Math.random() < 0.01) {
      this.dustMotes.push({
        x: Math.random() * this.canvas.width,
        y: Math.random() * this.canvas.height,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2,
        life: 1.0,
        maxLife: 10 + Math.random() * 5,
        size: 1 + Math.random() * 2
      });
    }

    for (let i = this.dustMotes.length - 1; i >= 0; i--) {
      const mote = this.dustMotes[i];
      mote.x += mote.vx * dt;
      mote.y += mote.vy * dt;
      mote.life -= dt / mote.maxLife;

      if (mote.life <= 0 || mote.x < 0 || mote.x > this.canvas.width || mote.y < 0 || mote.y > this.canvas.height) {
        this.dustMotes.splice(i, 1);
      }
    }
  }

  updateWeather(dt, t) {
    this.lightningTimer += dt;
    
    // Occasional lightning
    if (this.lightningTimer > 10 + Math.random() * 20) {
      this.lightningActive = true;
      this.lightningTimer = 0;
      setTimeout(() => { this.lightningActive = false; }, 100);
    }

    // Dynamic rain based on time of day simulation
    const timeOfDay = (t / 60) % 24;
    this.rainIntensity = Math.max(0, Math.sin((timeOfDay - 18) * 0.1)) * 0.3;
    
    if (this.rainIntensity > 0.1 && Math.random() < this.rainIntensity * 0.1) {
      this.rainParticles.push({
        x: Math.random() * this.canvas.width,
        y: -10,
        length: 10 + Math.random() * 10,
        speed: 200 + Math.random() * 100,
        life: 1.0
      });
    }

    for (let i = this.rainParticles.length - 1; i >= 0; i--) {
      const rain = this.rainParticles[i];
      rain.y += rain.speed * dt;
      rain.life -= dt * rain.speed / this.canvas.height;

      if (rain.life <= 0) {
        this.rainParticles.splice(i, 1);
      }
    }
  }

  drawBackground() {
    const ctx = this.ctx;
    const t = (performance.now() - this.timeStart) / 1000;
  // Static simple sky
  ctx.fillStyle = this.skyGradient || '#cfeeff';
  ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  // Clouds
  this.drawClouds();
  // Birds
  this.drawBirds();
  }

  drawClouds() {
    const ctx = this.ctx;
    ctx.save();
    for (const c of this.clouds) {
      const baseX = c.x;
      const baseY = c.y;
      const puffCount = 5 + Math.floor(c.scale * 4);
      for (let i = 0; i < puffCount; i++) {
        const offX = (i - puffCount / 2) * 30 * c.scale + Math.sin((i + c.puffSeed) * 2) * 8;
        const offY = Math.sin((i + c.puffSeed) * 1.4) * 6 * c.scale;
        const r = 38 * c.scale * (0.7 + Math.random() * 0.3);
        const g = this.safeCreateRadialGradient(ctx, baseX + offX, baseY + offY, r * 0.2, baseX + offX, baseY + offY, r);
        if (g) {
          g.addColorStop(0, `rgba(255,255,255,0.95)`);
          g.addColorStop(1, `rgba(255,255,255,0)`);
          ctx.fillStyle = g;
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.6)';
        }
        ctx.beginPath();
        ctx.arc(baseX + offX, baseY + offY, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  drawParallaxLayers() { /* intentionally empty (removed) */ }

  drawBirds() {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (const b of this.birds) {
      const flap = Math.sin(b.flap) * 4 * b.scale;
      ctx.strokeStyle = 'rgba(70,90,110,0.8)';
      ctx.beginPath();
      const wingSpan = 14 * b.scale;
      ctx.moveTo(b.x - wingSpan * b.dir, b.y);
      ctx.lineTo(b.x, b.y - flap - 2);
      ctx.lineTo(b.x + wingSpan * b.dir, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawCelestialBody(t) {
    const ctx = this.ctx;
    const timeOfDay = (t / 60) % 24;
    const isDay = timeOfDay >= 6 && timeOfDay <= 18;
    
    let cx, cy, radius, color1, color2;
    
    if (isDay) {
      // Sun
      cx = 200 + Math.sin(t * 0.5) * 20;
      cy = 150 + Math.cos(t * 0.3) * 10;
      radius = 40;
      color1 = '#ffd700';
      color2 = '#ffed4e';
    } else {
      // Moon
      cx = 200 + Math.sin(t * 0.3) * 15;
      cy = 150 + Math.cos(t * 0.2) * 8;
      radius = 25;
      color1 = '#f8f9fa';
      color2 = '#e9ecef';
    }
    
    // Celestial body glow
    const glowGradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 2);
    glowGradient.addColorStop(0, color1);
    glowGradient.addColorStop(0.7, color2);
    glowGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    
    ctx.fillStyle = glowGradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 2, 0, Math.PI * 2);
    ctx.fill();
    
    // Main body
    const bodyGradient = ctx.createRadialGradient(cx - 10, cy - 10, 0, cx, cy, radius);
    bodyGradient.addColorStop(0, color1);
    bodyGradient.addColorStop(0.8, color2);
    bodyGradient.addColorStop(1, 'rgba(255, 255, 255, 0.8)');
    
    ctx.fillStyle = bodyGradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    
    // Craters for moon
    if (!isDay) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.beginPath();
      ctx.arc(cx + 8, cy + 5, 6, 0, Math.PI * 2);
      ctx.arc(cx - 12, cy - 3, 4, 0, Math.PI * 2);
      ctx.arc(cx + 5, cy + 12, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawSparkles() {
    const ctx = this.ctx;
    for (const sparkle of this.sparkles) {
      const alpha = sparkle.life / sparkle.maxLife;
      ctx.globalAlpha = alpha * 0.8;
      ctx.fillStyle = sparkle.color;
      
      // Animated sparkle shape
      const pulse = Math.sin(performance.now() * 0.01 + sparkle.x * 0.01) * 0.5 + 0.5;
      const size = sparkle.size * pulse;
      
      ctx.beginPath();
      ctx.arc(sparkle.x, sparkle.y, size, 0, Math.PI * 2);
      ctx.fill();
      
      // Crosshair sparkle effect
      ctx.strokeStyle = sparkle.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sparkle.x - size, sparkle.y);
      ctx.lineTo(sparkle.x + size, sparkle.y);
      ctx.moveTo(sparkle.x, sparkle.y - size);
      ctx.lineTo(sparkle.x, sparkle.y + size);
      ctx.stroke();
      
      ctx.globalAlpha = 1;
    }
  }

  drawFloatingLeaves() {
    const ctx = this.ctx;
    for (const leaf of this.floatingLeaves) {
      const alpha = leaf.life;
      ctx.globalAlpha = alpha * 0.7;
      ctx.fillStyle = leaf.color;
      
      ctx.save();
      ctx.translate(leaf.x, leaf.y);
      ctx.rotate(leaf.rotation);
      
      // Leaf shape
      ctx.beginPath();
      ctx.ellipse(0, 0, 6 * alpha, 3 * alpha, 0, 0, Math.PI * 2);
      ctx.fill();
      
      // Stem
      ctx.strokeStyle = '#8b4513';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, 3 * alpha);
      ctx.lineTo(0, 8 * alpha);
      ctx.stroke();
      
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  drawDustMotes() {
    const ctx = this.ctx;
    for (const mote of this.dustMotes) {
      const alpha = mote.life;
      ctx.globalAlpha = alpha * 0.3;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      
      ctx.beginPath();
      ctx.arc(mote.x, mote.y, mote.size, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.globalAlpha = 1;
    }
  }

  drawRain() {
    if (this.rainIntensity <= 0) return;
    
    const ctx = this.ctx;
    ctx.globalAlpha = this.rainIntensity;
    ctx.strokeStyle = 'rgba(173, 216, 230, 0.8)';
    ctx.lineWidth = 1;
    
    for (const rain of this.rainParticles) {
      const alpha = rain.life;
      ctx.globalAlpha = this.rainIntensity * alpha;
      
      ctx.beginPath();
      ctx.moveTo(rain.x, rain.y);
      ctx.lineTo(rain.x - 2, rain.y + rain.length);
      ctx.stroke();
    }
    
    ctx.globalAlpha = 1;
  }

  drawVignette() {
    const ctx = this.ctx;
    const gradient = ctx.createRadialGradient(
      this.canvas.width / 2, this.canvas.height / 2, 0,
      this.canvas.width / 2, this.canvas.height / 2, Math.max(this.canvas.width, this.canvas.height) / 2
    );
    
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(0.7, 'rgba(0,0,0,0)');
    gradient.addColorStop(1, 'rgba(0,0,0,0.4)');
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  drawPlatforms(platforms) {
    const ctx = this.ctx;
    
    for (const plat of platforms) {
      const topY = this.canvas.height - (plat.y + plat.h);
      
      // Platform shadow
      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.fillRect(plat.x + 2, topY + 2, plat.w, plat.h);
      
      // Main platform body - pixelated stone/brick texture
      const stoneGradient = ctx.createLinearGradient(0, topY, 0, topY + plat.h);
      stoneGradient.addColorStop(0, '#95a5a6');
      stoneGradient.addColorStop(0.5, '#bdc3c7');
      stoneGradient.addColorStop(1, '#7f8c8d');
      
      ctx.fillStyle = stoneGradient;
      
      // Draw brick pattern
      const brickWidth = 32;
      const brickHeight = 16;
      const mortarColor = '#34495e';
      
      for (let y = 0; y < plat.h; y += brickHeight) {
        for (let x = 0; x < plat.w; x += brickWidth) {
          // Mortar lines
          ctx.fillStyle = mortarColor;
          ctx.fillRect(plat.x + x, topY + y, 2, brickHeight);
          ctx.fillRect(plat.x + x, topY + y, brickWidth, 2);
          
          // Offset every other row
          if ((y / brickHeight) % 2 === 1) {
            ctx.fillRect(plat.x + x + brickWidth / 2, topY + y, 2, brickHeight);
          }
          
          // Brick
          ctx.fillStyle = stoneGradient;
          ctx.fillRect(plat.x + x + 2, topY + y + 2, brickWidth - 4, brickHeight - 4);
          
          // Brick texture details
          ctx.strokeStyle = 'rgba(0,0,0,0.1)';
          ctx.lineWidth = 1;
          for (let i = 0; i < 3; i++) {
            const lineX = plat.x + x + 8 + (i * 8);
            ctx.beginPath();
            ctx.moveTo(lineX, topY + y + 4);
            ctx.lineTo(lineX, topY + y + brickHeight - 4);
            ctx.stroke();
          }
        }
      }
      
      // Platform edge highlights
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(plat.x, topY - 3, plat.w, 3);
      
      // Grass/decorative top edge
      ctx.fillStyle = '#27ae60';
      ctx.fillRect(plat.x, topY - 8, plat.w, 5);
      
      // Grass blades
      ctx.strokeStyle = '#2ecc71';
      ctx.lineWidth = 2;
      for (let x = plat.x; x < plat.x + plat.w; x += 12) {
        const bladeHeight = 8 + Math.random() * 4;
        ctx.beginPath();
        ctx.moveTo(x + Math.random() * 6, topY - 3);
        ctx.lineTo(x + Math.random() * 6 + 2, topY - 3 - bladeHeight);
        ctx.stroke();
      }
      
      // Platform name/debug info (remove in production)
      ctx.fillStyle = '#fff';
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(plat.x)},${Math.round(plat.y)}`, plat.x + plat.w / 2, topY - 15);
    }
  }

  drawPlayer(p, camera, isLocal, tagger) {
    const ctx = this.ctx;
    const baseX = p.x - camera.x;
    const baseY = this.canvas.height - p.y;
    
    ctx.save();
    ctx.translate(baseX, baseY);
    if (p.dir < 0) ctx.scale(-1, 1);
    
    const t = (performance.now() - this.timeStart) / 1000;
    const runSpeed = Math.abs(p.vx || 0);
    const bob = runSpeed > 10 ? Math.sin(t * 12) * 3 : this.bobOffset;
    
    ctx.translate(0, bob);
    
    // Enhanced shadow with glow
    const shadowGradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 20);
    shadowGradient.addColorStop(0, 'rgba(0, 0, 0, 0.4)');
    shadowGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    
    ctx.fillStyle = shadowGradient;
    ctx.beginPath();
    ctx.ellipse(0, 8, 18, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    
    // Player body - pixel art style
    const bodyColor = '#2c3e50';
    const outlineColor = '#fff';
    const highlightColor = '#ecf0f1';
    
    // Main body (pixelated rounded rectangle)
    ctx.fillStyle = bodyColor;
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = 2;
    
    // Body shape
    ctx.beginPath();
    ctx.roundRect(-16, -50, 32, 50, 8);
    ctx.fill();
    ctx.stroke();
    
    // Head (separate for better animation)
    ctx.fillStyle = '#f8f9fa';
    ctx.beginPath();
    ctx.arc(0, -58, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    
    // Player color accent (headband/scarf)
    if (p.color) {
      const accentGradient = ctx.createLinearGradient(-10, -62, 10, -62);
      accentGradient.addColorStop(0, p.color);
      accentGradient.addColorStop(1, this.adjustBrightness(p.color, 20));
      
      ctx.fillStyle = accentGradient;
      ctx.beginPath();
      ctx.roundRect(-18, -64, 36, 8, 4);
      ctx.fill();
      ctx.strokeStyle = outlineColor;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    
    // Eyes - large expressive pixel eyes
    const eyeOffset = runSpeed > 10 ? Math.sin(t * 10) * 2 : 0;
    
    // Eye whites
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(-6 + eyeOffset, -60, 6, 0, Math.PI * 2);
    ctx.arc(6 - eyeOffset, -60, 6, 0, Math.PI * 2);
    ctx.fill();
    
    // Pupils
    const pupilX = eyeOffset * 0.5;
    ctx.fillStyle = '#2c3e50';
    ctx.beginPath();
    ctx.arc(-6 + pupilX, -60, 3, 0, Math.PI * 2);
    ctx.arc(6 + pupilX, -60, 3, 0, Math.PI * 2);
    ctx.fill();
    
    // Eye shine
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(-5 + pupilX, -61, 1, 0, Math.PI * 2);
    ctx.arc(7 + pupilX, -61, 1, 0, Math.PI * 2);
    ctx.fill();
    
    // Mouth - expressive based on state
    ctx.strokeStyle = tagger ? '#e74c3c' : '#7f8c8d';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    
    if (tagger) {
      // Panicked expression for tagger
      ctx.beginPath();
      ctx.arc(0, -48, 5, 0, Math.PI);
      ctx.stroke();
    } else {
      // Calm smile
      ctx.beginPath();
      ctx.arc(0, -48, 4, 0, Math.PI);
      ctx.stroke();
    }
    
    // Arms - enhanced animation
    const armSwing = runSpeed > 10 ? Math.sin(t * 14) * 12 : 0;
    const armColor = p.color || '#3498db';
    
    // Left arm
    ctx.strokeStyle = bodyColor;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(-16, -40);
    ctx.lineTo(-24, -40 - armSwing * 0.3);
    ctx.lineTo(-20, -20 - armSwing * 0.2);
    ctx.stroke();
    
    // Right arm
    ctx.beginPath();
    ctx.moveTo(16, -40);
    ctx.lineTo(24, -40 + armSwing * 0.3);
    ctx.lineTo(20, -20 + armSwing * 0.2);
    ctx.stroke();
    
    // Arm cuffs (player color)
    ctx.fillStyle = armColor;
    ctx.beginPath();
    ctx.arc(-20, -38, 4, 0, Math.PI * 2);
    ctx.arc(20, -38, 4, 0, Math.PI * 2);
    ctx.fill();
    
    // Legs - enhanced running animation
    const legPhase = t * (runSpeed > 10 ? 16 : 4);
    const legSwing = runSpeed > 10 ? Math.sin(legPhase) * 12 : 0;
    
    ctx.strokeStyle = bodyColor;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    
    // Left leg
    ctx.beginPath();
    ctx.moveTo(-8, -8);
    ctx.lineTo(-8, -8 + legSwing);
    ctx.lineTo(-4, 8 + legSwing * 0.5);
    ctx.stroke();
    
    // Right leg
    ctx.beginPath();
    ctx.moveTo(8, -8);
    ctx.lineTo(8, -8 - legSwing);
    ctx.lineTo(4, 8 - legSwing * 0.5);
    ctx.stroke();
    
    // Feet
    ctx.fillStyle = '#8b4513';
    ctx.beginPath();
    ctx.ellipse(-4, 12 + legSwing * 0.5, 6, 3, 0, 0, Math.PI * 2);
    ctx.ellipse(4, 12 - legSwing * 0.5, 6, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    
    // Tagger indicator - enhanced arrow with glow
    if (tagger) {
      // Glow effect
      ctx.shadowColor = '#e74c3c';
      ctx.shadowBlur = 15;
      
      // Main arrow
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(-20, -80);
      ctx.lineTo(20, -80);
      ctx.lineTo(0, -60);
      ctx.closePath();
      ctx.fill();
      
      // Arrow tip glow
      ctx.fillStyle = 'rgba(231, 76, 60, 0.6)';
      ctx.beginPath();
      ctx.moveTo(-25, -85);
      ctx.lineTo(25, -85);
      ctx.lineTo(0, -55);
      ctx.closePath();
      ctx.fill();
      
      // "IT" badge with glow
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#e74c3c';
      ctx.font = 'bold 12px "Press Start 2P"';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('IT', 0, -70);
      
      // Outline for badge
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeText('IT', 0, -70);
      
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }
    
    // Local player enhancement
    if (isLocal) {
      // Local player outline glow
      ctx.strokeStyle = this.adjustBrightness(p.color || '#3498db', 30);
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    
    ctx.restore();
    
    // Name tag with pixelated styling
    ctx.save();
    if (p.color) {
      const nameGradient = ctx.createLinearGradient(0, baseY - 85, 0, baseY - 65);
      nameGradient.addColorStop(0, p.color);
      nameGradient.addColorStop(1, this.adjustBrightness(p.color, -20));
      
      ctx.fillStyle = nameGradient;
    } else {
      ctx.fillStyle = '#2c3e50';
    }
    
    ctx.font = '10px "Press Start 2P"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeText(p.name, baseX, baseY - 85);
    ctx.fillText(p.name, baseX, baseY - 85);
    
    ctx.restore();
  }

  adjustBrightness(color, amount) {
    // Simple brightness adjustment for colors
    const num = parseInt(color.replace("#", ""), 16);
    const amt = Math.round(2.55 * amount);
    const R = (num >> 16) + amt;
    const G = (num >> 8 & 0x00FF) + amt;
    const B = (num & 0x0000FF) + amt;
    return "#" + (0x1000000 + (R < 255 ? R < 1 ? 0 : R : 255) * 0x10000 +
      (G < 255 ? G < 1 ? 0 : G : 255) * 0x100 +
      (B < 255 ? B < 1 ? 0 : B : 255)).toString(16).slice(1);
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