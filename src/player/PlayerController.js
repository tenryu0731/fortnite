import * as THREE from 'three';
import { CharacterMesh } from './CharacterMesh.js';
import { GRAVITY } from '../sim/Physics.js';

/**
 * PlayerController — the local player's movement, pose and orientation.
 *
 * Reads only the normalised InputState, so it is identical under touch and
 * keyboard. Movement is intentionally arcade-tuned rather than realistic:
 * strong gravity, high air control by shooter standards, and acceleration
 * curves that reach full speed in a few frames, because a build-fight is
 * unplayable with momentum-heavy movement.
 */

const SPEED = { walk: 4.4, sprint: 7.2, crouch: 2.2, air: 0.6 };
const ACCEL_GROUND = 46;
const ACCEL_AIR = 12;
const FRICTION = 12;
const JUMP_SPEED = 7.6;
const COYOTE_TIME = 0.11;      // grace period for jumping just after leaving ground
const JUMP_BUFFER = 0.14;      // remembers a jump pressed just before landing
const PITCH_LIMIT = Math.PI / 2 - 0.03;
const FALL_SAFE_SPEED = 17;    // m/s; about a 6.5m drop
const TERMINAL_SPEED = 58;     // caps damage and keeps skydiving predictable

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();

export class PlayerController {
  constructor(opts = {}) {
    this.order = 50;
    this.seed = opts.seed || 1;

    this.body = {
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      radius: 0.36,
      height: CharacterMesh.HEIGHT,
      stepHeight: 0.58,
      grounded: false,
      onBox: false,
      steepGround: false,
      groundY: 0,
      groundNormal: new THREE.Vector3(0, 1, 0),
      hitWall: false,
      landingSpeed: 0,
    };

    this.yaw = 0;
    this.pitch = 0;
    this.crouching = false;
    this.sprinting = false;
    this.aiming = false;
    this.speed = 0;
    this.alive = true;

    this.health = 100;
    this.maxHealth = 100;
    this.shield = 0;
    this.maxShield = 100;

    this._coyote = 0;
    this._jumpBuffer = 0;
    this._airborneTime = 0;
    this.justLanded = 0;
    this.stats = { distance: 0, jumps: 0, falls: 0 };
  }

  init(services) {
    this.services = services;
    this.input = services.get('input');
    this.physics = services.get('physics');
    this.terrain = services.get('terrain');
    this.settings = services.get('settings');
    this.bus = services.get('bus');
    const scene = services.get('scene');

    this.mesh = new CharacterMesh(services.get('materials'), this.seed ^ 0x5eed, {});
    scene.add(this.mesh.root);

    services.set('player', this);
  }

  /** Place the player on the ground at a world position. */
  spawnAt(x, z, yOffset = 0) {
    const y = this.terrain.heightAt(x, z);
    this.body.pos.set(x, y + yOffset, z);
    this.body.vel.set(0, 0, 0);
    this.body.grounded = yOffset <= 0.01;
    this.mesh.root.position.copy(this.body.pos);
    return this.body.pos;
  }

  get position() { return this.body.pos; }
  get velocity() { return this.body.vel; }
  get eyeHeight() { return (this.crouching ? 1.20 : 1.62); }

  /** World-space eye position, used for aiming, LOS and camera framing. */
  eyePosition(out = new THREE.Vector3()) {
    return out.set(this.body.pos.x, this.body.pos.y + this.eyeHeight, this.body.pos.z);
  }

