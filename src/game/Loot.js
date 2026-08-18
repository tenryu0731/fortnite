import * as THREE from 'three';
import * as MeshGen from '../gen/MeshGen.js';
import { Rng } from '../gen/Rng.js';
import { srgbHex } from '../gen/Palette.js';
import { RARITY, RARITY_WEIGHTS, LOOT_WEIGHTS, WEAPON_IDS, WEAPONS, makeWeapon } from '../combat/Weapons.js';

/**
 * Loot — chests, floor pickups and the items they produce.
 *
 * Every ground item in a match is one instance in a shared InstancedMesh, and
 * chests are a second one, so the whole loot layer costs two draw calls no
 * matter how much is on the map. Items bob and spin, which is the cheapest way
 * to make a small object read as interactive at a distance; rarity is carried
 * by instance colour, so a player can tell an epic from a common across a room.
 *
 * Pickup is proximity plus intent: ammo and materials are absorbed on contact
 * because stopping to press a button for them is pure friction, while weapons
 * and consumables require the interact button so a player never loses a slot by
 * walking over something.
 */

export const ITEM = { WEAPON: 0, AMMO: 1, SHIELD: 2, MEDKIT: 3, MATERIAL: 4 };
const ITEM_NAMES = ['weapon', 'ammo', 'shield', 'medkit', 'material'];

const CONSUMABLE_DEFS = {
  shield: { name: 'Shield Potion', amount: 50, useTime: 4.0, stack: 3, color: 0x49b8ff },
  medkit: { name: 'Medkit', amount: 100, useTime: 8.0, stack: 3, color: 0xff5a6a },
};

const AUTO_PICKUP = new Set([ITEM.AMMO, ITEM.MATERIAL]);
const PICKUP_RADIUS = 2.1;
const CHEST_RADIUS = 2.6;

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();

export class Loot {
  constructor(seed, opts = {}) {
    this.order = 45;
    this.seed = seed;
    this.rng = Rng.forStream(seed, 'loot');
    this.items = [];
    this.chests = [];
    this.capacity = opts.capacity || 260;
    this.chestCapacity = opts.chestCapacity || 90;
    this.nearest = null;
    this.stats = { spawned: 0, pickedUp: 0, chestsOpened: 0, chests: 0 };
  }

