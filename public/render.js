// Rendering module for stylized visuals (background, platforms, animated players)

export class SceneDecorator {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.initSky();
    this.initClouds();
    this.initBirds();
    this.timeStart = performance.now();
  }
  initSky() {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0,0,0,this.canvas.height);
    g.addColorStop(0,'#85cffe');
    g.addColorStop(.6,'#b7e7ff');
    g.addColorStop(1,'#ffffff');
    this.skyGradient = g;
  }
  initClouds() {
    this.clouds = Array.from({length:8}, (_,i)=>({
      x: Math.random()*this.canvas.width,
      y: 80+ Math.random()*220,
      scale: .6 + Math.random()*0.9,
      speed: 10 + Math.random()*15 + i*0.5,
      seed: Math.random()*1000
    }));
  }
  initBirds() {
    this.birds = Array.from({length:5}, ()=>({
      x: Math.random()*this.canvas.width,
      y: 380 + Math.random()*180,
      speed: 35 + Math.random()*30,
      phase: Math.random()*Math.PI*2
    }));
  }
  update(dt) {
    const W = this.canvas.width;
    for (const c of this.clouds) {
      c.x += c.speed * dt * 0.2;
      if (c.x - 150*c.scale > W) c.x = -150*c.scale;
    }
    for (const b of this.birds) {
      b.x += b.speed * dt * 0.5;
      b.phase += dt * 3;
      if (b.x > W+60) b.x = -60;
    }
  }
  drawBackground() {
    const ctx = this.ctx;
    ctx.fillStyle = this.skyGradient;
    ctx.fillRect(0,0,this.canvas.width,this.canvas.height);
    // Sun
    const sunX = 140, sunY = this.canvas.height-120;
    const rad = 80;
    const g = ctx.createRadialGradient(sunX, sunY, 10, sunX, sunY, rad);
    g.addColorStop(0,'#fff9c4');
    g.addColorStop(1,'rgba(255,249,196,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(sunX, sunY, rad, 0, Math.PI*2); ctx.fill();
    // Clouds
    for (const c of this.clouds) this.drawCloud(c);
    // Birds
    for (const b of this.birds) this.drawBird(b);
  }
  drawCloud(c) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(c.x, this.canvas.height - c.y);
    ctx.scale(c.scale, c.scale);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(0,0,40,0,Math.PI*2);
    ctx.arc(35,-10,30,0,Math.PI*2);
    ctx.arc(-35,-8,32,0,Math.PI*2);
    ctx.arc(10,-22,28,0,Math.PI*2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  drawBird(b) {
    const ctx = this.ctx;
    const flap = Math.sin(b.phase)*6;
    const y = this.canvas.height - (b.y + flap);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(b.x - 8, y);
    ctx.quadraticCurveTo(b.x, y-6, b.x+8, y);
    ctx.stroke();
  }
  drawPlatforms(platforms) {
    const ctx = this.ctx;
    for (const p of platforms) {
      const topY = this.canvas.height - (p.y + p.h);
      // Dirt body
      const grd = ctx.createLinearGradient(0, topY, 0, topY + p.h);
      grd.addColorStop(0,'#5e3c15');
      grd.addColorStop(1,'#3d270d');
      ctx.fillStyle = grd;
      ctx.fillRect(p.x, topY, p.w, p.h);
      // Grass top
      ctx.fillStyle = '#4caf50';
      ctx.fillRect(p.x, topY - 10, p.w, 12);
      // Grass blades pattern
      ctx.strokeStyle = '#66d168';
      ctx.lineWidth = 2;
      for (let x = p.x; x < p.x + p.w; x += 8) {
        ctx.beginPath();
        ctx.moveTo(x+2, topY - 8);
        ctx.lineTo(x+5, topY - 12 - Math.random()*4);
        ctx.stroke();
      }
    }
  }
  drawPlayer(p, camera, isLocal, tagger) {
    // p: {x,y,isTagger,name,dir,vx,vy}
    const ctx = this.ctx;
    const baseX = p.x - camera.x;
    const baseY = this.canvas.height - p.y;
    const scale = 1;
    ctx.save();
    ctx.translate(baseX, baseY);
    if (p.dir < 0) ctx.scale(-1,1);
    const runSpeed = Math.abs(p.vx||0);
    const t = (performance.now()-this.timeStart)/1000;
    // New character style: unified rounded body (includes head), colored headband (player color), large eyes, simple mouth.
    const outline = '#222';
    const bodyColor = '#0d2c36'; // constant dark teal body
    const headbandColor = p.color || '#e74c3c';
    // Bobbing for run animation
    const bob = runSpeed>10 ? Math.sin(t*12)*2 : 0;
    ctx.translate(0,bob);
    // Shadow
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(0, -18, 16, 6, 0, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;
    // Body (taller to include head region)
    ctx.fillStyle = bodyColor; ctx.strokeStyle = outline; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(-18,-70,36,60,10); ctx.fill(); ctx.stroke();
    // Headband
    ctx.fillStyle = headbandColor;
    ctx.beginPath(); ctx.roundRect(-20,-66,40,14,6); ctx.fill();
    // Eyes (white sclera + pupils)
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(-8,-50,8,0,Math.PI*2); ctx.arc(8,-50,8,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(-6,-50,4,0,Math.PI*2); ctx.arc(10,-50,4,0,Math.PI*2); ctx.fill();
    // Mouth (small white smile)
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0,-34,8,0,Math.PI); ctx.stroke();
    // Arms (simple swing lines at sides)
    const armSwing = runSpeed>10 ? Math.sin(t*14)*10 : 0;
    ctx.strokeStyle = outline; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(-18,-46); ctx.lineTo(-26, -46 - armSwing*0.25); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(18,-46); ctx.lineTo(26, -46 + armSwing*0.25); ctx.stroke();
    // Legs (extend from base)
    const legPhase = t * (runSpeed>10?16:0);
    const legSwing = runSpeed>10 ? Math.sin(legPhase)*10 : 0;
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(-8,-10); ctx.lineTo(-8, -30 + legSwing); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(8,-10); ctx.lineTo(8, -30 - legSwing); ctx.stroke();
    // Tag indicator
    if (tagger) {
      // Arrow above head (now pointing downward toward player)
      ctx.save();
      ctx.translate(0,-90); // a bit higher
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 4;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      // Base (top wide) -> tip (bottom narrow near player)
      ctx.moveTo(-18,-16);
      ctx.lineTo(18,-16);
      ctx.lineTo(0,10); // downward tip
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
      // Existing text badge for clarity
      ctx.fillStyle = '#ffeb3b';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('IT',0,-78);
    }
    ctx.restore();
    // Name tag outside transform
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, baseX, baseY - 80);
    ctx.restore();
  }
}

export function ensureCtxRoundRectSupport() {
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x,y,w,h,r){
      if (!Array.isArray(r)) r=[r,r,r,r];
      this.beginPath();
      this.moveTo(x+r[0],y);
      this.lineTo(x+w-r[1],y);
      this.quadraticCurveTo(x+w,y,x+w,y+r[1]);
      this.lineTo(x+w,y+h-r[2]);
      this.quadraticCurveTo(x+w,y+h,x+w-r[2],y+h);
      this.lineTo(x+r[3],y+h);
      this.quadraticCurveTo(x,y+h,x,y+h-r[3]);
      this.lineTo(x,y+r[0]);
      this.quadraticCurveTo(x,y,x+r[0],y);
      return this;
    };
  }
}
