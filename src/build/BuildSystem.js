import * as THREE from 'three';
import { StructureKit, MODULE } from '../world/StructureKit.js';
import { BuildGrid, SLOT, WALL_SLOTS, DIR } from './BuildGrid.js';
import { srgbHex } from '../gen/Palette.js';

/**
 * BuildSystem — the genre's defining mechanic: instant 4-metre structures.
 *
 * Pieces are placed into a world-aligned grid shared with the POI architecture,
 * emitted through a dedicated StructureKit so every player build in a match
 * costs four draw calls in total and each piece stays individually damageable.
 *
 * Three rules make building feel right rather than merely functional:
 *
 *  1. **Placement follows the aim, not a cursor.** The target cell comes from
 *     where the player is looking, clamped to a build radius. On touch there is
 *     no mouse to hover with, so the preview has to be legible from the camera
 *     alone.
 *  2. **Pieces must be supported.** A piece is valid only if it meets the
 *     ground, or touches something already built or built-in. Without this,
 *     players place floating platforms and the game stops being about ramps.
 *  3. **Health ramps in.** A freshly placed piece starts weak and reaches full
 *     strength over a material-dependent time, so a wall thrown up mid-fight
 *     can still be broken through — the whole build-fight dynamic depends on it.
 */

export const PIECE = { WALL: 0, FLOOR: 1, RAMP: 2, CONE: 3 };
export const PIECE_NAMES = ['wall', 'floor', 'ramp', 'cone'];
const PIECE_PROTO = ['wall', 'floor', 'stair', 'cone'];
const PIECE_SLOT = [null, SLOT.FLOOR, SLOT.RAMP, SLOT.CONE];   // wall slot depends on facing

export const BUILD_MAT = {
  wood: {
    key: 'wood', tint: 0xc08a4a, cost: 10,
    hp: 150, initialHp: 0.60, buildTime: 0.6, harvest: 'wood',
  },
  brick: {
    key: 'brick', tint: 0xa8604f, cost: 10,
    hp: 300, initialHp: 0.30, buildTime: 4.0, harvest: 'brick',
  },
  metal: {
    key: 'metal', tint: 0x8b96a3, cost: 10,
    hp: 500, initialHp: 0.20, buildTime: 6.0, harvest: 'metal',
  },
};
export const BUILD_MAT_ORDER = ['wood', 'brick', 'metal'];

