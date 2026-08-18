import * as THREE from 'three';
import { Rng } from '../gen/Rng.js';
import { StructureKit, MAT, MODULE } from './StructureKit.js';
import { SEA_LEVEL } from './Biome.js';

/**
 * Structures — named points of interest.
 *
 * Sites are chosen by scoring candidate positions on flatness, elevation and
 * separation, then the height field is flattened into a level pad before the
 * terrain is meshed (Terrain.postInit). Each POI lays its buildings out on the
 * same 4-metre module grid the player builds on, so player structures and world
 * structures line up.
 *
 * Everything is emitted through StructureKit, so the entire set of buildings on
 * the island costs about ten draw calls and every panel remains individually
 * destructible.
 */

const POI_TYPES = ['town', 'factory', 'camp', 'tower', 'farm'];

const NAMES = {
  town: ['Copper Hollow', 'Bramble Cross', 'Maple Row', 'Quarry Gate', 'Anvil Court'],
  factory: ['Ironworks', 'The Foundry', 'Dust Refinery', 'Cargo Yard'],
  camp: ['Fern Camp', 'Ridgeline Camp', 'Hunters Rest', 'Willow Camp'],
  tower: ['Signal Spire', 'Watchpost', 'The Beacon', 'Lookout'],
  farm: ['Harvest Acre', 'Two Silos', 'Clover Farm', 'Old Mill'],
};

/** Footprint radius reserved (and flattened) per POI type, in metres. */
const POI_RADIUS = { town: 42, factory: 30, camp: 22, tower: 16, farm: 32 };

export class Structures {
  constructor(seed, opts = {}) {
    this.order = 25;              // after terrain bake, before vegetation
    this.seed = seed;
    this.poiCount = opts.poiCount || 9;
    this.pois = [];
    this.buildings = [];
    this.lootSpots = [];
    this.stats = { pois: 0, buildings: 0, panels: 0, lootSpots: 0 };
  }

  init(services) {
    this.services = services;
    this.terrain = services.get('terrain');
    this.field = this.terrain.field;
    this.kit = new StructureKit(services, 1600);
    services.set('structures', this);

    const rng = Rng.forStream(this.seed, 'poi');
    this._chooseSites(rng);
    for (const poi of this.pois) this._build(poi, new Rng(poi.seed));
    this.stats.pois = this.pois.length;
    this.stats.buildings = this.buildings.length;
    this.stats.panels = this.kit.stats.placed;
    this.stats.lootSpots = this.lootSpots.length;
  }

