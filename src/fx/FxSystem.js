import * as THREE from 'three';
import { ParticleSystem } from './ParticleSystem.js';
import { Tracers } from './Tracers.js';
import { Decals } from './Decals.js';
import { Rng } from '../gen/Rng.js';
import { srgbHex } from '../gen/Palette.js';

/**
 * FxSystem — turns gameplay events into things the player can see and hear.
 *
 * Every effect is driven off the event bus rather than called directly from
 * gameplay code, so combat and building never need to know that feedback
 * exists. That also means the whole feedback layer can be muted or budgeted in
 * one place: on the low quality preset the particle pool shrinks and decals are
 * disabled, and nothing else has to change.
 *
 * Randomness comes from a seeded stream, so effects are reproducible frame for
 * frame under the deterministic harness.
 */

const MAT_COLOR = {
  wood: srgbHex(0xb98a52),
  timber: srgbHex(0xb98a52),
  brick: srgbHex(0xa8604f),
  concrete: srgbHex(0x9d9c96),
  steel: srgbHex(0x7f8792),
  metal: srgbHex(0x8b96a3),
  roof: srgbHex(0x9c7358),
  glass: srgbHex(0xbfe0ef),
  terrain: srgbHex(0x8a7a5c),
  tree: srgbHex(0x8a6a44),
  rock: srgbHex(0x9a9a94),
};
const SPARK = srgbHex(0xffd08a);
const FLASH = srgbHex(0xfff0c8);
const SMOKE = srgbHex(0x9aa0a6);

const _v = new THREE.Vector3();
const _end = new THREE.Vector3();
const _muzzle = new THREE.Vector3();

export class FxSystem {
  constructor(seed = 1) {
    this.order = 85;
    this.rng = Rng.forStream(seed, 'fx');
    this.stats = { flashes: 0, impacts: 0, tracers: 0, decals: 0, debris: 0 };
  }

  init(services) {
    this.services = services;
    this.scene = services.get('scene');
    this.camera = services.get('camera');
    this.settings = services.get('settings');
    this.bus = services.get('bus');
    this.materials = services.get('materials');
    this.audio = services.peek('audio');
    this.player = services.get('player');

    const q = this.settings.q;
    this.group = new THREE.Group();
    this.group.name = 'fx';
    this.scene.add(this.group);

    const quad = new THREE.PlaneGeometry(1, 1);
    // Additive pool: flashes, sparks, glow. Lit pool: debris and dust, which
    // must sit in the scene's lighting or they read as glowing confetti.
    this.additive = new ParticleSystem(q.particleBudget, this.materials.sprite('spark'), quad, seedOf(this.rng));
    this.debris = new ParticleSystem(Math.floor(q.particleBudget * 0.6),
      this.materials.particleLit('debris'), new THREE.BoxGeometry(1, 1, 1), seedOf(this.rng));
    this.group.add(this.additive.mesh);
    this.group.add(this.debris.mesh);

    this.tracers = new Tracers(64, this.materials.additive('tracer', { vertexColors: true }));
    this.group.add(this.tracers.mesh);

    this.decalsEnabled = q.decalBudget > 0;
    if (this.decalsEnabled) {
      this.decals = new Decals(q.decalBudget, this.materials.decal('bullet'));
      this.group.add(this.decals.mesh);
    }

    this._subscribe();
    services.set('fx', this);
  }

  _subscribe() {
    const bus = this.bus;
    bus.on('weapon:fired', (e) => this.onFired(e));
    bus.on('weapon:impact', (e) => this.onImpact(e));
    bus.on('weapon:hit', (e) => this.onHit(e));
    bus.on('build:placed', (e) => this.onBuildPlaced(e));
    bus.on('build:destroyed', (e) => this.onBuildDestroyed(e));
    bus.on('player:land', (e) => this.onLand(e));
    bus.on('player:damaged', (e) => this.onPlayerDamaged(e));
    bus.on('entity:eliminated', (e) => this.onEliminated(e));
    bus.on('resource:gained', (e) => this.onResource(e));
  }

  /* ------------------------------------------------------------------ */
  /* emitters                                                            */
  /* ------------------------------------------------------------------ */

  muzzleFlash(origin, dir) {
    const r = this.rng;
    _v.copy(origin).addScaledVector(dir, 0.55);
    this.additive.emit({
      x: _v.x, y: _v.y, z: _v.z,
      life: 0.055, size0: 0.55, size1: 0.16,
      color0: FLASH, color1: [FLASH[0] * 0.4, FLASH[1] * 0.25, FLASH[2] * 0.05],
    });
    for (let i = 0; i < 4; i++) {
      this.additive.emit({
        x: _v.x, y: _v.y, z: _v.z,
        vx: dir.x * r.range(4, 11) + r.range(-2, 2),
        vy: dir.y * r.range(4, 11) + r.range(-1.4, 1.4),
        vz: dir.z * r.range(4, 11) + r.range(-2, 2),
        gravity: -7, drag: 5,
        life: r.range(0.07, 0.16), size0: 0.09, size1: 0.01,
        color0: SPARK, color1: [SPARK[0] * 0.3, SPARK[1] * 0.1, 0],
      });
    }
    this.stats.flashes++;
  }

