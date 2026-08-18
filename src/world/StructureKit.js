import * as THREE from 'three';
import * as MeshGen from '../gen/MeshGen.js';
import { srgbHex } from '../gen/Palette.js';

/**
 * StructureKit — the shared panel library every building on the map is made of.
 *
 * Buildings are assembled from a small set of 4-metre panel prototypes, each
 * drawn as a single InstancedMesh. Two consequences follow, and both are why
 * the kit exists:
 *
 *  1. Every structure on the island costs one draw call per panel type
 *     (about ten in total), regardless of how many POIs are placed.
 *  2. A panel is an instance, so destroying one is a matrix write and a
 *     collider removal — no geometry rebuild, no material switch.
 *
 * Material identity (timber / brick / concrete / steel) is carried by the
 * per-instance colour, not by separate materials, so the whole kit shares one
 * neutral panel texture. Per-vertex shading on the prototypes supplies the
 * baked edge darkening that sells the form under a single light.
 */

export const MODULE = 4;          // metres; matches the player build grid
const WALL_T = 0.24;              // wall thickness
const SLAB_T = 0.28;              // floor slab thickness

/** Structure material tints, authored in sRGB. */
export const MAT = {
  timber: { key: 'timber', tint: 0xb98a52, hp: 220, harvest: 'wood' },
  brick: { key: 'brick', tint: 0xa8604f, hp: 340, harvest: 'brick' },
  concrete: { key: 'concrete', tint: 0x9d9c96, hp: 380, harvest: 'brick' },
  steel: { key: 'steel', tint: 0x7f8792, hp: 460, harvest: 'metal' },
  roof: { key: 'roof', tint: 0x9c7358, hp: 200, harvest: 'wood' },
  glass: { key: 'glass', tint: 0x86b3c8, hp: 40, harvest: 'brick' },
};

/**
 * Bake soft directional shading into vertex colours: down-facing faces darker,
 * up-facing lighter, plus a slight vertical gradient. Instanced panels get no
 * ambient occlusion otherwise, and flat white boxes read as cardboard.
 */
function shadePanel(geo, height = MODULE) {
  geo.computeVertexNormals();
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const ny = nrm.getY(i);
    const y = pos.getY(i);
    const facing = 0.84 + Math.max(0, ny) * 0.24 - Math.max(0, -ny) * 0.16;
    const vertical = 0.90 + THREE.MathUtils.clamp(y / height, -0.5, 1) * 0.14;
    const k = facing * vertical;
    col[i * 3] = k; col[i * 3 + 1] = k; col[i * 3 + 2] = k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Box helper whose UVs are scaled to world size so the detail map keeps scale. */
function panelBox(w, h, d, uvScale = 0.42) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv');
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i));
    // Project UVs onto the dominant axis so texel density is uniform per face.
    let u, v;
    if (nx > 0.5) { u = pos.getZ(i); v = pos.getY(i); }
    else if (ny > 0.5) { u = pos.getX(i); v = pos.getZ(i); }
    else { u = pos.getX(i); v = pos.getY(i); }
    uv.setXY(i, u * uvScale, v * uvScale);
  }
  return g;
}

/**
 * Prototype builders. Each returns geometry centred on its module origin:
 * X and Z span the module, Y runs from 0 at the module floor.
 */
