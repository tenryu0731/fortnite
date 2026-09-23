import * as THREE from 'three';
import * as MeshGen from '../gen/MeshGen.js';
import * as Humanoid from '../gen/Humanoid.js';
import { weaponGeometry } from '../combat/WeaponMesh.js';

/**
 * BotMesh — the whole opposing team as one InstancedMesh, one draw call.
 *
 * A per-bot rig like the player's costs six draw calls each; twenty-four of
 * those would eat the mobile budget on their own. Instead every bot shares one
 * merged copy of the stylised humanoid (gen/Humanoid.js) in a two-handed carry
 * pose, and the two things a rigid instance cannot do are moved to the GPU:
 *
 *  - Outfits. Each vertex carries the outfit *slot* it belongs to (skin, top,
 *    trousers, boots, accent, hair...) and each instance carries an outfit
 *    row; the vertex shader looks the colour up in a small palette texture.
 *    A single tint per bot made the whole team read as monochrome statues.
 *  - The walk cycle. Each vertex carries its limb, each instance a stride
 *    phase and amplitude, and the vertex shader swings the legs (and a little
 *    of the arms) about their joints. Bots now visibly walk and run.
 *
 * Body bob, forward lean and yaw stay in the instance matrix. The figure faces
 * -Z like lookDirection() at yaw 0, so yaw goes in unmodified.
 */

// Two-handed carry: the rifle rides across the belly, the right hand on the
// grip with the elbow bent, the left reaching across to the foregrip. Pitch is
// forward swing at the shoulder, `in` rolls the arm toward the body's centre,
// elbow bends the forearm forward.
const ARM_R = { pitch: 0.2, in: 0.22, elbow: 1.2 };
const ARM_L = { pitch: 0.62, in: 0.55, elbow: 0.75 };
const GUN_AT = [0.1, 1.13, -0.16];

function buildBody() {
  const body = Humanoid.buildMerged(ARM_R.pitch, ARM_L.in, ARM_R.in, ARM_L.elbow, ARM_R.elbow, ARM_L.pitch);

  // A rifle in the hands: bots always carry something, and merging it in keeps
  // the whole team at one draw call. Authored pointing +Z; turned to face -Z.
  const gun = weaponGeometry('rifle', 'common').clone();
  gun.deleteAttribute('color');
  MeshGen.xform(gun, { rot: [0, Math.PI, 0] });
  MeshGen.xform(gun, { pos: GUN_AT, rot: [-0.06, -0.08, 0] });
  Humanoid.tagProp(gun, Humanoid.PART.GUN, Humanoid.BONE.BODY, 1);
  return MeshGen.merge([body, gun]);
}

let _geo = null;
export function botBodyGeometry() {
  if (!_geo) _geo = buildBody();
  return _geo;
}

/**
 * Lambert with the outfit lookup and the limb swing injected. Lighting, fog,
 * shadows and instancing all stay three's own code.
 */
function botMaterial() {
  const palette = Humanoid.outfitTexture();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPalette = { value: palette };
    shader.uniforms.uPaletteRows = { value: Humanoid.OUTFITS.length };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float part;
attribute float bone;
attribute float aOutfit;
attribute vec2 aWalk;
uniform sampler2D uPalette;
uniform float uPaletteRows;
mat3 walkRotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
// Stride: legs swing opposite each other about the hips; the arms, already
// holding the rifle, only sway a little about the shoulders.
float stride = sin(aWalk.x) * aWalk.y;
float walkAngle = 0.0;
vec3 walkPivot = vec3(0.0);
if (bone > 2.5 && bone < 3.5) { walkAngle = stride; walkPivot = vec3(0.0, ${Humanoid.HIP_Y.toFixed(3)}, 0.0); }
else if (bone > 3.5) { walkAngle = -stride; walkPivot = vec3(0.0, ${Humanoid.HIP_Y.toFixed(3)}, 0.0); }
else if (bone > 0.5 && bone < 2.5) { walkAngle = stride * 0.12; walkPivot = vec3(0.0, ${Humanoid.SHOULDER_Y.toFixed(3)}, 0.0); }
mat3 walkR = walkRotX(walkAngle);
objectNormal = walkR * objectNormal;
`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
transformed = walkR * (transformed - walkPivot) + walkPivot;
`)
      .replace('#include <color_vertex>', `#include <color_vertex>
vec3 outfitColor = texture2D(uPalette, vec2((part + 0.5) / ${Humanoid.PART_COUNT.toFixed(1)}, (aOutfit + 0.5) / uPaletteRows)).rgb;
vColor.rgb *= outfitColor;
`);
  };
  // Distinct cache key: without it three may reuse a plain Lambert program.
  mat.customProgramCacheKey = () => 'bot-humanoid-v1';
  return mat;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _s = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();

export class BotMeshPool {
  constructor(capacity) {
    this.capacity = capacity;
    const geo = botBodyGeometry().clone();
    this.outfitAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.walkAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    this.outfitAttr.setUsage(THREE.DynamicDrawUsage);
    this.walkAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aOutfit', this.outfitAttr);
    geo.setAttribute('aWalk', this.walkAttr);
    this.mesh = new THREE.InstancedMesh(geo, botMaterial(), capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Instance colour stays white in normal play and is used as a hit flash.
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
   * Write one bot. `bob` and `lean` ride in the instance matrix, `phase` and
   * `stride` drive the shader walk cycle, `flash` (0..1) whitens the figure
   * for a hit.
   */
  write(pos, yaw, bob, lean, crouch, outfit, phase = 0, stride = 0, flash = 0) {
    if (this._n >= this.capacity) return false;
    const i = this._n++;
    _p.set(pos.x, pos.y + bob, pos.z);
    // YXZ: yaw first, then lean about the bot's own right axis. The figure
    // faces -Z, so a forward lean is a negative pitch.
    _e.set(-lean, yaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    _s.set(1, crouch, 1);
    _m.compose(_p, _q, _s);
    this.mesh.setMatrixAt(i, _m);
    const f = 1 + flash * 1.6;
    _c.setRGB(f, f, f);
    this.mesh.setColorAt(i, _c);
    this.outfitAttr.array[i] = outfit;
    this.walkAttr.array[i * 2] = phase;
    this.walkAttr.array[i * 2 + 1] = stride;
    return true;
  }

  end() {
    this.mesh.count = this._n;
    if (this._n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
      this.outfitAttr.needsUpdate = true;
      this.walkAttr.needsUpdate = true;
    }
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }

  static get HEIGHT() { return Humanoid.HEIGHT; }
}
