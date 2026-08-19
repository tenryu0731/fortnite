import * as THREE from 'three';
import { WEAPONS, makeWeapon, falloff, partMultiplier, RARITY, STARTING_AMMO } from './Weapons.js';
import { HeldWeapon } from './WeaponMesh.js';
import { Rng } from '../gen/Rng.js';

/**
 * CombatSystem — firing, hit resolution and damage routing for every shooter
 * in the match, player and bot alike.
 *
 * Hit resolution is a single ordered query rather than several: characters,
 * world architecture, player builds and terrain all compete for the nearest
 * intersection along one ray. Resolving them separately is where "I shot
 * through my own wall" bugs come from.
 *
 * Accuracy is the classic cone model — a base spread widened by sustained fire
 * ("bloom"), by movement and by being airborne, and tightened by aiming. Recoil
 * is a fixed per-weapon pattern applied to the camera, so it is learnable;
 * randomness lives only in the spread cone.
 */

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _spread = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

const MOVE_BLOOM = 0.9;         // extra cone while running
const AIR_BLOOM = 1.6;          // extra cone while airborne
const ADS_TIGHTEN = 0.35;       // cone multiplier while aiming

export class CombatSystem {
  constructor(seed = 1) {
    this.order = 58;              // after build, before the camera
    this.rng = Rng.forStream(seed, 'combat');
    this.targets = [];            // damageable characters
    this.projectiles = [];
    // `shots`/`hits` count every shooter in the match; the player-only
    // counters are what the results screen and accuracy readout use.
    this.stats = { shots: 0, hits: 0, headshots: 0, damageDealt: 0, structureHits: 0,
      eliminations: 0, playerShots: 0, playerHits: 0 };
    this.lastHit = null;
  }

  init(services) {
    this.services = services;
    this.player = services.get('player');
    this.physics = services.get('physics');
    this.colliders = services.get('colliders');
    this.terrain = services.get('terrain');
    this.input = services.get('input');
    this.camera = services.get('camera');
    this.rig = services.get('cameraRig');
    this.build = services.get('build');
    this.structures = services.get('structures');
    this.vegetation = services.peek('vegetation');
    this.bus = services.get('bus');
    this.materials = services.get('materials');

    // Loadout: slot 0 is always the harvesting tool, as in the genre.
    this.slots = [makeWeapon('pickaxe'), null, null, null, null];
    this.activeSlot = 0;
    this.reserveAmmo = { ...STARTING_AMMO };
    this.reloading = false;
    this.reloadTimer = 0;

    // Consumables are counters with a single HEAL button rather than inventory
    // slots. On a phone, juggling a slot to drink a potion mid-fight is pure
    // friction; a button that picks the sensible item is what players want.
    this.consumables = { shield: 0, medkit: 0 };
    this.consumableMax = { shield: 3, medkit: 3 };
    this.using = null;
    this.useTimer = 0;

    this.held = new HeldWeapon(services.get('materials').vertex('character'));
    this.player.mesh.weaponSocket.add(this.held.object);
    this._syncHeld();

    this.audio = services.peek('audio');
    this.registerTarget(this.player, { isPlayer: true });
    this.bus.on('player:damaged', (e) => {
      // Healing while being shot is not a thing; interrupting is what makes
      // the decision to drink a real risk.
      if (this.using && e.source && e.source.type === 'weapon') this.cancelUse('damaged');
    });
    services.set('combat', this);
  }

  /* ------------------------------------------------------------------ */
  /* loadout                                                             */
  /* ------------------------------------------------------------------ */

  get weapon() { return this.slots[this.activeSlot]; }

  giveWeapon(id, rarity = 'common', slot = null) {
    const w = makeWeapon(id, rarity);
    let target = slot;
    if (target === null) {
      target = this.slots.findIndex((s, i) => i > 0 && s === null);
      if (target < 0) target = Math.max(1, this.activeSlot);
    }
    if (target === 0) target = 1;              // never displace the pickaxe
    this.slots[target] = w;
    this.bus.queue('inventory:changed', { slot: target, weapon: w });
    return target;
  }

