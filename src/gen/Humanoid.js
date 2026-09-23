import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import * as MeshGen from './MeshGen.js';

/**
 * Humanoid — the one stylised character body shared by the player rig and the
 * instanced bots.
 *
 * Proportions follow the genre rather than anatomy: a large head (about a
 * sixth of the height), broad shoulders over a tapered waist, chunky gloves and
 * boots. Every part is a smooth rounded primitive — capsules, spheres, bevelled
 * boxes with welded normals — because at third-person scale the silhouette and
 * the soft shading are what make a figure read as a "character" rather than a
 * stack of crates.
 *
 * Coordinate convention: the figure stands on y = 0 and FACES -Z, the same
 * direction `lookDirection()` returns at yaw 0. A model that faces +Z has to
 * be spun half a turn by every caller, and forgetting that once is exactly how
 * the previous character ended up aiming over its own shoulder.
 *
 * Geometry carries two extra attributes:
 *   part  — which outfit colour slot a vertex takes (see PART)
 *   bone  — which rigid limb it belongs to (see BONE), used by the bots'
 *           vertex-shader walk cycle
 * and a `color` attribute holding a greyscale shade (baked occlusion and
 * detail contrast) that the outfit colour multiplies.
 */

export const HEIGHT = 1.8;
export const HIP_Y = 0.86;
export const SHOULDER_Y = 1.38;
export const SHOULDER_X = 0.265;
export const HIP_X = 0.11;
export const ARM_LEN = 0.6;
/** Hip-to-knee distance; the shin hangs from here in the player rig. */
export const KNEE_DROP = 0.4;
/** Shoulder-to-elbow distance. */
export const ELBOW_DROP = 0.28;

export const BONE = { BODY: 0, ARM_L: 1, ARM_R: 2, LEG_L: 3, LEG_R: 4 };
export const PART = { SKIN: 0, TOP: 1, BOTTOM: 2, BOOT: 3, ACCENT: 4, HAIR: 5, DARK: 6, PACK: 7, GUN: 8 };
export const PART_COUNT = 9;
/** Carried weapons are gunmetal whatever the outfit. */
const GUN_COLOR = 0x3c424c;

/**
 * Outfits: bold, saturated, two-tone, in the genre's toy-like palette. Each is
 * [skin, top, bottom, boot, accent, hair, dark, pack] in sRGB hex.
 */
export const OUTFITS = [
  [0xf1c7a0, 0xf07a2a, 0x2c3e5c, 0x3a2a22, 0x2fc9d8, 0x5a3520, 0x1a1a22, 0x4a5a3a],
  [0xd9a173, 0x6a3fc8, 0x2a2438, 0x201c26, 0xffd23f, 0x1e1a1a, 0x16141c, 0x3a2f5a],
  [0xa9744a, 0xd83a3a, 0x1e1e24, 0x121214, 0xf2f2f2, 0x14100e, 0x121212, 0x2e2e36],
  [0xf1c7a0, 0x3f8f4a, 0x5a4a32, 0x3a2e22, 0xe0b24a, 0xc8903a, 0x1a1a1a, 0x5a6a3a],
  [0x7a4f30, 0xff6fa8, 0xf4f4f8, 0xd8d8e0, 0x3a3a48, 0x2a1a14, 0x151515, 0x8a5a9a],
  [0xd9a173, 0x2a7fd8, 0xe8e2d0, 0x6a4a30, 0xff8a2a, 0x3a2a1a, 0x181820, 0x2a4a6a],
  [0x54331f, 0x1f1f26, 0x2f3a46, 0x141418, 0x58e070, 0x0e0c0c, 0x0c0c0e, 0x2a3036],
  [0xf1c7a0, 0xf4d23a, 0x3a3a44, 0x2a2a30, 0xe23a5a, 0xa04a2a, 0x161616, 0x5a4a2a],
];

/** Weld and re-normal a geometry so a rounded primitive shades smoothly. */
function smooth(g) {
  g.deleteAttribute('uv');
  const w = mergeVertices(g, 1e-4);
  w.computeVertexNormals();
  return w;
}