/** Edit presets, chosen by which of the 3x3 cells the player selected. */
const EDIT_PRESETS = [
  { id: 'door', proto: 'wallDoor', cells: [6, 7, 8] },
  { id: 'window', proto: 'wallWindow', cells: [4] },
  { id: 'half', proto: 'wallHalf', cells: [0, 1, 2] },
  { id: 'side', proto: 'wallHalfSide', cells: [2, 5, 8] },
  { id: 'open', proto: null, cells: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
];

const MAX_BUILD_RANGE = 11;
const PLACE_COOLDOWN = 0.11;      // seconds between pieces while holding place

const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _cell = { cx: 0, cy: 0, cz: 0 };
const _anchor = { x: 0, y: 0, z: 0, yaw: 0 };
const _box = new THREE.Box3();
const _mat4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

export class BuildSystem {
  constructor(opts = {}) {
    this.order = 55;                 // after the player, before the camera
    this.grid = new BuildGrid(MODULE);
    this.piece = PIECE.WALL;
    this.material = 'wood';
    this.rotation = 0;               // extra quarter turns for ramps and cones
    this.active = false;
    this.editing = false;
    this.editTarget = null;
    this.editCells = new Set();
    this.resources = { wood: opts.wood ?? 200, brick: opts.brick ?? 120, metal: opts.metal ?? 60 };
    this.maxResource = 999;
    this._cooldown = 0;
    this.pending = [];               // pieces still ramping to full health
    this.preview = { valid: false, reason: '', key: null, proto: 'wall', x: 0, y: 0, z: 0, yaw: 0 };
    this.stats = { placed: 0, destroyed: 0, edits: 0, spent: 0, refunded: 0 };
  }

  init(services) {
    this.services = services;
    this.player = services.get('player');
    this.physics = services.get('physics');
    this.terrain = services.get('terrain');
    this.colliders = services.get('colliders');
    this.input = services.get('input');
    this.camera = services.get('camera');
    this.bus = services.get('bus');
    this.settings = services.get('settings');
    this.touch = services.peek('touch');

    // Player builds get their own kit: separate capacity from the world's
    // architecture, and a clean boundary for "did the player build this".
    this.kit = new StructureKit(services, 700);
    this.kit.group.name = 'player-builds';

    this._buildGhost(services);
    services.set('build', this);

    this.bus.on('build:destroyRecord', (e) => this.destroyRecord(e.record));
  }

  /** Translucent preview mesh, one per piece type, swapped as the piece changes. */
  _buildGhost(services) {
    const materials = services.get('materials');
    this.ghostMatValid = materials.additive('ghostOk', { color: 0x39e6ff, opacity: 0.34 });
    this.ghostMatInvalid = materials.additive('ghostNo', { color: 0xff4d5e, opacity: 0.34 });
    this.ghosts = new Map();
    this.ghostGroup = new THREE.Group();
    this.ghostGroup.name = 'build-ghost';
    services.get('scene').add(this.ghostGroup);
    for (const proto of ['wall', 'floor', 'stair', 'cone']) {
      const geo = this.kit._mesh(proto).geometry;
      const m = new THREE.Mesh(geo, this.ghostMatValid);
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 5;
      this.ghostGroup.add(m);
      this.ghosts.set(proto, m);
    }
  }

  /* ------------------------------------------------------------------ */
  /* selection                                                           */
  /* ------------------------------------------------------------------ */

  setPiece(i) { this.piece = Math.max(0, Math.min(3, i | 0)); }
  setMaterial(key) { if (BUILD_MAT[key]) this.material = key; }
  cycleMaterial() {
    const i = BUILD_MAT_ORDER.indexOf(this.material);
    this.setMaterial(BUILD_MAT_ORDER[(i + 1) % BUILD_MAT_ORDER.length]);
    return this.material;
  }
  rotate() { this.rotation = (this.rotation + 1) % 4; return this.rotation; }

  addResource(kind, amount) {
    if (!(kind in this.resources)) return 0;
    const before = this.resources[kind];
    this.resources[kind] = Math.min(this.maxResource, before + amount);
    return this.resources[kind] - before;
  }

  canAfford(matKey = this.material) {
    const m = BUILD_MAT[matKey];
    return this.resources[m.key] >= m.cost;
  }

  /* ------------------------------------------------------------------ */
  /* targeting                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve the cell and slot the player is currently targeting.
   *
   * The aim point is the first solid surface along the view ray, pulled back
   * slightly so it lands inside the cell in front of the surface rather than
   * inside the surface itself, and clamped into the build radius.
   */
  computeTarget(out = this.preview) {
    const p = this.player;
    p.eyePosition(_eye);
    p.lookDirection(_dir);

    const hit = this.physics.raycast(_eye, _dir, MAX_BUILD_RANGE + 1.5, null);
    // Land the aim point *on* the surface being looked at, nudged back along
    // its normal. Clamping the distance to a minimum instead would push the
    // point through the floor when the player aims at their own feet, which is
    // exactly the case where they are trying to place a floor.
    const dist = Math.min(hit ? hit.t : MAX_BUILD_RANGE * 0.8, MAX_BUILD_RANGE);
    _pt.copy(_eye).addScaledVector(_dir, Math.max(dist, 0.5));
    if (hit) _pt.addScaledVector(hit.normal, 0.12);

    const piece = this.piece;
    const g = this.grid;

    if (piece === PIECE.WALL) {
      // Walls sit on cell boundaries. Of the two boundaries of the aimed-at
      // cell along the facing axis, take the one *nearer* the player: a wall is
      // cover, and cover belongs between the player and what they are looking
      // at, not on the far side of it. That also keeps walls within arm's reach
      // for editing.
      const useX = Math.abs(_dir.x) > Math.abs(_dir.z);
      const dirIndex = useX ? (_dir.x > 0 ? 1 : 3) : (_dir.z > 0 ? 2 : 0);
      const nearSlotDir = (dirIndex + 2) % 4;    // the boundary behind the aim point
      g.cellOf(_pt.x, _pt.y, _pt.z, _cell);

      // If that boundary is level with or behind the player, step one cell on
      // so the wall always goes up in front of them.
      const axisPlayer = useX ? p.position.x : p.position.z;
      const sign = useX ? Math.sign(_dir.x) : Math.sign(_dir.z);
      let boundary = this._wallBoundary(_cell, nearSlotDir, useX);
      if ((boundary - axisPlayer) * sign < 1.1) {
        if (useX) _cell.cx += sign > 0 ? 1 : -1; else _cell.cz += sign > 0 ? 1 : -1;
        boundary = this._wallBoundary(_cell, nearSlotDir, useX);
      }

      const key = g.wallKey(_cell.cx, _cell.cy, _cell.cz, nearSlotDir);
      const parts = key.split(',');
      const kcx = +parts[0], kcy = +parts[1], kcz = +parts[2], kslot = +parts[3];
      g.anchor(kcx, kcy, kcz, kslot, _anchor);
      out.key = key;
      out.proto = 'wall';
      out.slot = kslot;
      out.cell = { cx: kcx, cy: kcy, cz: kcz };
      out.x = _anchor.x; out.y = _anchor.y; out.z = _anchor.z; out.yaw = _anchor.yaw;
    } else {
      g.cellOf(_pt.x, _pt.y, _pt.z, _cell);
      const slot = PIECE_SLOT[piece];
      // A floor or ramp aimed at the ground should land on the cell the surface
      // belongs to, not the one the ray happened to stop a few centimetres into.
      if (hit && hit.normal.y > 0.5 && piece !== PIECE.CONE) {
        _cell.cy = Math.floor((_pt.y + 0.15) / MODULE);
      }
      g.anchor(_cell.cx, _cell.cy, _cell.cz, slot, _anchor);
      out.key = g.key(_cell.cx, _cell.cy, _cell.cz, slot);
      out.proto = PIECE_PROTO[piece];
      out.slot = slot;
      out.cell = { cx: _cell.cx, cy: _cell.cy, cz: _cell.cz };
      out.x = _anchor.x; out.y = _anchor.y; out.z = _anchor.z;
      // Ramps face the player's cardinal heading; cones are symmetric.
      out.yaw = piece === PIECE.RAMP ? this._rampYaw() : 0;
    }

    out.valid = true;
    out.reason = '';
    this._validate(out);
    return out;
  }

  /** World coordinate of a cell's wall boundary along the given axis. */
  _wallBoundary(cell, dir, useX) {
    const m = MODULE;
    if (useX) return dir === 1 ? (cell.cx + 1) * m : cell.cx * m;
    return dir === 2 ? (cell.cz + 1) * m : cell.cz * m;
  }

  /** Ramps ascend away from the player, snapped to the nearest quarter turn. */
  _rampYaw() {
    const yaw = this.player.yaw + this.rotation * Math.PI / 2;
    return Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
  }

  _validate(t) {
    if (!this.canAfford()) { t.valid = false; t.reason = 'resources'; return; }
    if (this.grid.has(t.key)) { t.valid = false; t.reason = 'occupied'; return; }
    if (!this.terrain.isInsideMap(t.x, t.z)) { t.valid = false; t.reason = 'bounds'; return; }

    // The piece must not be placed inside the player. Floors and ramps under
    // the feet are allowed — that is how a player builds upward.
    this._pieceBox(t, _box);
    const pp = this.player.position;
    const pr = this.player.body.radius;
    const overlapsPlayer = _box.max.x > pp.x - pr && _box.min.x < pp.x + pr
      && _box.max.z > pp.z - pr && _box.min.z < pp.z + pr
      && _box.max.y > pp.y + 0.35 && _box.min.y < pp.y + this.player.body.height;
    if (overlapsPlayer && (t.proto === 'wall' || t.proto === 'cone')) {
      t.valid = false; t.reason = 'blocked'; return;
    }

    if (!this._isSupported(t)) { t.valid = false; t.reason = 'unsupported'; return; }
  }

  /**
   * Supported means the piece physically touches something: the ground, world
   * architecture, or another build piece.
   *
   * An earlier version tested grid adjacency instead — "is any slot in a
   * neighbouring cell occupied" — which let a cone hover a full cell above the
   * wall it was supposedly resting on, because the cone anchors to the *top* of
   * its cell while a wall spans the cell below. A geometric contact test has no
   * such blind spot, and needs no special case per piece type: every build
   * piece is already a collider, so one query covers both worlds.
   */
  _isSupported(t) {
    this._pieceBox(t, _box);
    const groundY = this.terrain.heightAt(t.x, t.z);
    if (_box.min.y <= groundY + 1.2) return true;

    const pad = 0.3;
    const out = [];
    const n = this.colliders.query(
      _box.min.x - pad, _box.min.y - pad, _box.min.z - pad,
      _box.max.x + pad, _box.max.y + pad, _box.max.z + pad, out);
    for (let i = 0; i < n; i++) {
      const meta = this.colliders.getMeta(out[i]);
      if (!meta) continue;
      if (meta.type === 'structure' || meta.type === 'tree' || meta.type === 'rock') return true;
    }
    return false;
  }

  /** Approximate world AABB of a previewed piece. */
  _pieceBox(t, box) {
    const m = MODULE;
    const half = m / 2;
    switch (t.proto) {
      case 'wall':
        if (Math.abs(t.yaw) < 0.01) box.set(new THREE.Vector3(t.x - half, t.y, t.z - 0.15),
          new THREE.Vector3(t.x + half, t.y + m, t.z + 0.15));
        else box.set(new THREE.Vector3(t.x - 0.15, t.y, t.z - half),
          new THREE.Vector3(t.x + 0.15, t.y + m, t.z + half));
        break;
      case 'floor':
        box.set(new THREE.Vector3(t.x - half, t.y - 0.14, t.z - half),
          new THREE.Vector3(t.x + half, t.y + 0.14, t.z + half));
        break;
      case 'cone':
        box.set(new THREE.Vector3(t.x - half, t.y, t.z - half),
          new THREE.Vector3(t.x + half, t.y + m * 0.5, t.z + half));
        break;
      default: // stair
        box.set(new THREE.Vector3(t.x - half, t.y, t.z - half),
          new THREE.Vector3(t.x + half, t.y + m, t.z + half));
    }
    return box;
  }

  /* ------------------------------------------------------------------ */
  /* placement                                                           */
  /* ------------------------------------------------------------------ */

  place() {
    const t = this.preview;
    if (!t.valid) return false;
    const mat = BUILD_MAT[this.material];

    const recordId = this.kit.place(t.proto, t.x, t.y, t.z, t.yaw, {
      key: mat.key, tint: mat.tint, hp: mat.hp, harvest: mat.harvest,
    });
    if (recordId === null) return false;

    const rec = this.kit.records[recordId];
    rec.meta.owner = 'player';
    rec.meta.buildKey = t.key;
    rec.meta.material = mat.key;
    rec.meta.maxHp = mat.hp;
    // Ramp health in from a fraction of maximum, so a wall thrown up mid-fight
    // is breakable for a moment. This is the core of the build-fight dynamic.
    rec.meta.hp = Math.max(1, Math.round(mat.hp * mat.initialHp));
    rec.meta.buildTimer = 0;
    rec.meta.buildTime = mat.buildTime;
    this.pending.push(rec);

    this.grid.set(t.key, recordId);
    this.resources[mat.key] -= mat.cost;
    this.stats.placed++;
    this.stats.spent += mat.cost;

    this.bus.queue('build:placed', {
      record: recordId, piece: this.piece, material: mat.key,
      x: t.x, y: t.y, z: t.z, key: t.key,
    });
    return true;
  }

  /** Damage a placed piece by its collider meta. Returns true when destroyed. */
  damageRecord(recordId, amount, source = null) {
    const rec = this.kit.records[recordId];
    if (!rec || !rec.alive) return false;
    const destroyed = this.kit.damage(recordId, amount);
    if (destroyed) {
      this.grid.remove(rec.meta.buildKey);
      this.stats.destroyed++;
      this.bus.queue('build:destroyed', {
        record: recordId, material: rec.meta.material, source,
        x: (rec.box.min.x + rec.box.max.x) / 2,
        y: (rec.box.min.y + rec.box.max.y) / 2,
        z: (rec.box.min.z + rec.box.max.z) / 2,
      });
    } else {
      this.bus.queue('build:damaged', { record: recordId, amount, hp: rec.meta.hp });
    }
    return destroyed;
  }

  destroyRecord(recordId) { return this.damageRecord(recordId, 1e9); }

  /** Remove a piece and refund most of its cost — the player's own structure. */
  reclaim(recordId) {
    const rec = this.kit.records[recordId];
    if (!rec || !rec.alive || rec.meta.owner !== 'player') return false;
    const mat = BUILD_MAT[rec.meta.material];
    this.kit.destroy(recordId);
    this.grid.remove(rec.meta.buildKey);
    const refund = Math.floor(mat.cost * 0.5);
    this.addResource(mat.key, refund);
    this.stats.refunded += refund;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* editing                                                             */
  /* ------------------------------------------------------------------ */

  /** The player's own wall under the crosshair, or null. */
  targetOwnPiece() {
    this.player.eyePosition(_eye);
    this.player.lookDirection(_dir);
    // Anything within build reach should be editable; a shorter ray would make
    // a wall the player just placed unreachable on sloping ground.
    const hit = this.colliders.raycast(_eye.x, _eye.y, _eye.z, _dir.x, _dir.y, _dir.z, MAX_BUILD_RANGE + MODULE,
      (meta) => meta && meta.owner === 'player');
    if (!hit || !hit.meta) return null;
    return hit.meta.record;
  }

  beginEdit() {
    const recordId = this.targetOwnPiece();
    if (recordId === null || recordId === undefined) return false;
    const rec = this.kit.records[recordId];
    if (!rec || !rec.alive) return false;
    if (!EDITABLE_PROTOS.has(rec.proto)) return false;
    this.editing = true;
    this.editTarget = recordId;
    this.editCells.clear();
    return true;
  }

  toggleEditCell(i) {
    if (!this.editing) return false;
    if (this.editCells.has(i)) this.editCells.delete(i);
    else this.editCells.add(i);
    return true;
  }

  /**
   * Map a normalised tap on the edited face to one of the 3x3 cells.
   * `u` and `v` are 0..1 across the face, v measured from the top.
   */
  editCellAt(u, v) {
    const col = Math.min(2, Math.max(0, Math.floor(u * 3)));
    const row = Math.min(2, Math.max(0, Math.floor(v * 3)));
    return row * 3 + col;
  }

  /**
   * Apply the selection as the closest matching preset. Supporting all 512
   * possible 3x3 patterns would need 512 prototypes; matching to a small preset
   * set keeps the mechanic (making openings on demand) with instanced geometry.
   */
  confirmEdit() {
    if (!this.editing || this.editTarget === null) return false;
    const rec = this.kit.records[this.editTarget];
    if (!rec || !rec.alive) { this.cancelEdit(); return false; }

    // Touch fallback: confirming with nothing selected applies the doorway, the
    // preset players reach for most. The 3x3 selection overlay lands with the
    // HUD; until then EDIT is still usable with one button.
    if (this.editCells.size === 0) { this.editCells.add(6); this.editCells.add(7); this.editCells.add(8); }

    let best = null, bestScore = -1;
    for (const preset of EDIT_PRESETS) {
      const set = new Set(preset.cells);
      let hit = 0;
      for (const c of this.editCells) if (set.has(c)) hit++;
      // Jaccard similarity: rewards overlap, penalises extra cells on either side.
      const score = hit / (set.size + this.editCells.size - hit);
      if (score > bestScore) { bestScore = score; best = preset; }
    }
    if (!best || bestScore <= 0) { this.cancelEdit(); return false; }

    const key = rec.meta.buildKey;
    const matKey = rec.meta.material;
    const box = rec.box.clone();
    const yaw = this._recordYaw(rec);
    this.kit.destroy(this.editTarget);
    this.grid.remove(key);

    if (best.proto) {
      const mat = BUILD_MAT[matKey];
      const x = (box.min.x + box.max.x) / 2;
      const z = (box.min.z + box.max.z) / 2;
      const newId = this.kit.place(best.proto, x, box.min.y, z, yaw, {
        key: mat.key, tint: mat.tint, hp: mat.hp, harvest: mat.harvest,
      });
      if (newId !== null) {
        const nr = this.kit.records[newId];
        nr.meta.owner = 'player';
        nr.meta.buildKey = key;
        nr.meta.material = matKey;
        nr.meta.hp = rec.meta.hp;
        nr.meta.maxHp = mat.hp;
        this.grid.set(key, newId);
      }
    }
    this.stats.edits++;
    this.bus.queue('build:edited', { preset: best.id, record: this.editTarget });
    this.cancelEdit();
    return true;
  }

  cancelEdit() { this.editing = false; this.editTarget = null; this.editCells.clear(); }

  /** Recover a placed panel's yaw from its footprint (walls are thin in one axis). */
  _recordYaw(rec) {
    const w = rec.box.max.x - rec.box.min.x;
    const d = rec.box.max.z - rec.box.min.z;
    return w < d ? Math.PI / 2 : 0;
  }

  /* ------------------------------------------------------------------ */
  /* per-frame                                                           */
  /* ------------------------------------------------------------------ */

  fixedUpdate(dt) {
    const s = this.input.state;
    this.active = s.buildMode;

    // Health ramp-up for recently placed pieces.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const rec = this.pending[i];
      if (!rec.alive) { this.pending.splice(i, 1); continue; }
      rec.meta.buildTimer += dt;
      const t = Math.min(1, rec.meta.buildTimer / rec.meta.buildTime);
      const mat = BUILD_MAT[rec.meta.material];
      const target = Math.round(mat.hp * (mat.initialHp + (1 - mat.initialHp) * t));
      // Never heal a piece that has been shot below its ramp value.
      rec.meta.hp = Math.min(rec.meta.hp + Math.max(0, target - rec.meta.hp), mat.hp);
      if (t >= 1) this.pending.splice(i, 1);
    }

    this._cooldown = Math.max(0, this._cooldown - dt);

    if (!this.active) {
      if (this.editing) this.cancelEdit();
      return;
    }

    if (s.buildPiece !== this.piece) this.setPiece(s.buildPiece);
    if (s.buildMaterial) this.setMaterial(s.buildMaterial);
    if (this.input.pressed.buildRotate) this.rotate();

    if (this.input.pressed.editMode) {
      if (this.editing) this.confirmEdit(); else this.beginEdit();
    }
    if (this.editing) return;      // no placement while an edit is open

    this.computeTarget();

    // Holding place keeps building — "turbo build" — with a short cooldown so
    // a single tap cannot spend a whole stack of materials.
    if (s.fire && this._cooldown <= 0) {
      if (this.place()) this._cooldown = PLACE_COOLDOWN;
      else this._cooldown = 0.05;
    }
  }

  update() {
    // Ghost visibility and colour.
    for (const m of this.ghosts.values()) m.visible = false;
    if (!this.active || this.editing) return;
    const t = this.preview;
    const ghost = this.ghosts.get(t.proto);
    if (!ghost) return;
    _e.set(0, t.yaw, 0);
    _q.setFromEuler(_e);
    _v.set(t.x, t.y, t.z);
    _mat4.compose(_v, _q, _s);
    ghost.matrix.copy(_mat4);
    ghost.matrixAutoUpdate = false;
    ghost.material = t.valid ? this.ghostMatValid : this.ghostMatInvalid;
    ghost.visible = true;
  }

  state() {
    return {
      active: this.active,
      piece: PIECE_NAMES[this.piece],
      material: this.material,
      editing: this.editing,
      editTarget: this.editTarget,
      editCells: [...this.editCells],
      resources: { ...this.resources },
      placed: this.stats.placed,
      destroyed: this.stats.destroyed,
      edits: this.stats.edits,
      live: this.kit.liveCount,
      gridCount: this.grid.count,
      preview: {
        valid: this.preview.valid, reason: this.preview.reason, key: this.preview.key,
        proto: this.preview.proto,
        pos: [+this.preview.x.toFixed(2), +this.preview.y.toFixed(2), +this.preview.z.toFixed(2)],
      },
    };
  }

  dispose() { this.kit.dispose(); }

  static get PIECE() { return PIECE; }
  static get EDIT_PRESETS() { return EDIT_PRESETS; }
}

const EDITABLE_PROTOS = new Set(['wall', 'wallDoor', 'wallWindow', 'wallHalf', 'wallHalfSide']);

