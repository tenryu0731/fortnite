import * as THREE from 'three';
import { Rng } from '../gen/Rng.js';

/**
 * Storm — the shrinking safe circle that ends a match.
 *
 * Phases alternate between a stationary wait and a timed shrink toward a new
 * centre chosen inside the current circle, so the safe area always stays
 * reachable from wherever a player currently is. Damage per second climbs with
 * each phase: early storm is a nudge, late storm is a death sentence, which is
 * what converts a large map into a forced endgame.
 *
 * The wall is a single inward-facing cylinder with a scrolling procedural
 * texture. Rendering it as one mesh whose radius is animated costs one draw
 * call regardless of circle size, and being inside a BackSide cylinder is what
 * makes the boundary readable from any direction.
 */

const PHASES = [
  { wait: 32, shrink: 62, radius: 0.62, dps: 1 },
  { wait: 26, shrink: 52, radius: 0.44, dps: 2 },
  { wait: 22, shrink: 46, radius: 0.31, dps: 4 },
  { wait: 20, shrink: 40, radius: 0.21, dps: 6 },
  { wait: 18, shrink: 34, radius: 0.13, dps: 8 },
  { wait: 15, shrink: 30, radius: 0.075, dps: 10 },
  { wait: 12, shrink: 24, radius: 0.035, dps: 12 },
  { wait: 10, shrink: 20, radius: 0.0, dps: 15 },
];

const PHASE = { WAITING: 0, SHRINKING: 1, FINISHED: 2 };

export class Storm {
  constructor(seed, opts = {}) {
    this.order = 40;
    this.rng = Rng.forStream(seed, 'storm');
    this.mapRadius = opts.mapRadius || 420;
    this.active = false;
    this.reset();
  }

  reset() {
    this.phaseIndex = -1;
    this.state = PHASE.WAITING;
    this.timer = 0;
    this.centre = new THREE.Vector2(0, 0);
    this.targetCentre = new THREE.Vector2(0, 0);
    this.startCentre = new THREE.Vector2(0, 0);
    this.radius = this.mapRadius;
    this.startRadius = this.mapRadius;
    this.targetRadius = this.mapRadius;
    this.dps = 0;
    this.elapsed = 0;
    this.damageAccum = new Map();
    this.active = false;
  }

  init(services) {
    this.services = services;
    this.scene = services.get('scene');
    this.terrain = services.get('terrain');
    this.player = services.get('player');
    this.bots = services.peek('bots');
    this.bus = services.get('bus');
    this.materials = services.get('materials');
    this.audio = services.peek('audio');
    this.settings = services.get('settings');
    this._buildWall();
    services.set('storm', this);
  }