  /* ------------------------------------------------------------------ */
  /* site selection                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Score candidates on a jittered lattice and greedily take the best that are
   * far enough apart. Scoring flatness over a ring (not just the centre) is
   * what stops a POI landing on a knife-edge ridge that happens to be flat at
   * one point.
   */
  _chooseSites(rng) {
    const f = this.field;
    const reach = f.half * 0.72;
    const candidates = [];
    const STEP = 44;
    for (let z = -reach; z <= reach; z += STEP) {
      for (let x = -reach; x <= reach; x += STEP) {
        const cx = x + rng.range(-14, 14), cz = z + rng.range(-14, 14);
        const h = f.heightAt(cx, cz);
        if (h < SEA_LEVEL + 2.5 || h > 58) continue;

        let minH = h, maxH = h, slopeSum = 0, n = 0, wet = false;
        for (let a = 0; a < 8; a++) {
          const ang = (a / 8) * Math.PI * 2;
          for (const r of [12, 24, 34]) {
            const sx = cx + Math.cos(ang) * r, sz = cz + Math.sin(ang) * r;
            const sh = f.heightAt(sx, sz);
            if (sh < SEA_LEVEL + 1) wet = true;
            minH = Math.min(minH, sh); maxH = Math.max(maxH, sh);
            slopeSum += f.slopeAt(sx, sz); n++;
          }
        }
        if (wet) continue;
        const relief = maxH - minH;
        const flatness = slopeSum / n;
        // Prefer flat, low-relief ground away from the exact map centre.
        const score = flatness * 3 - relief * 0.12 + (h > 8 && h < 34 ? 0.6 : 0);
        candidates.push({ x: cx, z: cz, y: h, score, relief });
      }
    }
    candidates.sort((a, b) => b.score - a.score);

    const chosen = [];
    const typePool = rng.shuffle([...POI_TYPES, ...POI_TYPES]);
    for (const c of candidates) {
      if (chosen.length >= this.poiCount) break;
      const type = typePool[chosen.length % typePool.length];
      const radius = POI_RADIUS[type];
      let ok = true;
      for (const p of chosen) {
        if (Math.hypot(p.x - c.x, p.z - c.z) < radius + POI_RADIUS[p.type] + 34) { ok = false; break; }
      }
      if (!ok) continue;
      const nameList = NAMES[type];
      chosen.push({
        type, x: c.x, z: c.z, radius,
        name: nameList[chosen.filter((p) => p.type === type).length % nameList.length],
        seed: (this.seed ^ (chosen.length * 0x9e3779b9) ^ 0x51ed) >>> 0,
      });
    }

    // Flatten pads before terrain meshing so buildings sit on level ground.
    for (const p of chosen) {
      p.y = this.field.flatten(p.x, p.z, p.radius * 0.72, p.radius * 0.55);
      // Dry the ground inside a POI so the biome shades it as packed dirt,
      // which reads as a cleared, built-up area without extra geometry.
      this._dryGround(p.x, p.z, p.radius * 0.85);
    }
    this.pois = chosen;
  }

