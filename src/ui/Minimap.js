import { SEA_LEVEL, classify } from '../world/Biome.js';

/**
 * Minimap — a Canvas2D map in the corner.
 *
 * The island never changes during a match, so its colours are rasterised once
 * into an offscreen canvas at boot and every frame is a single drawImage of a
 * cropped, rotated region plus a few vector overlays. Re-sampling the height
 * field per frame would cost more than the entire rest of the HUD.
 *
 * It redraws at 12Hz rather than every frame: a minimap that updates at 60Hz
 * looks identical and costs five times as much on a phone.
 */

const REDRAW_HZ = 12;
const BIOME_COL = [
  [40, 70, 90], [205, 186, 132], [92, 133, 61], [61, 102, 51],
  [118, 112, 107], [235, 240, 247], [112, 87, 56],
];

export class Minimap {
  constructor(opts = {}) {
    this.order = 93;
    this.size = opts.size || 168;         // backing resolution in device pixels
    this.rangeMetres = opts.range || 240; // world span shown across the map
    this._acc = 0;
    this.visible = true;
  }

  init(services) {
    this.terrain = services.get('terrain');
    this.player = services.get('player');
    this.storm = services.get('storm');
    this.structures = services.get('structures');
    this.bots = services.get('bots');
    this.loot = services.peek('loot');
    this.settings = services.get('settings');

    const root = document.getElementById('ui-root');
    this.wrap = document.createElement('div');
    this.wrap.className = 'hud-minimap';
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.size;
    this.canvas.height = this.size;
    this.ctx = this.canvas.getContext('2d');
    this.wrap.appendChild(this.canvas);
    this.label = document.createElement('div');
    this.label.className = 'hud-minimap-label';
    this.wrap.appendChild(this.label);
    root.appendChild(this.wrap);

    this._bakeIsland();
    services.set('minimap', this);
  }

  /** Rasterise the whole island once; per-frame work is then a crop and blit. */
  _bakeIsland() {
    const f = this.terrain.field;
    const N = 256;
    const c = document.createElement('canvas');
    c.width = N; c.height = N;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(N, N);
    const world = this.terrain.size;

    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const wx = (x / N - 0.5) * world;
        const wz = (y / N - 0.5) * world;
        const h = f.heightAt(wx, wz);
        const slope = f.slopeAt(wx, wz);
        const b = classify(h, f.moistureAt(wx, wz), slope);
        // A cheap hillshade makes terrain legible at map scale, where flat
        // biome colour alone reads as an undifferentiated green blob.
        const n = f.normalAt(wx, wz);
        const lit = Math.max(0.45, n.x * -0.45 + n.y * 0.82 + n.z * -0.36);
        const col = BIOME_COL[b];
        const i = (y * N + x) * 4;
        img.data[i] = Math.min(255, col[0] * lit);
        img.data[i + 1] = Math.min(255, col[1] * lit);
        img.data[i + 2] = Math.min(255, col[2] * lit);
        img.data[i + 3] = h < SEA_LEVEL ? 210 : 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.island = c;
    this.islandN = N;
  }

  update(dt) {
    if (!this.visible) return;
    this._acc += dt;
    if (this._acc < 1 / REDRAW_HZ) return;
    this._acc = 0;
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const S = this.size;
    const p = this.player.position;
    const world = this.terrain.size;
    const R = this.rangeMetres;

    ctx.save();
    ctx.clearRect(0, 0, S, S);

    // Circular mask so the map reads as a scope rather than a rectangle.
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#10151f';
    ctx.fillRect(0, 0, S, S);

    // North-up map: the player rotates on it, which is far easier to read than
    // a rotating world when you are also aiming.
    const px = (p.x / world + 0.5) * this.islandN;
    const pz = (p.z / world + 0.5) * this.islandN;
    const spanPx = (R / world) * this.islandN;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.island, px - spanPx / 2, pz - spanPx / 2, spanPx, spanPx, 0, 0, S, S);

    const toScreen = (wx, wz) => [
      S / 2 + ((wx - p.x) / R) * S,
      S / 2 + ((wz - p.z) / R) * S,
    ];

    /* --- storm circle ------------------------------------------------ */
    const st = this.storm;
    if (st.active) {
      const [cx, cy] = toScreen(st.centre.x, st.centre.y);
      const r = (st.radius / R) * S;
      // Shade everything outside the circle, which is what a player needs to
      // see at a glance: not the boundary, but which side they are on.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, S, S);
      ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2, true);
      ctx.fillStyle = 'rgba(150, 70, 255, 0.34)';
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(200, 140, 255, 0.95)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // Next circle, so a player can rotate early.
      if (st.isShrinking || st.targetRadius < st.radius) {
        const [tx, ty] = toScreen(st.targetCentre.x, st.targetCentre.y);
        ctx.beginPath();
        ctx.arc(tx, ty, Math.max(1, (st.targetRadius / R) * S), 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    /* --- POI markers -------------------------------------------------- */
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const poi of this.structures.pois) {
      const [x, y] = toScreen(poi.x, poi.z);
      if (x < -20 || x > S + 20 || y < -20 || y > S + 20) continue;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.62)';
      ctx.fillText(poi.name, x, y - 4);
    }

    /* --- loot chests --------------------------------------------------- */
    if (this.loot) {
      ctx.fillStyle = 'rgba(255, 205, 90, 0.9)';
      for (const ch of this.loot.chests) {
        if (ch.opened) continue;
        const [x, y] = toScreen(ch.x, ch.z);
        if (x < 0 || x > S || y < 0 || y > S) continue;
        ctx.fillRect(x - 1, y - 1, 2.5, 2.5);
      }
    }

    /* --- nearby opponents ---------------------------------------------- */
    // Only bots close enough to matter, so the map is a threat indicator
    // rather than a wallhack.
    ctx.fillStyle = 'rgba(255, 90, 106, 0.95)';
    for (const b of this.bots.bots) {
      if (!b.alive) continue;
      const d = Math.hypot(b.position.x - p.x, b.position.z - p.z);
      if (d > R * 0.36) continue;
      const [x, y] = toScreen(b.position.x, b.position.z);
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    /* --- player arrow ---------------------------------------------------- */
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.rotate(-this.player.yaw + Math.PI);
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fillStyle = '#eaf2ff';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.restore();

    /* --- compass ring + POI label ------------------------------------- */
    ctx.save();
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(226,238,255,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(226,238,255,0.8)';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', S / 2, 12);
    ctx.restore();

    const near = this.structures.nearestPoi(p.x, p.z);
    const text = near && near.distance < near.poi.radius * 1.4 ? near.poi.name : '';
    if (this.label.textContent !== text) this.label.textContent = text;
  }

  setVisible(v) { this.visible = v; this.wrap.classList.toggle('hidden', !v); }

  dispose() { if (this.wrap.parentNode) this.wrap.parentNode.removeChild(this.wrap); }
}
