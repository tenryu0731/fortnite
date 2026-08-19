import * as THREE from 'three';
import * as MeshGen from '../gen/MeshGen.js';
import { Rng } from '../gen/Rng.js';
import { srgbHex } from '../gen/Palette.js';

/**
 * CharacterMesh — a procedurally generated, procedurally animated humanoid.
 *
 * The body is five rigid parts (torso group, two arms, two legs) rather than a
 * skinned mesh: at this art scale rigid limbs are indistinguishable from
 * skinning, and five hierarchy nodes are far cheaper to update than a skeleton
 * with a bone texture. Animation is entirely procedural — a phase accumulator
 * driven by ground speed feeds the limb swing, with additive poses layered on
 * top for crouch, airborne and aiming.
 *
 * Outfits are seeded, so every bot in a match looks different without art.
 */

const HEIGHT = 1.8;
const HIP_Y = 0.88;
// One pickaxe swing, matched to the tool's 1.4/s fire rate so the animation
// finishes just before the next swing is allowed.
const SWING_TIME = 0.42;
// Low-ready carry. The weapon socket rides the arm bone, which hangs straight
// down when the arm is lowered — so a rifle at rest ends up aimed at the sky.
// This pitches the socket back to horizontal (plus a touch of muzzle-down) so
// the idle pose reads as carrying a weapon rather than holding it upside down.
// It blends out as the aim pose takes over, where the raised arm already
// points the barrel correctly.
const CARRY_PITCH = Math.PI / 2 + 0.18;
const CARRY_ROLL = 0.22;
// The aim pose stops the arm just under horizontal so the barrel does not
// cross the character's own head from the over-shoulder camera; that leaves
// the weapon tilted about 22 degrees up, which this levels back out so the
// muzzle agrees with the crosshair.
const AIM_PITCH = 0.38;
const SHOULDER_Y = 0.52;      // relative to hips
const ARM_LEN = 0.62;
const LEG_LEN = HIP_Y;

const OUTFITS = [
  { jacket: 0x3d5a8a, trouser: 0x2f3542, boot: 0x23262c, accent: 0xe0a12c },
  { jacket: 0x7a3b46, trouser: 0x3a3138, boot: 0x241f22, accent: 0xd9d2c2 },
  { jacket: 0x3f6b4e, trouser: 0x37402f, boot: 0x22261f, accent: 0xc8b06a },
  { jacket: 0x5a4a7a, trouser: 0x33304a, boot: 0x232030, accent: 0x8fd8e0 },
  { jacket: 0x9a6a3a, trouser: 0x4a3b2c, boot: 0x2b241c, accent: 0xf0e2c0 },
  { jacket: 0x2f4f5f, trouser: 0x293840, boot: 0x1d2226, accent: 0xff8a4c },
];
const SKINS = [0xf0c8a0, 0xd9a173, 0xa9744a, 0x7a4f30, 0x54331f];

/** Limb built with its pivot at the top, extending down -Y. */
function limb(width, length, depth, colorTop, colorBottom, taper = 0.85) {
  const upper = MeshGen.xform(MeshGen.roundedBox(width, length * 0.55, depth, 0.05, 2),
    { pos: [0, -length * 0.275, 0] });
  MeshGen.paint(upper, colorTop);
  const lower = MeshGen.xform(MeshGen.roundedBox(width * taper, length * 0.5, depth * taper, 0.05, 2),
    { pos: [0, -length * 0.78, 0] });
  MeshGen.paint(lower, colorBottom);
  return MeshGen.merge([upper, lower]);
}