  /** Unit vector the player is looking along. */
  lookDirection(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  fixedUpdate(dt) {
    if (!this.alive) return;
    const s = this.input.state;

    /* --- orientation --------------------------------------------------- */
    this.yaw += s.look.dx;
    this.pitch = THREE.MathUtils.clamp(this.pitch + s.look.dy, -PITCH_LIMIT, PITCH_LIMIT);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;

    /* --- pose ----------------------------------------------------------- */
    const wantCrouch = s.crouch;
    if (wantCrouch !== this.crouching) {
      // Refuse to stand up under a ceiling.
      if (!wantCrouch) {
        const ceil = this.physics.ceilingAbove(this.body.pos.x, this.body.pos.z, this.body.radius,
          this.body.pos.y + 1.3, this.body.pos.y + CharacterMesh.HEIGHT + 0.2);
        if (ceil > this.body.pos.y + CharacterMesh.HEIGHT) this.crouching = false;
      } else {
        this.crouching = true;
      }
    }
    this.aiming = s.aim;
    const moveLen = Math.hypot(s.move.x, s.move.y);
    this.sprinting = s.sprint && !this.crouching && !this.aiming && s.move.y > 0.35;

    this.body.height = this.crouching ? CharacterMesh.HEIGHT - 0.45 : CharacterMesh.HEIGHT;

    /* --- horizontal acceleration --------------------------------------- */
    const maxSpeed = this.crouching ? SPEED.crouch : this.sprinting ? SPEED.sprint : SPEED.walk;
    const aimScale = this.aiming ? 0.62 : 1;

    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    _wish.set(0, 0, 0);
    if (moveLen > 0.001) {
      _wish.addScaledVector(_fwd, s.move.y).addScaledVector(_right, s.move.x);
      if (_wish.lengthSq() > 1) _wish.normalize();
      _wish.multiplyScalar(maxSpeed * aimScale * Math.min(1, moveLen));
    }

    const vel = this.body.vel;
    const accel = this.body.grounded ? ACCEL_GROUND : ACCEL_AIR;
    if (this.body.grounded && moveLen < 0.001) {
      // Ground friction: exponential decay, so stopping is quick but not instant.
      const drop = Math.exp(-FRICTION * dt);
      vel.x *= drop; vel.z *= drop;
      if (Math.abs(vel.x) < 0.02) vel.x = 0;
      if (Math.abs(vel.z) < 0.02) vel.z = 0;
    } else {
      const airLimit = this.body.grounded ? Infinity : maxSpeed * (1 + SPEED.air);
      vel.x += (_wish.x - vel.x) * Math.min(1, accel * dt / Math.max(1, maxSpeed));
      vel.z += (_wish.z - vel.z) * Math.min(1, accel * dt / Math.max(1, maxSpeed));
      const hs = Math.hypot(vel.x, vel.z);
      if (hs > airLimit) { vel.x *= airLimit / hs; vel.z *= airLimit / hs; }
    }

    /* --- jumping -------------------------------------------------------- */
    if (this.body.grounded) this._coyote = COYOTE_TIME;
    else this._coyote = Math.max(0, this._coyote - dt);
    if (this.input.pressed.jump) this._jumpBuffer = JUMP_BUFFER;
    else this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);

    if (this._jumpBuffer > 0 && this._coyote > 0 && !this.body.steepGround) {
      vel.y = JUMP_SPEED;
      this.body.grounded = false;
      this._coyote = 0;
      this._jumpBuffer = 0;
      this.stats.jumps++;
      this.bus.queue('player:jump', { pos: this.body.pos });
    }

    /* --- integrate ------------------------------------------------------ */
    if (vel.y < -TERMINAL_SPEED) vel.y = -TERMINAL_SPEED;
    const wasGrounded = this.body.grounded;
    const prevX = this.body.pos.x, prevZ = this.body.pos.z;
    this.physics.moveCharacter(this.body, dt);

    const dx = this.body.pos.x - prevX, dz = this.body.pos.z - prevZ;
    this.speed = Math.hypot(dx, dz) / dt;
    this.stats.distance += Math.hypot(dx, dz);

    if (!wasGrounded && this.body.grounded) {
      this.justLanded = this.body.landingSpeed;
      this._airborneTime = 0;
      // Fall damage above a generous threshold, so ramps and roofs stay safe.
      // The curve is tuned so a two-storey drop is free, a tower is survivable
      // but expensive, and a mountainside is lethal.
      if (this.body.landingSpeed > FALL_SAFE_SPEED) {
        const dmg = Math.round((this.body.landingSpeed - FALL_SAFE_SPEED) * 2.6);
        if (dmg > 0) this.applyDamage(dmg, { type: 'fall' });
        this.stats.falls++;
      }
      this.bus.queue('player:land', { speed: this.body.landingSpeed, pos: this.body.pos });
    } else {
      this.justLanded = 0;
      if (!this.body.grounded) this._airborneTime += dt;
    }

    // Never let the player leave the island bounds.
    const lim = this.terrain.size / 2 - 4;
    this.body.pos.x = THREE.MathUtils.clamp(this.body.pos.x, -lim, lim);
    this.body.pos.z = THREE.MathUtils.clamp(this.body.pos.z, -lim, lim);
  }

  /** Damage goes to shield first, then health. Returns the amount applied. */
  applyDamage(amount, source = {}) {
    if (!this.alive || amount <= 0) return 0;
    let left = amount;
    const toShield = Math.min(this.shield, left);
    this.shield -= toShield;
    left -= toShield;
    this.health = Math.max(0, this.health - left);
    this.bus.queue('player:damaged', { amount, source, health: this.health, shield: this.shield });
    if (this.health <= 0) {
      this.alive = false;
      this.bus.queue('entity:eliminated', { entity: this, isPlayer: true, source });
    }
    return amount;
  }

  heal(amount) {
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    return this.health - before;
  }

  addShield(amount) {
    const before = this.shield;
    this.shield = Math.min(this.maxShield, this.shield + amount);
    return this.shield - before;
  }

  /** Animation and mesh placement run on the render tick, not the sim tick. */
  update(dt) {
    const mesh = this.mesh;
    mesh.root.position.copy(this.body.pos);
    // The body faces the aim direction; a small offset keeps a strafing player
    // from looking like they are skating sideways.
    mesh.root.rotation.y = this.yaw;
    const strafe = this.input.state.move.x;
    mesh.update(dt, {
      speed: this.speed,
      maxSpeed: SPEED.sprint,
      grounded: this.body.grounded,
      crouch: this.crouching,
      aim: this.aiming,
      pitch: this.pitch,
      strafe,
      torsoYaw: 0,
    });
    mesh.setVisible(this.alive);
  }

  state() {
    return {
      pos: this.body.pos.toArray().map((n) => +n.toFixed(3)),
      vel: this.body.vel.toArray().map((n) => +n.toFixed(3)),
      yaw: +this.yaw.toFixed(4),
      pitch: +this.pitch.toFixed(4),
      speed: +this.speed.toFixed(3),
      grounded: this.body.grounded,
      onBox: this.body.onBox,
      crouching: this.crouching,
      sprinting: this.sprinting,
      aiming: this.aiming,
      health: this.health,
      shield: this.shield,
      alive: this.alive,
      height: +this.body.height.toFixed(3),
      distance: +this.stats.distance.toFixed(2),
      jumps: this.stats.jumps,
    };
  }

  dispose() { this.mesh.dispose(); }

  static get SPEED() { return SPEED; }
  static get JUMP_SPEED() { return JUMP_SPEED; }
  static get GRAVITY() { return GRAVITY; }
}
