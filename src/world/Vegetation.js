import * as THREE from 'three';
import * as MeshGen from '../gen/MeshGen.js';
import { Rng } from '../gen/Rng.js';
import { srgbHex } from '../gen/Palette.js';
import { SCATTER, SEA_LEVEL } from './Biome.js';

/**
 * Vegetation — instanced scatter of trees, pines, boulders and grass tufts.
 *
 * Placement is computed once at world build time into per-chunk lists. Each
 * frame we only decide which chunks are near enough to draw and, when that set
 * changes, repack the instance matrices. Repacking a few thousand matrices
 * costs a fraction of a millisecond and happens only when the camera crosses a
 * refresh threshold, so the steady-state per-frame cost is four draw calls and
 * no CPU work at all.
 *
 * Grass is handled separately: it is dense, short-range, and rebuilt on a
 * tighter threshold because popping is far more visible up close.
 */
const CHUNK = 128;
const REFRESH_DIST = 24;      // metres of camera travel before repacking props
const GRASS_REFRESH = 7;

const SPECIES = [
  { key: 'tree', density: 1.0, minSlope: 0.80, scale: [0.75, 1.35] },
  { key: 'pine', density: 1.0, minSlope: 0.74, scale: [0.8, 1.5] },
  { key: 'rock', density: 1.0, minSlope: 0.55, scale: [0.5, 1.9] },
];

export class Vegetation {
  constructor(seed) {
    this.order = 30;
    this.seed = seed;
    this.stats = { trees: 0, pines: 0, rocks: 0, grass: 0, drawn: 0, near: 0, far: 0, propTris: 0 };
    this._lastPack = new THREE.Vector3(1e9, 0, 1e9);
    this._lastGrass = new THREE.Vector3(1e9, 0, 1e9);
  }

  init(services) {
    this.scene = services.get('scene');
    this.camera = services.get('camera');
    this.settings = services.get('settings');
    this.terrain = services.get('terrain');
    this.materials = services.get('materials');
    this.colliders = services.get('colliders');

    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    this.scene.add(this.group);

    this._buildPrototypes();
    this._scatter();
    this._buildInstancedMeshes();
    this.repack(true);
    this.repackGrass(true);
  }

  /**
   * Prototypes come in two tiers. The near tier is the full recursive tree or
   * tiered pine; the far tier is a handful of triangles that preserves the
   * silhouette and colour. At the switch distance the two read the same, and
   * the far tier costs roughly one twentieth of the geometry.
   */
  _buildPrototypes() {
    const rng = Rng.forStream(this.seed, 'veg-proto');
    const t = MeshGen.tree({ seed: rng.int(1e6), height: 9.5, foliageSize: 2.6 });
    const p = MeshGen.pine({ seed: rng.int(1e6), height: 12, radius: 2.3, tiers: 4 });
    const r = MeshGen.rockLump(1.0, 1, rng.int(1e6), 0.38);
    MeshGen.paint(r, 0x8a8880, 0.22, rng);

    // Far proxies must match the near tier's silhouette and mean albedo,
    // otherwise the LOD switch shows up as a visible colour and size seam.
    // Bounds and colours below are taken from the measured near-tier geometry.
    const treeLeafCol = srgbHex(0x4c8c3d);
    const pineLeafCol = srgbHex(0x3a7245);
    const shade = (col, k) => [col[0] * k, col[1] * k, col[2] * k];

    // Near tree canopy occupies y 6.2..10.4 with a ~3.6m radius.
    const farTreeParts = [
      MeshGen.paint(MeshGen.xform(MeshGen.box(0.55, 6.6, 0.55), { pos: [0, 3.3, 0] }), 0x6b4b32),
      MeshGen.paintBy(
        MeshGen.xform(new THREE.IcosahedronGeometry(3.5, 0), { pos: [0, 8.2, 0], scale: [1, 0.62, 1] }),
        (x, y) => shade(treeLeafCol, 0.90 + Math.min(1, Math.max(0, (y - 6.2) / 4.2)) * 0.30),
      ),
    ];
    // Near pine canopy occupies y 2.7..11.0 with a ~2.2m base radius.
    const farPineParts = [
      MeshGen.paint(MeshGen.xform(MeshGen.box(0.48, 3.4, 0.48), { pos: [0, 1.7, 0] }), 0x5a4231),
      MeshGen.paintBy(MeshGen.xform(new THREE.ConeGeometry(2.25, 5.4, 5, 1, true), { pos: [0, 5.4, 0] }),
        (x, y) => shade(pineLeafCol, 0.76 + Math.min(1, Math.max(0, y / 11)) * 0.30)),
      MeshGen.paintBy(MeshGen.xform(new THREE.ConeGeometry(1.45, 4.2, 5, 1, true), { pos: [0, 8.9, 0] }),
        (x, y) => shade(pineLeafCol, 0.76 + Math.min(1, Math.max(0, y / 11)) * 0.30)),
    ];

    this.proto = {
      treeWood: t.wood, treeLeaves: t.leaves,
      pineWood: p.wood, pineLeaves: p.leaves,
      rock: r,
      treeFar: MeshGen.merge(farTreeParts),
      pineFar: MeshGen.merge(farPineParts),
      grass: MeshGen.grassTuft(rng.int(1e6), 5, 0.66, 0.07),
    };
    this.protoTris = {
      treeNear: MeshGen.triCount(t.wood) + MeshGen.triCount(t.leaves),
      pineNear: MeshGen.triCount(p.wood) + MeshGen.triCount(p.leaves),
      treeFar: MeshGen.triCount(this.proto.treeFar),
      pineFar: MeshGen.triCount(this.proto.pineFar),
      rock: MeshGen.triCount(r),
    };
  }