const PROTOS = {
  /** Solid wall filling one module face. */
  wall() {
    const g = panelBox(MODULE, MODULE, WALL_T);
    g.translate(0, MODULE / 2, 0);
    return shadePanel(g);
  },

  /** Wall with a window opening, built as four strips around the hole. */
  wallWindow() {
    const ww = 2.0, wh = 1.5, sillY = 1.15;
    const side = (MODULE - ww) / 2;
    const parts = [
      MeshGen.xform(panelBox(MODULE, sillY, WALL_T), { pos: [0, sillY / 2, 0] }),
      MeshGen.xform(panelBox(MODULE, MODULE - sillY - wh, WALL_T), { pos: [0, sillY + wh + (MODULE - sillY - wh) / 2, 0] }),
      MeshGen.xform(panelBox(side, wh, WALL_T), { pos: [-(ww / 2 + side / 2), sillY + wh / 2, 0] }),
      MeshGen.xform(panelBox(side, wh, WALL_T), { pos: [ww / 2 + side / 2, sillY + wh / 2, 0] }),
    ];
    return shadePanel(MeshGen.merge(parts));
  },

  /** Wall with a doorway. */
  wallDoor() {
    const dw = 1.25, dh = 2.4;
    const side = (MODULE - dw) / 2;
    const parts = [
      MeshGen.xform(panelBox(MODULE, MODULE - dh, WALL_T), { pos: [0, dh + (MODULE - dh) / 2, 0] }),
      MeshGen.xform(panelBox(side, dh, WALL_T), { pos: [-(dw / 2 + side / 2), dh / 2, 0] }),
      MeshGen.xform(panelBox(side, dh, WALL_T), { pos: [dw / 2 + side / 2, dh / 2, 0] }),
    ];
    return shadePanel(MeshGen.merge(parts));
  },

  /** Floor / ceiling slab covering one module. */
  floor() {
    const g = panelBox(MODULE, SLAB_T, MODULE);
    return shadePanel(g, 1);
  },

  /** Window glass pane — separate so it can be tinted and shot out. */
  glass() {
    const g = panelBox(2.0, 1.5, 0.05, 0.3);
    g.translate(0, 1.15 + 1.5 / 2, 0);
    return shadePanel(g);
  },

  /** Staircase spanning one module in run and rise. */
  stair() {
    const g = MeshGen.stairs(MODULE - 0.4, MODULE, MODULE, 8);
    g.translate(0, MODULE / 2, 0);
    const n = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    return shadePanel(g);
  },

  /** Corner post. */
  pillar() {
    const g = panelBox(0.36, MODULE, 0.36);
    g.translate(0, MODULE / 2, 0);
    return shadePanel(g);
  },

  /** Waist-high railing: two horizontal rails on three posts. */
  rail() {
    const parts = [
      MeshGen.xform(panelBox(MODULE, 0.09, 0.09), { pos: [0, 1.05, 0] }),
      MeshGen.xform(panelBox(MODULE, 0.09, 0.09), { pos: [0, 0.55, 0] }),
      MeshGen.xform(panelBox(0.12, 1.1, 0.12), { pos: [-MODULE / 2 + 0.1, 0.55, 0] }),
      MeshGen.xform(panelBox(0.12, 1.1, 0.12), { pos: [0, 0.55, 0] }),
      MeshGen.xform(panelBox(0.12, 1.1, 0.12), { pos: [MODULE / 2 - 0.1, 0.55, 0] }),
    ];
    return shadePanel(MeshGen.merge(parts), 1.2);
  },

  /** Gable end: a triangular prism closing a pitched roof. */
  gable() {
    const g = MeshGen.extrude([[-MODULE / 2, 0], [MODULE / 2, 0], [0, MODULE * 0.5]], WALL_T);
    const n = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    return shadePanel(g, MODULE * 0.5);
  },

  /** Supply crate prop. */
  crate() {
    const g = MeshGen.roundedBox(1.15, 1.15, 1.15, 0.06, 2);
    g.translate(0, 0.58, 0);
    const n = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    return shadePanel(g, 1.2);
  },

  /** Barrel prop. */
  barrel() {
    const g = new THREE.CylinderGeometry(0.42, 0.42, 1.1, 8, 1);
    g.translate(0, 0.55, 0);
    return shadePanel(g, 1.2);
  },
};

export const PROTO_NAMES = Object.keys(PROTOS);

