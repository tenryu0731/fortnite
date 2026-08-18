import * as THREE from 'three';

/**
 * DamageNumbers — floating damage readouts projected from world space.
 *
 * A pool of DOM nodes is created once and recycled; only `transform` and
 * `opacity` are written per frame, both of which the compositor can handle
 * without a layout or paint. Writing `left`/`top` instead would force a layout
 * for every number every frame, which is what makes this kind of effect
 * expensive.
 */

const POOL = 24;
const LIFE = 0.95;
const RISE = 1.4;          // metres the number floats upward over its life

const _v = new THREE.Vector3();

export class DamageNumbers {
  constructor() {
    this.order = 94;
    this.live = [];
    this.free = [];
  }

  init(services) {
    this.camera = services.get('camera');
    this.bus = services.get('bus');
    this.player = services.get('player');
    this.renderer = services.get('renderer');

    const root = document.getElementById('ui-root');
    this.layer = document.createElement('div');
    this.layer.className = 'hud-damage-layer';
    for (let i = 0; i < POOL; i++) {
      const e = document.createElement('div');
      e.className = 'hud-damage';
      e.style.opacity = '0';
      this.layer.appendChild(e);
      this.free.push(e);
    }
    root.appendChild(this.layer);

    this.bus.on('weapon:hit', (e) => {
      if (e.shooter !== this.player) return;
      this.spawn(e.point, e.damage, e.part);
    });
    services.set('damageNumbers', this);
  }

  spawn(point, amount, part) {
    let el = this.free.pop();
    if (!el) {
      // Recycle the oldest rather than skipping: the newest hit is the one the
      // player is looking for.
      const oldest = this.live.shift();
      if (!oldest) return null;
      el = oldest.el;
    }
    el.textContent = String(Math.round(amount));
    el.className = `hud-damage ${part === 'head' ? 'head' : ''}`;
    const entry = { el, x: point.x, y: point.y, z: point.z, t: 0, jitter: (this.live.length % 5 - 2) * 8 };
    this.live.push(entry);
    return entry;
  }

  update(dt) {
    if (this.live.length === 0) return;
    const cam = this.camera;
    const w = this.renderer.width, h = this.renderer.height;

    for (let i = this.live.length - 1; i >= 0; i--) {
      const d = this.live[i];
      d.t += dt;
      if (d.t >= LIFE) {
        d.el.style.opacity = '0';
        this.free.push(d.el);
        this.live.splice(i, 1);
        continue;
      }
      const k = d.t / LIFE;
      _v.set(d.x, d.y + RISE * k, d.z);
      _v.project(cam);
      // Behind the camera: hide rather than mirror it onto the wrong side.
      if (_v.z > 1) { d.el.style.opacity = '0'; continue; }
      const sx = (_v.x * 0.5 + 0.5) * w + d.jitter;
      const sy = (-_v.y * 0.5 + 0.5) * h;
      const scale = 1.15 - k * 0.35;
      d.el.style.transform = `translate(-50%,-50%) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) scale(${scale.toFixed(2)})`;
      d.el.style.opacity = String(Math.max(0, 1 - k * k));
    }
  }

  clear() {
    for (const d of this.live) { d.el.style.opacity = '0'; this.free.push(d.el); }
    this.live.length = 0;
  }

  dispose() { if (this.layer.parentNode) this.layer.parentNode.removeChild(this.layer); }
}