export class CharacterMesh {
  constructor(materials, seed = 1, opts = {}) {
    const rng = new Rng(seed);
    const outfit = opts.outfit || rng.pick(OUTFITS);
    const skin = opts.skin || rng.pick(SKINS);
    this.outfit = outfit;
    this.material = materials.vertex('character');

    this.root = new THREE.Group();
    this.root.name = 'character';

    this.hips = new THREE.Group();
    this.hips.position.y = HIP_Y;
    this.root.add(this.hips);

    /* --- torso, head, pack: one static mesh -------------------------- */
    const torsoParts = [];
    torsoParts.push(MeshGen.paint(
      MeshGen.xform(MeshGen.roundedBox(0.46, 0.58, 0.27, 0.07, 2), { pos: [0, 0.29, 0] }), outfit.jacket));
    // Chest stripe reads as a zip/harness and gives the silhouette a front.
    torsoParts.push(MeshGen.paint(
      MeshGen.xform(MeshGen.roundedBox(0.10, 0.42, 0.03, 0.02, 1), { pos: [0, 0.30, 0.145] }), outfit.accent));
    torsoParts.push(MeshGen.paint(
      MeshGen.xform(MeshGen.roundedBox(0.30, 0.36, 0.18, 0.05, 2), { pos: [0, 0.30, -0.20] }), outfit.trouser));
    torsoParts.push(MeshGen.paint(
      MeshGen.xform(MeshGen.roundedBox(0.19, 0.11, 0.19, 0.04, 1), { pos: [0, 0.62, 0] }), skin));
    torsoParts.push(MeshGen.paint(
      MeshGen.xform(MeshGen.roundedBox(0.25, 0.26, 0.25, 0.07, 2), { pos: [0, 0.80, 0] }), skin));
    // Cap: a flat brimmed slab so the head reads with a facing direction.
    torsoParts.push(MeshGen.paint(
      MeshGen.xform(MeshGen.roundedBox(0.27, 0.09, 0.27, 0.04, 1), { pos: [0, 0.93, 0] }), outfit.jacket));
    torsoParts.push(MeshGen.paint(
      MeshGen.xform(MeshGen.roundedBox(0.24, 0.03, 0.12, 0.02, 1), { pos: [0, 0.90, 0.17] }), outfit.jacket));
    this.torso = new THREE.Mesh(MeshGen.merge(torsoParts), this.material);
    this.torso.castShadow = true;
    this.hips.add(this.torso);

    /* --- limbs --------------------------------------------------------- */
    const mkArm = (side) => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.29, SHOULDER_Y, 0);
      const mesh = new THREE.Mesh(limb(0.15, ARM_LEN, 0.16, outfit.jacket, skin), this.material);
      mesh.castShadow = true;
      pivot.add(mesh);
      this.hips.add(pivot);
      return pivot;
    };
    const mkLeg = (side) => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.12, 0, 0);
      const mesh = new THREE.Mesh(limb(0.18, LEG_LEN, 0.19, outfit.trouser, outfit.boot), this.material);
      mesh.castShadow = true;
      pivot.add(mesh);
      this.hips.add(pivot);
      return pivot;
    };
    this.armL = mkArm(-1);
    this.armR = mkArm(1);
    this.legL = mkLeg(-1);
    this.legR = mkLeg(1);

    /* --- weapon socket -------------------------------------------------- */
    // Attached to the right arm so a held weapon follows the aim pose.
    this.weaponSocket = new THREE.Group();
    this.weaponSocket.position.set(0, -ARM_LEN * 0.92, 0.06);
    this.armR.add(this.weaponSocket);

    this.phase = rng.range(0, Math.PI * 2);
    this.aimBlend = 0;
    this.swingTimer = 0;
    this.crouchBlend = 0;
    this.airBlend = 0;
    this.lean = 0;
    this.height = HEIGHT;
  }

  /** Start a melee swing; the arm arcs over the next `SWING_TIME` seconds. */
  swing() { this.swingTimer = SWING_TIME; }

  /**
   * Advance the animation.
   * `p` = { speed, maxSpeed, grounded, crouch, aim, yaw, pitch, strafe }
   */
  update(dt, p) {
    // A melee swing overrides the aim pose entirely: an overhead chop reads as
    // a tool being used, where the rifle-carry pose reads as aiming a gun.
    if (this.swingTimer > 0) this.swingTimer = Math.max(0, this.swingTimer - dt);
    const speed = p.speed || 0;
    const maxSpeed = p.maxSpeed || 7.2;
    const norm = Math.min(1, speed / maxSpeed);

    // Stride frequency rises with speed but not linearly; a constant cadence at
    // walking pace and a faster one at sprint reads better than a pure ratio.
    const cadence = 4.2 + norm * 4.4;
    if (p.grounded) this.phase += dt * cadence * (0.35 + norm * 0.9);

    const target = {
      aim: p.aim ? 1 : 0,
      crouch: p.crouch ? 1 : 0,
      air: p.grounded ? 0 : 1,
    };
    const k = 1 - Math.exp(-dt * 12);
    this.aimBlend += (target.aim - this.aimBlend) * k;
    this.crouchBlend += (target.crouch - this.crouchBlend) * k;
    this.airBlend += (target.air - this.airBlend) * k;

    const swing = Math.sin(this.phase);
    const swing2 = Math.sin(this.phase * 2);
    const amp = norm * 0.85 * (1 - this.airBlend) * (1 - this.crouchBlend * 0.45);

    // Legs: opposed swing, plus a tuck while airborne.
    const tuck = this.airBlend * 0.7;
    this.legL.rotation.x = swing * amp + tuck * 0.9;
    this.legR.rotation.x = -swing * amp + tuck * 0.5;
    this.legL.rotation.z = this.crouchBlend * -0.12;
    this.legR.rotation.z = this.crouchBlend * 0.12;

    // Arms: counter-swing when running, raised and forward when aiming.
    const runArm = -swing * amp * 0.75;
    // Raise the weapon arm to just under horizontal: raising it fully puts the
    // barrel across the character's own head from the over-shoulder camera.
    const aimArmR = -1.24 - (p.pitch || 0) * 0.9;
    const aimArmL = -1.02 - (p.pitch || 0) * 0.9;
    this.armR.rotation.x = runArm * (1 - this.aimBlend) + aimArmR * this.aimBlend;
    this.armL.rotation.x = -runArm * (1 - this.aimBlend) + aimArmL * this.aimBlend;
    this.armR.rotation.z = -0.10 - this.aimBlend * 0.12 + this.airBlend * -0.5;
    this.armL.rotation.z = 0.10 + this.aimBlend * 0.42 + this.airBlend * 0.5;

    // Overhead chop: wind up fast, strike through, recover. `t` runs 1 -> 0.
    if (this.swingTimer > 0) {
      const t = this.swingTimer / SWING_TIME;
      // Windup occupies the first third, the strike the rest, so the arc
      // accelerates into the hit the way a swung tool does.
      const arc = t > 0.66 ? (1 - t) / 0.34 : (t / 0.66) ** 0.6;
      this.armR.rotation.x = -2.5 + arc * 3.4;
      this.armR.rotation.z = -0.10 - arc * 0.25;
      this.torso.rotation.y = (p.torsoYaw || 0) - arc * 0.30;
    }

    this.weaponSocket.rotation.x = -CARRY_PITCH * (1 - this.aimBlend) - AIM_PITCH * this.aimBlend;
    this.weaponSocket.rotation.z = CARRY_ROLL * (1 - this.aimBlend);

    // Torso: vertical bob, forward lean with speed, roll into strafes.
    const bob = Math.abs(swing2) * 0.035 * norm * (1 - this.airBlend);
    const crouchDrop = this.crouchBlend * 0.34;
    this.hips.position.y = HIP_Y + bob - crouchDrop;
    const leanTarget = norm * 0.16 + this.aimBlend * 0.06;
    this.lean += (leanTarget - this.lean) * k;
    this.torso.rotation.x = this.lean + this.crouchBlend * 0.30;
    this.torso.rotation.z = (p.strafe || 0) * -0.08;
    // Head/torso yaw offset so the upper body tracks where the player looks.
    // A swing already set this above and must win.
    if (this.swingTimer <= 0) this.torso.rotation.y = (p.torsoYaw || 0);
  }

  /** Total collision height for the current pose. */
  get poseHeight() { return HEIGHT - this.crouchBlend * 0.45; }

  setVisible(v) { this.root.visible = v; }

  dispose() {
    this.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }

  static get HEIGHT() { return HEIGHT; }
  static outfitFor(seed) { return OUTFITS[seed % OUTFITS.length]; }
  static get OUTFITS() { return OUTFITS; }
}