  selectSlot(i) {
    if (i < 0 || i >= this.slots.length) return false;
    if (!this.slots[i]) return false;
    if (i === this.activeSlot) return true;
    this.activeSlot = i;
    this.cancelReload();
    this.cancelUse('switched');
    this._syncHeld();
    this.bus.queue('inventory:selected', { slot: i, weapon: this.slots[i] });
    return true;
  }

  dropSlot(i) {
    if (i <= 0 || !this.slots[i]) return null;
    const w = this.slots[i];
    this.slots[i] = null;
    if (this.activeSlot === i) this.selectSlot(0);
    return w;
  }

  _syncHeld() {
    const w = this.weapon;
    this.held.set(w ? w.def.class : null, w ? w.rarity : 'common');
    this.player.weaponFov = w && w.def.adsFov ? w.def.adsFov : null;
  }

  /* ------------------------------------------------------------------ */
  /* targets                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Register a damageable character. `entity` needs `position` (feet),
   * `body.radius`, `body.height`, `alive` and `applyDamage(amount, source)`.
   */
  registerTarget(entity, opts = {}) {
    this.targets.push({ entity, isPlayer: !!opts.isPlayer, team: opts.team ?? -1 });
    return entity;
  }

  unregisterTarget(entity) {
    const i = this.targets.findIndex((t) => t.entity === entity);
    if (i >= 0) this.targets.splice(i, 1);
  }

  /* ------------------------------------------------------------------ */
  /* firing                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Firing is shooter-agnostic: the weapon is a parameter so bots carry and
   * spend their own magazines through exactly the same code path as the
   * player. Only presentation (recoil, stats) is player-specific.
   */
  canFire(shooter = this.player, w = this.weapon) {
    if (!w || !shooter.alive) return false;
    if (shooter === this.player && this.reloading) return false;
    if (w.reloadTimer > 0) return false;
    if (w.cooldown > 0) return false;
    if (w.ammo <= 0) return false;
    return true;
  }

  /** Current cone half-angle, given the shooter's state. */
  currentSpread(w, shooter) {
    const def = w.def;
    let cone = def.spread + w.bloom;
    const speed = Math.hypot(shooter.velocity.x, shooter.velocity.z);
    cone += (speed / 7.2) * def.spread * MOVE_BLOOM;
    if (!shooter.body.grounded) cone += def.spread * AIR_BLOOM;
    if (shooter.aiming) cone *= ADS_TIGHTEN;
    return cone;
  }

