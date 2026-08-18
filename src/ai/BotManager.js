import * as THREE from 'three';
import { Rng } from '../gen/Rng.js';
import { srgbHex } from '../gen/Palette.js';
import { makeWeapon, RARITY_ORDER } from '../combat/Weapons.js';
import { BotMeshPool } from './BotMesh.js';
import { CharacterMesh } from '../player/CharacterMesh.js';

/**
 * BotManager — the opposing team.
 *
 * Bots run the same physics, the same weapons and the same build rules as the
 * player; nothing here reaches around a system to cheat. What differs is
 * perception and aim: a bot's accuracy is an explicit aim-error cone scaled by
 * its skill, and its reaction to seeing a target is delayed. That is the honest
 * way to make an opponent beatable — degrading its aim rather than giving it
 * different physics.
 *
 * Cost is controlled in two ways. Perception (the expensive part: line-of-sight
 * rays) is time-sliced across four groups, so each bot re-evaluates targets at
 * 15Hz rather than 60. And bots beyond a distance threshold skip physics
 * entirely and glide along the terrain, because a capsule sweep 300 metres away
 * buys nothing a player can see.
 */

const STATE = { IDLE: 0, ROAM: 1, ENGAGE: 2, COVER: 3, ROTATE: 4, LOOT: 5, DEAD: 6 };
const STATE_NAMES = ['idle', 'roam', 'engage', 'cover', 'rotate', 'loot', 'dead'];

const PERCEPTION_GROUPS = 4;
const SIMPLE_DISTANCE = 170;      // beyond this, bots move without physics
const VIEW_RANGE = 130;
const VIEW_COS = Math.cos(1.15);  // ~66 degrees to either side
const ENGAGE_RANGE = 95;
const SHOOT_RANGE = 85;

const OUTFIT_TINTS = CharacterMesh.OUTFITS.map((o) => srgbHex(o.jacket));

const _v = new THREE.Vector3();
const _to = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _tgtEye = new THREE.Vector3();

/** One bot. Kept as a plain object so a whole match serialises for tests. */
function makeBot(id, rng) {
  const skill = rng.range(0.18, 0.92);
  return {
    id, skill,
    alive: true,
    health: 100, maxHealth: 100,
    shield: rng.chance(0.45) ? rng.intRange(20, 60) : 0, maxShield: 100,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    body: {
      pos: null, vel: null, radius: 0.36, height: CharacterMesh.HEIGHT,
      stepHeight: 0.58, grounded: false, onBox: false, steepGround: false,
      groundY: 0, groundNormal: new THREE.Vector3(0, 1, 0), hitWall: false, landingSpeed: 0,
    },
    yaw: rng.range(-Math.PI, Math.PI),
    pitch: 0,
    aiming: false,
    state: STATE.ROAM,
    stateTime: 0,
    target: null,
    lastSeen: 0,
    reactionTimer: 0,
    // Aim error shrinks with skill; the weapon cone is added on top by combat.
    aimError: 0.075 * (1 - skill) + 0.006,
    weapon: null,
    reloadTimer: 0,
    wander: new THREE.Vector3(),
    wanderTimer: 0,
    strafe: rng.sign(),
    strafeTimer: 0,
    buildCooldown: 0,
    damageMemory: 0,
    outfit: rng.int(OUTFIT_TINTS.length),
    phase: rng.range(0, Math.PI * 2),
    bob: 0, lean: 0, speed: 0,
    simple: false,
    eliminatedBy: null,
    kills: 0,
  };
}

export class BotManager {
  constructor(seed, opts = {}) {
    this.order = 52;                 // after the player, before combat
    this.seed = seed;
    this.rng = Rng.forStream(seed, 'bots');
    this.count = opts.count ?? 24;
    this.bots = [];
    this.aliveCount = 0;
    this.frame = 0;
    this.stats = { spawned: 0, alive: 0, eliminations: 0, shotsFired: 0, buildsPlaced: 0, simple: 0 };
  }