  /** Push the moisture field down in a radius so the biome classifies dirt. */
  _dryGround(cx, cz, radius) {
    const f = this.field;
    const i0 = Math.max(0, Math.floor((cx - radius + f.half) / f.step));
    const i1 = Math.min(f.dim - 1, Math.ceil((cx + radius + f.half) / f.step));
    const j0 = Math.max(0, Math.floor((cz - radius + f.half) / f.step));
    const j1 = Math.min(f.dim - 1, Math.ceil((cz + radius + f.half) / f.step));
    for (let j = j0; j <= j1; j++) {
      const z = -f.half + j * f.step;
      for (let i = i0; i <= i1; i++) {
        const x = -f.half + i * f.step;
        const d = Math.hypot(x - cx, z - cz);
        if (d > radius) continue;
        const t = 1 - (d / radius) * (d / radius);
        const k = j * f.dim + i;
        f.moisture[k] = f.moisture[k] * (1 - t * 0.9);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* building assembly                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Place a rectangular building. `w` x `d` modules, `floors` storeys.
   * Panels are emitted in module space then offset by the building origin,
   * which is the corner of module (0,0).
   */
  _building(rng, ox, oy, oz, w, d, floors, opts = {}) {
    const kit = this.kit;
    const wallMat = opts.wallMat || MAT.timber;
    const floorMat = opts.floorMat || MAT.timber;
    const roofMat = opts.roofMat || MAT.roof;
    const wallH = opts.wallHeight || 1;   // module heights per storey
    const cell = (m) => ox + (m + 0.5) * MODULE;
    const cellZ = (m) => oz + (m + 0.5) * MODULE;

    // Doorways: one guaranteed, plus a chance of a second on another face, so
    // a building is never approachable from only one direction.
    const doors = [{ side: rng.int(4), i: 0 }];
    doors[0].i = rng.int(doors[0].side < 2 ? w : d);
    if (rng.chance(0.55)) {
      const side = (doors[0].side + rng.intRange(1, 3)) % 4;
      doors.push({ side, i: rng.int(side < 2 ? w : d) });
    }
    const isDoor = (side, i) => doors.some((dr) => dr.side === side && dr.i === i);
    const stairX = w > 1 ? rng.int(w) : 0;
    const stairZ = d > 1 ? rng.int(d) : 0;

    for (let f = 0; f < floors; f++) {
      const y = oy + f * MODULE * wallH;

      // Floor slabs. The cell holding the stair is left open above ground level.
      for (let mz = 0; mz < d; mz++) {
        for (let mx = 0; mx < w; mx++) {
          if (f > 0 && floors > 1 && mx === stairX && mz === stairZ) continue;
          kit.place('floor', cell(mx), y, cellZ(mz), 0, floorMat);
        }
      }

      for (let s = 0; s < wallH; s++) {
        const wy = y + s * MODULE;
        const groundBand = f === 0 && s === 0;
        for (let mx = 0; mx < w; mx++) {
          this._wall(rng, cell(mx), wy, oz, 0, wallMat, groundBand && isDoor(0, mx));
          this._wall(rng, cell(mx), wy, oz + d * MODULE, 0, wallMat, groundBand && isDoor(1, mx));
        }
        for (let mz = 0; mz < d; mz++) {
          this._wall(rng, ox, wy, cellZ(mz), Math.PI / 2, wallMat, groundBand && isDoor(2, mz));
          this._wall(rng, ox + w * MODULE, wy, cellZ(mz), Math.PI / 2, wallMat, groundBand && isDoor(3, mz));
        }
      }

      if (floors > 1 && f < floors - 1) {
        kit.place('stair', cell(stairX), y, cellZ(stairZ), rng.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]), floorMat);
      }

      // Scatter a little cover and loot on each storey.
      if (rng.chance(0.75)) {
        const px = ox + rng.range(1, w * MODULE - 1);
        const pz = oz + rng.range(1, d * MODULE - 1);
        kit.place(rng.chance(0.5) ? 'crate' : 'barrel', px, y + 0.15, pz, rng.range(0, 6.28), MAT.timber);
        this.lootSpots.push({ x: px, y: y + 0.6, z: pz, kind: 'floor' });
      }
    }

    const roofY = oy + floors * MODULE * wallH;
    if (opts.flatRoof) {
      for (let mz = 0; mz < d; mz++) {
        for (let mx = 0; mx < w; mx++) kit.place('floor', cell(mx), roofY, cellZ(mz), 0, roofMat);
      }
      for (let mx = 0; mx < w; mx++) {
        kit.place('rail', cell(mx), roofY, oz + 0.2, 0, MAT.steel, { solid: false });
        kit.place('rail', cell(mx), roofY, oz + d * MODULE - 0.2, 0, MAT.steel, { solid: false });
      }
      for (let mz = 0; mz < d; mz++) {
        kit.place('rail', ox + 0.2, roofY, cellZ(mz), Math.PI / 2, MAT.steel, { solid: false });
        kit.place('rail', ox + w * MODULE - 0.2, roofY, cellZ(mz), Math.PI / 2, MAT.steel, { solid: false });
      }
      this.lootSpots.push({ x: ox + w * MODULE * 0.5, y: roofY + 0.5, z: oz + d * MODULE * 0.5, kind: 'roof' });
    } else {
      this._pitchedRoof(ox, roofY, oz, w, d, roofMat);
    }

    const record = {
      x: ox + w * MODULE / 2, y: oy, z: oz + d * MODULE / 2,
      ox, oz, w, d, floors,
      top: roofY, flatRoof: !!opts.flatRoof, doors: doors.length,
    };
    this.buildings.push(record);
    return record;
  }

  /** One perimeter wall panel, choosing between solid, window and door. */
  _wall(rng, x, y, z, rotY, mat, isDoor) {
    if (isDoor) { this.kit.place('wallDoor', x, y, z, rotY, mat); return; }
    if (rng.chance(0.42)) {
      this.kit.place('wallWindow', x, y, z, rotY, mat);
      this.kit.place('glass', x, y, z, rotY, MAT.glass, { solid: false });
    } else {
      this.kit.place('wall', x, y, z, rotY, mat);
    }
  }

  /** Two sloped slabs meeting at a ridge running along X, plus gable ends. */
  _pitchedRoof(ox, y, oz, w, d, mat) {
    const kit = this.kit;
    const spanZ = d * MODULE;
    const rise = Math.min(3.0, spanZ * 0.34);
    const run = spanZ / 2;
    const slopeLen = Math.hypot(run, rise);
    const pitch = Math.atan2(rise, run);
    const cz = oz + spanZ / 2;

    for (const side of [-1, 1]) {
      for (let mx = 0; mx < w; mx++) {
        kit.place('floor',
          ox + (mx + 0.5) * MODULE,
          y + rise / 2,
          cz + side * run / 2,
          0, mat,
          { rotX: -side * pitch, sz: slopeLen / MODULE, sy: 0.7 });
      }
    }
    for (const end of [0, w * MODULE]) {
      kit.place('gable', ox + end, y, cz, Math.PI / 2, mat, { sx: spanZ / MODULE, sy: rise / (MODULE * 0.5) });
    }
  }

  /* ------------------------------------------------------------------ */
  /* POI layouts                                                         */
  /* ------------------------------------------------------------------ */

  _build(poi, rng) {
    const y = poi.y;
    switch (poi.type) {
      case 'town': return this._town(poi, rng, y);
      case 'factory': return this._factory(poi, rng, y);
      case 'camp': return this._camp(poi, rng, y);
      case 'tower': return this._tower(poi, rng, y);
      case 'farm': return this._farm(poi, rng, y);
      default: return null;
    }
  }

  /** A cluster of houses around a small square, on a loose street grid. */
  _town(poi, rng, y) {
    const lots = [];
    const spacing = 21;
    for (let gz = -1; gz <= 1; gz++) {
      for (let gx = -1; gx <= 1; gx++) {
        if (gx === 0 && gz === 0) continue;   // leave the middle as a square
        lots.push({ x: poi.x + gx * spacing, z: poi.z + gz * spacing });
      }
    }
    rng.shuffle(lots);
    const count = rng.intRange(4, 6);
    for (let i = 0; i < count; i++) {
      const lot = lots[i];
      const w = rng.intRange(2, 3), d = 2;
      const floors = rng.chance(0.45) ? 2 : 1;
      const walls = rng.pickWeighted([MAT.timber, MAT.brick, MAT.concrete], [0.5, 0.32, 0.18]);
      this._building(rng, lot.x - w * MODULE / 2, y, lot.z - d * MODULE / 2, w, d, floors, {
        wallMat: walls, floorMat: MAT.timber, roofMat: MAT.roof, flatRoof: rng.chance(0.22),
      });
    }
    for (let i = 0; i < 6; i++) {
      const a = rng.range(0, Math.PI * 2), r = rng.range(3, 9);
      this.kit.place(rng.chance(0.5) ? 'crate' : 'barrel',
        poi.x + Math.cos(a) * r, y, poi.z + Math.sin(a) * r, rng.range(0, 6.28), MAT.timber);
    }
    this.lootSpots.push({ x: poi.x, y: y + 0.6, z: poi.z, kind: 'square' });
  }

  /** One tall warehouse with a flat roof, plus a yard of crates. */
  _factory(poi, rng, y) {
    const w = rng.intRange(4, 5), d = 3;
    this._building(rng, poi.x - w * MODULE / 2, y, poi.z - d * MODULE / 2, w, d, 1, {
      wallMat: MAT.steel, floorMat: MAT.concrete, roofMat: MAT.steel,
      flatRoof: true, wallHeight: 2,
    });
    // Yard: stacked crates give cover and vertical routes onto the roof.
    for (let i = 0; i < 12; i++) {
      const a = rng.range(0, Math.PI * 2), r = rng.range(14, 24);
      const px = poi.x + Math.cos(a) * r, pz = poi.z + Math.sin(a) * r;
      const stack = rng.intRange(1, 3);
      for (let s = 0; s < stack; s++) {
        this.kit.place('crate', px, y + s * 1.15, pz, rng.range(0, 6.28), MAT.steel);
      }
      if (stack >= 2) this.lootSpots.push({ x: px, y: y + stack * 1.15 + 0.4, z: pz, kind: 'yard' });
    }
  }

  /** Small huts around a clearing. */
  _camp(poi, rng, y) {
    const count = rng.intRange(3, 5);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const r = rng.range(9, 15);
      const w = rng.chance(0.4) ? 2 : 1, d = 1;
      this._building(rng, poi.x + Math.cos(a) * r - w * MODULE / 2, y, poi.z + Math.sin(a) * r - d * MODULE / 2,
        w, d, 1, { wallMat: MAT.timber, floorMat: MAT.timber, roofMat: MAT.roof });
    }
    for (let i = 0; i < 4; i++) {
      const a = rng.range(0, Math.PI * 2), r = rng.range(2, 5);
      this.kit.place('barrel', poi.x + Math.cos(a) * r, y, poi.z + Math.sin(a) * r, 0, MAT.timber);
    }
    this.lootSpots.push({ x: poi.x, y: y + 0.6, z: poi.z, kind: 'clearing' });
  }

