import * as THREE from 'three';
import { Rng } from '../gen/Rng.js';
import { makeWeapon, RARITY_ORDER, WEAPONS as WEAPON_DEFS } from '../combat/Weapons.js';
import { BotMeshPool } from './BotMesh.js';
import { ITEM } from '../game/Loot.js';
import { makeHandles } from '../gen/Names.js';
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

const STATE = { IDLE: 0, ROAM: 1, ENGAGE: 2, COVER: 3, ROTATE: 4, LOOT: 5, DEAD: 6, HEAL: 7 };
const STATE_NAMES = ['idle', 'roam', 'engage', 'cover', 'rotate', 'loot', 'dead', 'heal'];

const PERCEPTION_GROUPS = 4;
const SIMPLE_DISTANCE = 170;      // beyond this, bots move without physics
const VIEW_RANGE = 130;
const VIEW_COS = Math.cos(1.15);  // ~66 degrees to either side
const ENGAGE_RANGE = 95;
const SHOOT_RANGE = 85;

const OUTFIT_COUNT = CharacterMesh.OUTFITS.length;

/**
 * Difficulty tiers: the range bot skill is drawn from, plus a multiplier on
 * the aim error. Skill itself drives reaction time, how fast aim settles,
 * how well a moving target is tracked, and trigger discipline.
 */
export const DIFFICULTY = {
  easy: { skill: [0.05, 0.5], error: 1.35, label: 'EASY' },
  normal: { skill: [0.15, 0.85], error: 1.0, label: 'NORMAL' },
  hard: { skill: [0.45, 0.97], error: 0.85, label: 'HARD' },
};

/**
 * Preferred engagement range per weapon class. A bot closes to (or backs off
 * toward) this distance, so a shotgun rushes, a sniper holds back, and an
 * assault rifle fights at mid range — the same instincts a human has.
 */
const PREFERRED_RANGE = { shotgun: 8, smg: 14, pistol: 18, rifle: 28, sniper: 65, melee: 2 };

const lerp = (a, b, t) => a + (b - a) * t;

// Hearing. Gunfire inside this radius turns an idle bot toward the sound and
// sends it to investigate — the "third party" that makes a fight draw a crowd.
const HEAR_RANGE = 75;
const HEAR_RANGE_SNIPER = 130;
const HEAR_MEMORY = 7;

// Looting: how far a bot will divert for an item or an unopened chest.
const LOOT_RADIUS = 32;
const WEAPON_BASE = { pistol: 0, smg: 1.5, shotgun: 1.8, rifle: 2.0, sniper: 1.7, melee: -5 };
const RARITY_RANK = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };
const weaponScore = (id, rarity, cls) => (WEAPON_BASE[cls] ?? 0) + (RARITY_RANK[rarity] ?? 0) * 0.9;

// Healing: a shield potion's worth, and how long drinking one takes.
const HEAL_TIME = 2.2;

// Opening calm: engagement range ramps from OPENING_RANGE to ENGAGE_RANGE
// over this many seconds after bots land.
const OPENING_TIME = 60;
const OPENING_RANGE = 30;
const BOT_VS_BOT_RANGE = 38;