  init(services) {
    this.services = services;
    this.terrain = services.get('terrain');
    this.physics = services.get('physics');
    this.structures = services.get('structures');
    this.player = services.get('player');
    this.combat = services.get('combat');
    this.build = services.get('build');
    this.bus = services.get('bus');
    this.settings = services.get('settings');
    const scene = services.get('scene');

    this.pool = new BotMeshPool(this.count, services.get('materials').particleLit('bots'));
    scene.add(this.pool.mesh);

    for (let i = 0; i < this.count; i++) {
      const b = makeBot(i, this.rng);
      b.body.pos = b.position;
      b.body.vel = b.velocity;
      b.applyDamage = (amount, src) => this.damageBot(b, amount, src);
      b.eyePosition = (out = new THREE.Vector3()) =>
        out.set(b.position.x, b.position.y + 1.58, b.position.z);
      b.lookDirection = (out = new THREE.Vector3()) => {
        const cp = Math.cos(b.pitch);
        return out.set(-Math.sin(b.yaw) * cp, Math.sin(b.pitch), -Math.cos(b.yaw) * cp);
      };
      b.mesh = null;                 // bots are instanced, not rigged
      this.bots.push(b);
      this.combat.registerTarget(b, { team: 1 });
    }
    services.set('bots', this);
  }

  /** Scatter bots across the island and arm them. */
  spawnAll(centre = null, radius = 420) {
    const rng = this.rng;
    for (const b of this.bots) {
      const a = rng.range(0, Math.PI * 2);
      const r = Math.sqrt(rng.next()) * radius;
      const cx = centre ? centre.x : 0, cz = centre ? centre.z : 0;
      const g = this.terrain.findGround(cx + Math.cos(a) * r, cz + Math.sin(a) * r, rng);
      b.position.set(g.x, g.y, g.z);
      b.velocity.set(0, 0, 0);
      b.alive = true;
      b.health = b.maxHealth;
      b.state = STATE.ROAM;
      b.weapon = this._rollWeapon(rng, b.skill);
      this._pickWander(b);
      this.stats.spawned++;
    }
    this.aliveCount = this.bots.length;
    return this.bots.length;
  }

  /** Higher-skill bots carry better gear, which makes skill legible in a fight. */
  _rollWeapon(rng, skill) {
    const ids = ['ar', 'smg', 'shotgun', 'pistol'];
    if (skill > 0.7 && rng.chance(0.25)) ids.push('sniper');
    const id = rng.pick(ids);
    const tierBias = Math.min(RARITY_ORDER.length - 1, Math.floor(skill * 3 + rng.range(0, 2)));
    return makeWeapon(id, RARITY_ORDER[tierBias]);
  }

  /* ------------------------------------------------------------------ */
  /* damage                                                              */
  /* ------------------------------------------------------------------ */

  damageBot(b, amount, src = {}) {
    if (!b.alive || amount <= 0) return 0;
    let left = amount;
    const s = Math.min(b.shield, left); b.shield -= s; left -= s;
    b.health = Math.max(0, b.health - left);
    b.damageMemory = 2.5;
    // Being shot is what makes a bot look for the shooter and take cover.
    if (src.shooter && src.shooter !== b) {
      b.target = src.shooter;
      b.lastSeen = 0;
      if (b.state !== STATE.ENGAGE) this._setState(b, STATE.COVER);
    }
    if (b.health <= 0) this._eliminate(b, src);
    return amount;
  }

  _eliminate(b, src) {
    b.alive = false;
    b.state = STATE.DEAD;
    b.eliminatedBy = src && src.shooter ? src.shooter : null;
    this.aliveCount--;
    if (b.eliminatedBy && b.eliminatedBy.kills !== undefined) b.eliminatedBy.kills++;
    this.stats.eliminations++;
    this.bus.queue('entity:eliminated', {
      entity: b, isPlayer: false, source: src,
      position: b.position.clone(), weapon: b.weapon ? b.weapon.id : null,
    });
  }

  /* ------------------------------------------------------------------ */
  /* perception and decisions                                            */
  /* ------------------------------------------------------------------ */

  /** Can `b` see `other`? Distance, then field of view, then a line-of-sight ray. */
  _canSee(b, other) {
    if (!other || !other.alive) return false;
    _to.copy(other.position).sub(b.position);
    const dist = _to.length();
    if (dist > VIEW_RANGE) return false;
    _to.multiplyScalar(1 / dist);
    b.lookDirection(_v);
    if (_v.dot(_to) < VIEW_COS) return false;
    b.eyePosition(_eye);
    _tgtEye.copy(other.position).setY(other.position.y + 1.2);
    return this.physics.lineOfSight(_eye, _tgtEye);
  }

