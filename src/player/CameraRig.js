import * as THREE from 'three';

/**
 * CameraRig — third-person spring arm with occlusion pull-in.
 *
 * The pivot sits at the player's eye and is smoothed; the camera hangs behind
 * and to the shoulder along the look direction. Rotation is never smoothed:
 * on a touch device any latency between a drag and the view turning is
 * immediately noticeable, so only translation is damped.
 *
 * Occlusion is resolved by sweeping a small sphere from the pivot to the
 * desired camera position and clamping to the first hit. Recovery from a
 * pull-in is deliberately slower than the pull-in itself, so brushing past a
 * wall does not make the camera lurch.
 */

const BASE = {
  distance: 3.5,
  shoulder: 0.62,
  heightOffset: 0.16,
  fov: 75,
};
const ADS = {
  distance: 1.55,
  shoulder: 0.42,
  heightOffset: 0.06,
  fov: 52,
};
const SPHERE_R = 0.28;

const _pivot = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _tmp = new THREE.Vector3();

export class CameraRig {
  constructor() {
    this.order = 60;
    this.distance = BASE.distance;
    this.shoulder = BASE.shoulder;
    this.heightOffset = BASE.heightOffset;
    this.fov = BASE.fov;
    this.occlusion = 1;           // 0..1 fraction of the arm that is clear
    this.smoothPivot = new THREE.Vector3();
    this._init = false;

    // Additive offsets other systems write into: recoil kick and screen shake.
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.shake = 0;
    this._shakeTime = 0;
    this.extraPitch = 0;
    this.extraYaw = 0;
    this.leftHanded = false;
    // Visual-regression scenarios take direct control of the camera.
    this.enabled = true;
  }

  init(services) {
    this.camera = services.get('camera');
    this.player = services.get('player');
    this.physics = services.get('physics');
    this.settings = services.get('settings');
    this.bus = services.get('bus');
    this.camera.fov = this.settings.user.fov;
    this.camera.updateProjectionMatrix();
    services.set('cameraRig', this);

    this.bus.on('player:damaged', (e) => { if (e.amount > 0) this.addShake(Math.min(0.5, e.amount / 120)); });
    this.bus.on('player:land', (e) => { if (e.speed > 8) this.addShake(Math.min(0.35, e.speed / 80)); });
  }

  addShake(amount) { this.shake = Math.min(1, this.shake + amount); }

  /** Apply a recoil impulse in radians; decays back to zero over time. */
  addRecoil(pitch, yaw) { this.recoilPitch += pitch; this.recoilYaw += yaw; }

  /** Field of view for the current aim state, honouring the user's setting. */
  targetFov(aiming, weaponFov) {
    const base = this.settings.user.fov;
    if (!aiming) return base;
    return weaponFov || (base * (ADS.fov / BASE.fov));
  }

  update(dt) {
    if (!this.enabled) return;
    const p = this.player;
    const cam = this.camera;
    const aiming = p.aiming;

    /* --- rig parameters ------------------------------------------------ */
    const k = 1 - Math.exp(-dt * 11);
    const tgt = aiming ? ADS : BASE;
    this.distance += (tgt.distance - this.distance) * k;
    this.shoulder += (tgt.shoulder - this.shoulder) * k;
    this.heightOffset += (tgt.heightOffset - this.heightOffset) * k;

    const fovTarget = this.targetFov(aiming, p.weaponFov);
    cam.fov += (fovTarget - cam.fov) * k;

    /* --- recoil and shake decay ---------------------------------------- */
    const decay = Math.exp(-dt * 7);
    this.recoilPitch *= decay;
    this.recoilYaw *= decay;
    this.shake *= Math.exp(-dt * 6);
    this._shakeTime += dt;

    /* --- pivot ---------------------------------------------------------- */
    _pivot.set(p.position.x, p.position.y + p.eyeHeight + this.heightOffset, p.position.z);
    if (!this._init) { this.smoothPivot.copy(_pivot); this._init = true; }
    // Vertical follow is damped harder than horizontal so stairs and ramps do
    // not bounce the view, while horizontal stays tight for aiming.
    const kh = 1 - Math.exp(-dt * 26);
    const kv = 1 - Math.exp(-dt * (p.body.grounded ? 13 : 22));
    this.smoothPivot.x += (_pivot.x - this.smoothPivot.x) * kh;
    this.smoothPivot.z += (_pivot.z - this.smoothPivot.z) * kh;
    this.smoothPivot.y += (_pivot.y - this.smoothPivot.y) * kv;

    /* --- orientation ----------------------------------------------------- */
    const yaw = p.yaw + this.recoilYaw + this.extraYaw + this._shakeOffset(0.9) * this.shake * 0.05;
    const pitch = THREE.MathUtils.clamp(
      p.pitch + this.recoilPitch + this.extraPitch + this._shakeOffset(1.7) * this.shake * 0.05,
      -1.45, 1.45);

    const cp = Math.cos(pitch);
    _fwd.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp).normalize();
    _right.crossVectors(_fwd, _up).normalize();

    const side = this.leftHanded ? -this.shoulder : this.shoulder;
    _desired.copy(this.smoothPivot).addScaledVector(_right, side).addScaledVector(_fwd, -this.distance);

    /* --- occlusion -------------------------------------------------------- */
    _dir.subVectors(_desired, this.smoothPivot);
    const armLen = _dir.length();
    if (armLen > 1e-4) {
      _dir.multiplyScalar(1 / armLen);
      const hit = this.physics.raycast(this.smoothPivot, _dir, armLen + SPHERE_R, OCCLUDER_FILTER);
      const clearT = hit ? Math.max(0.25, hit.t - SPHERE_R) : armLen;
      const targetOcc = THREE.MathUtils.clamp(clearT / armLen, 0.12, 1);
      // Pull in immediately, ease back out.
      if (targetOcc < this.occlusion) this.occlusion = targetOcc;
      else this.occlusion += (targetOcc - this.occlusion) * (1 - Math.exp(-dt * 5));
      _desired.copy(this.smoothPivot).addScaledVector(_dir, armLen * this.occlusion);
    }

    cam.position.copy(_desired);
    _tmp.copy(this.smoothPivot).addScaledVector(_right, side * this.occlusion).addScaledVector(_fwd, 12);
    cam.lookAt(_tmp);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }

  /** Deterministic pseudo-noise for shake, so replays stay reproducible. */
  _shakeOffset(freq) {
    const t = this._shakeTime * freq;
    return Math.sin(t * 37.1) * 0.6 + Math.sin(t * 61.7) * 0.4;
  }

  /**
   * The exact ray the weapon fires along: from the eye, down the camera's
   * forward axis, so what the crosshair covers is what gets hit.
   */
  aimRay(outOrigin, outDir) {
    outOrigin.set(this.smoothPivot.x, this.smoothPivot.y, this.smoothPivot.z);
    this.camera.getWorldDirection(outDir);
    return { origin: outOrigin, dir: outDir };
  }

  dispose() {}
}

/** Glass and decoration must not push the camera around. */
function OCCLUDER_FILTER(meta) {
  if (!meta) return true;
  if (meta.type === 'structure' && meta.material === 'glass') return false;
  return true;
}