const _v = new THREE.Vector3();
const _to = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _sphere = new THREE.Sphere(new THREE.Vector3(), 3.5);
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
    // Aim error is recomputed every step from skill, how long the bot has been
    // tracking this target, and how fast the target is moving across its view
    // (see _updateAim). The weapon cone is added on top by combat.
    aimError: 0.05,
    settle: 0,
    burstLeft: 0,
    burstPause: 0,
    jumpTimer: 0,
    heardAt: null,
    heardTimer: 0,
    potions: 0,
    healTimer: 0,
    boxedUp: false,
    lootGoal: null,
    lootScan: 0,
    weapon: null,
    reloadTimer: 0,
    wander: new THREE.Vector3(),
    wanderTimer: 0,
    strafe: rng.sign(),
    strafeTimer: 0,
    buildCooldown: 0,
    damageMemory: 0,
    outfit: rng.int(OUTFIT_COUNT),
    hitFlash: 0,
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
    this.difficulty = opts.difficulty || 'normal';
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
    this.camera = services.get('camera');
    this.setDifficulty(this.settings.user.botDifficulty || 'normal');
    this.bus.on('weapon:fired', (e) => this._onGunfire(e));
    this.settings.onChange((key, value) => { if (key === 'botDifficulty') this.setDifficulty(value); });
    const scene = services.get('scene');

    this.pool = new BotMeshPool(this.count);
    scene.add(this.pool.mesh);

    // A separate stream, so naming never shifts the bots' other seeded traits.
    const names = makeHandles(Rng.forStream(this.seed, 'bot-names'), this.count);
    for (let i = 0; i < this.count; i++) {
      const b = makeBot(i, this.rng);
      b.name = names[i] || `Player${i + 1}`;
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
      // Skill is re-drawn every match from the current difficulty, so a change
      // in the settings applies from the next drop.
      const range = (DIFFICULTY[this.difficulty] || DIFFICULTY.normal).skill;
      b.skill = rng.range(range[0], range[1]);
      b.settle = 0; b.burstLeft = 0; b.burstPause = 0; b.reactionTimer = 0;
      b.target = null; b.heardAt = null; b.heardTimer = 0;
      b.inBus = false; b.dropIn = 0; b.sinceLand = 0;
      b.potions = rng.chance(0.5) ? rng.intRange(1, 2) : 0;
      b.healTimer = 0; b.boxedUp = false; b.lootGoal = null; b.lootScan = rng.range(0, 1);
      // Not everyone lands on a gun. Four in ten start with a common pistol and
      // have to loot an upgrade, which gives the opening minute a looting
      // phase instead of an instant twenty-four-way firefight.
      b.weapon = rng.chance(0.4) ? makeWeapon('pistol', 'common') : this._rollWeapon(rng, b.skill);
      this._pickWander(b);
      this.stats.spawned++;
    }
    this.aliveCount = this.bots.length;
    this.sinceSpawn = 0;
    return this.bots.length;
  }

  /**
   * Put the bots on the battle bus. Each picks a moment to jump along the
   * flight line and a landing spot — a POI within reach of its jump point, or
   * open ground near the line — and stays out of the world until it lands.
   * Without this every bot was standing armed on the island while the player
   * was still in the air, and half the lobby was gone before they touched
   * down.
   */
  scheduleDrops(busStart, busEnd, busSpeed) {
    const rng = this.rng;
    const len = busStart.distanceTo(busEnd);
    const flight = len / busSpeed;
    const pois = this.structures ? this.structures.pois : [];
    for (const b of this.bots) {
      if (!b.alive) continue;
      const t = rng.range(0.06, 0.92);
      const jx = busStart.x + (busEnd.x - busStart.x) * t;
      const jz = busStart.z + (busEnd.z - busStart.z) * t;
      let lx = jx + rng.range(-110, 110), lz = jz + rng.range(-110, 110);
      const reachable = pois.filter((p) => Math.hypot(p.x - jx, p.z - jz) < 320);
      if (reachable.length && rng.chance(0.5)) {
        const p = rng.pick(reachable);
        lx = p.x + rng.range(-p.radius * 0.6, p.radius * 0.6);
        lz = p.z + rng.range(-p.radius * 0.6, p.radius * 0.6);
      }
      const g = this.terrain.findGround(lx, lz, rng);
      b.landing = new THREE.Vector3(g.x, g.y, g.z);
      // Jump, free-fall, then glide: roughly the player's own descent time,
      // plus the sideways travel to the chosen spot.
      b.dropIn = t * flight + 6 + Math.hypot(g.x - jx, g.z - jz) / 60;
      b.inBus = true;
      b.position.set(jx, 190, jz);
      b.velocity.set(0, 0, 0);
    }
  }

  /** Difficulty from settings; takes effect at the next spawnAll. */
  setDifficulty(name) {
    if (DIFFICULTY[name]) this.difficulty = name;
    return this.difficulty;
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
    b.hitFlash = 1;
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
      if (other !== b && other.alive && !other.inBus) candidates.push(other);
    }

    // Opening calm: engagement range ramps up over the first minute after
    // landing, while everyone is busy looting — fights start at close quarters
    // around the POIs and spread out from there.
    const opening = Math.min(1, (b.sinceLand ?? OPENING_TIME) / OPENING_TIME);
    const engageRange = lerp(OPENING_RANGE, ENGAGE_RANGE, opening);
    const underArmed = !b.weapon || (b.weapon.def.class === 'pistol' && (RARITY_RANK[b.weapon.rarity] || 0) < 2);
    let best = null, bestD = Infinity;
    for (const c of candidates) {
      const d = b.position.distanceTo(c.position);
      // Bots pick fights with each other only up close. They are the player's
      // opponents first: at full range they would thin each other out long
      // before the player has anyone left to fight.
      // A bot that has only just landed with a starter pistol is looting, not
      // hunting: it leaves other bots alone until it is armed or a minute has
      // passed (it still fights back when shot — see damageBot).
      if (c !== this.player && underArmed && (b.sinceLand ?? 99) < OPENING_TIME) continue;
      const range = c === this.player ? engageRange : Math.min(engageRange, BOT_VS_BOT_RANGE);
      if (d > range || d >= bestD) continue;
      if (!this._canSee(b, c)) continue;
      best = c; bestD = d;
    }

    if (best) {
      if (b.target !== best) {
        b.target = best;
        // Reaction delay scales with skill (0.65s weak .. 0.22s strong) with a
        // little jitter, so two bots of the same skill do not fire in lockstep.
        b.reactionTimer = lerp(0.65, 0.22, b.skill) + this.rng.range(-0.06, 0.08);
        // A fresh target starts unsettled: the first rounds go wide and aim
        // tightens as the bot tracks, which is what rewards breaking line of
        // sight instead of standing still.
        b.settle = 0;
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
      // Close to (or back off toward) the weapon's preferred range, and strafe
      // across the target's view.
      const cls = b.weapon ? b.weapon.def.class : 'rifle';
      const preferred = PREFERRED_RANGE[cls] || 26;
      const approach = dist > preferred + 6 ? 1 : dist < preferred - 6 ? -1 : 0;
      out.addScaledVector(_to, approach * speed);
      _v.set(-_to.z, 0, _to.x);
      out.addScaledVector(_v, b.strafe * speed * 0.8);
      b.strafeTimer -= dt;
      if (b.strafeTimer <= 0) { b.strafe = -b.strafe; b.strafeTimer = this.rng.range(0.7, 2.2); }
      return out;
    }

    // Drinking a potion: stand still inside whatever cover was built.
    if (b.state === STATE.HEAL) return out;

    // Looting: walk to the item or chest.
    if (b.state === STATE.LOOT && b.lootGoal) {
      _to.set(b.lootGoal.x - b.position.x, 0, b.lootGoal.z - b.position.z);
      const d = _to.length();
      if (d > 0.5) out.copy(_to).multiplyScalar(speed / d);
      return out;
    }

    // Heard gunfire and nothing better to do: move toward it, stopping short
    // so the bot arrives looking rather than blundering into the fight.
    if (b.heardTimer > 0 && b.heardAt && (b.state === STATE.ROAM || b.state === STATE.ROTATE)) {
      _to.set(b.heardAt.x - b.position.x, 0, b.heardAt.z - b.position.z);
      const d = _to.length();
      if (d > 12) { out.copy(_to).multiplyScalar(speed * 0.8 / d); return out; }
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
    } else if (b.heardTimer > 0 && b.heardAt) {
      // Look where the shots came from, so perception can pick the shooter up.
      desired = Math.atan2(-(b.heardAt.x - b.position.x), -(b.heardAt.z - b.position.z));
      b.pitch *= 0.9;
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

  /**
   * Human-shaped aim. Error is the sum of three things a real player also
   * fights:
   *  - base spread, shrinking with skill and with difficulty;
   *  - an acquisition term that starts large and decays as the bot keeps the
   *    target in view (settle 0 -> 1 over 0.55s strong .. 1.6s weak);
   *  - a tracking term proportional to how fast the target sweeps across the
   *    bot's view, times a skill-dependent lag. A strafing target is harder
   *    to hit, and stronger bots lose less to it.
   * The bot's own movement adds a little on top.
   */
  _updateAim(b, dt, visible) {
    const diff = DIFFICULTY[this.difficulty] || DIFFICULTY.normal;
    const skill = b.skill;
    if (visible) b.settle = Math.min(1, b.settle + dt / lerp(1.6, 0.55, skill));
    else b.settle *= Math.exp(-dt / 0.5);

    let omega = 0;
    const t = b.target;
    if (t && t.alive) {
      _to.copy(t.position).sub(b.position);
      const d = Math.max(1, _to.length());
      _to.multiplyScalar(1 / d);
      const tv = t.velocity || (t.body && t.body.vel) || _zero;
      // Component of the target's velocity across the line of sight.
      const along = tv.x * _to.x + tv.y * _to.y + tv.z * _to.z;
      const cx = tv.x - _to.x * along, cy = tv.y - _to.y * along, cz = tv.z - _to.z * along;
      omega = Math.hypot(cx, cy, cz) / d;
    }
    const base = lerp(0.055, 0.011, skill) * diff.error;
    const acquire = base * 2.4 * (1 - b.settle);
    const tracking = omega * lerp(0.22, 0.07, skill);
    const ownMove = (b.speed / 7.2) * 0.01;
    b.aimError = base + acquire + tracking + ownMove;
  }

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

    // Trigger discipline. Past close range a spray just feeds bloom, so bots
    // fire bursts and pause to let the cone recover — skilled bots in short
    // controlled bursts, weak ones in long sprays with barely a break.
    if (b.burstPause > 0) { b.burstPause -= dt; return; }
    const automatic = w.def.fireRate >= 3;
    if (automatic && dist > 22 && b.burstLeft <= 0 && w.cooldown <= 0) {
      b.burstLeft = Math.round(lerp(9, 3, b.skill) + this.rng.range(-1, 1.5));
    }

    // A final line-of-sight check: a bot must not shoot through the wall the
    // player just built between them.
    b.eyePosition(_eye);
    _tgtEye.copy(b.target.position).setY(b.target.position.y + 1.1);
    if (!this.physics.lineOfSight(_eye, _tgtEye)) return;

    b.aiming = true;
    if (this.combat.fire(b, w)) {
      this.stats.shotsFired++;
      if (b.burstLeft > 0 && --b.burstLeft === 0) {
        b.burstPause = lerp(0.12, 0.42, b.skill) * Math.min(2, dist / 40) + this.rng.range(0, 0.1);
      }
    }
  }

  /**
   * Take cover by building a wall toward the threat — the same BuildSystem
   * rules the player uses, including material cost and the health ramp.
   */
  /** Gunfire heard: idle bots within range turn toward it and investigate. */
  _onGunfire(e) {
    if (!e || e.melee || !e.origin) return;
    const range = e.weapon === 'sniper' ? HEAR_RANGE_SNIPER : HEAR_RANGE;
    for (const b of this.bots) {
      if (!b.alive || b === e.shooter || b.state === STATE.ENGAGE || b.state === STATE.HEAL) continue;
      const dx = e.origin.x - b.position.x, dz = e.origin.z - b.position.z;
      if (dx * dx + dz * dz > range * range) continue;
      if (!b.heardAt) b.heardAt = new THREE.Vector3();
      b.heardAt.copy(e.origin);
      b.heardTimer = HEAR_MEMORY;
    }
  }

  /**
   * Place a wood wall on the grid boundary between the bot and direction
   * (dx, dz), through the same StructureKit the player's builds use.
   */
  _placeWall(b, dx, dz, dist = 2.2) {
    const x = b.position.x + dx * dist;
    const z = b.position.z + dz * dist;
    const cellX = Math.floor(x / 4), cellZ = Math.floor(z / 4);
    const cellY = Math.floor((b.position.y + 0.2) / 4);
    const useX = Math.abs(dx) > Math.abs(dz);
    const dir = useX ? (dx > 0 ? 1 : 3) : (dz > 0 ? 2 : 0);
    const key = this.build.grid.wallKey(cellX, cellY, cellZ, (dir + 2) % 4);
    if (this.build.grid.has(key)) return false;
    const parts = key.split(',');
    const anchor = this.build.grid.anchor(+parts[0], +parts[1], +parts[2], +parts[3]);
    const rec = this.build.kit.place('wall', anchor.x, anchor.y, anchor.z, anchor.yaw, {
      key: 'wood', tint: 0xc08a4a, hp: 150, harvest: 'wood',
    });
    if (rec === null) return false;
    const r = this.build.kit.records[rec];
    r.meta.owner = 'bot';
    r.meta.buildKey = key;
    r.meta.material = 'wood';
    r.meta.maxHp = 150;
    this.build.grid.set(key, rec);
    this.stats.buildsPlaced++;
    this.bus.queue('build:placed', { record: rec, material: 'wood', x: anchor.x, y: anchor.y, z: anchor.z, key });
    return true;
  }

  /**
   * Heal when hurt and not in a fight. Skilled bots box up first — four walls
   * around themselves — which is exactly what a player does to drink safely.
   */
  _maybeHeal(b) {
    if (b.state !== STATE.ROAM && b.state !== STATE.LOOT && b.state !== STATE.ROTATE) return;
    if (b.potions <= 0 || b.damageMemory > 0 || b.target) return;
    if (b.shield >= 50 && b.health >= 70) return;
    this._setState(b, STATE.HEAL);
    b.healTimer = HEAL_TIME;
    if (b.skill > 0.55 && !b.simple && !b.boxedUp) {
      this._placeWall(b, 1, 0, 1.2); this._placeWall(b, -1, 0, 1.2);
      this._placeWall(b, 0, 1, 1.2); this._placeWall(b, 0, -1, 1.2);
      b.boxedUp = true;
    }
  }

  _stepHeal(b, dt) {
    b.healTimer -= dt;
    if (b.healTimer > 0) return;
    if (b.shield < b.maxShield) b.shield = Math.min(b.maxShield, b.shield + 50);
    else b.health = Math.min(b.maxHealth, b.health + 25);
    b.potions--;
    this.stats.heals = (this.stats.heals || 0) + 1;
    this._setState(b, STATE.ROAM);
  }

  /**
   * Look for something worth picking up nearby: a better weapon, a potion,
   * or an unopened chest. Runs on the perception time-slice.
   */
  _scanLoot(b) {
    const loot = this.services.peek('loot');
    if (!loot || b.target || b.state === STATE.HEAL || b.state === STATE.ENGAGE) return;
    const cur = b.weapon ? weaponScore(b.weapon.id, b.weapon.rarity, b.weapon.def.class) : -10;
    let best = null, bestD = LOOT_RADIUS * LOOT_RADIUS;
    for (const it of loot.items) {
      const dx = it.x - b.position.x, dz = it.z - b.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= bestD) continue;
      let want = false;
      if (it.type === ITEM.WEAPON) {
        const def = WEAPON_DEFS[it.id];
        want = def && weaponScore(it.id, it.rarity, def.class) > cur + 0.5;
      } else if (it.type === ITEM.SHIELD || it.type === ITEM.MEDKIT) {
        want = b.potions < 3;
      }
      if (want) { best = it; bestD = d2; }
    }
    if (!best) {
      for (const ch of loot.chests) {
        if (ch.opened) continue;
        const dx = ch.x - b.position.x, dz = ch.z - b.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD) { best = ch; bestD = d2; }
      }
    }
    if (best) { b.lootGoal = best; this._setState(b, STATE.LOOT); }
  }

  _stepLoot(b) {
    const loot = this.services.peek('loot');
    const g = b.lootGoal;
    if (!loot || !g) { this._setState(b, STATE.ROAM); return; }
    const isChest = g.opened !== undefined && g.type === undefined;
    const gone = isChest ? g.opened : loot.items.indexOf(g) < 0;
    if (gone || b.stateTime > 14) { b.lootGoal = null; this._setState(b, STATE.ROAM); return; }
    const d = Math.hypot(g.x - b.position.x, g.z - b.position.z);
    if (d > 1.7) return;
    if (isChest) {
      loot.openChest(g);
    } else if (g.type === ITEM.WEAPON) {
      b.weapon = makeWeapon(g.id, g.rarity);
      loot._remove(g);
    } else {
      b.potions = Math.min(3, b.potions + (g.count || 1));
      loot._remove(g);
    }
    this.stats.looted = (this.stats.looted || 0) + 1;
    b.lootGoal = null;
    this._setState(b, STATE.ROAM);
  }

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
    // A wall two metres toward the threat, on the shared build grid.
    this._placeWall(b, _to.x, _to.z, 2.2);
  }

  /* ------------------------------------------------------------------ */
  /* per-frame                                                           */
  /* ------------------------------------------------------------------ */

  fixedUpdate(dt) {
    // Staged scenes and tests hold the bots still while keeping them drawn and
    // hittable.
    if (this.paused) return;
    this.frame++;
    this.sinceSpawn = (this.sinceSpawn || 0) + dt;
    const group = this.frame % PERCEPTION_GROUPS;
    const camPos = this.player.position;
    let simple = 0;

    for (const b of this.bots) {
      if (!b.alive) continue;
      if (b.inBus) {
        b.dropIn -= dt;
        if (b.dropIn > 0) continue;
        b.inBus = false;
        b.position.copy(b.landing);
        b.velocity.set(0, 0, 0);
        b.sinceLand = 0;
        b.state = STATE.ROAM;
        this._pickWander(b);
        this.bus.queue('bot:landed', { bot: b });
      }
      b.sinceLand = (b.sinceLand || 0) + dt;
      b.stateTime += dt;
      b.damageMemory = Math.max(0, b.damageMemory - dt);
      b.heardTimer = Math.max(0, b.heardTimer - dt);
      if (b.heardTimer <= 0) b.heardAt = null;
      b.wanderTimer -= dt;
      if (b.wanderTimer <= 0) this._pickWander(b);

      const distToPlayer = b.position.distanceTo(camPos);
      b.simple = distToPlayer > SIMPLE_DISTANCE;
      if (b.simple) simple++;

      if ((b.id % PERCEPTION_GROUPS) === group) {
        this._perceive(b, dt);
        // Out-of-fight decisions ride the same time-slice as perception.
        this._maybeHeal(b);
        if (b.state === STATE.ROAM && (b.lootScan -= dt * PERCEPTION_GROUPS) <= 0) {
          b.lootScan = 1.0;
          this._scanLoot(b);
        }
      }
      if (b.state === STATE.HEAL) this._stepHeal(b, dt);
      else if (b.state === STATE.LOOT) this._stepLoot(b);

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
        // Skilled bots jump-strafe in a fight: it throws off the opponent's
        // aim the same way it throws off theirs.
        b.jumpTimer -= dt;
        if (b.state === STATE.ENGAGE && b.skill > 0.55 && b.body.grounded && b.jumpTimer <= 0) {
          b.jumpTimer = this.rng.range(1.4, 3.2);
          if (this.rng.chance(b.skill * 0.55)) vel.y = 6.8;
        }
        this.physics.moveCharacter(b.body, dt);
      }

      b.speed = Math.hypot(b.velocity.x, b.velocity.z);
      b.phase += dt * (4.2 + Math.min(1, b.speed / 7) * 4.4);

      if (b.state === STATE.ENGAGE) {
        // lastSeen is reset by perception whenever the target is in view.
        this._updateAim(b, dt, b.lastSeen < 0.3);
        this._tryShoot(b, dt);
      } else {
        b.aiming = false;
        b.settle *= Math.exp(-dt / 0.5);
      }
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

  update(dt = 0) {
    const pool = this.pool;
    pool.begin();
    // Cull on the CPU: the instanced mesh cannot be frustum-culled per
    // instance, so an off-screen bot would still cost its full triangle count
    // in both the colour and the shadow pass. The sphere is padded well past
    // the body so a bot just off-screen still casts its shadow into view.
    const cam = this.camera;
    _projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    let culled = 0;
    for (const b of this.bots) {
      if (!b.alive || b.inBus) continue;
      _sphere.center.set(b.position.x, b.position.y + 0.9, b.position.z);
      if (!_frustum.intersectsSphere(_sphere)) { culled++; continue; }
      const norm = Math.min(1, b.speed / 7.2);
      const bob = Math.abs(Math.sin(b.phase * 2)) * 0.055 * norm;
      const lean = norm * 0.17;
      // Stride amplitude grows with speed and vanishes airborne, matching the
      // player rig so a running bot and a running player read the same.
      const stride = norm * 0.7 * (b.body.grounded ? 1 : 0.2);
      b.hitFlash = Math.max(0, (b.hitFlash || 0) - (dt || 0) * 6);
      pool.write(b.position, b.yaw, bob, lean, 1, b.outfit, b.phase, stride, b.hitFlash);
    }
    pool.end();
    this.stats.culled = culled;
  }

  /** Nearest living bot to a point, used by the match director and tests. */
  nearest(x, z) {
    let best = null, bd = Infinity;
    for (const b of this.bots) {
      if (!b.alive || b.inBus) continue;
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
