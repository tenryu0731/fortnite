import * as THREE from 'three';

/**
 * Physics — character movement and unified world raycasting.
 *
 * Characters are vertical capsules resolved against two very different
 * representations: a continuous height field (terrain) and a grid of axis
 * aligned boxes (props, buildings, player builds). Rather than run a general
 * solver, movement is resolved axis-by-axis with a circle-vs-rectangle push-out
 * in the XZ plane, which is exact for a boxy world and cheap enough to run for
 * every bot every fixed step.
 *
 * Step-up is handled during horizontal resolution: if the blocking box's top is
 * within `stepHeight` of the character's feet and there is headroom, the
 * character is lifted onto it instead of being stopped. That is what lets a
 * player walk up stairs, over crates and onto build ramps without a jump.
 */

export const GRAVITY = -22;          // stronger than real gravity, for snappier arcs
const MAX_SLOPE_COS = 0.60;          // steeper than ~53 degrees is not standable
const SKIN = 0.015;                  // keeps the capsule just clear of surfaces
const MAX_ITER = 4;

const _out = [];
const _n = new THREE.Vector3();

export class Physics {
  constructor() {
    this.order = 35;
    this.stats = { moves: 0, boxTests: 0, rays: 0 };
  }

  init(services) {
    this.terrain = services.get('terrain');
    this.colliders = services.get('colliders');
    services.set('physics', this);
  }