  /** Poisson-ish scatter: jittered grid samples rejected by biome weight. */
  _scatter() {
    const rng = Rng.forStream(this.seed, 'veg-scatter');
    const terrain = this.terrain;
    const half = terrain.size / 2;
    const density = this.settings.q.vegetationDensity;
    const n = Math.ceil(terrain.size / CHUNK);

    this.chunkProps = new Map();   // chunk key -> { tree:[], pine:[], rock:[] }
    this.chunkCenters = [];

    const SPACING = 7.5;           // metres between candidate sample points
    const perChunk = Math.floor(CHUNK / SPACING);

    for (let cz = 0; cz < n; cz++) {
      for (let cx = 0; cx < n; cx++) {
        const key = cz * 64 + cx;
        const lists = { tree: [], pine: [], rock: [] };
        const x0 = -half + cx * CHUNK, z0 = -half + cz * CHUNK;
        for (let j = 0; j < perChunk; j++) {
          for (let i = 0; i < perChunk; i++) {
            const x = x0 + (i + rng.next()) * SPACING;
            const z = z0 + (j + rng.next()) * SPACING;
            const h = terrain.heightAt(x, z);
            if (h < SEA_LEVEL + 1.0) continue;
            const slope = terrain.slopeAt(x, z);
            const biome = terrain.biomeAt(x, z);
            const w = SCATTER[biome];
            const roll = rng.next();
            let acc = 0;
            let placed = null;
            for (let s = 0; s < SPECIES.length; s++) {
              acc += w[s] * density * 0.42;
              if (roll < acc) { placed = SPECIES[s]; break; }
            }
            if (!placed) continue;
            if (slope < placed.minSlope) continue;
            const scale = rng.range(placed.scale[0], placed.scale[1]);
            lists[placed.key].push({
              x, y: h, z,
              rot: rng.range(0, Math.PI * 2),
              scale,
              tilt: placed.key === 'rock' ? rng.range(-0.25, 0.25) : rng.range(-0.05, 0.05),
            });
          }
        }
        this.chunkProps.set(key, lists);
        this.chunkCenters.push({ key, x: x0 + CHUNK / 2, z: z0 + CHUNK / 2 });
        this.stats.trees += lists.tree.length;
        this.stats.pines += lists.pine.length;
        this.stats.rocks += lists.rock.length;
      }
    }

    // Static collision: trunks and boulders. Foliage is walk-through.
    const min = new THREE.Vector3(), max = new THREE.Vector3();
    for (const lists of this.chunkProps.values()) {
      for (const t of lists.tree) {
        const r = 0.42 * t.scale;
        min.set(t.x - r, t.y, t.z - r); max.set(t.x + r, t.y + 7 * t.scale, t.z + r);
        this.colliders.add(min, max, { type: 'tree', harvest: 'wood', x: t.x, y: t.y, z: t.z });
      }
      for (const t of lists.pine) {
        const r = 0.4 * t.scale;
        min.set(t.x - r, t.y, t.z - r); max.set(t.x + r, t.y + 9 * t.scale, t.z + r);
        this.colliders.add(min, max, { type: 'tree', harvest: 'wood', x: t.x, y: t.y, z: t.z });
      }
      for (const t of lists.rock) {
        const r = 1.0 * t.scale;
        min.set(t.x - r, t.y - 0.4, t.z - r); max.set(t.x + r, t.y + r * 0.9, t.z + r);
        this.colliders.add(min, max, { type: 'rock', harvest: 'brick', x: t.x, y: t.y, z: t.z });
      }
    }
  }