  /** Re-evaluate targets. Expensive, so only one group runs per fixed step. */
  _perceive(b, dt) {
    const candidates = [];
    if (this.player.alive) candidates.push(this.player);
    // Bots also fight each other, which is what makes the match feel populated.
    for (let i = 0; i < 4; i++) {
      const other = this.bots[(b.id * 7 + i * 5 + this.frame) % this.bots.length];
      if (other !== b && other.alive) candidates.push(other);
    }

    let best = null, bestD = Infinity;
    for (const c of candidates) {
      const d = b.position.distanceTo(c.position);
      if (d > ENGAGE_RANGE || d >= bestD) continue;
      if (!this._canSee(b, c)) continue;
      best = c; bestD = d;
    }

    if (best) {
      if (b.target !== best) {
        b.target = best;
        // Reaction delay scales with skill: a weak bot is slow on the draw.
        b.reactionTimer = 0.55 * (1 - b.skill) + 0.09;
      }
      b.lastSeen = 0;
      if (b.state !== STATE.COVER) this._setState(b, STATE.ENGAGE);
    } else {
      b.lastSeen += dt * PERCEPTION_GROUPS;
      if (b.lastSeen > 3.0 && b.state === STATE.ENGAGE) {
        b.target = null;
        this._setState(b, STATE.ROAM);
      }
    }
  }

  _setState(b, s) {
    if (b.state === s) return;
    b.state = s;
    b.stateTime = 0;
  }

  _pickWander(b) {
    const rng = this.rng;
    // Prefer heading for a POI: it is where loot and fights are.
    const poi = this.structures && this.structures.pois.length
      ? this.structures.pois[rng.int(this.structures.pois.length)] : null;
    if (poi && rng.chance(0.6)) {
      b.wander.set(poi.x + rng.range(-20, 20), 0, poi.z + rng.range(-20, 20));
    } else {
      const a = rng.range(0, Math.PI * 2), r = rng.range(30, 120);
      b.wander.set(b.position.x + Math.cos(a) * r, 0, b.position.z + Math.sin(a) * r);
    }
    const lim = this.terrain.size / 2 - 30;
    b.wander.x = THREE.MathUtils.clamp(b.wander.x, -lim, lim);
    b.wander.z = THREE.MathUtils.clamp(b.wander.z, -lim, lim);
    b.wanderTimer = rng.range(6, 16);
  }

  /* ------------------------------------------------------------------ */
  /* movement                                                            */
  /* ------------------------------------------------------------------ */

  /** Desired horizontal velocity for the bot's current state. */
  _steer(b, dt, out) {
    out.set(0, 0, 0);
    const speed = b.state === STATE.ENGAGE ? 5.0 : 6.4;

    if (b.state === STATE.ENGAGE && b.target) {
      _to.copy(b.target.position).sub(b.position); _to.y = 0;
      const dist = _to.length();
      _to.normalize();
      // Close to a preferred range, and strafe across the target's view.
      const preferred = b.weapon && b.weapon.def.class === 'shotgun' ? 9 : 26;
      const approach = dist > preferred + 6 ? 1 : dist < preferred - 6 ? -1 : 0;
      out.addScaledVector(_to, approach * speed);
      _v.set(-_to.z, 0, _to.x);
      out.addScaledVector(_v, b.strafe * speed * 0.8);
      b.strafeTimer -= dt;
      if (b.strafeTimer <= 0) { b.strafe = -b.strafe; b.strafeTimer = this.rng.range(0.7, 2.2); }
      return out;
    }

    // ROAM / ROTATE / COVER: head for the current objective.
    _to.copy(b.wander).sub(b.position); _to.y = 0;
    const d = _to.length();
    if (d < 4) { this._pickWander(b); return out; }
    _to.multiplyScalar(1 / d);
    out.copy(_to).multiplyScalar(speed);

    // Cheap obstacle avoidance: if the way ahead is blocked, veer.
    if (b.body.hitWall) {
      _v.set(-_to.z, 0, _to.x);
      out.addScaledVector(_v, b.strafe * speed);
    }
    return out;
  }

