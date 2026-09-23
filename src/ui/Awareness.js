import * as THREE from 'three';

/**
 * Awareness — directional HUD cues for things the player cannot see.
 *
 *  - Damage indicators: a red arc around the crosshair pointing at whoever
 *    just shot you. It tracks the attacker as you turn, so swinging toward the
 *    arc brings them onto the reticle.
 *  - Sound visualisation: icons on a ring for gunfire and footsteps nearby,
 *    placed at their bearing and faded with distance. Phones are very often
 *    played muted, and without this a muted player simply cannot know someone
 *    is running up behind them — which is why the genre ships it on mobile.
 *
 * Both are pooled DOM elements with transforms written only when they change;
 * nothing here allocates per frame.
 */

const DAMAGE_TTL = 1.4;
const DAMAGE_POOL = 4;
const SOUND_TTL = 1.3;
const SOUND_POOL = 8;
const GUN_RANGE = 80;
const STEP_RANGE = 24;

const _dir = new THREE.Vector3();

function wrap(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class Awareness {
  constructor() {
    this.order = 91;                  // UI, after the world has moved
    this.visible = true;
    this.damage = [];
    this.sounds = [];
    this.stats = { damageShown: 0, gunShown: 0, stepShown: 0 };
  }

  init(services) {
    this.services = services;
    this.camera = services.get('camera');
    this.player = services.get('player');
    this.settings = services.get('settings');
    this.bus = services.get('bus');
    const root = document.getElementById('ui-root') || document.body;

    const layer = document.createElement('div');
    layer.className = 'awareness';
    for (let i = 0; i < DAMAGE_POOL; i++) {
      const el = document.createElement('div');
      el.className = 'aw-damage';
      layer.appendChild(el);
      this.damage.push({ el, ttl: 0, x: 0, z: 0, rot: null, alpha: null });
    }
    for (let i = 0; i < SOUND_POOL; i++) {
      const el = document.createElement('div');
      el.className = 'aw-sound';
      el.innerHTML = '<i></i>';
      layer.appendChild(el);
      this.sounds.push({ el, ttl: 0, x: 0, z: 0, kind: '', key: null, strength: 0, rot: null, alpha: null });
    }
    root.appendChild(layer);
    this.layer = layer;

    this.bus.on('player:damaged', (e) => this._onDamaged(e));
    this.bus.on('weapon:fired', (e) => this._onFired(e));
    services.set('awareness', this);
  }

  setVisible(v) {
    this.visible = !!v;
    this.layer.classList.toggle('hidden', !this.visible);
  }

  get soundVizOn() { return this.settings.user.soundViz !== false; }

  _onDamaged(e) {
    const src = e.source && e.source.shooter;
    if (!src || !src.position || e.amount <= 0) return;
    // Reuse the attacker's slot if they already have one, else the oldest.
    let slot = this.damage.find((d) => d.ttl > 0 && d.src === src);
    if (!slot) slot = this.damage.reduce((a, b) => (a.ttl <= b.ttl ? a : b));
    slot.src = src;
    slot.x = src.position.x; slot.z = src.position.z;
    slot.ttl = DAMAGE_TTL;
    this.stats.damageShown++;
  }

  _onFired(e) {
    if (!this.soundVizOn || !e || e.shooter === this.player || !e.origin) return;
    const p = this.player.position;
    const d = Math.hypot(e.origin.x - p.x, e.origin.z - p.z);
    if (d > GUN_RANGE) return;
    this._sound(e.shooter, 'gun', e.origin.x, e.origin.z, 1 - d / GUN_RANGE);
    this.stats.gunShown++;
  }

  _sound(key, kind, x, z, strength) {
    let slot = this.sounds.find((s) => s.ttl > 0 && s.key === key && s.kind === kind);
    if (!slot) slot = this.sounds.reduce((a, b) => (a.ttl <= b.ttl ? a : b));
    slot.key = key; slot.kind = kind; slot.x = x; slot.z = z;
    slot.strength = Math.max(0.25, strength);
    slot.ttl = SOUND_TTL;
    if (slot.el.dataset.kind !== kind) slot.el.dataset.kind = kind;
  }

  /** Bearing of a world point relative to where the camera faces; 0 = ahead, + = right. */
  bearing(x, z) {
    this.camera.getWorldDirection(_dir);
    const camYaw = Math.atan2(-_dir.x, -_dir.z);
    const cp = this.camera.position;
    const toYaw = Math.atan2(-(x - cp.x), -(z - cp.z));
    // Yaw grows turning left; screen angles grow clockwise.
    return -wrap(toYaw - camYaw);
  }

  update(dt) {
    if (!this.visible) return;

    // Footsteps: any bot moving at a run nearby leaves a marker, refreshed
    // while it keeps moving. Polled rather than evented; it is two dozen bots.
    const bots = this.services.peek('bots');
    if (bots && this.soundVizOn && this.player.alive) {
      const p = this.player.position;
      for (const b of bots.bots) {
        if (!b.alive || b.inBus || b.speed < 2.2) continue;
        const d = Math.hypot(b.position.x - p.x, b.position.z - p.z);
        if (d > STEP_RANGE) continue;
        this._sound(b, 'step', b.position.x, b.position.z, 1 - d / STEP_RANGE);
        this.stats.stepShown++;
      }
    }

    for (const s of this.damage) this._draw(s, dt, DAMAGE_TTL, 1);
    for (const s of this.sounds) this._draw(s, dt, SOUND_TTL, s.strength);
  }

  _draw(s, dt, ttlMax, strength) {
    if (s.ttl <= 0) {
      if (s.alpha !== 0) { s.el.style.opacity = '0'; s.alpha = 0; }
      return;
    }
    s.ttl = Math.max(0, s.ttl - dt);
    // Keep pointing at the source as it or the camera moves.
    if (s.src && s.src.position) { s.x = s.src.position.x; s.z = s.src.position.z; }
    const rot = Math.round(this.bearing(s.x, s.z) * 57.2958);
    const alpha = Math.round(Math.min(1, s.ttl / (ttlMax * 0.5)) * strength * 100) / 100;
    if (rot !== s.rot) { s.el.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`; s.rot = rot; }
    if (alpha !== s.alpha) { s.el.style.opacity = String(alpha); s.alpha = alpha; }
  }

  /** Test/debug snapshot. */
  snapshot() {
    return {
      damage: this.damage.filter((d) => d.ttl > 0).map((d) => ({ rot: d.rot, alpha: d.alpha })),
      sounds: this.sounds.filter((s) => s.ttl > 0).map((s) => ({ kind: s.kind, rot: s.rot, alpha: s.alpha })),
    };
  }
}
