import { MODULE } from '../world/StructureKit.js';

/**
 * BuildGrid — occupancy bookkeeping for player-placed structures.
 *
 * The grid is world-aligned in 4-metre cells, the same module the POI buildings
 * use, so player builds line up with world architecture instead of clipping
 * through it.
 *
 * A cell holds several independent slots, mirroring the genre's rules:
 *   floor        — one per cell, at the cell's base
 *   wall N/E/S/W — one per cell face
 *   ramp         — one per cell (its rotation is part of the piece, not the slot)
 *   cone         — one per cell, capping it
 *
 * Keys are packed into a single string per (cell, slot); the map is small
 * (hundreds of entries in a match) so a Map of strings is far simpler than a
 * bitfield and never shows up in a profile.
 */

export const SLOT = { FLOOR: 0, RAMP: 1, CONE: 2, WALL_N: 3, WALL_E: 4, WALL_S: 5, WALL_W: 6 };
export const SLOT_NAMES = ['floor', 'ramp', 'cone', 'wallN', 'wallE', 'wallS', 'wallW'];

/** Wall slots indexed by cardinal direction, matching DIR below. */
export const WALL_SLOTS = [SLOT.WALL_N, SLOT.WALL_E, SLOT.WALL_S, SLOT.WALL_W];

/** Cardinal directions: 0=-Z (north), 1=+X (east), 2=+Z (south), 3=-X (west). */
export const DIR = [
  { x: 0, z: -1, yaw: 0 },
  { x: 1, z: 0, yaw: Math.PI / 2 },
  { x: 0, z: 1, yaw: 0 },
  { x: -1, z: 0, yaw: Math.PI / 2 },
];

export class BuildGrid {
  constructor(module = MODULE) {
    this.module = module;
    this.cells = new Map();       // key -> record id
    this.count = 0;
  }

  cellOf(x, y, z, out = { cx: 0, cy: 0, cz: 0 }) {
    out.cx = Math.floor(x / this.module);
    out.cy = Math.floor(y / this.module);
    out.cz = Math.floor(z / this.module);
    return out;
  }

  key(cx, cy, cz, slot) { return `${cx},${cy},${cz},${slot}`; }

  get(key) { return this.cells.get(key); }
  has(key) { return this.cells.has(key); }

  set(key, recordId) {
    if (!this.cells.has(key)) this.count++;
    this.cells.set(key, recordId);
  }

  remove(key) {
    if (this.cells.delete(key)) { this.count--; return true; }
    return false;
  }

  /**
   * A wall sits on the boundary between two cells, so the same physical wall is
   * reachable from either side. Normalising to the lower cell keeps one canonical
   * key, otherwise a player could stack two walls in the same space.
   */
  wallKey(cx, cy, cz, dir) {
    if (dir === 2) return this.key(cx, cy, cz + 1, SLOT.WALL_N);   // south == north of cell+1
    if (dir === 1) return this.key(cx + 1, cy, cz, SLOT.WALL_W);   // east  == west  of cell+1
    return this.key(cx, cy, cz, WALL_SLOTS[dir]);
  }

  /** World-space centre of the piece occupying a slot in a cell. */
  anchor(cx, cy, cz, slot, out = { x: 0, y: 0, z: 0, yaw: 0 }) {
    const m = this.module;
    const x0 = cx * m, y0 = cy * m, z0 = cz * m;
    switch (slot) {
      case SLOT.FLOOR: out.x = x0 + m / 2; out.y = y0; out.z = z0 + m / 2; out.yaw = 0; break;
      case SLOT.RAMP: out.x = x0 + m / 2; out.y = y0; out.z = z0 + m / 2; out.yaw = 0; break;
      case SLOT.CONE: out.x = x0 + m / 2; out.y = y0 + m; out.z = z0 + m / 2; out.yaw = 0; break;
      case SLOT.WALL_N: out.x = x0 + m / 2; out.y = y0; out.z = z0; out.yaw = 0; break;
      case SLOT.WALL_S: out.x = x0 + m / 2; out.y = y0; out.z = z0 + m; out.yaw = 0; break;
      case SLOT.WALL_W: out.x = x0; out.y = y0; out.z = z0 + m / 2; out.yaw = Math.PI / 2; break;
      case SLOT.WALL_E: out.x = x0 + m; out.y = y0; out.z = z0 + m / 2; out.yaw = Math.PI / 2; break;
      default: out.x = x0 + m / 2; out.y = y0; out.z = z0 + m / 2; out.yaw = 0;
    }
    return out;
  }

  /** Every occupied key in a cell, for support checks and structural queries. */
  cellKeys(cx, cy, cz, out = []) {
    out.length = 0;
    for (let s = 0; s < SLOT_NAMES.length; s++) {
      const k = this.key(cx, cy, cz, s);
      if (this.cells.has(k)) out.push(k);
    }
    return out;
  }

  clear() { this.cells.clear(); this.count = 0; }
}