  /** Point the bot where it is going, or at its target. */
  _face(b, dt, wish) {
    let desired = b.yaw;
    if (b.state === STATE.ENGAGE && b.target) {
      _to.copy(b.target.position).sub(b.position);
      desired = Math.atan2(-_to.x, -_to.z);
      _tgtEye.copy(b.target.position).setY(b.target.position.y + 1.2);
      b.eyePosition(_eye);
      const flat = Math.hypot(_tgtEye.x - _eye.x, _tgtEye.z - _eye.z);
      b.pitch = Math.atan2(_tgtEye.y - _eye.y, Math.max(0.1, flat));
    } else if (wish.lengthSq() > 0.01) {
      desired = Math.atan2(-wish.x, -wish.z);
      b.pitch *= 0.9;
    }
    // Turn rate scales with skill so weak bots are slow to track.
    const rate = (5.5 + b.skill * 7) * dt;
    let delta = desired - b.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    b.yaw += THREE.MathUtils.clamp(delta, -rate, rate);
  }

  /* ------------------------------------------------------------------ */
  /* actions                                                             */
  /* ------------------------------------------------------------------ */

  _tryShoot(b, dt) {
    if (!b.target || !b.target.alive || !b.weapon) return;
    b.reactionTimer = Math.max(0, b.reactionTimer - dt);
    if (b.reactionTimer > 0) return;
    const dist = b.position.distanceTo(b.target.position);
    if (dist > SHOOT_RANGE) return;

    const w = b.weapon;
    w.cooldown = Math.max(0, w.cooldown - dt);
    if (w.reloadTimer > 0) {
      w.reloadTimer -= dt;
      if (w.reloadTimer <= 0) { w.ammo = w.magSize; w.shotIndex = 0; }
      return;
    }
    if (w.ammo <= 0) { w.reloadTimer = w.def.reloadTime; return; }

    // A final line-of-sight check: a bot must not shoot through the wall the
    // player just built between them.
    b.eyePosition(_eye);
    _tgtEye.copy(b.target.position).setY(b.target.position.y + 1.1);
    if (!this.physics.lineOfSight(_eye, _tgtEye)) return;

    b.aiming = true;
    if (this.combat.fire(b, w)) this.stats.shotsFired++;
  }

  /**
   * Take cover by building a wall toward the threat — the same BuildSystem
   * rules the player uses, including material cost and the health ramp.
   */
  _tryBuild(b, dt) {
    b.buildCooldown = Math.max(0, b.buildCooldown - dt);
    if (b.buildCooldown > 0 || !b.target) return;
    if (b.skill < 0.35) return;                 // weak bots do not build
    if (b.damageMemory <= 0) return;
    b.buildCooldown = this.rng.range(2.5, 6.0);

    _to.copy(b.target.position).sub(b.position); _to.y = 0;
    const d = _to.length();
    if (d < 2 || d > 60) return;
    _to.multiplyScalar(1 / d);

    // Place a wall two metres in front, on the shared build grid.
    const x = b.position.x + _to.x * 2.2;
    const z = b.position.z + _to.z * 2.2;
    const cellX = Math.floor(x / 4), cellZ = Math.floor(z / 4);
    const cellY = Math.floor((b.position.y + 0.2) / 4);
    const useX = Math.abs(_to.x) > Math.abs(_to.z);
    const dir = useX ? (_to.x > 0 ? 1 : 3) : (_to.z > 0 ? 2 : 0);
    const key = this.build.grid.wallKey(cellX, cellY, cellZ, (dir + 2) % 4);
    if (this.build.grid.has(key)) return;

    const parts = key.split(',');
    const anchor = this.build.grid.anchor(+parts[0], +parts[1], +parts[2], +parts[3]);
    const rec = this.build.kit.place('wall', anchor.x, anchor.y, anchor.z, anchor.yaw, {
      key: 'wood', tint: 0xc08a4a, hp: 150, harvest: 'wood',
    });
    if (rec === null) return;
    const r = this.build.kit.records[rec];
    r.meta.owner = 'bot';
    r.meta.buildKey = key;
    r.meta.material = 'wood';
    r.meta.maxHp = 150;
    this.build.grid.set(key, rec);
    this.stats.buildsPlaced++;
    this.bus.queue('build:placed', { record: rec, material: 'wood', x: anchor.x, y: anchor.y, z: anchor.z, key });
  }