  impact(point, normal, materialKey) {
    const r = this.rng;
    const col = MAT_COLOR[materialKey] || MAT_COLOR.terrain;
    // Sparks only from hard materials; dust from everything.
    const hard = materialKey === 'metal' || materialKey === 'steel' || materialKey === 'rock';
    const sparks = hard ? 6 : 2;
    for (let i = 0; i < sparks; i++) {
      this.additive.emit({
        x: point.x, y: point.y, z: point.z,
        vx: normal.x * r.range(1, 5) + r.range(-2.4, 2.4),
        vy: normal.y * r.range(1, 5) + r.range(0, 3),
        vz: normal.z * r.range(1, 5) + r.range(-2.4, 2.4),
        gravity: -12, drag: 2.4,
        life: r.range(0.12, 0.30), size0: 0.06, size1: 0,
        color0: SPARK, color1: [0.4, 0.12, 0],
      });
    }
    for (let i = 0; i < 3; i++) {
      this.additive.emit({
        x: point.x + r.range(-0.1, 0.1), y: point.y + r.range(-0.1, 0.1), z: point.z + r.range(-0.1, 0.1),
        vx: normal.x * r.range(0.4, 1.4), vy: normal.y * r.range(0.4, 1.4) + 0.5, vz: normal.z * r.range(0.4, 1.4),
        gravity: 0.6, drag: 2.6,
        life: r.range(0.3, 0.6), size0: 0.14, size1: 0.5,
        color0: [col[0] * 1.4, col[1] * 1.4, col[2] * 1.4], color1: [SMOKE[0] * 0.1, SMOKE[1] * 0.1, SMOKE[2] * 0.1],
      });
    }
    for (let i = 0; i < 3; i++) {
      this.debris.emit({
        x: point.x, y: point.y, z: point.z,
        vx: normal.x * r.range(1, 4) + r.range(-1.6, 1.6),
        vy: normal.y * r.range(1, 4) + r.range(0.5, 3),
        vz: normal.z * r.range(1, 4) + r.range(-1.6, 1.6),
        gravity: -18, drag: 0.4,
        life: r.range(0.5, 1.0), size0: r.range(0.03, 0.08), size1: r.range(0.02, 0.05),
        spin: r.range(-14, 14), billboard: false,
        color0: col, color1: [col[0] * 0.6, col[1] * 0.6, col[2] * 0.6],
      });
    }
    this.stats.impacts++;
  }

  tracer(from, to) {
    this.tracers.spawn(from, to, [1, 0.82, 0.5], 0.075);
    this.stats.tracers++;
  }

  decal(point, normal, size, materialKey) {
    if (!this.decalsEnabled) return;
    const col = MAT_COLOR[materialKey] || MAT_COLOR.terrain;
    this.decals.place(point, normal, size, [0.6 + col[0], 0.6 + col[1], 0.6 + col[2]], this.rng.range(0, Math.PI * 2));
    this.stats.decals++;
  }