/**
 * Collision shape per prototype, in the prototype's own local space, as a list
 * of boxes given by centre and half-extents.
 *
 * Most panels are a single box. A staircase is emphatically not: representing
 * one as its overall bounds turns it into a solid four-metre cube that nothing
 * can walk up. Each tread therefore gets its own box, sized so the rise from
 * one to the next stays inside the character controller's step height.
 */
function stairBoxes() {
  const steps = 8;
  const sh = MODULE / steps, sd = MODULE / steps;
  const hw = (MODULE - 0.4) / 2;
  const out = [];
  for (let i = 0; i < steps; i++) {
    // Geometry ascends toward -Z; each tread is solid from the ground up so a
    // character standing on it is supported.
    const top = sh * (i + 1);
    const zc = MODULE / 2 - sd * (i + 0.5);
    out.push({ cx: 0, cy: top / 2, cz: zc, hx: hw, hy: top / 2, hz: sd / 2 });
  }
  return out;
}

const SHAPES = {
  stair: stairBoxes(),
};

/** Overall footprint per prototype, used when no explicit shape is given. */
const BOUNDS = {
  wall: [MODULE, MODULE, WALL_T],
  wallWindow: [MODULE, MODULE, WALL_T],
  wallDoor: [MODULE, MODULE, WALL_T],
  floor: [MODULE, SLAB_T, MODULE],
  glass: [2.0, 1.5, 0.05],
  stair: [MODULE - 0.4, MODULE, MODULE],
  pillar: [0.36, MODULE, 0.36],
  rail: [MODULE, 1.1, 0.14],
  gable: [MODULE, MODULE * 0.5, WALL_T],
  crate: [1.15, 1.15, 1.15],
  barrel: [0.84, 1.1, 0.84],
};

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _min = new THREE.Vector3();
const _max = new THREE.Vector3();
const _box = new THREE.Box3();

export class StructureKit {
  constructor(services, capacityHint = 900) {
    this.scene = services.get('scene');
    this.settings = services.get('settings');
    this.materials = services.get('materials');
    this.colliders = services.get('colliders');

    this.group = new THREE.Group();
    this.group.name = 'structures';
    this.scene.add(this.group);

    this.material = this.materials.surface('panel', { repeat: 1, vertexColors: true, normalScale: 0.6 });
    this.glassMaterial = this.materials.surface('panel', { repeat: 1, vertexColors: true });

    this.meshes = new Map();
    this.records = [];             // one entry per placed panel
    this.capacityHint = capacityHint;
    this.stats = { placed: 0, destroyed: 0, drawCalls: 0 };
  }

  _mesh(proto) {
    let m = this.meshes.get(proto);
    if (m) return m;
    const geo = PROTOS[proto]();
    const isGlass = proto === 'glass';
    const mat = isGlass
      ? this.materials.basic('glasspane', { transparent: true, opacity: 0.14, depthWrite: false, vertexColors: true, side: THREE.DoubleSide })
      : this.material;
    m = new THREE.InstancedMesh(geo, mat, this.capacityHint);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.castShadow = this.settings.q.shadows && !isGlass;
    m.receiveShadow = this.settings.q.shadows;
    m.name = `panel_${proto}`;
    // Buildings are static and clustered; a generous bounding sphere set once
    // is cheaper than per-instance culling and still lets the whole POI drop
    // out of the frustum together.
    m.frustumCulled = false;
    this.meshes.set(proto, m);
    this.group.add(m);
    this.stats.drawCalls = this.meshes.size;
    return m;
  }