/** Tag every vertex with a part, a bone and a greyscale shade. */
function tag(g, part, bone, shade = 1, shadeFn = null) {
  const n = g.getAttribute('position').count;
  const pa = new Float32Array(n).fill(part);
  const ba = new Float32Array(n).fill(bone);
  const col = new Float32Array(n * 3);
  const pos = g.getAttribute('position');
  for (let i = 0; i < n; i++) {
    const s = shadeFn ? shadeFn(pos.getX(i), pos.getY(i), pos.getZ(i)) * shade : shade;
    col[i * 3] = s; col[i * 3 + 1] = s; col[i * 3 + 2] = s;
  }
  g.setAttribute('part', new THREE.BufferAttribute(pa, 1));
  g.setAttribute('bone', new THREE.BufferAttribute(ba, 1));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Capsule along -Y from the origin, i.e. with its pivot at the top joint. */
// Tessellation level. The player rig is seen up close and gets the full count;
// the instanced bots are drawn two dozen times (twice, with the shadow pass)
// and mostly seen at range, so they build with the low set.
let LOW = false;
const seg = (hi, lo) => (LOW ? lo : hi);

function capsule(r, len, radial = 8) {
  const g = new THREE.CapsuleGeometry(r, len, seg(3, 2), seg(radial, 6));
  g.translate(0, -len / 2, 0);
  return smooth(g);
}

function sphere(r, ws = 12, hs = 9) {
  return smooth(new THREE.SphereGeometry(r, seg(ws, Math.max(5, Math.round(ws * 0.62))), seg(hs, Math.max(4, Math.round(hs * 0.62)))));
}

function rounded(w, h, d, r, n = 3) {
  return smooth(MeshGen.roundedBox(w, h, d, r, seg(n, Math.max(1, n - 1))));
}

/**
 * Build the body as five bone groups, each in its bone's local space (pivot at
 * the joint), so the player rig can parent them to animated nodes.
 */
export function buildParts(opts = {}) {
  LOW = !!opts.low;
  const detail = !LOW;         // small details that only read up close
  const body = [], armL = [], armR = [], legL = [], legR = [];

  /* --- torso ---------------------------------------------------------- */
  // Tapered from broad shoulders to a narrower waist: the V is most of what
  // makes the genre's figures read as heroic rather than boxy.
  const torso = rounded(0.46, 0.56, 0.29, 0.1, 3);
  const tp = torso.getAttribute('position');
  for (let i = 0; i < tp.count; i++) {
    const t = (tp.getY(i) + 0.28) / 0.56;            // 0 waist .. 1 shoulders
    tp.setX(i, tp.getX(i) * (0.84 + t * 0.24));
    tp.setZ(i, tp.getZ(i) * (0.92 + t * 0.1));
  }
  torso.computeVertexNormals();
  torso.translate(0, HIP_Y + 0.3, 0);
  // Darker toward the waist: cheap occlusion that separates torso from legs.
  body.push(tag(torso, PART.TOP, BONE.BODY, 1, (x, y) => 0.78 + Math.min(1, (y - HIP_Y) / 0.56) * 0.26));

  // Chest detail: a zip stripe down the front and a belt.
  const zip = rounded(0.07, 0.4, 0.04, 0.015, 1);
  zip.translate(0, HIP_Y + 0.33, -0.15);
  body.push(tag(zip, PART.ACCENT, BONE.BODY, 1));
  const belt = rounded(0.43, 0.075, 0.31, 0.03, 2);
  belt.translate(0, HIP_Y + 0.04, 0);
  body.push(tag(belt, PART.ACCENT, BONE.BODY, 0.85));
  if (detail) {
    const buckle = rounded(0.08, 0.06, 0.03, 0.01, 1);
    buckle.translate(0, HIP_Y + 0.04, -0.165);
    body.push(tag(buckle, PART.DARK, BONE.BODY, 2.2));
  }
  // Pelvis, in trouser colour, bridges the belt to the thighs.
  const pelvis = rounded(0.38, 0.16, 0.27, 0.07, 2);
  pelvis.translate(0, HIP_Y - 0.04, 0);
  body.push(tag(pelvis, PART.BOTTOM, BONE.BODY, 0.9));
  // Backpack: the silhouette cue that tells you which way someone faces.
  const pack = rounded(0.32, 0.36, 0.14, 0.06, 2);
  pack.translate(0, HIP_Y + 0.34, 0.2);
  body.push(tag(pack, PART.PACK, BONE.BODY, 1, (x, y) => 0.8 + (y - HIP_Y) * 0.35));
  if (detail) {
    const flap = rounded(0.28, 0.1, 0.05, 0.02, 1);
    flap.translate(0, HIP_Y + 0.46, 0.28);
    body.push(tag(flap, PART.ACCENT, BONE.BODY, 0.8));
  }

  /* --- head ------------------------------------------------------------ */
  const neck = capsule(0.07, 0.06, 8);
  neck.translate(0, SHOULDER_Y + 0.11, 0);
  body.push(tag(neck, PART.SKIN, BONE.BODY, 0.82));
  const head = sphere(0.155, 14, 11);
  head.scale(1, 1.08, 1);
  head.translate(0, SHOULDER_Y + 0.25, 0);
  body.push(tag(head, PART.SKIN, BONE.BODY, 1, (x, y) => 0.9 + (y - SHOULDER_Y - 0.1) * 0.5));
  // Hair: a cap over the crown and back of the head, open at the face.
  const hair = smooth(new THREE.SphereGeometry(0.168, seg(14, 9), seg(8, 5), 0, Math.PI * 2, 0, Math.PI * 0.56));
  hair.rotateX(0.32);                               // tip the open side to the face (-Z)
  hair.scale(1, 1.06, 1.02);
  hair.translate(0, SHOULDER_Y + 0.27, 0.012);
  body.push(tag(hair, PART.HAIR, BONE.BODY, 1));
  // Eyes and brows: two dark dots are enough to give an opponent a face.
  for (const s of [-1, 1]) {
    const eye = sphere(0.022, 6, 5);
    eye.scale(1, 1.35, 0.6);
    eye.translate(s * 0.055, SHOULDER_Y + 0.26, -0.148);
    body.push(tag(eye, PART.DARK, BONE.BODY, 1));
  }

  /* --- arms (pivot at the shoulder, optional elbow) ----------------------- */
  // As with the legs, the forearm is built about the elbow joint so it can be
  // bent: a rifle is carried with bent elbows, and straight rigid arms held
  // out in front read as a zombie rather than a soldier.
  const foreL = [], foreR = [];
  const mkArm = (list, fore, bone) => {
    const shoulder = sphere(0.1, 10, 8);
    shoulder.scale(1, 0.9, 1);
    list.push(tag(shoulder, PART.TOP, bone, 1.05));
    const upper = capsule(0.078, 0.2, 8);
    list.push(tag(upper, PART.TOP, bone, 1));
    if (detail) {
      const elbow = sphere(0.075, 8, 6);
      fore.push(tag(elbow, PART.TOP, bone, 0.9));
      const cuff = capsule(0.08, 0.03, 8);
      cuff.translate(0, 0.01, 0);
      fore.push(tag(cuff, PART.TOP, bone, 0.85));
    }
    const arm = capsule(0.068, 0.2, 8);
    fore.push(tag(arm, PART.SKIN, bone, 0.95));
    // Oversized glove: chunky hands are a genre signature.
    const glove = sphere(0.075, 9, 7);
    glove.scale(0.9, 1.1, 1);
    glove.translate(0, -(ARM_LEN - ELBOW_DROP) + 0.03, 0);
    fore.push(tag(glove, PART.ACCENT, bone, 0.9));
  };
  mkArm(armL, foreL, BONE.ARM_L);
  mkArm(armR, foreR, BONE.ARM_R);

  /* --- legs (pivot at the hip, optional knee) ------------------------------ */
  // Everything below the knee is built relative to the knee joint and then
  // either merged back into the leg (bots: one rigid leg, animated in the
  // vertex shader) or returned separately so the player rig can bend it.
  const shinL = [], shinR = [];
  const mkLeg = (list, lower, bone) => {
    const thigh = capsule(0.1, 0.3, 8);
    list.push(tag(thigh, PART.BOTTOM, bone, 1));
    if (detail) {
      const knee = sphere(0.092, 8, 6);
      knee.translate(0, 0.02, -0.01);
      lower.push(tag(knee, PART.BOTTOM, bone, 0.85));
    }
    const shin = capsule(0.085, 0.28, 8);
    shin.translate(0, -0.02, 0);
    lower.push(tag(shin, PART.BOTTOM, bone, 0.92));
    // Boot, lengthened toward the toe (-Z) so the stance has a direction.
    const footY = -(HIP_Y - KNEE_DROP);
    const boot = rounded(0.16, 0.13, 0.27, 0.05, 2);
    boot.translate(0, footY + 0.065, -0.045);
    lower.push(tag(boot, PART.BOOT, bone, 1));
    if (detail) {
      const sole = rounded(0.165, 0.035, 0.28, 0.012, 1);
      sole.translate(0, footY + 0.017, -0.045);
      lower.push(tag(sole, PART.DARK, bone, 1.6));
    }
  };
  mkLeg(legL, shinL, BONE.LEG_L);
  mkLeg(legR, shinR, BONE.LEG_R);

  const m = (list) => MeshGen.merge(list);
  if (opts.joints) {
    return {
      body: m(body), armL: m(armL), armR: m(armR), legL: m(legL), legR: m(legR),
      foreL: m(foreL), foreR: m(foreR), shinL: m(shinL), shinR: m(shinR),
    };
  }
  // Rigid limbs: fold each lower segment back onto its parent, optionally
  // bent at the joint (the bots' static carry pose).
  const hang = (list, drop, bend = 0) => list.map((g) => {
    if (bend) g.rotateX(bend);
    return g.translate(0, -drop, 0);
  });
  const eL = opts.elbowL || 0, eR = opts.elbowR || 0;
  return {
    body: m(body),
    armL: m([...armL, ...hang(foreL, ELBOW_DROP, eL)]),
    armR: m([...armR, ...hang(foreR, ELBOW_DROP, eR)]),
    legL: m([...legL, ...hang(shinL, KNEE_DROP)]),
    legR: m([...legR, ...hang(shinR, KNEE_DROP)]),
  };
}

/** Where each bone's local origin sits in the standing figure. */
export const PIVOTS = {
  [BONE.BODY]: [0, 0, 0],
  [BONE.ARM_L]: [-SHOULDER_X, SHOULDER_Y, 0],
  [BONE.ARM_R]: [SHOULDER_X, SHOULDER_Y, 0],
  [BONE.LEG_L]: [-HIP_X, HIP_Y, 0],
  [BONE.LEG_R]: [HIP_X, HIP_Y, 0],
};

/**
 * The whole figure merged in world (figure) space, for instanced rendering.
 * `armPose` pitches both arms about their shoulders so a bot's merged body is
 * already in its carry pose; the vertex shader animates on top of that.
 */
export function buildMerged(armPose = 0, armL_in = 0, armR_in = 0, elbowL = 0, elbowR = 0, armPoseL = null, low = true) {
  const parts = buildParts({ elbowL, elbowR, low });
  const place = (g, bone, pitch = 0, roll = 0) => {
    const [x, y, z] = PIVOTS[bone];
    const c = g.clone();
    if (roll) c.rotateZ(roll);
    if (pitch) c.rotateX(pitch);
    c.translate(x, y, z);
    return c;
  };
  return MeshGen.merge([
    place(parts.body, BONE.BODY),
    place(parts.armL, BONE.ARM_L, armPoseL === null ? armPose : armPoseL, armL_in),
    place(parts.armR, BONE.ARM_R, armPose, -armR_in),
    place(parts.legL, BONE.LEG_L),
    place(parts.legR, BONE.LEG_R),
  ]);
}

/** Tag an arbitrary geometry (a carried weapon) so it merges with the body. */
export function tagProp(g, part, bone, shade = 1) { return tag(g, part, bone, shade); }

/** Paint a geometry's parts with an outfit, for the per-object player rig. */
export function applyOutfit(geo, outfit) {
  const part = geo.getAttribute('part');
  const col = geo.getAttribute('color');
  const c = new THREE.Color();
  const cols = [...outfit, GUN_COLOR].map((hex) => new THREE.Color(hex));
  for (let i = 0; i < part.count; i++) {
    c.copy(cols[part.getX(i)]);
    const s = col.getX(i);
    col.setXYZ(i, c.r * s, c.g * s, c.b * s);
  }
  col.needsUpdate = true;
  return geo;
}

/** Outfit palette as a PART_COUNT x N float RGB texture, for the bot shader. */
export function outfitTexture(outfits = OUTFITS) {
  const data = new Float32Array(PART_COUNT * outfits.length * 4);
  const c = new THREE.Color();
  outfits.forEach((o, row) => {
    for (let k = 0; k < PART_COUNT; k++) {
      c.set(k < o.length ? o[k] : GUN_COLOR);         // sRGB hex -> linear
      const i = (row * PART_COUNT + k) * 4;
      data[i] = c.r; data[i + 1] = c.g; data[i + 2] = c.b; data[i + 3] = 1;
    }
  });
  const tex = new THREE.DataTexture(data, PART_COUNT, outfits.length, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