  /* ------------------------------------------------------------------ */
  /* capsule queries                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Push a capsule out of every box it overlaps, in the XZ plane only.
   * `feet` is the capsule's base; `height` its full standing height.
   * Returns true when anything was resolved.
   */
  resolveHorizontal(pos, radius, height, feet, stepHeight, result) {
    const c = this.colliders;
    const n = c.query(pos.x - radius, feet + SKIN, pos.z - radius,
                      pos.x + radius, feet + height - SKIN, pos.z + radius, _out);
    this.stats.boxTests += n;
    let touched = false;
    let stepTo = -Infinity;

    for (let i = 0; i < n; i++) {
      const h = _out[i];
      const minX = c.minX[h], maxX = c.maxX[h];
      const minZ = c.minZ[h], maxZ = c.maxZ[h];
      const topY = c.maxY[h];

      // Closest point on the box footprint to the capsule axis.
      const cx = pos.x < minX ? minX : pos.x > maxX ? maxX : pos.x;
      const cz = pos.z < minZ ? minZ : pos.z > maxZ ? maxZ : pos.z;
      let dx = pos.x - cx, dz = pos.z - cz;
      let d2 = dx * dx + dz * dz;
      if (d2 >= radius * radius) continue;

      // A low box the character can simply step onto is not a wall.
      if (topY - feet <= stepHeight && topY - feet > -0.02) {
        if (topY > stepTo) stepTo = topY;
        continue;
      }
      // Nor is a box entirely above the character's head.
      if (c.minY[h] >= feet + height) continue;

      touched = true;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const push = (radius - d) + SKIN;
        pos.x += (dx / d) * push;
        pos.z += (dz / d) * push;
      } else {
        // Axis is inside the footprint: escape along the shallowest face.
        const left = pos.x - minX, right = maxX - pos.x;
        const back = pos.z - minZ, front = maxZ - pos.z;
        const m = Math.min(left, right, back, front);
        if (m === left) pos.x = minX - radius - SKIN;
        else if (m === right) pos.x = maxX + radius + SKIN;
        else if (m === back) pos.z = minZ - radius - SKIN;
        else pos.z = maxZ + radius + SKIN;
      }
    }
    if (result) { result.touched = touched; result.stepTo = stepTo; }
    return touched;
  }

  /** Highest box surface directly under the capsule, or -Infinity. */
  supportUnder(x, z, radius, fromY, toY) {
    const c = this.colliders;
    const n = c.query(x - radius, toY, z - radius, x + radius, fromY, z + radius, _out);
    let best = -Infinity;
    for (let i = 0; i < n; i++) {
      const h = _out[i];
      if (c.maxY[h] > fromY + 0.001 || c.maxY[h] < toY) continue;
      // Only count it if the footprint actually overlaps the capsule circle.
      const cx = x < c.minX[h] ? c.minX[h] : x > c.maxX[h] ? c.maxX[h] : x;
      const cz = z < c.minZ[h] ? c.minZ[h] : z > c.maxZ[h] ? c.maxZ[h] : z;
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz >= radius * radius) continue;
      if (c.maxY[h] > best) best = c.maxY[h];
    }
    return best;
  }

  /** Lowest box underside above the capsule, or +Infinity. */
  ceilingAbove(x, z, radius, fromY, toY) {
    const c = this.colliders;
    const n = c.query(x - radius, fromY, z - radius, x + radius, toY, z + radius, _out);
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const h = _out[i];
      if (c.minY[h] < fromY - 0.001 || c.minY[h] > toY) continue;
      const cx = x < c.minX[h] ? c.minX[h] : x > c.maxX[h] ? c.maxX[h] : x;
      const cz = z < c.minZ[h] ? c.minZ[h] : z > c.maxZ[h] ? c.maxZ[h] : z;
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz >= radius * radius) continue;
      if (c.minY[h] < best) best = c.minY[h];
    }
    return best;
  }

  /**
   * Integrate one character step.
   * `body` is { pos: Vector3 (feet), vel: Vector3, radius, height, grounded,
   *             groundY, groundNormal, stepHeight }.
   */
  moveCharacter(body, dt) {
    this.stats.moves++;
    const { pos, vel } = body;
    const radius = body.radius, height = body.height;
    const step = body.stepHeight ?? 0.55;

    /* --- horizontal ---------------------------------------------------- */
    const startY = pos.y;
    pos.x += vel.x * dt;
    pos.z += vel.z * dt;

    const res = { touched: false, stepTo: -Infinity };
    for (let i = 0; i < MAX_ITER; i++) {
      const before = { x: pos.x, z: pos.z };
      this.resolveHorizontal(pos, radius, height, pos.y, step, res);
      if (!res.touched) break;
      // Kill the velocity component pushed against, so we slide along the wall.
      const nx = pos.x - before.x, nz = pos.z - before.z;
      const len = Math.hypot(nx, nz);
      if (len > 1e-6) {
        const ux = nx / len, uz = nz / len;
        const dot = vel.x * ux + vel.z * uz;
        if (dot < 0) { vel.x -= ux * dot; vel.z -= uz * dot; }
      }
    }
    body.hitWall = res.touched;

    /* --- vertical ------------------------------------------------------ */
    vel.y += GRAVITY * dt;
    pos.y += vel.y * dt;

    const terrainY = this.terrain.heightAt(pos.x, pos.z);
    // A box counts as ground if its top is at or just below the capsule base
    // after the vertical step; the search window covers one frame of fall.
    const searchTop = Math.max(startY, pos.y) + step;
    const boxY = this.supportUnder(pos.x, pos.z, radius, searchTop, pos.y - 0.6);
    const groundY = Math.max(terrainY, boxY);

    body.onBox = boxY > terrainY;
    if (pos.y <= groundY + SKIN) {
      pos.y = groundY;
      if (vel.y < 0) {
        body.landingSpeed = -vel.y;
        vel.y = 0;
      }
      body.grounded = true;
      body.groundY = groundY;
      if (body.onBox) _n.set(0, 1, 0);
      else this.terrain.normalAt(pos.x, pos.z, _n);
      body.groundNormal.copy(_n);
      body.steepGround = !body.onBox && _n.y < MAX_SLOPE_COS;
    } else {
      body.grounded = false;
      body.steepGround = false;
      body.landingSpeed = 0;
      // Head bump: stop upward motion under a ceiling.
      if (vel.y > 0) {
        const ceil = this.ceilingAbove(pos.x, pos.z, radius, pos.y + height - 0.05, pos.y + height + 0.6);
        if (ceil < pos.y + height) { pos.y = ceil - height; vel.y = 0; }
      }
    }

    // Sliding off ground that is too steep to stand on.
    if (body.grounded && body.steepGround) {
      const n = body.groundNormal;
      const slide = 9 * dt;
      vel.x += n.x * slide;
      vel.z += n.z * slide;
    }
    return body;
  }

  /* ------------------------------------------------------------------ */
  /* unified raycast                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Cast against terrain and every static box, returning the nearest hit.
   * `filter(meta, handle)` can reject boxes (e.g. to ignore the shooter's own
   * build pieces or non-solid decoration).
   */
  raycast(origin, dir, maxT, filter = null, out = _hit) {
    this.stats.rays++;
    const boxHit = this.colliders.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxT, filter);
    const limit = boxHit ? boxHit.t : maxT;
    const terrHit = this.terrain.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, limit, 1.0);

    if (terrHit) {
      out.t = terrHit.t;
      out.point.set(terrHit.x, terrHit.y, terrHit.z);
      this.terrain.normalAt(terrHit.x, terrHit.z, out.normal);
      out.meta = TERRAIN_META;
      out.handle = -1;
      out.kind = 'terrain';
      return out;
    }
    if (boxHit) {
      out.t = boxHit.t;
      out.point.copy(boxHit.point);
      out.normal.copy(boxHit.normal);
      out.meta = boxHit.meta;
      out.handle = boxHit.handle;
      out.kind = boxHit.meta ? boxHit.meta.type : 'box';
      return out;
    }
    return null;
  }

  /** True when nothing solid blocks the segment between two points. */
  lineOfSight(from, to, filter = null) {
    _dir.subVectors(to, from);
    const dist = _dir.length();
    if (dist < 1e-4) return true;
    _dir.multiplyScalar(1 / dist);
    return this.raycast(from, _dir, dist - 0.05, filter, _losHit) === null;
  }
}

const TERRAIN_META = { type: 'terrain', harvest: null };
const _dir = new THREE.Vector3();
const _hit = { t: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), meta: null, handle: -1, kind: '' };
const _losHit = { t: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), meta: null, handle: -1, kind: '' };