  /**
   * Place one panel.
   *
   * Collision boxes are produced by transforming each local shape box's eight
   * corners through the same matrix used for rendering and taking the world
   * AABB. Deriving the box from unrotated bounds would misplace every rotated
   * wall and, worse, give a pitched roof slab the collision of a flat one.
   */
  place(proto, x, y, z, rotY = 0, material = MAT.timber, opts = {}) {
    const mesh = this._mesh(proto);
    if (mesh.count >= mesh.instanceMatrix.count) return null;
    const idx = mesh.count++;

    _p.set(x, y, z);
    _e.set(opts.rotX || 0, rotY, opts.rotZ || 0);
    _q.setFromEuler(_e);
    _s.set(opts.sx || 1, opts.sy || 1, opts.sz || 1);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(idx, _m);
    mesh.instanceMatrix.needsUpdate = true;

    _c.setHex(material.tint);
    mesh.setColorAt(idx, _c);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    const recordId = this.records.length;
    const meta = {
      type: 'structure', proto, material: material.key,
      harvest: material.harvest, hp: material.hp, maxHp: material.hp,
      record: recordId, solid: opts.solid !== false,
    };

    const handles = [];
    const bounds = new THREE.Box3();
    bounds.makeEmpty();
    if (opts.solid !== false) {
      for (const b of localBoxes(proto)) {
        worldAabb(b, _m, _min, _max);
        handles.push(this.colliders.add(_min, _max, meta));
        bounds.expandByPoint(_min);
        bounds.expandByPoint(_max);
      }
    } else {
      worldAabb(localBoxes(proto)[0], _m, _min, _max);
      bounds.set(_min.clone(), _max.clone());
    }

    this.records.push({ proto, idx, handles, meta, alive: true, box: bounds });
    this.stats.placed++;
    return recordId;
  }

  /** Apply damage to a placed panel; returns true when it is destroyed. */
  damage(recordId, amount) {
    const r = this.records[recordId];
    if (!r || !r.alive) return false;
    r.meta.hp -= amount;
    if (r.meta.hp > 0) return false;
    this.destroy(recordId);
    return true;
  }

  /**
   * Remove a panel. The instance is collapsed to zero scale rather than
   * compacted, so every other record keeps its index and no matrices move.
   */
  destroy(recordId) {
    const r = this.records[recordId];
    if (!r || !r.alive) return false;
    const mesh = this.meshes.get(r.proto);
    _m.makeScale(0, 0, 0);
    mesh.setMatrixAt(r.idx, _m);
    mesh.instanceMatrix.needsUpdate = true;
    for (const h of r.handles) this.colliders.remove(h);
    r.handles.length = 0;
    r.alive = false;
    this.stats.destroyed++;
    return true;
  }

  recordBox(recordId, target = _box) {
    const r = this.records[recordId];
    return r ? target.copy(r.box) : null;
  }

  get liveCount() { return this.stats.placed - this.stats.destroyed; }

  dispose() {
    for (const m of this.meshes.values()) { m.geometry.dispose(); this.group.remove(m); }
    this.meshes.clear();
    this.scene.remove(this.group);
  }
}

/** Local collision boxes for a prototype: an explicit shape, or its bounds. */
function localBoxes(proto) {
  if (SHAPES[proto]) return SHAPES[proto];
  const [w, h, d] = BOUNDS[proto];
  // Prototypes whose origin sits at the module floor extend upward; the slab
  // and prop prototypes are already centred on their own origin.
  const centred = proto === 'floor';
  return [{ cx: 0, cy: centred ? 0 : h / 2, cz: 0, hx: w / 2, hy: h / 2, hz: d / 2 }];
}

const _corner = new THREE.Vector3();

/** World-space AABB of a local box transformed by `m`. */
function worldAabb(b, m, min, max) {
  min.set(Infinity, Infinity, Infinity);
  max.set(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < 8; i++) {
    _corner.set(
      b.cx + ((i & 1) ? b.hx : -b.hx),
      b.cy + ((i & 2) ? b.hy : -b.hy),
      b.cz + ((i & 4) ? b.hz : -b.hz),
    ).applyMatrix4(m);
    min.min(_corner);
    max.max(_corner);
  }
  return min;
}

export { PROTOS, BOUNDS, SHAPES, localBoxes };