  init(services) {
    this.services = services;
    this.scene = services.get('scene');
    this.terrain = services.get('terrain');
    this.structures = services.get('structures');
    this.player = services.get('player');
    this.combat = services.get('combat');
    this.build = services.get('build');
    this.input = services.get('input');
    this.bus = services.get('bus');
    this.audio = services.peek('audio');
    this.touch = services.peek('touch');
    const materials = services.get('materials');

    // Item body: a small faceted capsule-ish shape, readable as "pickup".
    const itemGeo = MeshGen.merge([
      MeshGen.paint(MeshGen.xform(new THREE.IcosahedronGeometry(0.30, 0), { pos: [0, 0, 0] }), 0xffffff),
      MeshGen.paint(MeshGen.xform(MeshGen.box(0.62, 0.06, 0.62), { pos: [0, -0.30, 0] }), 0xffffff),
    ]);
    this.itemMesh = new THREE.InstancedMesh(itemGeo, materials.particleLit('loot'), this.capacity);
    this.itemMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3).fill(1), 3);
    this.itemMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.itemMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.itemMesh.frustumCulled = false;
    this.itemMesh.castShadow = true;
    this.itemMesh.count = 0;
    this.itemMesh.name = 'loot-items';
    this.scene.add(this.itemMesh);

    const chestGeo = MeshGen.merge([
      MeshGen.paint(MeshGen.roundedBox(1.05, 0.62, 0.72, 0.06, 2), 0xc79a4a),
      MeshGen.paint(MeshGen.xform(MeshGen.box(1.10, 0.10, 0.77), { pos: [0, 0.34, 0] }), 0xe0b45c),
      MeshGen.paint(MeshGen.xform(MeshGen.box(0.16, 0.22, 0.80), { pos: [0, 0.05, 0] }), 0x7a5c2c),
    ]);
    chestGeo.translate(0, 0.34, 0);
    this.chestMesh = new THREE.InstancedMesh(chestGeo, materials.particleLit('loot'), this.chestCapacity);
    this.chestMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.chestCapacity * 3).fill(1), 3);
    this.chestMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chestMesh.frustumCulled = false;
    this.chestMesh.castShadow = true;
    this.chestMesh.count = 0;
    this.chestMesh.name = 'loot-chests';
    this.scene.add(this.chestMesh);

    services.set('loot', this);
  }

  /* ------------------------------------------------------------------ */
  /* population                                                          */
  /* ------------------------------------------------------------------ */

  /** Place chests at POI loot spots and scatter floor loot around them. */
  populate() {
    this.items.length = 0;
    this.chests.length = 0;
    const rng = this.rng;

    for (const spot of this.structures.lootSpots) {
      if (this.chests.length >= this.chestCapacity) break;
      if (!rng.chance(0.62)) continue;
      this.chests.push({
        x: spot.x, y: spot.y - 0.5, z: spot.z,
        yaw: rng.range(0, Math.PI * 2),
        opened: false, kind: spot.kind,
      });
    }
    this.stats.chests = this.chests.length;

    // Floor loot around each POI: what a player finds without opening anything.
    for (const poi of this.structures.pois) {
      const n = rng.intRange(3, 6);
      for (let i = 0; i < n; i++) {
        const a = rng.range(0, Math.PI * 2);
        const r = Math.sqrt(rng.next()) * poi.radius * 0.75;
        const x = poi.x + Math.cos(a) * r, z = poi.z + Math.sin(a) * r;
        this._spawnRolled(x, this.terrain.heightAt(x, z) + 0.4, z, rng, 0.55);
      }
    }
    return { chests: this.chests.length, items: this.items.length };
  }

  /** Roll one item: mostly weapons near POIs, with support items mixed in. */
  _spawnRolled(x, y, z, rng, weaponChance = 0.5) {
    const roll = rng.next();
    if (roll < weaponChance) {
      const id = rng.pickWeighted(WEAPON_IDS, WEAPON_IDS.map((w) => LOOT_WEIGHTS[w] || 0.5));
      const rarity = rng.pickWeighted(Object.keys(RARITY_WEIGHTS), Object.values(RARITY_WEIGHTS));
      return this.spawnWeapon(x, y, z, id, rarity);
    }
    if (roll < weaponChance + 0.22) {
      const type = rng.pick(['light', 'medium', 'shells', 'heavy']);
      const amount = type === 'heavy' ? rng.intRange(4, 10) : type === 'shells' ? rng.intRange(6, 14) : rng.intRange(18, 40);
      return this.spawnAmmo(x, y, z, type, amount);
    }
    if (roll < weaponChance + 0.34) return this.spawnConsumable(x, y, z, 'shield', rng.intRange(1, 2));
    if (roll < weaponChance + 0.42) return this.spawnConsumable(x, y, z, 'medkit', 1);
    const kind = rng.pick(['wood', 'brick', 'metal']);
    return this.spawnMaterial(x, y, z, kind, rng.intRange(30, 90));
  }

  _push(item) {
    if (this.items.length >= this.capacity) {
      // Drop the oldest untouched item rather than refusing new drops: a fresh
      // elimination drop matters more than stale floor loot across the map.
      this.items.shift();
    }
    this.items.push(item);
    this.stats.spawned++;
    return item;
  }

  spawnWeapon(x, y, z, id, rarity = 'common') {
    const def = WEAPONS[id];
    return this._push({
      type: ITEM.WEAPON, x, y, z, id, rarity,
      label: def.name, color: srgbHex(RARITY[rarity].color),
      spin: this.rng.range(0.5, 1.4), phase: this.rng.range(0, 6.28),
      ammoType: def.ammo, ammo: def.magSize === Infinity ? 0 : def.magSize,
    });
  }

  spawnAmmo(x, y, z, ammoType, amount) {
    return this._push({
      type: ITEM.AMMO, x, y, z, ammoType, amount,
      label: `${ammoType} x${amount}`, color: srgbHex(0xd8c48a),
      spin: 0.8, phase: this.rng.range(0, 6.28),
    });
  }

  spawnConsumable(x, y, z, kind, count = 1) {
    const def = CONSUMABLE_DEFS[kind];
    return this._push({
      type: kind === 'shield' ? ITEM.SHIELD : ITEM.MEDKIT,
      x, y, z, kind, count, label: def.name, color: srgbHex(def.color),
      spin: 1.1, phase: this.rng.range(0, 6.28),
    });
  }

  spawnMaterial(x, y, z, kind, amount) {
    const tint = kind === 'wood' ? 0xc08a4a : kind === 'brick' ? 0xa8604f : 0x8b96a3;
    return this._push({
      type: ITEM.MATERIAL, x, y, z, kind, amount,
      label: `${kind} x${amount}`, color: srgbHex(tint),
      spin: 0.6, phase: this.rng.range(0, 6.28),
    });
  }

  /** Everything a defeated entity leaves behind. */
  dropFor(entity, weapon) {
    const y = entity.position.y + 0.4;
    const rng = this.rng;
    if (weapon && weapon.id !== 'pickaxe') {
      this.spawnWeapon(entity.position.x + rng.range(-0.6, 0.6), y, entity.position.z + rng.range(-0.6, 0.6),
        weapon.id, weapon.rarity);
    }
    this.spawnAmmo(entity.position.x + rng.range(-1, 1), y, entity.position.z + rng.range(-1, 1),
      rng.pick(['light', 'medium', 'shells']), rng.intRange(12, 30));
    this.spawnMaterial(entity.position.x + rng.range(-1, 1), y, entity.position.z + rng.range(-1, 1),
      rng.pick(['wood', 'brick', 'metal']), rng.intRange(40, 110));
    if (rng.chance(0.4)) {
      this.spawnConsumable(entity.position.x + rng.range(-1, 1), y, entity.position.z + rng.range(-1, 1), 'shield', 1);
    }
  }

  /* ------------------------------------------------------------------ */
  /* interaction                                                         */
  /* ------------------------------------------------------------------ */

  openChest(chest) {
    if (chest.opened) return 0;
    chest.opened = true;
    this.stats.chestsOpened++;
    const rng = this.rng;
    const n = rng.intRange(3, 5);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const r = 1.1 + rng.range(0, 0.6);
      this._spawnRolled(chest.x + Math.cos(a) * r, chest.y + 0.9, chest.z + Math.sin(a) * r, rng, 0.5);
    }
    this.bus.queue('loot:chest', { x: chest.x, y: chest.y, z: chest.z, items: n });
    if (this.audio) this.audio.play('ui_confirm', { position: { x: chest.x, y: chest.y, z: chest.z }, volume: 0.8 });
    return n;
  }

  /** Give an item to the player. Returns true when it was consumed. */
  collect(item) {
    const combat = this.combat;
    switch (item.type) {
      case ITEM.WEAPON: {
        const slot = combat.giveWeapon(item.id, item.rarity);
        combat.selectSlot(slot);
        break;
      }
      case ITEM.AMMO:
        combat.addAmmo(item.ammoType, item.amount);
        break;
      case ITEM.MATERIAL:
        this.build.addResource(item.kind, item.amount);
        break;
      case ITEM.SHIELD:
      case ITEM.MEDKIT:
        if (!combat.addConsumable(item.kind, item.count)) return false;
        break;
      default: return false;
    }
    this.stats.pickedUp++;
    this.bus.queue('loot:picked', { type: ITEM_NAMES[item.type], label: item.label, item });
    if (this.audio) this.audio.play('pickup', { volume: 0.7, bus: 'ui' });
    return true;
  }

  _remove(item) {
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
  }

  /* ------------------------------------------------------------------ */
  /* per-frame                                                           */
  /* ------------------------------------------------------------------ */

  fixedUpdate(dt) {
    const p = this.player.position;
    if (!this.player.alive) { this.nearest = null; return; }

    // Nearest interactable, for the contextual button and the HUD prompt.
    let best = null, bestD = Infinity, bestKind = null;
    for (const item of this.items) {
      const dx = item.x - p.x, dy = item.y - (p.y + 0.9), dz = item.z - p.z;
      const d2 = dx * dx + dy * dy * 0.5 + dz * dz;
      if (d2 > PICKUP_RADIUS * PICKUP_RADIUS) continue;
      if (AUTO_PICKUP.has(item.type)) {
        if (this.collect(item)) { this._remove(item); }
        continue;
      }
      if (d2 < bestD) { bestD = d2; best = item; bestKind = 'item'; }
    }
    for (const chest of this.chests) {
      if (chest.opened) continue;
      const dx = chest.x - p.x, dz = chest.z - p.z, dy = chest.y - p.y;
      if (Math.abs(dy) > 3) continue;
      const d2 = dx * dx + dz * dz;
      if (d2 > CHEST_RADIUS * CHEST_RADIUS) continue;
      if (d2 < bestD) { bestD = d2; best = chest; bestKind = 'chest'; }
    }

    this.nearest = best ? { target: best, kind: bestKind, distance: Math.sqrt(bestD) } : null;
    if (this.touch) {
      this.touch.setButtonVisible('interact', !!this.nearest);
      if (this.nearest) {
        this.touch.setButtonLabel('interact', bestKind === 'chest' ? 'OPEN' : 'PICK UP');
      }
    }

    if (this.nearest && this.input.pressed.interact) {
      if (bestKind === 'chest') this.openChest(best);
      else if (this.collect(best)) this._remove(best);
    }
    void dt;
  }

  update(dt) {
    const t = (this._t = (this._t || 0) + dt);
    const colors = this.itemMesh.instanceColor.array;
    let n = 0;
    const camX = this.player.position.x, camZ = this.player.position.z;
    const cull = 160 * 160;

    for (const item of this.items) {
      if (n >= this.capacity) break;
      const dx = item.x - camX, dz = item.z - camZ;
      if (dx * dx + dz * dz > cull) continue;
      // A bobbing, spinning object reads as "take me" without a UI marker.
      const bob = Math.sin(t * 2.2 + item.phase) * 0.10;
      _v.set(item.x, item.y + bob, item.z);
      _e.set(0, t * item.spin + item.phase, 0);
      _q.setFromEuler(_e);
      _m.compose(_v, _q, _s);
      this.itemMesh.setMatrixAt(n, _m);
      colors[n * 3] = item.color[0]; colors[n * 3 + 1] = item.color[1]; colors[n * 3 + 2] = item.color[2];
      n++;
    }
    this.itemMesh.count = n;
    if (n > 0) {
      this.itemMesh.instanceMatrix.needsUpdate = true;
      this.itemMesh.instanceColor.needsUpdate = true;
    }

    let c = 0;
    for (const chest of this.chests) {
      if (c >= this.chestCapacity) break;
      const dx = chest.x - camX, dz = chest.z - camZ;
      if (dx * dx + dz * dz > cull) continue;
      _v.set(chest.x, chest.y, chest.z);
      _e.set(0, chest.yaw, 0);
      _q.setFromEuler(_e);
      _s.set(1, chest.opened ? 0.55 : 1, 1);
      _m.compose(_v, _q, _s);
      this.chestMesh.setMatrixAt(c, _m);
      _c.setRGB(chest.opened ? 0.28 : 1, chest.opened ? 0.26 : 0.92, chest.opened ? 0.22 : 0.5);
      this.chestMesh.setColorAt(c, _c);
      c++;
    }
    _s.set(1, 1, 1);
    this.chestMesh.count = c;
    if (c > 0) {
      this.chestMesh.instanceMatrix.needsUpdate = true;
      if (this.chestMesh.instanceColor) this.chestMesh.instanceColor.needsUpdate = true;
    }
  }

  state() {
    return {
      items: this.items.length,
      chests: this.chests.length,
      chestsOpen: this.chests.filter((c) => c.opened).length,
      drawn: { items: this.itemMesh.count, chests: this.chestMesh.count },
      nearest: this.nearest ? { kind: this.nearest.kind, distance: +this.nearest.distance.toFixed(2) } : null,
      stats: { ...this.stats },
    };
  }

  dispose() {
    this.itemMesh.geometry.dispose();
    this.chestMesh.geometry.dispose();
    this.scene.remove(this.itemMesh);
    this.scene.remove(this.chestMesh);
  }

  static get CONSUMABLES() { return CONSUMABLE_DEFS; }
  static get ITEM_NAMES() { return ITEM_NAMES; }
}