  _buildWall() {
    // Unit cylinder, scaled per frame: the geometry never changes, only the
    // instance transform, so shrinking costs nothing.
    const geo = new THREE.CylinderGeometry(1, 1, 1, 48, 1, true);
    const s = this.materials.gen.surface('storm', { repeat: 1 });
    // Normal blending, not additive: additive over a bright sky washes the wall
    // out to a flat lavender tint with no visible structure, and the whole point
    // of the wall is that a player can read exactly where the boundary is.
    const mat = new THREE.MeshBasicMaterial({
      map: s.map,
      color: 0x9d5cff,
      transparent: true,
      opacity: 0.66,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    mat.map.wrapS = mat.map.wrapT = THREE.RepeatWrapping;
    mat.map.repeat.set(20, 5);
    this.wallMaterial = mat;
    this.wall = new THREE.Mesh(geo, mat);
    this.wall.frustumCulled = false;
    this.wall.renderOrder = 3;
    this.wall.visible = false;
    this.wall.name = 'storm-wall';
    this.scene.add(this.wall);
  }

  /** Begin the phase sequence. */
  start() {
    this.reset();
    this.active = true;
    this._advancePhase();
    return this;
  }

  _advancePhase() {
    this.phaseIndex++;
    if (this.phaseIndex >= PHASES.length) {
      this.state = PHASE.FINISHED;
      this.dps = PHASES[PHASES.length - 1].dps;
      return;
    }
    const p = PHASES[this.phaseIndex];
    this.state = PHASE.WAITING;
    this.timer = p.wait;
    this.dps = this.phaseIndex > 0 ? PHASES[this.phaseIndex - 1].dps : 0;

    // The next circle is centred inside the current one, offset by at most the
    // difference in radii, so the safe area is always reachable on foot.
    this.startCentre.copy(this.centre);
    this.startRadius = this.radius;
    this.targetRadius = this.mapRadius * p.radius;
    const maxOffset = Math.max(0, this.radius - this.targetRadius) * 0.72;
    const a = this.rng.range(0, Math.PI * 2);
    const d = Math.sqrt(this.rng.next()) * maxOffset;
    this.targetCentre.set(this.centre.x + Math.cos(a) * d, this.centre.y + Math.sin(a) * d);

    this.bus.queue('storm:phase', {
      index: this.phaseIndex, state: 'waiting', wait: p.wait,
      nextRadius: this.targetRadius, dps: p.dps,
    });
    if (this.audio) this.audio.play('storm_warn', { volume: 0.5, bus: 'ui' });
  }

  /** Seconds until the next transition, for the HUD timer. */
  get timeRemaining() { return Math.max(0, this.timer); }
  get isShrinking() { return this.state === PHASE.SHRINKING; }
  get phaseCount() { return PHASES.length; }

  distanceToSafety(x, z) {
    return Math.hypot(x - this.centre.x, z - this.centre.y) - this.radius;
  }

  isSafe(x, z) { return this.distanceToSafety(x, z) <= 0; }

  /** Direction a bot or the HUD should head to reach safety. */
  safeDirection(x, z, out = new THREE.Vector3()) {
    const dx = this.centre.x - x, dz = this.centre.y - z;
    const d = Math.hypot(dx, dz) || 1;
    return out.set(dx / d, 0, dz / d);
  }

  /** A point inside the safe circle, for bot rotation targets. */
  safePoint(rng, margin = 0.7) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * this.radius * margin;
    return { x: this.centre.x + Math.cos(a) * r, z: this.centre.y + Math.sin(a) * r };
  }

  fixedUpdate(dt) {
    if (!this.active) return;
    this.elapsed += dt;

    // Active with no phase yet is a legitimate intermediate state (a scenario
    // or a director that flipped the flag before starting the sequence); it
    // must be inert rather than index past the end of the phase table.
    if (this.phaseIndex < 0) { this._applyDamage(dt); return; }

    if (this.state !== PHASE.FINISHED) {
      this.timer -= dt;
      if (this.state === PHASE.WAITING && this.timer <= 0) {
        const p = PHASES[this.phaseIndex];
        this.state = PHASE.SHRINKING;
        this.timer = p.shrink;
        this.shrinkDuration = p.shrink;
        this.dps = p.dps;
        this.bus.queue('storm:phase', { index: this.phaseIndex, state: 'shrinking', duration: p.shrink, dps: p.dps });
      } else if (this.state === PHASE.SHRINKING) {
        const p = PHASES[this.phaseIndex];
        const t = 1 - Math.max(0, this.timer) / this.shrinkDuration;
        // Smoothstep so the wall eases in and out rather than snapping to a
        // constant crawl the moment the phase starts.
        const e = t * t * (3 - 2 * t);
        this.radius = this.startRadius + (this.targetRadius - this.startRadius) * e;
        this.centre.x = this.startCentre.x + (this.targetCentre.x - this.startCentre.x) * e;
        this.centre.y = this.startCentre.y + (this.targetCentre.y - this.startCentre.y) * e;
        if (this.timer <= 0) {
          this.radius = this.targetRadius;
          this.centre.copy(this.targetCentre);
          void p;
          this._advancePhase();
        }
      }
    }

    this._applyDamage(dt);
  }

  /**
   * Storm damage is accumulated per entity and applied in whole points, so a
   * 1 dps early storm actually ticks instead of rounding to zero every frame.
   */
  _applyDamage(dt) {
    if (this.dps <= 0) return;
    const tick = (entity, key) => {
      if (!entity || !entity.alive) return;
      const p = entity.position;
      if (this.isSafe(p.x, p.z)) { this.damageAccum.set(key, 0); return; }
      const acc = (this.damageAccum.get(key) || 0) + this.dps * dt;
      if (acc >= 1) {
        const whole = Math.floor(acc);
        this.damageAccum.set(key, acc - whole);
        entity.applyDamage(whole, { type: 'storm' });
      } else {
        this.damageAccum.set(key, acc);
      }
    };

    tick(this.player, 'player');
    if (this.bots) {
      for (const b of this.bots.bots) tick(b, 'bot' + b.id);
    }
  }

  update(dt) {
    if (!this.active) { this.wall.visible = false; return; }
    this.wall.visible = true;
    this.wall.position.set(this.centre.x, 0, this.centre.y);
    // Tall enough to cover any terrain and any tower a player could build on.
    this.wall.scale.set(this.radius, 400, this.radius);
    this.wall.updateMatrix();
    // Scroll the texture so the wall reads as moving energy, not a decal.
    const m = this.wallMaterial.map;
    m.offset.x = (m.offset.x + dt * 0.06) % 1;
    m.offset.y = (m.offset.y - dt * 0.13) % 1;
    // Repeat scales with radius so texel density stays constant as it shrinks.
    m.repeat.set(Math.max(8, this.radius * 0.16), 5);
  }

  snapshot() {
    return {
      active: this.active,
      phase: this.phaseIndex,
      phases: PHASES.length,
      mode: ['waiting', 'shrinking', 'finished'][this.state],
      timer: +this.timer.toFixed(2),
      radius: +this.radius.toFixed(1),
      targetRadius: +this.targetRadius.toFixed(1),
      centre: [+this.centre.x.toFixed(1), +this.centre.y.toFixed(1)],
      dps: this.dps,
      playerSafe: this.isSafe(this.player.position.x, this.player.position.z),
      playerDistance: +this.distanceToSafety(this.player.position.x, this.player.position.z).toFixed(1),
    };
  }

  dispose() {
    if (this.wall) { this.wall.geometry.dispose(); this.scene.remove(this.wall); }
  }

  static get PHASES() { return PHASES; }
}