  /* ------------------------------------------------------------------ */
  /* per-frame                                                           */
  /* ------------------------------------------------------------------ */

  fixedUpdate(dt) {
    this.frame++;
    const group = this.frame % PERCEPTION_GROUPS;
    const camPos = this.player.position;
    let simple = 0;

    for (const b of this.bots) {
      if (!b.alive) continue;
      b.stateTime += dt;
      b.damageMemory = Math.max(0, b.damageMemory - dt);
      b.wanderTimer -= dt;
      if (b.wanderTimer <= 0) this._pickWander(b);

      const distToPlayer = b.position.distanceTo(camPos);
      b.simple = distToPlayer > SIMPLE_DISTANCE;
      if (b.simple) simple++;

      if ((b.id % PERCEPTION_GROUPS) === group) this._perceive(b, dt);

      const wish = this._steer(b, dt, _wish);
      this._face(b, dt, wish);

      if (b.simple) {
        // Far from the player: glide along the terrain. A capsule sweep out
        // here buys nothing anyone can see.
        b.position.x += wish.x * dt;
        b.position.z += wish.z * dt;
        b.position.y = this.terrain.heightAt(b.position.x, b.position.z);
        b.velocity.set(wish.x, 0, wish.z);
        b.body.grounded = true;
      } else {
        const vel = b.velocity;
        const accel = b.body.grounded ? 30 : 8;
        vel.x += (wish.x - vel.x) * Math.min(1, accel * dt / 7);
        vel.z += (wish.z - vel.z) * Math.min(1, accel * dt / 7);
        // Hop over an obstruction rather than grinding into it forever.
        if (b.body.hitWall && b.body.grounded && this.rng.chance(0.04)) vel.y = 7.0;
        this.physics.moveCharacter(b.body, dt);
      }

      b.speed = Math.hypot(b.velocity.x, b.velocity.z);
      b.phase += dt * (4.2 + Math.min(1, b.speed / 7) * 4.4);

      if (b.state === STATE.ENGAGE) this._tryShoot(b, dt);
      else b.aiming = false;
      if (b.state === STATE.COVER) {
        this._tryBuild(b, dt);
        if (b.stateTime > 1.6) this._setState(b, b.target ? STATE.ENGAGE : STATE.ROAM);
      }

      const lim = this.terrain.size / 2 - 6;
      b.position.x = THREE.MathUtils.clamp(b.position.x, -lim, lim);
      b.position.z = THREE.MathUtils.clamp(b.position.z, -lim, lim);
    }

    this.stats.alive = this.aliveCount;
    this.stats.simple = simple;
  }

  update() {
    const pool = this.pool;
    pool.begin();
    for (const b of this.bots) {
      if (!b.alive) continue;
      const norm = Math.min(1, b.speed / 7.2);
      const bob = Math.abs(Math.sin(b.phase * 2)) * 0.055 * norm;
      const lean = norm * 0.17;
      pool.write(b.position, b.yaw, bob, lean, 1, OUTFIT_TINTS[b.outfit]);
    }
    pool.end();
  }

  /** Nearest living bot to a point, used by the match director and tests. */
  nearest(x, z) {
    let best = null, bd = Infinity;
    for (const b of this.bots) {
      if (!b.alive) continue;
      const d = Math.hypot(b.position.x - x, b.position.z - z);
      if (d < bd) { bd = d; best = b; }
    }
    return best ? { bot: best, distance: bd } : null;
  }

  killAll() { for (const b of this.bots) if (b.alive) this._eliminate(b, {}); }

  state() {
    const byState = {};
    for (const b of this.bots) {
      if (!b.alive) continue;
      const n = STATE_NAMES[b.state];
      byState[n] = (byState[n] || 0) + 1;
    }
    return {
      total: this.bots.length,
      alive: this.aliveCount,
      byState,
      simple: this.stats.simple,
      drawCalls: 1,
      stats: { ...this.stats },
    };
  }

  dispose() { this.pool.dispose(); }

  static get STATE() { return STATE; }
  static get STATE_NAMES() { return STATE_NAMES; }
}

const _wish = new THREE.Vector3();