  burst(point, count, color, speed, life) {
    const r = this.rng;
    for (let i = 0; i < count; i++) {
      this.additive.emit({
        x: point.x, y: point.y, z: point.z,
        vx: r.range(-speed, speed), vy: r.range(0, speed), vz: r.range(-speed, speed),
        gravity: -8, drag: 1.8,
        life: r.range(life * 0.6, life), size0: 0.12, size1: 0,
        color0: color, color1: [color[0] * 0.2, color[1] * 0.2, color[2] * 0.2],
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* event handlers                                                      */
  /* ------------------------------------------------------------------ */

  onFired(e) {
    if (e.shooter === this.player || this._nearCamera(e.origin, 90)) {
      // Shots are traced from the eye so the reticle is honest, but the flash
      // and tracer must appear to leave the barrel, not the character's face.
      const muzzle = this._muzzleOf(e.shooter, e.origin);
      this.muzzleFlash(muzzle, e.dir);
      if (!e.projectile) {
        _end.copy(e.origin).addScaledVector(e.dir, 60);
        this.tracer(muzzle, _end);
      }
    }
    if (this.audio) {
      const isPlayer = e.shooter === this.player;
      this.audio.play(e.sound, isPlayer
        ? { volume: 0.75, rate: 0.98 + this.rng.range(-0.03, 0.03) }
        : { position: e.origin, volume: 1.0, rate: 0.98 + this.rng.range(-0.05, 0.05) });
    }
  }

  onImpact(e) {
    if (!this._nearCamera(e.point, 120)) return;
    const key = e.material || (e.kind === 'terrain' ? 'terrain' : e.kind);
    this.impact(e.point, e.normal, key);
    this.decal(e.point, e.normal, 0.16 + this.rng.range(0, 0.08), key);
  }

  onHit(e) {
    _v.set(e.point.x, e.point.y, e.point.z);
    this.burst(_v, e.part === 'head' ? 10 : 6, srgbHex(0xff5a6a), 3.2, 0.28);
    if (this.audio && e.shooter === this.player) {
      this.audio.play(e.part === 'head' ? 'headshot' : 'hitmarker', { volume: 0.55, bus: 'ui' });
    }
  }

  onBuildPlaced(e) {
    _v.set(e.x, e.y + 1, e.z);
    if (this._nearCamera(_v, 70)) this.burst(_v, 5, MAT_COLOR[e.material] || SMOKE, 2.0, 0.35);
    if (this.audio) this.audio.play(`build_${e.material}`, { position: _v, volume: 0.7 });
  }

  onBuildDestroyed(e) {
    _v.set(e.x, e.y, e.z);
    const col = MAT_COLOR[e.material] || MAT_COLOR.terrain;
    const r = this.rng;
    for (let i = 0; i < 14; i++) {
      this.debris.emit({
        x: e.x + r.range(-1.4, 1.4), y: e.y + r.range(-1.4, 1.4), z: e.z + r.range(-1.4, 1.4),
        vx: r.range(-5, 5), vy: r.range(1, 7), vz: r.range(-5, 5),
        gravity: -20, drag: 0.35,
        life: r.range(0.7, 1.5), size0: r.range(0.10, 0.26), size1: r.range(0.06, 0.18),
        spin: r.range(-10, 10), billboard: false,
        color0: col, color1: [col[0] * 0.5, col[1] * 0.5, col[2] * 0.5],
      });
    }
    this.stats.debris += 14;
    if (this.audio) this.audio.play('build_break', { position: _v, volume: 0.9 });
  }

  onLand(e) {
    if (e.speed < 5) return;
    _v.set(e.pos.x, e.pos.y, e.pos.z);
    const r = this.rng;
    const n = Math.min(8, Math.round(e.speed * 0.5));
    for (let i = 0; i < n; i++) {
      this.additive.emit({
        x: _v.x + r.range(-0.3, 0.3), y: _v.y + 0.05, z: _v.z + r.range(-0.3, 0.3),
        vx: r.range(-1.6, 1.6), vy: r.range(0.2, 1.2), vz: r.range(-1.6, 1.6),
        gravity: -1.2, drag: 3,
        life: r.range(0.3, 0.6), size0: 0.16, size1: 0.5,
        color0: [0.35, 0.31, 0.24], color1: [0.05, 0.045, 0.035],
      });
    }
    if (this.audio) this.audio.play('step_dirt', { position: _v, volume: Math.min(1, e.speed / 14) });
  }

  onPlayerDamaged(e) {
    if (this.audio) this.audio.play('hurt', { volume: Math.min(0.9, 0.3 + e.amount / 120), bus: 'ui' });
  }

  onEliminated(e) {
    if (this.audio) this.audio.play('eliminate', { volume: 0.8, bus: 'ui' });
    const ent = e.entity;
    if (ent && ent.position) {
      _v.copy(ent.position).setY(ent.position.y + 1);
      this.burst(_v, 22, srgbHex(0x8fe8ff), 4.5, 0.7);
    }
  }

  onResource(e) {
    if (this.audio) this.audio.play('harvest', { volume: 0.5, bus: 'ui', rate: 1 + this.rng.range(-0.06, 0.06) });
  }

  /** World position of a shooter's weapon muzzle, falling back to the eye. */
  _muzzleOf(shooter, fallback) {
    const socket = shooter && shooter.mesh && shooter.mesh.weaponSocket;
    if (!socket) return _muzzle.copy(fallback);
    socket.updateWorldMatrix(true, false);
    return _muzzle.setFromMatrixPosition(socket.matrixWorld);
  }

  _nearCamera(p, radius) {
    const c = this.camera.position;
    const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
    return dx * dx + dy * dy + dz * dz < radius * radius;
  }

  /* ------------------------------------------------------------------ */

  update(dt) {
    this.additive.update(dt, this.camera);
    this.debris.update(dt, this.camera);
    this.tracers.update(dt);
  }

  clear() {
    this.additive.clear();
    this.debris.clear();
    this.tracers.clear();
    if (this.decals) this.decals.clear();
  }

  state() {
    return {
      particles: this.additive.count,
      debris: this.debris.count,
      tracers: this.tracers.count,
      decals: this.decals ? this.decals.count : 0,
      capacity: { additive: this.additive.capacity, debris: this.debris.capacity, decals: this.decals ? this.decals.capacity : 0 },
      stats: { ...this.stats },
    };
  }

  dispose() {
    this.additive.dispose();
    this.debris.dispose();
    this.tracers.dispose();
    if (this.decals) this.decals.dispose();
    this.scene.remove(this.group);
  }
}

/** Derive a child seed without consuming the parent's sequence meaningfully. */
function seedOf(rng) { return rng.int(0x7fffffff); }
