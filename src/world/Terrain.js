import * as THREE from 'three';
import { HeightField } from './HeightField.js';
import { colorAt, SEA_LEVEL } from './Biome.js';

/**
 * Terrain — chunked, distance-LODed meshes over a HeightField.
 *
 * The island is divided into `CHUNK` metre squares. Each chunk picks one of
 * four vertex densities from its distance to the camera and is rebuilt only
 * when that choice changes. Rebuilds are amortised across frames by a work
 * queue (`MAX_BUILDS_PER_FRAME`) so crossing a chunk boundary never produces a
 * visible hitch.
 *
 * Adjacent chunks at different LODs would leave cracks, so every chunk carries
 * a downward skirt around its border sized to the worst-case vertical gap.
 * That is cheaper and far more robust than stitching index buffers.
 */
const CHUNK = 128;
const LOD_SEGS = [64, 32, 16, 8];          // vertices per side - 1
const LOD_DIST = [190, 340, 560, Infinity]; // metres, scaled by quality bias
const MAX_BUILDS_PER_FRAME = 2;

const _v = new THREE.Vector3();
const _box = new THREE.Box3();
const _sphere = new THREE.Sphere();

export class Terrain {
  constructor(seed, opts = {}) {
    this.order = 20;
    this.seed = seed;
    this.size = opts.size || 1024;
    this.field = new HeightField(seed, { size: this.size, step: 2 });
    this.chunksPerSide = Math.ceil(this.size / CHUNK);
    this.chunks = [];
    this.queue = [];
    this.frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this.stats = { visible: 0, built: 0, queued: 0, triangles: 0 };
  }

  async init(services) {
    this.services = services;
    this.scene = services.get('scene');
    this.camera = services.get('camera');
    this.settings = services.get('settings');
    this.materials = services.get('materials');

    this.field.bake();

    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this.scene.add(this.group);

    this.material = this.materials.surface('ground', { repeat: 1, vertexColors: true, normalScale: 0.5 });

    const n = this.chunksPerSide;
    const half = this.size / 2;
    for (let cz = 0; cz < n; cz++) {
      for (let cx = 0; cx < n; cx++) {
        this.chunks.push({
          cx, cz,
          x0: -half + cx * CHUNK,
          z0: -half + cz * CHUNK,
          centerX: -half + cx * CHUNK + CHUNK / 2,
          centerZ: -half + cz * CHUNK + CHUNK / 2,
          lod: -1, wantLod: -1,
          mesh: null,
          minY: 0, maxY: 0,
          queued: false,
        });
      }
    }
    // Precompute vertical bounds so frustum culling has a real bounding volume
    // before the chunk has ever been meshed.
    for (const c of this.chunks) this._computeBounds(c);

    this._buildWater();

    // Seed the world with the chunks around the origin so the first rendered
    // frame is never empty.
    this.updateLods(true);
    this.flushQueue(this.chunks.length);
  }

  _computeBounds(c) {
    let mn = Infinity, mx = -Infinity;
    const step = CHUNK / 8;
    for (let j = 0; j <= 8; j++) {
      for (let i = 0; i <= 8; i++) {
        const h = this.field.heightAt(c.x0 + i * step, c.z0 + j * step);
        if (h < mn) mn = h;
        if (h > mx) mx = h;
      }
    }
    // Pad for interpolation error between the coarse probe and the real mesh.
    c.minY = mn - 8; c.maxY = mx + 8;
  }