  /** A narrow multi-storey tower — the vertical landmark of the map. */
  _tower(poi, rng, y) {
    const floors = rng.intRange(4, 5);
    this._building(rng, poi.x - MODULE, y, poi.z - MODULE, 2, 2, floors, {
      wallMat: MAT.concrete, floorMat: MAT.concrete, roofMat: MAT.concrete, flatRoof: true,
    });
    for (let i = 0; i < 4; i++) {
      const a = rng.range(0, Math.PI * 2), r = rng.range(7, 12);
      this.kit.place('crate', poi.x + Math.cos(a) * r, y, poi.z + Math.sin(a) * r, rng.range(0, 6.28), MAT.timber);
    }
    this.lootSpots.push({ x: poi.x, y: y + floors * MODULE + 0.5, z: poi.z, kind: 'tower-top' });
  }

  /** A barn, two silos and a run of fencing. */
  _farm(poi, rng, y) {
    const w = 3, d = 2;
    this._building(rng, poi.x - w * MODULE / 2, y, poi.z - d * MODULE / 2, w, d, 1, {
      wallMat: MAT.timber, floorMat: MAT.timber, roofMat: MAT.brick, wallHeight: 2,
    });
    for (const side of [-1, 1]) {
      const sx = poi.x + side * 16, sz = poi.z + rng.range(-6, 6);
      // Silo: the barrel prototype scaled into a storage tank.
      this.kit.place('barrel', sx, y, sz, 0, MAT.steel, { sx: 5.4, sy: 8.5, sz: 5.4 });
      this.lootSpots.push({ x: sx + 3.5, y: y + 0.5, z: sz, kind: 'silo' });
    }
    // Fence line along one edge of the pad.
    const fz = poi.z + 20;
    for (let i = -3; i <= 3; i++) {
      this.kit.place('rail', poi.x + i * MODULE, y, fz, 0, MAT.timber, { solid: false });
    }
    this.lootSpots.push({ x: poi.x, y: y + 0.6, z: poi.z, kind: 'barn' });
  }

  /* ------------------------------------------------------------------ */

  /** Nearest POI to a world position, for HUD labels and AI destinations. */
  nearestPoi(x, z) {
    let best = null, bd = Infinity;
    for (const p of this.pois) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) { bd = d; best = p; }
    }
    return best ? { poi: best, distance: bd } : null;
  }

  /** True when a point falls inside any POI footprint (used to skip scatter). */
  insidePoi(x, z, margin = 0) {
    for (const p of this.pois) {
      if (Math.hypot(p.x - x, p.z - z) < p.radius * 0.8 + margin) return true;
    }
    return false;
  }

  damage(recordId, amount) { return this.kit.damage(recordId, amount); }

  dispose() { this.kit.dispose(); }
}
