import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from './Rng.js';
import { Noise } from './Noise.js';

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

/**
 * Recursive tree: tapered trunk + branches, returned as two merged geometries
 * so bark and foliage can use different materials.
 * Vertex counts are deliberately low — trees are instanced by the thousand.
 */
export function tree(opts = {}) {
  const {
    seed = 1, height = 9, trunkRadius = 0.34, depth = 2,
    branches = 3, spread = 0.62, foliageSize = 2.4, radialSeg = 4,
    barkColor = 0x6b4b32, leafColor = 0x3f7a35,
  } = opts;
  const rng = new Rng(seed);
  const woodParts = [];
  const leafParts = [];
  const leafGeoCache = new THREE.IcosahedronGeometry(1, 0);

  const grow = (origin, dir, len, r, level) => {
    const g = limb(r, r * 0.68, len, radialSeg);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    xform(g, { pos: [origin.x, origin.y, origin.z], quat: q });
    woodParts.push(g);
    const tip = origin.clone().addScaledVector(dir, len);
    if (level >= depth) {
      const s = foliageSize * (0.62 + rng.next() * 0.5) * (1 - level * 0.1);
      const lg = leafGeoCache.clone();
      xform(lg, {
        pos: [tip.x, tip.y, tip.z],
        scale: [s, s * 0.82, s],
        rot: [rng.range(0, 3.14), rng.range(0, 3.14), rng.range(0, 3.14)],
      });
      leafParts.push(lg);
      return;
    }
    const n = branches + (level === 0 && rng.next() < 0.4 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.range(-0.4, 0.4);
      const tilt = spread * rng.range(0.7, 1.3);
      const nd = new THREE.Vector3(Math.cos(a) * tilt, 1, Math.sin(a) * tilt).normalize();
      nd.lerp(dir, 0.25).normalize();
      grow(tip, nd, len * rng.range(0.6, 0.78), r * 0.62, level + 1);
    }
  };

  grow(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), height * 0.42, trunkRadius, 0);
  leafGeoCache.dispose();

  const wood = merge(woodParts);
  paint(wood, barkColor, 0.18, rng);
  const leaves = merge(leafParts);
  // Vertical gradient on foliage reads as ambient occlusion without a shader.
  paintBy(leaves, (x, y) => {
    const t = THREE.MathUtils.clamp((y - height * 0.25) / (height * 0.8), 0, 1);
    _c.set(leafColor);
    const k = 0.62 + t * 0.55;
    return [_c.r * k, _c.g * k, _c.b * k];
  });
  return { wood, leaves };
}

/** Low-poly pine: stacked cones. Cheaper than the deciduous recursion. */
export function pine(opts = {}) {
  const { seed = 1, height = 11, radius = 2.1, tiers = 4, trunkRadius = 0.3,
    barkColor = 0x5a4231, leafColor = 0x2f5f3a } = opts;
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

/** Grass tuft: a few crossed quads, vertex-coloured from root to tip. */
export function grassTuft(seed = 1, blades = 3, height = 0.55, width = 0.13) {
  const rng = new Rng(seed);
  const parts = [];
  for (let i = 0; i < blades; i++) {
    const h = height * rng.range(0.7, 1.25);
    const g = new THREE.PlaneGeometry(width, h, 1, 2);
    const pos = g.getAttribute('position');
    // Bend the blade so it does not read as a flat card.
    for (let k = 0; k < pos.count; k++) {
      const y = pos.getY(k) + h / 2;
      const t = y / h;
      pos.setZ(k, t * t * h * 0.34);
    }
    g.computeVertexNormals();
    xform(g, { pos: [rng.range(-0.12, 0.12), h / 2, rng.range(-0.12, 0.12)], rot: [0, rng.range(0, Math.PI), 0] });
    paintBy(g, (x, y) => {
      const t = THREE.MathUtils.clamp(y / h, 0, 1);
      return [0.18 + t * 0.30, 0.32 + t * 0.42, 0.12 + t * 0.16];
    });
    parts.push(g);
  }
  return merge(parts);
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
