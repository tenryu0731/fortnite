import * as THREE from 'three';

/**
 * Decals — bullet holes as a fixed-capacity ring of instanced quads.
 *
 * Decals accumulate over a whole match, so the buffer is a ring: the oldest is
 * always the one recycled. They are oriented to the surface normal and pushed
 * out along it slightly to stay clear of z-fighting, with polygon offset on the
 * material as a second line of defence on tile-based mobile GPUs where depth
 * precision is coarser.
 */
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 0, 1);

export class Decals {
  constructor(capacity, material) {
    this.capacity = Math.max(1, capacity);
    this.head = 0;
    this.count = 0;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.InstancedMesh(geo, material, this.capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3).fill(1), 3);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 2;
  }

  /** Place a decal at a hit point, aligned to the surface. */
  place(point, normal, size = 0.22, tint = null, spin = 0) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;

    _n.copy(normal).normalize();
    _p.copy(point).addScaledVector(_n, 0.02);
    // A plane's local +Z is its normal; rotate that onto the surface normal.
    _q.setFromUnitVectors(_up, _n);
    if (spin) _q.multiply(_spinQ.setFromAxisAngle(_up, spin));
    _s.set(size, size, size);
    _m.compose(_p, _q, _s);
    this.mesh.setMatrixAt(i, _m);
    if (tint) {
      const c = this.mesh.instanceColor.array;
      c[i * 3] = tint[0]; c[i * 3 + 1] = tint[1]; c[i * 3 + 2] = tint[2];
      this.mesh.instanceColor.needsUpdate = true;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = this.count;
    return i;
  }

  clear() { this.count = 0; this.head = 0; this.mesh.count = 0; }

  dispose() { this.mesh.geometry.dispose(); }
}

const _spinQ = new THREE.Quaternion();