  /**
   * Fire one shot. Origin is the eye and direction is the camera's forward
   * axis, so what the crosshair covers is what is hit — the third-person
   * offset must never introduce a parallax error between reticle and bullet.
   */
  fire(shooter = this.player, weapon = null) {
    const isPlayer = shooter === this.player;
    const w = weapon || this.weapon;
    if (!this.canFire(shooter, w)) {
      if (isPlayer && w && w.ammo <= 0 && !this.reloading) this.beginReload();
      return false;
    }
    const def = w.def;

    shooter.eyePosition(_origin);
    if (isPlayer && this.rig) this.camera.getWorldDirection(_dir);
    else shooter.lookDirection(_dir);

    // A melee swing is a short sweep along the look axis with no cone: it
    // either reaches what the crosshair covers or it does not.
    const cone = def.class === 'melee' ? 0 : this.currentSpread(w, shooter);
    const pellets = def.pellets || 1;
    let anyHit = false;

    for (let p = 0; p < pellets; p++) {
      _spread.copy(_dir);
      // Bots add their own aim error on top of the weapon's cone; that is what
      // makes a low-skill bot miss without making its weapon feel broken.
      const total = cone + (shooter.aimError || 0);
      if (total > 0) this._applyCone(_spread, total);
      if (def.projectileSpeed) this._spawnProjectile(shooter, _origin, _spread, w);
      else if (this._resolveShot(shooter, _origin, _spread, w)) anyHit = true;
    }

    w.ammo = w.ammo === Infinity ? Infinity : w.ammo - 1;
    w.cooldown = 1 / def.fireRate;
    w.bloom = Math.min(def.bloom * 3, w.bloom + def.bloom);
    this.stats.shots++;
    if (isPlayer) this.stats.playerShots++;

    // Recoil follows the weapon's pattern, so it can be learned and countered.
    const pattern = def.recoil;
    const kick = pattern[w.shotIndex % pattern.length];
    w.shotIndex++;
    if (isPlayer && this.rig) {
      const scale = shooter.aiming ? 0.72 : 1;
      this.rig.addRecoil(kick[0] * scale, kick[1] * scale);
      this.rig.addShake(Math.min(0.25, def.damage / 600));
    }

    this.bus.queue('weapon:fired', {
      shooter, weapon: w.id, rarity: w.rarity, sound: def.sound,
      origin: _origin.clone(), dir: _dir.clone(), hit: anyHit,
      ammo: w.ammo, projectile: !!def.projectileSpeed,
      // A melee swing has no muzzle and no bullet: the FX layer must not draw
      // a flash or a tracer for it, and the character swings rather than aims.
      melee: def.class === 'melee',
    });
    if (def.class === 'melee' && shooter.mesh && shooter.mesh.swing) shooter.mesh.swing();
    if (w.ammo === 0 && isPlayer) this.beginReload();
    return true;
  }

