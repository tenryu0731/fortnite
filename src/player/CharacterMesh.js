import * as THREE from 'three';
import { Rng } from '../gen/Rng.js';
import * as Humanoid from '../gen/Humanoid.js';

/**
 * CharacterMesh — the player's rig: the shared stylised humanoid body (see
 * gen/Humanoid.js) split into five rigid parts, procedurally animated.
 *
 * The body is five rigid parts (torso, two arms, two legs) rather than a
 * skinned mesh: at this art scale rigid limbs read the same as skinning, and
 * five hierarchy nodes are far cheaper to update than a skeleton. A phase
 * accumulator driven by ground speed feeds the limb swing, with additive
 * poses layered on top for crouch, airborne, aiming and the pickaxe chop.
 *
 * FACING. The figure faces -Z, the same as lookDirection() at yaw 0, so the
 * root takes the player's yaw unmodified. Every pose sign below follows from
 * that: an arm hanging along -Y reaches forward when pitched by a POSITIVE
 * angle about X ((0,-1,0) -> (0, -cos a, -sin a)), and the torso leans forward
 * with a NEGATIVE pitch. The previous model faced +Z, so the whole body — arms,
 * chest, cap brim — pointed backwards while a counter-rotated gun pointed
 * forwards.
 */

const HEIGHT = Humanoid.HEIGHT;
const HIP_Y = Humanoid.HIP_Y;
const ARM_LEN = Humanoid.ARM_LEN;
// One pickaxe swing, matched to the tool's 1.4/s fire rate so the animation
// finishes just before the next swing is allowed.
const SWING_TIME = 0.42;
// Arm poses, as (shoulder pitch, elbow bend) pairs. Positive pitch swings a
// hanging limb forward. The barrel is laid along the right forearm, so its
// direction is shoulder + elbow + socket pitch; the socket pitches below make
// that sum land where each pose wants the muzzle.
//
// Aim: weapon arm raised to just under horizontal (raising it fully puts the
// barrel across the head from the over-shoulder camera), elbow nearly
// straight, muzzle level with the crosshair.
const AIM_ARM = 1.24, AIM_ELBOW = 0.25;
const AIM_SOCKET = Math.PI / 2 - (AIM_ARM + AIM_ELBOW);
// Carry: upper arm near the body, forearm forward, muzzle a little low — the
// low-ready every shooter's idle pose uses.
const CARRY_ARM = 0.3, CARRY_ELBOW = 1.0;
const CARRY_SOCKET = (Math.PI / 2 - 0.18) - (CARRY_ARM + CARRY_ELBOW);
// Support hand on the foregrip, reached across the body.
const SUPPORT_CARRY = { arm: 0.5, elbow: 1.05, roll: 0.38 };
const SUPPORT_AIM = { arm: AIM_ARM - 0.02, elbow: 0.5, roll: 0.46 };

