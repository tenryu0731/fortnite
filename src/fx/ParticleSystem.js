import * as THREE from 'three';
import { Rng } from '../gen/Rng.js';

/**
 * ParticleSystem — a fixed-capacity CPU particle pool drawn as one InstancedMesh.
 *
 * Everything is preallocated in typed arrays and the live set is kept dense by
 * swapping the last particle into a dead slot, so emitting and killing are O(1)
 * and the whole system allocates nothing per frame. Only the live prefix of the
 * instance buffers is uploaded each frame, which matters because on mobile the
 * upload, not the draw, is the cost of a particle system.
 *
 * Two instances of this class are used: an additive one for muzzle flashes,
 * sparks and tracer glow, and a lit one for debris and dust. Two draw calls
 * cover every effect in the game.
 */
export class ParticleSystem {
  constructor(capacity, material, geometry, seed = 1) {
    this.capacity = capacity;
    this.rng = new Rng(seed);
    this.count = 0;

    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.size1 = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    this.angle = new Float32Array(capacity);
    this.r0 = new Float32Array(capacity); this.g0 = new Float32Array(capacity); this.b0 = new Float32Array(capacity);
    this.r1 = new Float32Array(capacity); this.g1 = new Float32Array(capacity); this.b1 = new Float32Array(capacity);
    this.billboard = new Uint8Array(capacity);

    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.count = 0;

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._camQ = new THREE.Quaternion();
  }

  /**
   * Emit one particle. Returns false when the pool is full — effects degrade by
   * dropping detail rather than by stalling or growing.
   */
  emit(o) {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    this.px[i] = o.x; this.py[i] = o.y; this.pz[i] = o.z;
    this.vx[i] = o.vx || 0; this.vy[i] = o.vy || 0; this.vz[i] = o.vz || 0;
    this.gravity[i] = o.gravity ?? 0;
    this.drag[i] = o.drag ?? 0;
    this.life[i] = 0;
    this.maxLife[i] = o.life ?? 0.5;
    this.size0[i] = o.size0 ?? 0.1;
    this.size1[i] = o.size1 ?? 0;
    this.spin[i] = o.spin ?? 0;
    this.angle[i] = o.angle ?? 0;
    const c0 = o.color0 || [1, 1, 1];
    const c1 = o.color1 || c0;
    this.r0[i] = c0[0]; this.g0[i] = c0[1]; this.b0[i] = c0[2];
    this.r1[i] = c1[0]; this.g1[i] = c1[1]; this.b1[i] = c1[2];
    this.billboard[i] = o.billboard === false ? 0 : 1;
    return true;
  }

  _kill(i) {
    const last = --this.count;
    if (i === last) return;
    const move = (a) => { a[i] = a[last]; };
    move(this.px); move(this.py); move(this.pz);
    move(this.vx); move(this.vy); move(this.vz);
    move(this.gravity); move(this.drag);
    move(this.life); move(this.maxLife);
    move(this.size0); move(this.size1);
    move(this.spin); move(this.angle);
    move(this.r0); move(this.g0); move(this.b0);
    move(this.r1); move(this.g1); move(this.b1);
    this.billboard[i] = this.billboard[last];
  }

  update(dt, camera) {
    camera.getWorldQuaternion(this._camQ);
    const colors = this.mesh.instanceColor.array;

    for (let i = 0; i < this.count; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) { this._kill(i); i--; continue; }

      const d = this.drag[i];
      if (d > 0) {
        const k = Math.exp(-d * dt);
        this.vx[i] *= k; this.vy[i] *= k; this.vz[i] *= k;
      }
      this.vy[i] += this.gravity[i] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.angle[i] += this.spin[i] * dt;

      const t = this.life[i] / this.maxLife[i];
      const size = this.size0[i] + (this.size1[i] - this.size0[i]) * t;

      this._p.set(this.px[i], this.py[i], this.pz[i]);
      if (this.billboard[i]) {
        this._q.copy(this._camQ);
        if (this.angle[i] !== 0) this._q.multiply(_spin.setFromAxisAngle(_zAxis, this.angle[i]));
      } else {
        this._q.setFromAxisAngle(_yAxis, this.angle[i]);
      }
      this._s.setScalar(size);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);

      const o = i * 3;
      colors[o] = this.r0[i] + (this.r1[i] - this.r0[i]) * t;
      colors[o + 1] = this.g0[i] + (this.g1[i] - this.g0[i]) * t;
      colors[o + 2] = this.b0[i] + (this.b1[i] - this.b0[i]) * t;
    }

    this.mesh.count = this.count;
    if (this.count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
      // Only the live prefix is dirty; uploading the whole buffer every frame
      // is the usual reason a particle system shows up in a mobile profile.
      this.mesh.instanceMatrix.addUpdateRange(0, this.count * 16);
      this.mesh.instanceColor.addUpdateRange(0, this.count * 3);
    }
  }

  clear() { this.count = 0; this.mesh.count = 0; }

  dispose() { this.mesh.geometry.dispose(); }
}

const _spin = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _yAxis = new THREE.Vector3(0, 1, 0);