  /** Perturb a direction inside a cone of the given half-angle. */
  _applyCone(dir, halfAngle) {
    _right.crossVectors(dir, WORLD_UP);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_right, dir).normalize();
    // Uniform over the disc so the centre is not over-weighted.
    const a = this.rng.next() * Math.PI * 2;
    const r = Math.sqrt(this.rng.next()) * halfAngle;
    dir.addScaledVector(_right, Math.cos(a) * r).addScaledVector(_up, Math.sin(a) * r).normalize();
  }

  /**
   * Trace one instant shot and apply its damage.
   * Characters and the static world are resolved in one comparison so the
   * nearest thing along the ray always wins.
   */
  _resolveShot(shooter, origin, dir, w) {
    const def = w.def;
    const maxT = def.range;
    const worldHit = this.physics.raycast(origin, dir, maxT, null, _worldHit);
    const charHit = this._raycastCharacters(shooter, origin, dir, worldHit ? worldHit.t : maxT);

    if (charHit) return this._damageCharacter(shooter, charHit, w, dir);
    if (worldHit) { this._damageWorld(shooter, worldHit, w); return false; }
    this.bus.queue('weapon:miss', { shooter, origin: origin.clone(), dir: dir.clone(), distance: maxT });
    return false;
  }

  /** Nearest character capsule along the ray, excluding the shooter. */
  _raycastCharacters(shooter, origin, dir, maxT) {
    let best = null;
    for (const t of this.targets) {
      const e = t.entity;
      if (e === shooter || !e.alive) continue;
      const hit = rayCapsule(origin, dir, e.position, e.body.radius + 0.06, e.body.height, maxT);
      if (hit && (!best || hit.t < best.t)) best = { t: hit.t, y: hit.y, entity: e, target: t };
    }
    return best;
  }

  _damageCharacter(shooter, hit, w, dir) {
    const def = w.def;
    const e = hit.entity;
    const frac = (hit.y - e.position.y) / e.body.height;
    const { mult, part } = partMultiplier(def, frac);
    const dmg = Math.max(1, Math.round(w.damage * mult * falloff(def, hit.t)));

    const before = (e.health || 0) + (e.shield || 0);
    e.applyDamage(dmg, { type: 'weapon', weapon: w.id, shooter, part });
    const after = (e.health || 0) + (e.shield || 0);

    this.stats.hits++;
    if (part === 'head') this.stats.headshots++;
    if (shooter === this.player) {
      this.stats.playerHits++;
      this.stats.damageDealt += before - after;
    }

    this.lastHit = { part, damage: dmg, distance: hit.t, entity: e };
    this.bus.queue('weapon:hit', {
      shooter, target: e, damage: dmg, part, distance: hit.t,
      point: { x: e.position.x, y: hit.y, z: e.position.z },
      lethal: e.alive === false,
    });
    if (!e.alive && shooter === this.player) this.stats.eliminations++;
    return true;
  }

  /** Route damage to whatever static thing was hit: build, POI panel, or prop. */
  _damageWorld(shooter, hit, w) {
    const meta = hit.meta;
    const def = w.def;
    this.bus.queue('weapon:impact', {
      shooter, point: hit.point.clone(), normal: hit.normal.clone(),
      kind: hit.kind, material: meta ? meta.material : null, weapon: w.id,
    });
    if (!meta) return;

    if (meta.type === 'structure') {
      const dmg = Math.max(1, Math.round(w.damage * def.structureMult));
      this.stats.structureHits++;
      if (meta.owner === 'player') this.build.damageRecord(meta.record, dmg, shooter);
      else this.structures.damage(meta.record, dmg);
      // Harvesting yields materials from whatever was struck.
      if (shooter === this.player && meta.harvest && def.harvestPower) {
        this.build.addResource(meta.harvest, Math.round(def.harvestPower * 0.5));
        this.bus.queue('resource:gained', { kind: meta.harvest, amount: Math.round(def.harvestPower * 0.5) });
      }
      return;
    }

    if (meta.type === 'tree' || meta.type === 'rock') {
      // Props have health and are felled by harvesting them, so a single tree
      // is a finite pile of wood rather than an infinite tap. The yield is the
      // damage the prop actually absorbed, which keeps the total per prop
      // fixed no matter which tool chews through it.
      const dealt = this.vegetation && meta.prop
        ? this.vegetation.damageProp(meta.prop, def.harvestPower || Math.round(w.damage * 0.4))
        : 0;
      if (shooter === this.player && dealt > 0) {
        const kind = meta.harvest || 'wood';
        this.build.addResource(kind, Math.round(dealt));
        this.bus.queue('resource:gained', {
          kind, amount: Math.round(dealt), x: hit.point.x, y: hit.point.y, z: hit.point.z,
        });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* projectiles                                                         */
  /* ------------------------------------------------------------------ */

  _spawnProjectile(shooter, origin, dir, w) {
    this.projectiles.push({
      shooter, weapon: w,
      pos: origin.clone(), vel: dir.clone().multiplyScalar(w.def.projectileSpeed),
      gravity: w.def.gravity || 0, life: 0, maxLife: w.def.range / w.def.projectileSpeed,
      travelled: 0,
    });
  }

  /** Step every projectile as a series of short ray segments. */
  _stepProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.vel.y += p.gravity * dt;
      _tmp.copy(p.vel).multiplyScalar(dt);
      const segLen = _tmp.length();
      _tmp2.copy(_tmp).normalize();

      const worldHit = this.physics.raycast(p.pos, _tmp2, segLen, null, _worldHit);
      const charHit = this._raycastCharacters(p.shooter, p.pos, _tmp2, worldHit ? worldHit.t : segLen);

      if (charHit) {
        charHit.t += p.travelled;
        this._damageCharacter(p.shooter, charHit, p.weapon, _tmp2);
        this.projectiles.splice(i, 1);
        continue;
      }
      if (worldHit) {
        this._damageWorld(p.shooter, worldHit, p.weapon);
        this.projectiles.splice(i, 1);
        continue;
      }
      p.pos.add(_tmp);
      p.travelled += segLen;
      p.life += dt;
      if (p.life > p.maxLife) this.projectiles.splice(i, 1);
    }
  }

  /* ------------------------------------------------------------------ */
  /* reload                                                              */
  /* ------------------------------------------------------------------ */

  beginReload() {
    const w = this.weapon;
    if (!w || this.reloading) return false;
    if (w.magSize === Infinity) return false;
    if (w.ammo >= w.magSize) return false;
    if (this.reserveAmmo[w.def.ammo] <= 0) return false;
    this.reloading = true;
    this.reloadTimer = w.def.reloadTime;
    this.bus.queue('weapon:reloadStart', { weapon: w.id, time: w.def.reloadTime });
    return true;
  }

  cancelReload() {
    if (!this.reloading) return false;
    this.reloading = false;
    this.reloadTimer = 0;
    return true;
  }

  _finishReload() {
    const w = this.weapon;
    this.reloading = false;
    this.reloadTimer = 0;
    if (!w) return;
    const need = w.magSize - w.ammo;
    const have = this.reserveAmmo[w.def.ammo] || 0;
    const take = Math.min(need, have);
    w.ammo += take;
    this.reserveAmmo[w.def.ammo] = have - take;
    w.bloom = 0;
    w.shotIndex = 0;
    this.bus.queue('weapon:reloadEnd', { weapon: w.id, ammo: w.ammo, reserve: this.reserveAmmo[w.def.ammo] });
  }

  /* ------------------------------------------------------------------ */
  /* consumables                                                         */
  /* ------------------------------------------------------------------ */

  addConsumable(kind, count = 1) {
    if (!(kind in this.consumables)) return false;
    if (this.consumables[kind] >= this.consumableMax[kind]) return false;
    this.consumables[kind] = Math.min(this.consumableMax[kind], this.consumables[kind] + count);
    return true;
  }

  /** What the HEAL button would use right now, or null if nothing applies. */
  bestConsumable() {
    const p = this.player;
    if (this.consumables.shield > 0 && p.shield < p.maxShield) return 'shield';
    if (this.consumables.medkit > 0 && p.health < p.maxHealth) return 'medkit';
    return null;
  }

  beginUse(kind = null) {
    if (this.using) return false;
    const pick = kind || this.bestConsumable();
    if (!pick || this.consumables[pick] <= 0) return false;
    const def = CONSUMABLE_TIMES[pick];
    this.using = pick;
    this.useTimer = def.time;
    this.bus.queue('item:useStart', { kind: pick, time: def.time });
    return true;
  }

  /** Interrupted by firing, by taking damage, or by switching weapons. */
  cancelUse(reason = 'cancelled') {
    if (!this.using) return false;
    const kind = this.using;
    this.using = null;
    this.useTimer = 0;
    this.bus.queue('item:useCancel', { kind, reason });
    return true;
  }

  _finishUse() {
    const kind = this.using;
    this.using = null;
    this.useTimer = 0;
    if (!kind || this.consumables[kind] <= 0) return;
    this.consumables[kind]--;
    const def = CONSUMABLE_TIMES[kind];
    const applied = kind === 'shield' ? this.player.addShield(def.amount) : this.player.heal(def.amount);
    this.bus.queue('item:used', { kind, applied, remaining: this.consumables[kind] });
    if (this.audio) this.audio.play(kind === 'shield' ? 'shield' : 'pickup', { volume: 0.8, bus: 'ui' });
  }

  addAmmo(type, amount) {
    if (!(type in this.reserveAmmo)) return 0;
    this.reserveAmmo[type] += amount;
    return amount;
  }

  /* ------------------------------------------------------------------ */
  /* per-frame                                                           */
  /* ------------------------------------------------------------------ */

  fixedUpdate(dt) {
    const s = this.input.state;
    const w = this.weapon;

    if (w) {
      w.cooldown = Math.max(0, w.cooldown - dt);
      w.bloom = Math.max(0, w.bloom - w.def.bloomDecay * w.def.bloom * dt);
    }

    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) this._finishReload();
    }

    if (s.slot >= 0) this.selectSlot(s.slot);
    if (this.input.pressed.reload) this.beginReload();

    // Consumable use: started by the HEAL button, cancelled by anything that
    // means the player stopped healing and started fighting.
    if (this.input.pressed.useItem) {
      if (this.using) this.cancelUse('toggled'); else this.beginUse();
    }
    if (this.using) {
      if (s.fire || this.build.active || !this.player.alive) this.cancelUse('interrupted');
      else {
        this.useTimer -= dt;
        if (this.useTimer <= 0) this._finishUse();
      }
    }

    // Building takes over the fire button; the pickaxe is used through the
    // dedicated harvest button so a player can chop without swapping slots.
    if (!this.build.active && this.player.alive) {
      const wantFire = s.fire;
      const wantHarvest = s.harvest;
      if (wantHarvest && this.activeSlot !== 0) this.selectSlot(0);
      if (wantFire || (wantHarvest && this.activeSlot === 0)) this.fire(this.player);
    }

    this._stepProjectiles(dt);
  }

  state() {
    const w = this.weapon;
    return {
      slot: this.activeSlot,
      weapon: w ? w.id : null,
      rarity: w ? w.rarity : null,
      ammo: w ? (w.ammo === Infinity ? -1 : w.ammo) : 0,
      magSize: w ? (w.magSize === Infinity ? -1 : w.magSize) : 0,
      reserve: { ...this.reserveAmmo },
      reloading: this.reloading,
      reloadTimer: +this.reloadTimer.toFixed(3),
      consumables: { ...this.consumables },
      using: this.using,
      useTimer: +this.useTimer.toFixed(2),
      bloom: w ? +w.bloom.toFixed(5) : 0,
      slots: this.slots.map((x) => (x ? { id: x.id, rarity: x.rarity, ammo: x.ammo === Infinity ? -1 : x.ammo } : null)),
      projectiles: this.projectiles.length,
      stats: { ...this.stats },
      targets: this.targets.length,
    };
  }

  dispose() { this.held.dispose(); }
}