export class CharacterMesh {
  constructor(materials, seed = 1, opts = {}) {
    const rng = new Rng(seed);
    const outfit = opts.outfit || rng.pick(Humanoid.OUTFITS);
    this.outfit = outfit;
    this.material = materials.vertex('character');

    this.root = new THREE.Group();
    this.root.name = 'character';

    this.hips = new THREE.Group();
    this.hips.position.y = HIP_Y;
    this.root.add(this.hips);

    const parts = Humanoid.buildParts({ joints: true });
    for (const k of Object.keys(parts)) Humanoid.applyOutfit(parts[k], outfit);

    // Torso, head and pack. Re-based so the mesh origin is the hip joint, which
    // is where lean and crouch should pivot from.
    parts.body.translate(0, -HIP_Y, 0);
    this.torso = new THREE.Mesh(parts.body, this.material);
    this.torso.castShadow = true;
    this.hips.add(this.torso);

    const mkLimb = (geo, pivot) => {
      const node = new THREE.Group();
      node.position.set(pivot[0], pivot[1] - HIP_Y, pivot[2]);
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.castShadow = true;
      node.add(mesh);
      this.hips.add(node);
      return node;
    };
    const P = Humanoid.PIVOTS, B = Humanoid.BONE;
    this.armL = mkLimb(parts.armL, P[B.ARM_L]);
    this.armR = mkLimb(parts.armR, P[B.ARM_R]);
    this.legL = mkLimb(parts.legL, P[B.LEG_L]);
    this.legR = mkLimb(parts.legR, P[B.LEG_R]);
    const mkKnee = (leg, geo) => {
      const node = new THREE.Group();
      node.position.y = -Humanoid.KNEE_DROP;
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.castShadow = true;
      node.add(mesh);
      leg.add(node);
      return node;
    };
    this.kneeL = mkKnee(this.legL, parts.shinL);
    this.kneeR = mkKnee(this.legR, parts.shinR);
    const mkElbow = (arm, geo) => {
      const node = new THREE.Group();
      node.position.y = -Humanoid.ELBOW_DROP;
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.castShadow = true;
      node.add(mesh);
      arm.add(node);
      return node;
    };
    this.elbowL = mkElbow(this.armL, parts.foreL);
    this.elbowR = mkElbow(this.armR, parts.foreR);

    /* --- weapon socket -------------------------------------------------- */
    // In the glove at the end of the right arm, so a held weapon follows the
    // aim pose.
    this.weaponSocket = new THREE.Group();
    this.weaponSocket.position.set(0, -(ARM_LEN - Humanoid.ELBOW_DROP) + 0.04, 0);
    this.elbowR.add(this.weaponSocket);

    this.phase = rng.range(0, Math.PI * 2);
    this.aimBlend = 0;
    this.swingTimer = 0;
    this.twoHanded = true;
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

    // Legs: opposed swing, plus a knees-forward tuck while airborne.
    const tuck = this.airBlend * 0.7;
    this.legL.rotation.x = swing * amp + tuck * 0.9;
    this.legR.rotation.x = -swing * amp + tuck * 0.5;
    // Knees bend backward (negative pitch) on the recovering leg's forward
    // swing, which lifts the foot clear instead of dragging a stiff leg.
    const liftL = Math.max(0, Math.sin(this.phase + 0.9)) * amp * 1.3;
    const liftR = Math.max(0, Math.sin(this.phase + 0.9 + Math.PI)) * amp * 1.3;
    // Crouch: thighs forward and shins back, sized so the feet stay on the
    // ground as the hips drop (0.40 cos 1.1 + 0.46 cos 0.7 = the crouched
    // hip height).
    const cr = this.crouchBlend;
    this.legL.rotation.x += cr * 1.1;
    this.legR.rotation.x += cr * 0.95;
    this.kneeL.rotation.x = -(liftL + cr * 1.8 + tuck * 1.2);
    this.kneeR.rotation.x = -(liftR + cr * 1.6 + tuck * 0.9);
    this.legL.rotation.z = cr * -0.08;
    this.legR.rotation.z = cr * 0.08;

    // Arms. The weapon arm blends between the low-ready carry and the aim
    // pose; the off arm either supports a two-handed weapon or, with the
    // pickaxe, swings freely against the stride.
    const a = this.aimBlend, c = 1 - a;
    const runArm = -swing * amp * 0.75;
    const pitch = p.pitch || 0;
    this.armR.rotation.x = (CARRY_ARM + runArm * 0.25) * c + (AIM_ARM + pitch * 0.9) * a;
    this.elbowR.rotation.x = CARRY_ELBOW * c + AIM_ELBOW * a;
    this.armR.rotation.z = 0.1 * c + 0.02 * a + this.airBlend * 0.4;
    if (this.twoHanded !== false) {
      this.armL.rotation.x = (SUPPORT_CARRY.arm + runArm * 0.2) * c + (SUPPORT_AIM.arm + pitch * 0.9) * a;
      this.elbowL.rotation.x = SUPPORT_CARRY.elbow * c + SUPPORT_AIM.elbow * a;
      this.armL.rotation.z = SUPPORT_CARRY.roll * c + SUPPORT_AIM.roll * a;
    } else {
      this.armL.rotation.x = -runArm;
      this.elbowL.rotation.x = 0.35 + Math.abs(runArm) * 0.4;
      this.armL.rotation.z = -0.1 - this.airBlend * 0.5;
    }

    // Overhead chop: wind up behind the head, strike forward and down, then
    // recover. `t` runs 1 -> 0; the windup takes the first third so the arc
    // accelerates into the hit the way a swung tool does.
    if (this.swingTimer > 0) {
      const t = this.swingTimer / SWING_TIME;
      const arc = t > 0.66 ? (1 - t) / 0.34 : (t / 0.66) ** 0.6;
      this.armR.rotation.x = 0.8 + arc * 2.8;
      this.elbowR.rotation.x = 0.25 + arc * 0.3;
      this.armR.rotation.z = 0.08 + arc * 0.2;
      this.torso.rotation.y = (p.torsoYaw || 0) + arc * 0.3;
    }

    this.weaponSocket.rotation.x = CARRY_SOCKET * c + AIM_SOCKET * a;

    // Torso: vertical bob, forward lean with speed, roll into strafes.
    const bob = Math.abs(swing2) * 0.035 * norm * (1 - this.airBlend);
    const crouchDrop = this.crouchBlend * 0.33;
    this.hips.position.y = HIP_Y + bob - crouchDrop;
    const leanTarget = norm * 0.16 + this.aimBlend * 0.06;
    this.lean += (leanTarget - this.lean) * k;
    // Negative pitch tips the chest toward -Z, i.e. forward.
    this.torso.rotation.x = -(this.lean + this.crouchBlend * 0.30);
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
  static outfitFor(seed) { return Humanoid.OUTFITS[seed % Humanoid.OUTFITS.length]; }
  static get OUTFITS() { return Humanoid.OUTFITS; }
}
