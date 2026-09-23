import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from './Rng.js';
import { Noise } from './Noise.js';
import { srgb } from './Palette.js';

/**
 * MeshGen — procedural BufferGeometry builders.
 *
 * Colour is baked into vertices wherever possible so that a whole prop family
 * shares one material (ARCHITECTURE.md 4.4). Anything built here is merged into
 * as few draw calls as the subsystem can manage.
 */

const _c = new THREE.Color();

/** Bake a flat colour into a geometry's `color` attribute. */
export function paint(geo, hex, jitter = 0, rng = null) {
  const pos = geo.getAttribute('position');
  const n = pos.count;
  const arr = new Float32Array(n * 3);
  _c.set(hex);
  for (let i = 0; i < n; i++) {
    let r = _c.r, g = _c.g, b = _c.b;
    if (jitter > 0 && rng) {
      const j = 1 + (rng.next() - 0.5) * jitter;
      r *= j; g *= j; b *= j;
    }
    arr[i * 3] = r; arr[i * 3 + 1] = g; arr[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Per-vertex colour from a callback receiving object-space position. */
export function paintBy(geo, fn) {
  const pos = geo.getAttribute('position');
  const n = pos.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = fn(pos.getX(i), pos.getY(i), pos.getZ(i), i);
    arr[i * 3] = c[0]; arr[i * 3 + 1] = c[1]; arr[i * 3 + 2] = c[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Ensure a geometry carries the attributes required for a merge set. */
function normalizeForMerge(geo) {
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  if (!geo.getAttribute('uv')) {
    const n = geo.getAttribute('position').count;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (!geo.getAttribute('color')) paint(geo, 0xffffff);
  return geo.index ? geo.toNonIndexed() : geo;
}

/** Merge a list of geometries into one, tolerating mismatched attribute sets. */
export function merge(geos) {
  if (geos.length === 0) return new THREE.BufferGeometry();
  if (geos.length === 1) return normalizeForMerge(geos[0]);
  const prepared = geos.map(normalizeForMerge);
  const out = mergeGeometries(prepared, false);
  for (const g of prepared) g.dispose();
  return out || prepared[0];
}

/** Apply a transform to a geometry in place, then return it (chainable). */
export function xform(geo, { pos, rot, scale, quat } = {}) {
  const m = new THREE.Matrix4();
  const q = quat || new THREE.Quaternion();
  if (!quat && rot) q.setFromEuler(new THREE.Euler(rot[0] || 0, rot[1] || 0, rot[2] || 0));
  m.compose(
    new THREE.Vector3(pos ? pos[0] : 0, pos ? pos[1] : 0, pos ? pos[2] : 0),
    q,
    new THREE.Vector3(scale ? scale[0] : 1, scale ? scale[1] : 1, scale ? scale[2] : 1),
  );
  geo.applyMatrix4(m);
  return geo;
}

export function box(w, h, d, color) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (color !== undefined) paint(g, color);
  return g;
}

/** Rounded box built from a scaled/beveled box — cheap silhouette softening. */
export function roundedBox(w, h, d, r = 0.06, seg = 2, color) {
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  const pos = g.getAttribute('position');
  const hw = w / 2 - r, hh = h / 2 - r, hd = d / 2 - r;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const cx = THREE.MathUtils.clamp(v.x, -hw, hw);
    const cy = THREE.MathUtils.clamp(v.y, -hh, hh);
    const cz = THREE.MathUtils.clamp(v.z, -hd, hd);
    const dx = v.x - cx, dy = v.y - cy, dz = v.z - cz;
    const len = Math.hypot(dx, dy, dz) || 1;
    pos.setXYZ(i, cx + (dx / len) * r, cy + (dy / len) * r, cz + (dz / len) * r);
  }
  g.computeVertexNormals();
  if (color !== undefined) paint(g, color);
  return g;
}

/** A staircase of `steps` boxes filling a w x h x d volume. */
export function stairs(w, h, d, steps = 8, color = 0xa0a0a0) {
  const parts = [];
  const sh = h / steps, sd = d / steps;
  for (let i = 0; i < steps; i++) {
    const g = new THREE.BoxGeometry(w, sh, sd);
    xform(g, { pos: [0, -h / 2 + sh * (i + 0.5), d / 2 - sd * (i + 0.5)] });
    parts.push(g);
  }
  const merged = merge(parts);
  paint(merged, color);
  return merged;
}

/**
 * Displaced icosphere — the base shape for boulders and cliff chunks.
 * `detail` 1 gives 80 tris, 2 gives 320; keep it at 1 for scatter props.
 */
export function rockLump(radius = 1, detail = 1, seed = 1, roughness = 0.34) {
  const g = new THREE.IcosahedronGeometry(radius, detail);
  const noise = new Noise(seed);
  const pos = g.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = noise.fbm2(v.x * 1.4, v.z * 1.4 + v.y * 0.9, 3);
    const s = 1 + n * roughness;
    v.multiplyScalar(s);
    v.y *= 0.82; // squash so boulders sit rather than float
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Tapered cylinder segment used for trunks and branches. */
function limb(r0, r1, len, radialSeg = 5) {
  const g = new THREE.CylinderGeometry(r1, r0, len, radialSeg, 1, true);
  g.translate(0, len / 2, 0);
  return g;
}

/** Leaf palette shared by the near trees and their far proxies (sRGB hex). */
export const TREE_LEAF = 0x5fae3c;
export const TREE_LEAF_DARK = 0x2f6e2a;
export const TREE_BARK = 0x7a5436;
export const PINE_LEAF = 0x3f8c4a;
export const PINE_BARK = 0x6a4a33;

/**
 * Replace a canopy's normals with ones radiating from an ellipsoid centre.
 *
 * This is the standard trick behind stylised foliage: individual blobs shade
 * as one soft volume, so a cluster of low-poly spheres reads as a single puffy
 * crown lit from the sun side instead of a pile of faceted rocks.
 */
export function sphericalNormals(geo, cx, cy, cz, rx = 1, ry = 1, rz = 1) {
  const pos = geo.getAttribute('position');
  const nrm = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    // Gradient of the ellipsoid field, which is the true surface normal of a
    // stretched sphere rather than a naive radial direction.
    v.set((pos.getX(i) - cx) / (rx * rx), (pos.getY(i) - cy) / (ry * ry), (pos.getZ(i) - cz) / (rz * rz));
    if (v.lengthSq() < 1e-9) v.set(0, 1, 0);
    v.normalize();
    nrm[i * 3] = v.x; nrm[i * 3 + 1] = v.y; nrm[i * 3 + 2] = v.z;
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return geo;
}

/**
 * Stylised broadleaf tree: a short, slightly curved trunk that splits into a
 * few thick limbs, under one broad, puffy crown built from overlapping blobs.
 *
 * The crown is shaded as a single volume (see sphericalNormals) and graded
 * from a cool dark underside to a warm lime top, which is what makes the
 * genre's trees read as soft and round rather than faceted.
 *
 * Returned as two merged geometries so bark and foliage can use different
 * materials. Kept under 500 triangles: trees are instanced by the hundred.
 */
export function tree(opts = {}) {
  const {
    seed = 1, height = 9, trunkRadius = 0.36, foliageSize = 2.4,
    barkColor = TREE_BARK, leafColor = TREE_LEAF, leafDark = TREE_LEAF_DARK,
  } = opts;
  const rng = new Rng(seed);
  const woodParts = [];

  // Trunk to the fork, then three limbs reaching into the crown.
  const fork = height * 0.42;
  const trunk = limb(trunkRadius, trunkRadius * 0.72, fork, 6);
  woodParts.push(trunk);
  const crownY = height * 0.72;
  const crownR = foliageSize * 1.5;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const dir = new THREE.Vector3(Math.cos(a) * 0.55, 1, Math.sin(a) * 0.55).normalize();
    const len = (crownY - fork) * 1.15;
    const g = limb(trunkRadius * 0.62, trunkRadius * 0.28, len, 5);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    xform(g, { pos: [0, fork - 0.1, 0], quat: q });
    woodParts.push(g);
  }

  // Crown: a big central blob ringed by smaller ones, wider than tall.
  const blobs = [];
  const main = new THREE.IcosahedronGeometry(1, 1);
  xform(main, { pos: [0, crownY + crownR * 0.1, 0], scale: [crownR, crownR * 0.78, crownR] });
  blobs.push(main);
  const ring = 4;
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2 + rng.range(-0.35, 0.35);
    const r = crownR * rng.range(0.52, 0.66);
    const d = crownR * rng.range(0.55, 0.72);
    const g = new THREE.IcosahedronGeometry(1, 1);
    xform(g, {
      pos: [Math.cos(a) * d, crownY - crownR * rng.range(0.05, 0.25), Math.sin(a) * d],
      scale: [r, r * 0.82, r],
      rot: [0, rng.range(0, 3.14), 0],
    });
    blobs.push(g);
  }
  let leaves = merge(blobs);
  const rx = crownR * 1.55, ry = crownR * 0.95;
  sphericalNormals(leaves, 0, crownY - crownR * 0.1, 0, rx, ry, rx);

  const wood = merge(woodParts);
  paint(wood, barkColor, 0.14, rng);

  // Underside dark and cool, crown bright and warm: reads as ambient
  // occlusion and sky light without a shader.
  const lo = new THREE.Color(leafDark), hi = new THREE.Color(leafColor);
  const top = crownY + crownR * 0.9, bottom = crownY - crownR * 0.8;
  paintBy(leaves, (x, y) => {
    const t = THREE.MathUtils.clamp((y - bottom) / (top - bottom), 0, 1);
    _c.copy(lo).lerp(hi, Math.pow(t, 0.75));
    const k = 0.94 + rng.next() * 0.12;
    return [_c.r * k, _c.g * k, _c.b * k];
  });
  return { wood, leaves, crown: { y: crownY, r: crownR } };
}

/** Low-poly pine: stacked cones. Cheaper than the deciduous recursion. */
export function pine(opts = {}) {
  const { seed = 1, height = 11, radius = 2.1, tiers = 4, trunkRadius = 0.3,
    barkColor = PINE_BARK, leafColor = PINE_LEAF } = opts;
  const rng = new Rng(seed);
  const trunk = limb(trunkRadius, trunkRadius * 0.6, height * 0.42, 5);
  paint(trunk, barkColor, 0.15, rng);
  const parts = [];
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const r = radius * (1 - t * 0.62);
    const h = height * 0.34 * (1 - t * 0.18);
    const g = new THREE.ConeGeometry(r, h, 6, 1, true);
    xform(g, { pos: [0, height * 0.26 + t * height * 0.52 + h * 0.4, 0], rot: [0, rng.range(0, 1.0), 0] });
    parts.push(g);
  }
  const leaves = merge(parts);
  paintBy(leaves, (x, y) => {
    const t = THREE.MathUtils.clamp(y / height, 0, 1);
    _c.set(leafColor);
    const k = 0.6 + t * 0.6;
    return [_c.r * k, _c.g * k, _c.b * k];
  });
  return { wood: trunk, leaves };
}

/**
 * Grass tuft: blades built as tapered, forward-bent strips rather than quads.
 * Tapering to a point is what stops a blade from reading as a paper card, and
 * costs nothing extra — it is the same triangle count as a subdivided plane.
 * Meant to be rendered double-sided, since a blade is visible from both faces.
 */
export function grassTuft(seed = 1, blades = 4, height = 0.62, width = 0.075) {
  const rng = new Rng(seed);
  const SEG = 3;
  const vertCount = (SEG + 1) * 2;
  const positions = new Float32Array(blades * vertCount * 3);
  const colors = new Float32Array(blades * vertCount * 3);
  const indices = [];
  // Authored in sRGB; the attribute is read as linear.
  const ROOT_COL = srgb(0.25, 0.46, 0.11);
  const TIP_COL = srgb(0.64, 0.84, 0.31);

  for (let b = 0; b < blades; b++) {
    const h = height * rng.range(0.65, 1.35);
    const w = width * rng.range(0.8, 1.3);
    const yaw = rng.range(0, Math.PI * 2);
    const lean = rng.range(0.18, 0.55);
    const ox = rng.range(-0.14, 0.14), oz = rng.range(-0.14, 0.14);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const tint = rng.range(0.85, 1.15);
    const base = b * vertCount;

    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      const y = t * h;
      // Quadratic bend forward along the blade's own facing direction.
      const fwd = t * t * h * lean;
      const halfW = w * (1 - t) * (1 - t * 0.35);
      for (let side = 0; side < 2; side++) {
        const sw = side === 0 ? -halfW : halfW;
        const px = ox + cy * sw + sy * fwd;
        const pz = oz - sy * sw + cy * fwd;
        const i = (base + s * 2 + side) * 3;
        positions[i] = px; positions[i + 1] = y; positions[i + 2] = pz;
        colors[i] = (ROOT_COL[0] + (TIP_COL[0] - ROOT_COL[0]) * t) * tint;
        colors[i + 1] = (ROOT_COL[1] + (TIP_COL[1] - ROOT_COL[1]) * t) * tint;
        colors[i + 2] = (ROOT_COL[2] + (TIP_COL[2] - ROOT_COL[2]) * t) * tint;
      }
    }
    for (let s = 0; s < SEG; s++) {
      const a = base + s * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  const n = positions.length / 3;
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}

/** Hollow window/door frame built from four boxes. */
export function frame(w, h, thickness = 0.12, depth = 0.16, color = 0xd8d2c4) {
  const parts = [
    xform(box(w, thickness, depth), { pos: [0, h / 2 - thickness / 2, 0] }),
    xform(box(w, thickness, depth), { pos: [0, -h / 2 + thickness / 2, 0] }),
    xform(box(thickness, h - thickness * 2, depth), { pos: [-w / 2 + thickness / 2, 0, 0] }),
    xform(box(thickness, h - thickness * 2, depth), { pos: [w / 2 - thickness / 2, 0, 0] }),
  ];
  const g = merge(parts);
  paint(g, color);
  return g;
}

/** Extrude a closed 2D profile along +Z. Used for weapon silhouettes. */
export function extrude(points, depth, color, bevel = 0) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1, curveSegments: 2,
  });
  g.translate(0, 0, -depth / 2);
  if (color !== undefined) paint(g, color);
  return g;
}

/** Triangle count of a geometry, for budget assertions. */
export function triCount(geo) {
  if (geo.index) return geo.index.count / 3;
  return geo.getAttribute('position').count / 3;
}

export { THREE };
