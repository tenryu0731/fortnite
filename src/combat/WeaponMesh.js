import * as THREE from 'three';
import * as MeshGen from '../gen/MeshGen.js';
import { RARITY } from './Weapons.js';

/**
 * WeaponMesh — procedurally built weapon models.
 *
 * Each class is assembled from a handful of boxes into a single merged
 * geometry, so a held weapon is one draw call. Silhouette carries the class
 * (long barrel for a sniper, stubby for an SMG) because at third-person scale
 * the outline is all the player can read; rarity is carried by an accent colour
 * on the receiver so a dropped weapon's tier is legible at a glance.
 */

const BODY = 0x2b2f36;
const METAL = 0x6d7581;
const GRIP = 0x3a2f27;

/** Shorthand: coloured box at a position. */
function part(w, h, d, x, y, z, color) {
  return MeshGen.paint(MeshGen.xform(MeshGen.box(w, h, d), { pos: [x, y, z] }), color);
}

const BUILDERS = {
  rifle(accent) {
    return [
      part(0.07, 0.09, 0.62, 0, 0, 0.12, BODY),        // receiver
      part(0.045, 0.045, 0.52, 0, 0.005, 0.55, METAL), // barrel
      part(0.055, 0.05, 0.10, 0, 0.055, 0.06, accent), // optic rail
      part(0.05, 0.16, 0.09, 0, -0.11, 0.02, GRIP),    // grip
      part(0.06, 0.13, 0.10, 0, -0.09, 0.22, BODY),    // magazine
      part(0.06, 0.10, 0.24, 0, -0.02, -0.24, BODY),   // stock
      part(0.035, 0.035, 0.14, 0, -0.06, 0.42, METAL), // foregrip
    ];
  },
  smg(accent) {
    return [
      part(0.07, 0.09, 0.40, 0, 0, 0.08, BODY),
      part(0.04, 0.04, 0.26, 0, 0.005, 0.36, METAL),
      part(0.05, 0.04, 0.08, 0, 0.055, 0.02, accent),
      part(0.05, 0.15, 0.08, 0, -0.10, -0.02, GRIP),
      part(0.05, 0.18, 0.07, 0, -0.12, 0.14, BODY),
      part(0.05, 0.07, 0.16, 0, -0.01, -0.20, METAL),
    ];
  },
  shotgun(accent) {
    return [
      part(0.09, 0.10, 0.52, 0, 0, 0.14, BODY),
      part(0.06, 0.06, 0.56, 0, 0.01, 0.58, METAL),
      part(0.07, 0.05, 0.20, 0, -0.05, 0.44, GRIP),    // pump
      part(0.05, 0.05, 0.08, 0, 0.06, 0.06, accent),
      part(0.05, 0.15, 0.09, 0, -0.10, 0.00, GRIP),
      part(0.07, 0.11, 0.28, 0, -0.03, -0.26, BODY),
    ];
  },
  sniper(accent) {
    return [
      part(0.06, 0.09, 0.66, 0, 0, 0.16, BODY),
      part(0.038, 0.038, 0.80, 0, 0.005, 0.76, METAL),
      part(0.05, 0.05, 0.30, 0, 0.085, 0.12, BODY),    // scope tube
      part(0.065, 0.065, 0.07, 0, 0.085, 0.28, accent), // objective
      part(0.05, 0.15, 0.09, 0, -0.11, 0.00, GRIP),
      part(0.06, 0.09, 0.10, 0, -0.07, 0.22, BODY),    // bolt housing
      part(0.07, 0.12, 0.34, 0, -0.02, -0.32, GRIP),   // stock
    ];
  },
  pistol(accent) {
    return [
      part(0.05, 0.08, 0.26, 0, 0, 0.06, BODY),
      part(0.035, 0.035, 0.14, 0, 0.005, 0.24, METAL),
      part(0.04, 0.03, 0.05, 0, 0.05, 0.02, accent),
      part(0.05, 0.16, 0.08, 0, -0.11, -0.04, GRIP),
    ];
  },
  melee() {
    return [
      part(0.045, 0.045, 0.66, 0, 0, 0.20, GRIP),      // haft
      part(0.30, 0.06, 0.07, 0, 0.02, 0.50, METAL),    // head
      part(0.07, 0.05, 0.16, 0.14, 0.02, 0.46, METAL), // pick
      part(0.055, 0.05, 0.10, 0, 0, -0.10, BODY),      // pommel
    ];
  },
};

const cache = new Map();

/**
 * Geometry for a weapon class and rarity. Results are cached: a match can hold
 * dozens of dropped weapons, and they are all the same handful of shapes.
 */
export function weaponGeometry(cls, rarityKey = 'common') {
  const key = `${cls}:${rarityKey}`;
  if (cache.has(key)) return cache.get(key);
  const build = BUILDERS[cls] || BUILDERS.rifle;
  const accent = (RARITY[rarityKey] || RARITY.common).color;
  const geo = MeshGen.merge(build(accent));
  cache.set(key, geo);
  return geo;
}

export function disposeWeaponCache() {
  for (const g of cache.values()) g.dispose();
  cache.clear();
}

/** A held weapon: one mesh parented to the character's weapon socket. */
export class HeldWeapon {
  constructor(material) {
    this.material = material;
    this.mesh = new THREE.Mesh(weaponGeometry('rifle', 'common'), material);
    this.mesh.castShadow = true;
    this.mesh.visible = false;
    // Weapons are authored pointing +Z; the socket hangs down the arm, so the
    // model is pitched forward to sit in the hand.
    this.mesh.rotation.set(-Math.PI / 2 + 0.06, 0, 0);
    this.mesh.position.set(0, -0.02, 0.06);
  }

  set(cls, rarityKey) {
    if (!cls) { this.mesh.visible = false; return; }
    this.mesh.geometry = weaponGeometry(cls, rarityKey);
    this.mesh.visible = true;
  }

  get object() { return this.mesh; }

  dispose() { /* geometry is shared through the cache */ }
}
