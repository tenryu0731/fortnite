import * as THREE from 'three';

/**
 * Colliders — uniform-grid index of static axis-aligned boxes.
 *
 * Everything solid that is not terrain registers here: tree trunks, boulders,
 * building parts, props and player-placed build pieces. Insert and remove are
 * O(cells covered) because build pieces are created and destroyed constantly.
 *
 * Boxes are stored in flat arrays; `handle` is an index into them, and freed
 * handles are recycled so long matches do not grow the arrays without bound.
 */
const CELL = 8;

export class Colliders {
  constructor(worldSize = 1024, cell = CELL) {
    this.cell = cell;
    this.half = worldSize / 2;
    this.dim = Math.ceil(worldSize / cell);
    this.cells = new Map();       // packed cell key -> array of handles
    this.minX = []; this.minY = []; this.minZ = [];
    this.maxX = []; this.maxY = []; this.maxZ = [];
    this.meta = [];
    this.alive = [];
    this._free = [];
    this.count = 0;
    this._queryMark = new Map();  // handle -> last query id, to de-duplicate
    this._queryId = 0;
  }

  _cellKey(cx, cz) { return cx * 4096 + cz; }
  _cx(x) { return Math.floor((x + this.half) / this.cell); }

  /** Insert a box. `meta` is opaque to this class (owner, material, hp...). */
  add(min, max, meta = null) {
    let h;
    if (this._free.length) h = this._free.pop();
    else { h = this.minX.length; }
    this.minX[h] = min.x; this.minY[h] = min.y; this.minZ[h] = min.z;
    this.maxX[h] = max.x; this.maxY[h] = max.y; this.maxZ[h] = max.z;
    this.meta[h] = meta;
    this.alive[h] = true;
    const x0 = this._cx(min.x), x1 = this._cx(max.x);
    const z0 = this._cx(min.z), z1 = this._cx(max.z);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = this._cellKey(cx, cz);
        let list = this.cells.get(k);
        if (!list) { list = []; this.cells.set(k, list); }
        list.push(h);
      }
    }
    this.count++;
    return h;
  }

  addBox3(box3, meta) { return this.add(box3.min, box3.max, meta); }

  remove(h) {
    if (!this.alive[h]) return false;
    const x0 = this._cx(this.minX[h]), x1 = this._cx(this.maxX[h]);
    const z0 = this._cx(this.minZ[h]), z1 = this._cx(this.maxZ[h]);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const list = this.cells.get(this._cellKey(cx, cz));
        if (!list) continue;
        const i = list.indexOf(h);
        if (i >= 0) { list[i] = list[list.length - 1]; list.pop(); }
      }
    }
    this.alive[h] = false;
    this.meta[h] = null;
    this._free.push(h);
    this.count--;
    return true;
  }

  getMeta(h) { return this.meta[h]; }

  /** Collect handles whose box overlaps the query AABB. Returns a count. */
  query(minX, minY, minZ, maxX, maxY, maxZ, out) {
    out.length = 0;
    const id = ++this._queryId;
    const mark = this._queryMark;
    const x0 = this._cx(minX), x1 = this._cx(maxX);
    const z0 = this._cx(minZ), z1 = this._cx(maxZ);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const list = this.cells.get(this._cellKey(cx, cz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const h = list[i];
          if (mark.get(h) === id) continue;
          mark.set(h, id);
          if (this.maxX[h] < minX || this.minX[h] > maxX) continue;
          if (this.maxY[h] < minY || this.minY[h] > maxY) continue;
          if (this.maxZ[h] < minZ || this.minZ[h] > maxZ) continue;
          out.push(h);
        }
      }
    }
    return out.length;
  }

  /**
   * Slab-test raycast walking the grid along the ray (3D-DDA in the XZ plane).
   * Returns the nearest hit as {t, handle, normal, meta} or null.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxT, filter = null, out = _hit) {
    let bestT = maxT, bestH = -1, bestAxis = 0, bestSign = 1;
    const id = ++this._queryId;
    const mark = this._queryMark;

    // Step through XZ cells; a ray longer than a few hundred metres would walk
    // many cells, so the caller is expected to pass a sane maxT.
    const cell = this.cell;
    let cx = this._cx(ox), cz = this._cx(oz);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const invDx = dx !== 0 ? 1 / dx : Infinity;
    const invDz = dz !== 0 ? 1 / dz : Infinity;
    const bx = (cx + (stepX > 0 ? 1 : 0)) * cell - this.half;
    const bz = (cz + (stepZ > 0 ? 1 : 0)) * cell - this.half;
    let tMaxX = stepX !== 0 ? (bx - ox) * invDx : Infinity;
    let tMaxZ = stepZ !== 0 ? (bz - oz) * invDz : Infinity;
    const tDeltaX = stepX !== 0 ? Math.abs(cell * invDx) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(cell * invDz) : Infinity;

    let guard = 0;
    let t = 0;
    while (t <= bestT && guard++ < 512) {
      const list = this.cells.get(this._cellKey(cx, cz));
      if (list) {
        for (let i = 0; i < list.length; i++) {
          const h = list[i];
          if (mark.get(h) === id) continue;
          mark.set(h, id);
          if (filter && !filter(this.meta[h], h)) continue;
          // Slab test.
          let tmin = 0, tmax = bestT, axis = 0, sign = 1;
          for (let a = 0; a < 3; a++) {
            const o = a === 0 ? ox : a === 1 ? oy : oz;
            const d = a === 0 ? dx : a === 1 ? dy : dz;
            const lo = a === 0 ? this.minX[h] : a === 1 ? this.minY[h] : this.minZ[h];
            const hi = a === 0 ? this.maxX[h] : a === 1 ? this.maxY[h] : this.maxZ[h];
            if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { tmin = Infinity; break; } continue; }
            const inv = 1 / d;
            let t1 = (lo - o) * inv, t2 = (hi - o) * inv;
            let s = -1;
            if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
            if (t1 > tmin) { tmin = t1; axis = a; sign = s; }
            if (t2 < tmax) tmax = t2;
            if (tmin > tmax) { tmin = Infinity; break; }
          }
          if (tmin < bestT && tmin >= 0 && tmin !== Infinity) {
            bestT = tmin; bestH = h; bestAxis = axis; bestSign = sign;
          }
        }
      }
      if (tMaxX < tMaxZ) { t = tMaxX; cx += stepX; tMaxX += tDeltaX; }
      else { t = tMaxZ; cz += stepZ; tMaxZ += tDeltaZ; }
      if (stepX === 0 && stepZ === 0) break;
    }

    if (bestH < 0) return null;
    out.t = bestT;
    out.handle = bestH;
    out.meta = this.meta[bestH];
    out.normal.set(
      bestAxis === 0 ? bestSign : 0,
      bestAxis === 1 ? bestSign : 0,
      bestAxis === 2 ? bestSign : 0,
    );
    out.point.set(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT);
    return out;
  }

  box(h, target = new THREE.Box3()) {
    target.min.set(this.minX[h], this.minY[h], this.minZ[h]);
    target.max.set(this.maxX[h], this.maxY[h], this.maxZ[h]);
    return target;
  }

  clear() {
    this.cells.clear();
    this.minX.length = this.minY.length = this.minZ.length = 0;
    this.maxX.length = this.maxY.length = this.maxZ.length = 0;
    this.meta.length = this.alive.length = 0;
    this._free.length = 0;
    this.count = 0;
  }
}

const _hit = { t: 0, handle: -1, meta: null, normal: new THREE.Vector3(), point: new THREE.Vector3() };
