import * as THREE from 'three';

/**
 * AimAssist — the help every touch and controller shooter gives its players.
 *
 * A thumb on glass cannot make the small, fast corrections a mouse can, so a
 * shooter played on a phone without assistance feels broken rather than hard.
 * This implements the three standard components, all bounded so they help a
 * player who is already aiming at someone and do nothing for one who is not:
 *
 *  - FRICTION: while the reticle is over (or just beside) an enemy's body,
 *    look input is scaled down, so a drag across a target lingers on it
 *    instead of overshooting.
 *  - MAGNETISM: while the reticle is over an enemy that is moving across the
 *    view (or the player is strafing), aim is pulled a fraction of the way
 *    along with it. It follows; it never snaps from off-target.
 *  - ADS SNAP: switching into ADS with an enemy inside a small cone settles the
 *    aim onto their chest over a fraction of a second — the genre's
 *    signature assist on consoles and phones.
 *
 * Everything requires line of sight, is off with the pickaxe and in build
 * mode, and can be turned off in settings. It edits the published look input
 * before the player controller consumes it, so it composes with every input
 * device rather than being a touch special case.
 */

const FRICTION_RADIUS = 0.9;          // metres around the chest, converted to an angle
const FRICTION_MAX_ANGLE = 0.14;      // rad cap, so a target at 2m does not cover the screen
const FRICTION_SCALE = 0.5;           // look input multiplier at the centre of the cone
const MAGNET_FOLLOW = 0.45;           // fraction of the target's angular motion followed
const SNAP_ANGLE = 0.16;              // rad (~9 deg) cone for the ADS snap
const SNAP_TIME = 0.14;               // seconds to settle
const MAX_RANGE = 90;

const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _to = new THREE.Vector3();
const _chest = new THREE.Vector3();

function wrap(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class AimAssist {
  constructor() {
    this.order = 45;                  // after input publishes, before the player applies look
    this.snapTimer = 0;
    this.snapTarget = null;
    this.stats = { frictionSteps: 0, snaps: 0 };
    this.debug = { target: null, angle: 0, friction: 1 };
    this._prevAim = false;
    this._lastAngles = new Map();     // entity -> [yaw, pitch] from the camera last step
  }

  init(services) {
    this.input = services.get('input');
    this.player = services.get('player');
    this.camera = services.get('camera');
    this.physics = services.get('physics');
    this.settings = services.get('settings');
    this.services = services;
    services.set('aimAssist', this);
  }

  get enabled() { return this.settings.user.aimAssist !== false; }

  /** Best enemy near the reticle: smallest angular offset inside `maxAngle`. */
  _nearest(maxAngleFn) {
    const combat = this.services.peek('combat');
    if (!combat) return null;
    this.camera.getWorldPosition(_camPos);
    this.camera.getWorldDirection(_camDir);
    let best = null;
    for (const t of combat.targets) {
      const e = t.entity;
      if (e === this.player || !e.alive || e.inBus) continue;
      _chest.set(e.position.x, e.position.y + 1.25, e.position.z);
      _to.subVectors(_chest, _camPos);
      const d = _to.length();
      if (d > MAX_RANGE || d < 0.5) continue;
      const ang = Math.acos(THREE.MathUtils.clamp(_to.dot(_camDir) / d, -1, 1));
      const limit = maxAngleFn(d);
      if (ang > limit || (best && ang >= best.angle)) continue;
      if (!this.physics.lineOfSight(_camPos, _chest)) continue;
      best = { entity: e, angle: ang, limit, dist: d,
        yaw: Math.atan2(-_to.x, -_to.z), pitch: Math.asin(THREE.MathUtils.clamp(_to.y / d, -1, 1)) };
    }
    return best;
  }

  fixedUpdate(dt) {
    const s = this.input.state;
    const combat = this.services.peek('combat');
    const build = this.services.peek('build');
    const w = combat ? combat.weapon : null;
    const active = this.enabled && this.player.alive && w && w.def.class !== 'melee'
      && !(build && build.active);
    this.debug.friction = 1;
    this.debug.target = null;
    if (!active) { this._prevAim = s.aim; this.snapTimer = 0; return; }

    // Camera yaw/pitch, to express corrections in the player's own terms.
    this.camera.getWorldDirection(_camDir);
    const camYaw = Math.atan2(-_camDir.x, -_camDir.z);
    const camPitch = Math.asin(THREE.MathUtils.clamp(_camDir.y, -1, 1));

    /* --- ADS snap ------------------------------------------------------ */
    if (s.aim && !this._prevAim) {
      const t = this._nearest(() => SNAP_ANGLE);
      if (t) { this.snapTarget = t.entity; this.snapTimer = SNAP_TIME; this.stats.snaps++; }
    }
    this._prevAim = s.aim;
    if (this.snapTimer > 0 && this.snapTarget) {
      const t = this._nearest((d) => SNAP_ANGLE * 1.5);
      if (t && t.entity === this.snapTarget) {
        // Close a proportional share of the remaining gap each step, so the
        // snap eases in over SNAP_TIME rather than teleporting the view.
        const k = Math.min(1, dt / this.snapTimer);
        s.look.dx += wrap(t.yaw - camYaw) * k;
        s.look.dy += (t.pitch - camPitch) * k;
      }
      this.snapTimer = Math.max(0, this.snapTimer - dt);
      if (this.snapTimer <= 0) this.snapTarget = null;
    }

    /* --- friction and magnetism -------------------------------------- */
    const t = this._nearest((d) => Math.min(FRICTION_MAX_ANGLE, Math.atan(FRICTION_RADIUS / d)));
    if (!t) { this._lastAngles.clear(); return; }
    this.debug.target = t.entity;
    this.debug.angle = t.angle;
    // Strongest at the centre of the cone, fading to none at its edge.
    const inside = 1 - t.angle / t.limit;
    const f = 1 - (1 - FRICTION_SCALE) * inside;
    s.look.dx *= f;
    s.look.dy *= f;
    this.debug.friction = f;
    this.stats.frictionSteps++;

    // Follow the target's own motion across the view, measured as the change
    // in its bearing from the camera since the last step.
    const prev = this._lastAngles.get(t.entity);
    if (prev) {
      s.look.dx += wrap(t.yaw - prev[0]) * MAGNET_FOLLOW * inside;
      s.look.dy += (t.pitch - prev[1]) * MAGNET_FOLLOW * inside;
    }
    this._lastAngles.clear();
    this._lastAngles.set(t.entity, [t.yaw, t.pitch]);
  }
}
