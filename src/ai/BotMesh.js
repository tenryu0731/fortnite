import * as THREE from 'three';
import * as MeshGen from '../gen/MeshGen.js';
import { weaponGeometry } from '../combat/WeaponMesh.js';
import { CharacterMesh } from '../player/CharacterMesh.js';

/**
 * BotMesh — one merged humanoid geometry, drawn for every bot in the match
 * through a single InstancedMesh.
 *
 * This is a deliberate trade. A per-bot rig like the player's costs six draw
 * calls each; twenty-four of those would eat the entire mobile budget on its
 * own. Bots are almost always seen at engagement range, where a walk cycle's
 * limb detail is a few pixels, so the animation that actually reads at that
 * distance — vertical bob, forward lean, body yaw — is encoded in the instance
 * matrix instead, and the whole opposing team costs one draw call.
 *
 * Outfits vary by per-instance colour, so bots remain visually distinct.
 */

/** Merged body in a neutral carry pose, weapon included. */
function buildBody() {
  const parts = [];
  const W = 0xffffff;   // tinted per instance; geometry stays neutral
  const push = (g, shade) => {
    MeshGen.paintBy(g, () => [shade, shade, shade]);
    parts.push(g);
  };

  // Torso, head and cap. Shades bake the outfit's internal contrast so a single
  // instance colour still produces a readable figure.
  push(MeshGen.xform(MeshGen.roundedBox(0.46, 0.58, 0.27, 0.07, 2), { pos: [0, 1.17, 0] }), 1.0);
  push(MeshGen.xform(MeshGen.roundedBox(0.30, 0.36, 0.18, 0.05, 2), { pos: [0, 1.18, -0.20] }), 0.72);
  push(MeshGen.xform(MeshGen.roundedBox(0.19, 0.11, 0.19, 0.04, 1), { pos: [0, 1.50, 0] }), 1.35);
  push(MeshGen.xform(MeshGen.roundedBox(0.25, 0.26, 0.25, 0.07, 2), { pos: [0, 1.68, 0] }), 1.35);
  push(MeshGen.xform(MeshGen.roundedBox(0.27, 0.09, 0.27, 0.04, 1), { pos: [0, 1.81, 0] }), 0.85);
  push(MeshGen.xform(MeshGen.roundedBox(0.24, 0.03, 0.12, 0.02, 1), { pos: [0, 1.78, 0.17] }), 0.85);

  // Arms held forward in a carry pose, so the silhouette reads as armed.
  for (const side of [-1, 1]) {
    push(MeshGen.xform(MeshGen.roundedBox(0.15, 0.34, 0.16, 0.05, 2),
      { pos: [side * 0.29, 1.23, 0.06], rot: [-0.55, 0, 0] }), 0.92);
    push(MeshGen.xform(MeshGen.roundedBox(0.13, 0.30, 0.14, 0.05, 2),
      { pos: [side * 0.27, 1.02, 0.28], rot: [-0.95, 0, 0] }), 1.28);
  }

  // Legs, slightly parted.
  for (const side of [-1, 1]) {
    push(MeshGen.xform(MeshGen.roundedBox(0.18, 0.50, 0.19, 0.05, 2),
      { pos: [side * 0.12, 0.63, 0] }), 0.62);
    push(MeshGen.xform(MeshGen.roundedBox(0.16, 0.44, 0.18, 0.05, 2),
      { pos: [side * 0.12, 0.21, 0.01] }), 0.42);
  }

  const body = MeshGen.merge(parts);

  // A generic rifle in the hands: bots always carry something, and merging it
  // in keeps the whole team at one draw call.
  const gun = weaponGeometry('rifle', 'common').clone();
  MeshGen.xform(gun, { pos: [0.16, 0.98, 0.34], rot: [0.12, 0, 0] });
  MeshGen.paintBy(gun, () => [0.30, 0.30, 0.32]);
  void W;
  return MeshGen.merge([body, gun]);
}

let _geo = null;
export function botBodyGeometry() {
  if (!_geo) _geo = buildBody();
  return _geo;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();

export class BotMeshPool {
  constructor(capacity, material) {
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(botBodyGeometry(), material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.name = 'bots';
  }

  begin() { this._n = 0; }

  /**
   * Write one bot. `bob` and `lean` carry the walk animation that survives at
   * engagement range; `crouch` squashes the figure.
   */
  write(pos, yaw, bob, lean, crouch, color) {
    if (this._n >= this.capacity) return false;
    const i = this._n++;
    _p.set(pos.x, pos.y + bob, pos.z);
    _e.set(lean, yaw, 0);
    _q.setFromEuler(_e);
    _s.set(1, crouch, 1);
    _m.compose(_p, _q, _s);
    this.mesh.setMatrixAt(i, _m);
    _c.setRGB(color[0], color[1], color[2]);
    this.mesh.setColorAt(i, _c);
    return true;
  }

  end() {
    this.mesh.count = this._n;
    if (this._n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose() { this.mesh.geometry.dispose(); }

  static get HEIGHT() { return CharacterMesh.HEIGHT; }
}