  _buildInstancedMeshes() {
    const bark = this.materials.vertex('bark');
    const leaf = this.materials.vertex('leaf');
    const stone = this.materials.vertex('stone');
    const shadows = this.settings.q.shadows;
    const q = this.settings.q;

    // Capacity is bounded by the area each tier can cover, not by world totals.
    const area = (r) => Math.PI * r * r;
    const perM2 = {
      tree: this.stats.trees / (this.terrain.size * this.terrain.size),
      pine: this.stats.pines / (this.terrain.size * this.terrain.size),
      rock: this.stats.rocks / (this.terrain.size * this.terrain.size),
    };
    // 2.5x headroom absorbs clustering: props are far from uniformly spread.
    const cap = (rate, radius) => Math.max(8, Math.ceil(rate * area(radius) * 2.5) + 16);

    const mk = (geo, mat, count, castShadow) => {
      const m = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = castShadow && shadows;
      m.receiveShadow = shadows;
      m.frustumCulled = false;   // culled per chunk on the CPU instead
      m.count = 0;
      this.group.add(m);
      return m;
    };

    this.im = {
      // Near tier: full geometry, casts shadows.
      treeWood: mk(this.proto.treeWood, bark, cap(perM2.tree, q.propNearDistance), true),
      treeLeaves: mk(this.proto.treeLeaves, leaf, cap(perM2.tree, q.propNearDistance), true),
      pineWood: mk(this.proto.pineWood, bark, cap(perM2.pine, q.propNearDistance), true),
      pineLeaves: mk(this.proto.pineLeaves, leaf, cap(perM2.pine, q.propNearDistance), true),
      // Far tier: proxy geometry, no shadow casting (they are past the shadow
      // volume anyway, and the cost would double their triangle count).
      treeFar: mk(this.proto.treeFar, leaf, cap(perM2.tree, q.propDistance), false),
      pineFar: mk(this.proto.pineFar, leaf, cap(perM2.pine, q.propDistance), false),
      rock: mk(this.proto.rock, stone, cap(perM2.rock, q.propDistance), true),
    };

    // Blades are flat strips, so they must render from both faces or half the
    // tufts vanish depending on view angle.
    const grassMat = this.materials.vertex('grass', { side: THREE.DoubleSide });
    const grassCap = q.grassDensity > 0 ? 1400 : 1;
    this.grassMesh = mk(this.proto.grass, grassMat, grassCap, false);
    this.grassMesh.castShadow = false;
  }

  /** Repack instance matrices for chunks within view distance. */
  repack(force = false) {
    const cam = this.camera.position;
    if (!force && this._lastPack.distanceTo(cam) < REFRESH_DIST) return false;
    this._lastPack.copy(cam);

    const q = this.settings.q;
    // Chunk-level reject uses the far radius plus a chunk diagonal of slack, so
    // a prop near a chunk corner is never dropped early.
    const farR = q.propDistance, nearR = q.propNearDistance;
    const chunkReject = (farR + CHUNK) * (farR + CHUNK);
    const far2 = farR * farR, near2 = nearR * nearR;
    const c8 = { treeWood: 0, treeLeaves: 0, pineWood: 0, pineLeaves: 0, treeFar: 0, pineFar: 0, rock: 0 };
    const limit = {};
    for (const k of Object.keys(c8)) limit[k] = this.im[k].instanceMatrix.count;

    for (const c of this.chunkCenters) {
      const cdx = c.x - cam.x, cdz = c.z - cam.z;
      if (cdx * cdx + cdz * cdz > chunkReject) continue;
      const lists = this.chunkProps.get(c.key);

      for (const t of lists.tree) {
        const dx = t.x - cam.x, dz = t.z - cam.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > far2) continue;
        _pos.set(t.x, t.y, t.z);
        _quat.setFromEuler(_euler.set(t.tilt, t.rot, 0));
        _scl.setScalar(t.scale);
        _mat.compose(_pos, _quat, _scl);
        if (d2 <= near2) {
          if (c8.treeWood >= limit.treeWood) continue;
          this.im.treeWood.setMatrixAt(c8.treeWood++, _mat);
          this.im.treeLeaves.setMatrixAt(c8.treeLeaves++, _mat);
        } else {
          if (c8.treeFar >= limit.treeFar) continue;
          this.im.treeFar.setMatrixAt(c8.treeFar++, _mat);
        }
      }

      for (const t of lists.pine) {
        const dx = t.x - cam.x, dz = t.z - cam.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > far2) continue;
        _pos.set(t.x, t.y, t.z);
        _quat.setFromEuler(_euler.set(t.tilt, t.rot, 0));
        _scl.setScalar(t.scale);
        _mat.compose(_pos, _quat, _scl);
        if (d2 <= near2) {
          if (c8.pineWood >= limit.pineWood) continue;
          this.im.pineWood.setMatrixAt(c8.pineWood++, _mat);
          this.im.pineLeaves.setMatrixAt(c8.pineLeaves++, _mat);
        } else {
          if (c8.pineFar >= limit.pineFar) continue;
          this.im.pineFar.setMatrixAt(c8.pineFar++, _mat);
        }
      }