const CONSUMABLE_TIMES = {
  shield: { time: 4.0, amount: 50 },
  medkit: { time: 8.0, amount: 100 },
};

const _worldHit = { t: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), meta: null, handle: -1, kind: '' };

/**
 * Ray against a vertical capsule approximated as a cylinder with hemispherical
 * caps. Characters are upright and the ray is nearly horizontal in practice, so
 * the cylinder body dominates; the caps only matter for steep shots from above.
 * Returns { t, y } where `y` is the world height of the hit.
 */
export function rayCapsule(origin, dir, base, radius, height, maxT) {
  const top = base.y + height;
  // Infinite-cylinder test in the XZ plane.
  const ox = origin.x - base.x, oz = origin.z - base.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  if (a < 1e-9) {
    // Vertical shot: hit if the axis passes through the disc.
    if (ox * ox + oz * oz > radius * radius) return null;
    const t = dir.y > 0 ? (top - origin.y) / dir.y : (base.y - origin.y) / dir.y;
    if (t < 0 || t > maxT) return null;
    return { t, y: origin.y + dir.y * t };
  }
  const b = ox * dir.x + oz * dir.z;
  const c = ox * ox + oz * oz - radius * radius;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / a;
  if (t < 0) t = (-b + sq) / a;
  if (t < 0 || t > maxT) return null;

  const y = origin.y + dir.y * t;
  if (y >= base.y && y <= top) return { t, y };

  // Outside the cylinder body: clamp to the nearer cap plane and check radius.
  const capY = y < base.y ? base.y : top;
  if (Math.abs(dir.y) < 1e-9) return null;
  const tCap = (capY - origin.y) / dir.y;
  if (tCap < 0 || tCap > maxT) return null;
  const cx = origin.x + dir.x * tCap - base.x;
  const cz = origin.z + dir.z * tCap - base.z;
  if (cx * cx + cz * cz > radius * radius) return null;
  return { t: tCap, y: capY };
}

export { WEAPONS, RARITY };