  _buildWater() {
    const g = new THREE.PlaneGeometry(this.size * 1.6, this.size * 1.6, 1, 1);
    g.rotateX(-Math.PI / 2);
    const uv = g.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 90, uv.getY(i) * 90);
    const mat = this.materials.surface('fabric', { repeat: 1 });
    mat.color = new THREE.Color(0x2f6f9e);
    mat.transparent = true;
    mat.opacity = 0.86;
    this.water = new THREE.Mesh(g, mat);
    this.water.position.y = SEA_LEVEL;
    this.water.renderOrder = -1;
    this.water.name = 'water';
    this.group.add(this.water);
    this._waterMat = mat;
  }

  /* ------------------------------------------------------------------ */
  /* chunk meshing                                                       */
  /* ------------------------------------------------------------------ */

  _buildChunkGeometry(c, lod) {
    const segs = LOD_SEGS[lod];
    const cell = CHUNK / segs;
    const vpr = segs + 1;                    // vertices per row
    const gridVerts = vpr * vpr;
    const skirtVerts = vpr * 4;
    const total = gridVerts + skirtVerts;

    const pos = new Float32Array(total * 3);
    const nrm = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const col = new Float32Array(total * 3);
    const idx = new Uint32Array(segs * segs * 6 + segs * 4 * 6);

    const field = this.field;
    const rgb = [0, 0, 0];
    const nv = new THREE.Vector3();
    // Skirt depth must exceed the largest elevation difference the coarser
    // neighbour could introduce across one of its cells.
    const skirtDepth = cell * 2.5 + 2;

    let minY = Infinity, maxY = -Infinity;

    for (let j = 0; j < vpr; j++) {
      const z = c.z0 + j * cell;
      for (let i = 0; i < vpr; i++) {
        const x = c.x0 + i * cell;
        const k = j * vpr + i;
        const h = field.heightAt(x, z);
        if (h < minY) minY = h;
        if (h > maxY) maxY = h;
        pos[k * 3] = x - c.centerX;
        pos[k * 3 + 1] = h;
        pos[k * 3 + 2] = z - c.centerZ;
        field.normalAt(x, z, nv);
        nrm[k * 3] = nv.x; nrm[k * 3 + 1] = nv.y; nrm[k * 3 + 2] = nv.z;
        uv[k * 2] = x / 5.5; uv[k * 2 + 1] = z / 5.5;
        const moist = field.moistureAt(x, z);
        // Cheap deterministic per-vertex variation to break up flat colour.
        const varn = ((i * 73856093) ^ (j * 19349663) ^ (c.cx * 83492791)) & 255;
        colorAt(h, moist, nv.y, varn / 255, rgb);
        col[k * 3] = rgb[0]; col[k * 3 + 1] = rgb[1]; col[k * 3 + 2] = rgb[2];
      }
    }

    let t = 0;
    for (let j = 0; j < segs; j++) {
      for (let i = 0; i < segs; i++) {
        const a = j * vpr + i, b = a + 1, cc = a + vpr, d = cc + 1;
        idx[t++] = a; idx[t++] = cc; idx[t++] = b;
        idx[t++] = b; idx[t++] = cc; idx[t++] = d;
      }
    }

    // Skirts: duplicate each border vertex, drop it, and bridge the pair.
    let sv = gridVerts;
    const addSkirt = (borderIndex, count, stride, start) => {
      const first = sv;
      for (let n = 0; n < count; n++) {
        const src = start + n * stride;
        pos[sv * 3] = pos[src * 3];
        pos[sv * 3 + 1] = pos[src * 3 + 1] - skirtDepth;
        pos[sv * 3 + 2] = pos[src * 3 + 2];
        nrm[sv * 3] = nrm[src * 3]; nrm[sv * 3 + 1] = nrm[src * 3 + 1]; nrm[sv * 3 + 2] = nrm[src * 3 + 2];
        uv[sv * 2] = uv[src * 2]; uv[sv * 2 + 1] = uv[src * 2 + 1];
        col[sv * 3] = rgb[0] * 0 + col[src * 3] * 0.7;
        col[sv * 3 + 1] = col[src * 3 + 1] * 0.7;
        col[sv * 3 + 2] = col[src * 3 + 2] * 0.7;
        sv++;
      }
      for (let n = 0; n < count - 1; n++) {
        const a = start + n * stride, b = start + (n + 1) * stride;
        const sa = first + n, sb = first + n + 1;
        if (borderIndex === 0 || borderIndex === 3) {
          idx[t++] = a; idx[t++] = sa; idx[t++] = b;
          idx[t++] = b; idx[t++] = sa; idx[t++] = sb;
        } else {
          idx[t++] = a; idx[t++] = b; idx[t++] = sa;
          idx[t++] = b; idx[t++] = sb; idx[t++] = sa;
        }
      }
    };
    addSkirt(0, vpr, 1, 0);                         // -Z edge
    addSkirt(1, vpr, 1, (vpr - 1) * vpr);           // +Z edge
    addSkirt(2, vpr, vpr, 0);                       // -X edge
    addSkirt(3, vpr, vpr, vpr - 1);                 // +X edge

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, t), 1));
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(-CHUNK / 2, minY - skirtDepth, -CHUNK / 2),
      new THREE.Vector3(CHUNK / 2, maxY, CHUNK / 2),
    );
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(0, (minY + maxY) / 2, 0),
      Math.hypot(CHUNK * 0.71, (maxY - minY) / 2 + skirtDepth),
    );
    c.minY = minY - skirtDepth; c.maxY = maxY;
    return geo;
  }

  _applyChunk(c, lod) {
    const geo = this._buildChunkGeometry(c, lod);
    if (c.mesh) {
      c.mesh.geometry.dispose();
      c.mesh.geometry = geo;
    } else {
      const m = new THREE.Mesh(geo, this.material);
      m.position.set(c.centerX, 0, c.centerZ);
      m.castShadow = false;
      m.receiveShadow = this.settings.q.shadows;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      m.name = `chunk_${c.cx}_${c.cz}`;
      c.mesh = m;
      this.group.add(m);
    }
    c.lod = lod;
    c.queued = false;
    this.stats.built++;
  }

  /* ------------------------------------------------------------------ */
  /* per-frame LOD selection                                             */
  /* ------------------------------------------------------------------ */

  _lodFor(dist) {
    const bias = this.settings.q.terrainLodBias;
    for (let i = 0; i < LOD_DIST.length; i++) if (dist < LOD_DIST[i] * bias) return i;
    return LOD_SEGS.length - 1;
  }

  updateLods(force = false) {
    const cam = this.camera;
    const viewDist = this.settings.q.viewDistance;
    this._projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._projScreen);

    let visible = 0;
    let tris = 0;
    for (const c of this.chunks) {
      const dx = c.centerX - cam.position.x;
      const dz = c.centerZ - cam.position.z;
      const dist = Math.hypot(dx, dz);

      if (dist > viewDist + CHUNK) {
        if (c.mesh) c.mesh.visible = false;
        continue;
      }
      _box.min.set(c.x0, c.minY, c.z0);
      _box.max.set(c.x0 + CHUNK, c.maxY, c.z0 + CHUNK);
      _box.getBoundingSphere(_sphere);
      const inView = this.frustum.intersectsSphere(_sphere);
      if (c.mesh) c.mesh.visible = inView;
      if (!inView && !force) continue;
      if (inView) visible++;

      const want = this._lodFor(dist);
      if (want !== c.lod && !c.queued) {
        c.wantLod = want;
        c.queued = true;
        this.queue.push(c);
      }
      if (c.mesh && inView) tris += LOD_SEGS[c.lod] * LOD_SEGS[c.lod] * 2;
    }
    this.stats.visible = visible;
    this.stats.queued = this.queue.length;
    this.stats.triangles = tris;
  }

  /** Process queued rebuilds nearest-first, bounded per frame. */
  flushQueue(limit = MAX_BUILDS_PER_FRAME) {
    if (this.queue.length === 0) return 0;
    const cam = this.camera.position;
    this.queue.sort((a, b) => {
      const da = (a.centerX - cam.x) ** 2 + (a.centerZ - cam.z) ** 2;
      const db = (b.centerX - cam.x) ** 2 + (b.centerZ - cam.z) ** 2;
      return da - db;
    });
    let n = 0;
    while (this.queue.length && n < limit) {
      const c = this.queue.shift();
      this._applyChunk(c, c.wantLod);
      n++;
    }
    return n;
  }

  update() {
    this.updateLods(false);
    this.flushQueue();
    if (this._waterMat && this._waterMat.map) {
      // Slow UV drift reads as motion without a custom shader.
      this._waterMat.map.offset.x = (this._waterMat.map.offset.x + 0.00035) % 1;
      this._waterMat.map.offset.y = (this._waterMat.map.offset.y + 0.00021) % 1;
    }
  }

  /* ------------------------------------------------------------------ */
  /* public queries (ARCHITECTURE.md 5.1)                                */
  /* ------------------------------------------------------------------ */

  heightAt(x, z) { return this.field.heightAt(x, z); }
  normalAt(x, z, out) { return this.field.normalAt(x, z, out); }
  slopeAt(x, z) { return this.field.slopeAt(x, z); }
  biomeAt(x, z) { return this.field.biomeAt(x, z); }
  moistureAt(x, z) { return this.field.moistureAt(x, z); }
  isWater(x, z) { return this.field.isWater(x, z); }
  isInsideMap(x, z) { return this.field.inside(x, z); }
  findGround(x, z, rng) { return this.field.findGround(x, z, rng); }

  /**
   * Ray/terrain intersection by fixed-step marching with a bisection refine.
   * Terrain is smooth at gameplay scale, so 1m steps do not miss features that
   * matter for shooting or camera collision.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxT, step = 1.0) {
    let prevT = 0;
    let prevD = oy - this.field.heightAt(ox, oz);
    if (prevD < 0) return { t: 0, y: oy };
    for (let t = step; t <= maxT; t += step) {
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      const d = y - this.field.heightAt(x, z);
      if (d <= 0) {
        // Bisect between the last two samples for a tight hit point.
        let lo = prevT, hi = t;
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) * 0.5;
          const mx = ox + dx * mid, my = oy + dy * mid, mz = oz + dz * mid;
          if (my - this.field.heightAt(mx, mz) > 0) lo = mid; else hi = mid;
        }
        const ht = (lo + hi) * 0.5;
        return { t: ht, x: ox + dx * ht, y: oy + dy * ht, z: oz + dz * ht };
      }
      prevT = t; prevD = d;
    }
    return null;
  }

  dispose() {
    for (const c of this.chunks) {
      if (c.mesh) { c.mesh.geometry.dispose(); this.group.remove(c.mesh); }
      c.mesh = null; c.lod = -1;
    }
    if (this.water) { this.water.geometry.dispose(); this.group.remove(this.water); }
    this.scene.remove(this.group);
  }

  static get CHUNK() { return CHUNK; }
}