      for (const t of lists.rock) {
        const dx = t.x - cam.x, dz = t.z - cam.z;
        if (dx * dx + dz * dz > far2) continue;
        if (c8.rock >= limit.rock) continue;
        _pos.set(t.x, t.y + t.scale * 0.25, t.z);
        _quat.setFromEuler(_euler.set(t.tilt, t.rot, t.tilt * 0.6));
        _scl.setScalar(t.scale);
        _mat.compose(_pos, _quat, _scl);
        this.im.rock.setMatrixAt(c8.rock++, _mat);
      }
    }

    for (const k of Object.keys(c8)) {
      this.im[k].count = c8[k];
      this.im[k].instanceMatrix.needsUpdate = true;
    }
    this.stats.drawn = c8.treeWood + c8.pineWood + c8.rock;
    this.stats.near = c8.treeWood + c8.pineWood;
    this.stats.far = c8.treeFar + c8.pineFar;
    this.stats.propTris =
      c8.treeWood * this.protoTris.treeNear + c8.pineWood * this.protoTris.pineNear +
      c8.treeFar * this.protoTris.treeFar + c8.pineFar * this.protoTris.pineFar +
      c8.rock * this.protoTris.rock;
    return true;
  }

  /** Grass ring around the camera on a jittered lattice. */
  repackGrass(force = false) {
    const q = this.settings.q;
    if (q.grassDensity <= 0 || !this.grassMesh) return false;
    const cam = this.camera.position;
    if (!force && this._lastGrass.distanceTo(cam) < GRASS_REFRESH) return false;
    this._lastGrass.copy(cam);

    const range = q.grassDistance;
    const spacing = 1.05 / Math.max(0.35, q.grassDensity);
    const cap = this.grassMesh.instanceMatrix.count;
    const terrain = this.terrain;
    const bx = Math.floor(cam.x / spacing) * spacing;
    const bz = Math.floor(cam.z / spacing) * spacing;
    const steps = Math.floor(range / spacing);
    let n = 0;

    for (let j = -steps; j <= steps && n < cap; j++) {
      for (let i = -steps; i <= steps && n < cap; i++) {
        const gx = bx + i * spacing, gz = bz + j * spacing;
        const dx = gx - cam.x, dz = gz - cam.z;
        if (dx * dx + dz * dz > range * range) continue;
        // Deterministic hash jitter keeps tufts stable as the camera moves.
        const hsh = ((Math.round(gx * 13.7) * 73856093) ^ (Math.round(gz * 13.7) * 19349663)) >>> 0;
        const jx = ((hsh & 255) / 255 - 0.5) * spacing;
        const jz = (((hsh >> 8) & 255) / 255 - 0.5) * spacing;
        const x = gx + jx, z = gz + jz;
        const h = terrain.heightAt(x, z);
        if (h < SEA_LEVEL + 0.8) continue;
        if (terrain.slopeAt(x, z) < 0.82) continue;
        const biome = terrain.biomeAt(x, z);
        const w = SCATTER[biome][3];
        if (w < 0.2 || ((hsh >> 16) & 255) / 255 > w * 0.92) continue;
        _pos.set(x, h, z);
        _quat.setFromEuler(_euler.set(0, ((hsh >> 20) & 255) / 255 * Math.PI * 2, 0));
        _scl.setScalar(0.75 + ((hsh >> 12) & 15) / 15 * 0.6);
        _mat.compose(_pos, _quat, _scl);
        this.grassMesh.setMatrixAt(n++, _mat);
      }
    }
    this.grassMesh.count = n;
    this.grassMesh.instanceMatrix.needsUpdate = true;
    this.stats.grass = n;
    return true;
  }

  update() {
    this.repack(false);
    this.repackGrass(false);
  }

  dispose() {
    for (const k of Object.keys(this.im || {})) {
      this.im[k].geometry.dispose();
      this.group.remove(this.im[k]);
    }
    if (this.grassMesh) { this.grassMesh.geometry.dispose(); this.group.remove(this.grassMesh); }
    this.scene.remove(this.group);
  }
}

const _mat = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3(1, 1, 1);
const _euler = new THREE.Euler();
