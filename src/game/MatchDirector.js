import * as THREE from 'three';
import { Rng } from '../gen/Rng.js';
import { makeWeapon } from '../combat/Weapons.js';

/**
 * MatchDirector — the match state machine and the glue between subsystems.
 *
 * IDLE -> BUS -> DEPLOY -> PLAYING -> RESULT
 *
 * The director owns everything that is about *the match* rather than about a
 * mechanic: when the storm starts, when loot exists, how many players remain,
 * what happens on an elimination, and what the placement is at the end. Every
 * subsystem stays ignorant of the match; they are driven from here.
 *
 * Deploy is modelled rather than skipped because it is how a battle royale
 * starts: the drop decides the whole match, and a mobile player needs it to be
 * one button.
 */

export const MATCH = { IDLE: 0, BUS: 1, DEPLOY: 2, PLAYING: 3, RESULT: 4 };
export const MATCH_NAMES = ['idle', 'bus', 'deploy', 'playing', 'result'];

const BUS_ALTITUDE = 190;
const BUS_SPEED = 62;
const FREEFALL_SPEED = 56;
const GLIDE_SPEED = 13.5;
const GLIDE_HORIZONTAL = 11;
const GLIDER_ALTITUDE = 46;      // auto-deploy height above ground

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class MatchDirector {
  constructor(seed, opts = {}) {
    this.order = 95;               // last: observes the finished frame
    this.seed = seed;
    this.rng = Rng.forStream(seed, 'match');
    this.autoStart = opts.autoStart !== false;
    this.state = MATCH.IDLE;
    this.stateTime = 0;
    this.elapsed = 0;
    this.placement = 0;
    this.startingPlayers = 0;
    this.result = null;
    this.busProgress = 0;
    this.gliding = false;
    this.stats = { eliminations: 0, damage: 0, distance: 0, chests: 0, matchTime: 0 };
  }

  init(services) {
    this.services = services;
    this.bus = services.get('bus');
    this.terrain = services.get('terrain');
    this.player = services.get('player');
    this.bots = services.get('bots');
    this.storm = services.get('storm');
    this.loot = services.get('loot');
    this.combat = services.get('combat');
    this.build = services.get('build');
    this.input = services.get('input');
    this.touch = services.peek('touch');
    this.audio = services.peek('audio');
    this.cameraRig = services.get('cameraRig');
    const scene = services.get('scene');

    // The battle bus: a simple shape, but it has to be visible from below
    // because the player's only cue for where they are is looking down at it.
    const materials = services.get('materials');
    const geo = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(3.2, 9, 4, 10), materials.vertex('busbody'));
    body.rotation.z = Math.PI / 2;
    const balloon = new THREE.Mesh(new THREE.SphereGeometry(7.5, 12, 8), materials.vertex('busballoon'));
    balloon.position.y = 12;
    paintMesh(body, 0x3a6fb5);
    paintMesh(balloon, 0xe05a4a);
    geo.add(body, balloon);
    geo.visible = false;
    scene.add(geo);
    this.busMesh = geo;

    this.bus.on('entity:eliminated', (e) => this.onEliminated(e));
    this.bus.on('loot:chest', () => { this.stats.chests++; });
    services.set('match', this);
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Return to idle. Called when the player leaves a finished match for the
   * title screen: without it the storm keeps closing and the bots keep
   * fighting behind the title card, and the next match inherits that state.
   */
  reset() {
    this._setState(MATCH.IDLE);
    this.result = null;
    this.placement = 0;
    this.storm.active = false;
    this.storm.reset();
    if (this.busMesh) this.busMesh.visible = false;
    for (const b of this.bots.bots) b.alive = false;
    this.bots.aliveCount = 0;
    if (this.audio) { this.audio.stopLoop('storm_loop'); this.audio.stopLoop('wind_loop'); }
    return true;
  }

  /** Build a fresh match: loot, bots, storm and the bus flight line. */
  startMatch() {
    this.rng = Rng.forStream(this.seed ^ (this.elapsed * 1000 | 0), 'match');
    this.elapsed = 0;
    this.stateTime = 0;
    this.placement = 0;
    this.result = null;
    Object.assign(this.stats, { eliminations: 0, damage: 0, distance: 0, chests: 0, matchTime: 0 });

    this.loot.populate();
    this.bots.spawnAll();
    this.storm.reset();
    this.startingPlayers = this.bots.bots.length + 1;

    // Reset the player's loadout to a bare pickaxe: the drop matters because
    // you land with nothing.
    this.combat.slots = [makeWeapon('pickaxe'), null, null, null, null];
    this.combat.activeSlot = 0;
    this.combat.reserveAmmo = { light: 0, medium: 0, shells: 0, heavy: 0 };
    this.combat.consumables = { shield: 0, medkit: 0 };
    this.combat.cancelUse('restart');
    this.combat._syncHeld();
    this.build.resources = { wood: 0, brick: 0, metal: 0 };
    this.build.grid.clear();
    this.player.health = this.player.maxHealth;
    this.player.shield = 0;
    this.player.alive = true;
    this.player.stats.distance = 0;

    // Bus flight: a chord across the island through a random offset.
    const a = this.rng.range(0, Math.PI * 2);
    const half = this.terrain.size / 2;
    const perp = a + Math.PI / 2;
    const offset = this.rng.range(-half * 0.35, half * 0.35);
    this.busStart = new THREE.Vector3(
      Math.cos(a) * -half * 1.05 + Math.cos(perp) * offset, BUS_ALTITUDE,
      Math.sin(a) * -half * 1.05 + Math.sin(perp) * offset);
    this.busEnd = new THREE.Vector3(
      Math.cos(a) * half * 1.05 + Math.cos(perp) * offset, BUS_ALTITUDE,
      Math.sin(a) * half * 1.05 + Math.sin(perp) * offset);
    this.busProgress = 0;
    this.gliding = false;

    this._setState(MATCH.BUS);
    this.bus.queue('match:state', { state: 'bus', players: this.startingPlayers });
    if (this.audio) this.audio.loop('wind_loop', 0.25);
    return true;
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateTime = 0;
    this.bus.queue('match:state', { state: MATCH_NAMES[s], placement: this.placement });
  }

  /** Leave the bus. Called by the DROP button or automatically at the end. */
  deploy() {
    if (this.state !== MATCH.BUS) return false;
    const p = this.busMesh.position;
    this.player.spawnAt(p.x, p.z, 0);
    this.player.body.pos.set(p.x, p.y - 14, p.z);
    this.player.body.vel.set(0, -6, 0);
    this.gliding = false;
    this._setState(MATCH.DEPLOY);
    this.busMesh.visible = false;
    if (this.audio) this.audio.play('glider', { volume: 0.6, bus: 'ui' });
    return true;
  }

  onEliminated(e) {
    // Eliminations only conclude a match that is actually running. Without
    // this guard, any death outside a match — a test harness, a sandbox, a
    // restart in progress — pops the result screen and suspends input for a
    // match that was never started.
    if (this.state !== MATCH.BUS && this.state !== MATCH.DEPLOY && this.state !== MATCH.PLAYING) return;
    if (e.isPlayer) {
      // Placement is however many were still standing when the player fell.
      this.placement = this.bots.aliveCount + 1;
      this._finish(false);
      return;
    }
    if (e.source && e.source.shooter === this.player) this.stats.eliminations++;
    if (e.entity && this.loot) this.loot.dropFor(e.entity, e.entity.weapon);
    if (this.state === MATCH.PLAYING && this.bots.aliveCount <= 0) {
      this.placement = 1;
      this._finish(true);
    }
  }

  _finish(victory) {
    if (this.state === MATCH.RESULT || this.state === MATCH.IDLE) return;
    this.stats.matchTime = this.elapsed;
    this.stats.damage = this.combat.stats.damageDealt;
    this.stats.distance = this.player.stats.distance;
    this.result = {
      victory,
      placement: this.placement || (this.bots.aliveCount + 1),
      players: this.startingPlayers,
      eliminations: this.stats.eliminations,
      damage: Math.round(this.stats.damage),
      distance: Math.round(this.stats.distance),
      chests: this.stats.chests,
      time: Math.round(this.stats.matchTime),
      accuracy: this.combat.stats.playerShots > 0
        ? +(this.combat.stats.playerHits / this.combat.stats.playerShots).toFixed(3) : 0,
    };
    this._setState(MATCH.RESULT);
    this.storm.active = false;
    this.bus.queue('match:result', this.result);
    if (this.audio) {
      this.audio.stopLoop('storm_loop');
      this.audio.play(victory ? 'ui_confirm' : 'eliminate', { volume: 0.9, bus: 'ui' });
    }
  }

  /* ------------------------------------------------------------------ */
  /* per-frame                                                           */
  /* ------------------------------------------------------------------ */

  fixedUpdate(dt) {
    this.stateTime += dt;
    if (this.state !== MATCH.IDLE && this.state !== MATCH.RESULT) this.elapsed += dt;

    switch (this.state) {
      case MATCH.BUS: this._updateBus(dt); break;
      case MATCH.DEPLOY: this._updateDeploy(dt); break;
      case MATCH.PLAYING: this._updatePlaying(dt); break;
      default: break;
    }

    if (this.touch) {
      this.touch.setButtonVisible('deploy', this.state === MATCH.BUS);
      if (this.state === MATCH.BUS) {
        this.touch.setButtonLabel('deploy', this.stateTime > 1 ? 'DROP' : 'DROP');
      }
    }
  }

  _updateBus(dt) {
    this.busProgress += (BUS_SPEED * dt) / this.busStart.distanceTo(this.busEnd);
    const t = Math.min(1, this.busProgress);
    this.busMesh.visible = true;
    this.busMesh.position.lerpVectors(this.busStart, this.busEnd, t);
    _dir.subVectors(this.busEnd, this.busStart).normalize();
    this.busMesh.rotation.y = Math.atan2(-_dir.x, -_dir.z);

    // Hang the player well below the bus: at a shorter offset the third-person
    // camera ends up inside the bus body, looking at its untextured interior.
    this.player.body.pos.copy(this.busMesh.position).y -= 14;
    this.player.body.vel.set(0, 0, 0);
    this.player.body.grounded = false;

    if (this.input.pressed.deploy || this.input.pressed.jump) { this.deploy(); return; }
    if (t >= 1) this.deploy();
  }

  _updateDeploy(dt) {
    const body = this.player.body;
    const groundY = this.terrain.heightAt(body.pos.x, body.pos.z);
    const altitude = body.pos.y - groundY;

    if (!this.gliding && (altitude < GLIDER_ALTITUDE || this.input.state.jump)) {
      this.gliding = true;
      this.bus.queue('match:glide', { altitude });
      if (this.audio) this.audio.play('glider', { volume: 0.7, bus: 'ui' });
    }

    // Steering: the movement stick drives horizontal travel in both phases,
    // faster under canopy. This is the only control during the drop, so it has
    // to be responsive rather than realistic.
    const s = this.input.state;
    const yaw = this.player.yaw;
    const fwdX = -Math.sin(yaw), fwdZ = -Math.cos(yaw);
    const rightX = Math.cos(yaw), rightZ = -Math.sin(yaw);
    const speed = this.gliding ? GLIDE_HORIZONTAL : GLIDE_HORIZONTAL * 0.55;
    const wishX = (fwdX * s.move.y + rightX * s.move.x) * speed;
    const wishZ = (fwdZ * s.move.y + rightZ * s.move.x) * speed;
    body.vel.x += (wishX - body.vel.x) * Math.min(1, dt * 3.5);
    body.vel.z += (wishZ - body.vel.z) * Math.min(1, dt * 3.5);
    body.vel.y = this.gliding ? -GLIDE_SPEED : -FREEFALL_SPEED;

    body.pos.x += body.vel.x * dt;
    body.pos.z += body.vel.z * dt;
    body.pos.y += body.vel.y * dt;

    this.player.yaw += s.look.dx;
    this.player.pitch = THREE.MathUtils.clamp(this.player.pitch + s.look.dy, -1.2, 0.6);

    if (body.pos.y <= groundY + 0.02) {
      body.pos.y = groundY;
      body.vel.set(0, 0, 0);
      body.grounded = true;
      this.gliding = false;
      this._beginPlaying();
    }
  }

  _beginPlaying() {
    this._setState(MATCH.PLAYING);
    this.storm.start();
    if (this.audio) {
      this.audio.stopLoop('wind_loop');
      this.audio.loop('storm_loop', 0.18);
    }
    this.bus.queue('match:state', { state: 'playing', players: this.bots.aliveCount + 1 });
  }

  _updatePlaying(dt) {
    // Storm audio rises as the wall gets close, which is the only warning a
    // player gets when they are looking the other way.
    if (this.audio && this.audio.ready) {
      const d = this.storm.distanceToSafety(this.player.position.x, this.player.position.z);
      const near = THREE.MathUtils.clamp(1 - (d + 60) / 90, 0, 1);
      this.audio.setLoopVolume('storm_loop', 0.12 + near * 0.5, 0.6);
    }
    // Steer bots toward the safe circle when the storm threatens them.
    if (this.storm.active && (this._rotateTimer = (this._rotateTimer || 0) + dt) > 2) {
      this._rotateTimer = 0;
      for (const b of this.bots.bots) {
        if (!b.alive) continue;
        const d = this.storm.distanceToSafety(b.position.x, b.position.z);
        if (d > -25) {
          const pt = this.storm.safePoint(this.rng, 0.6);
          b.wander.set(pt.x, 0, pt.z);
          b.wanderTimer = 12;
        }
      }
    }
    void dt;
  }

  update() {
    if (this.state === MATCH.BUS || this.state === MATCH.DEPLOY) {
      // The rig still frames the player; nothing extra to do, but the player
      // mesh must not animate a walk cycle in mid-air.
      this.player.speed = 0;
    }
  }

  /** Named `snapshot` rather than `state` because `state` is the FSM field. */
  snapshot() {
    return {
      state: MATCH_NAMES[this.state],
      stateTime: +this.stateTime.toFixed(2),
      elapsed: +this.elapsed.toFixed(1),
      alive: this.bots.aliveCount + (this.player.alive ? 1 : 0),
      startingPlayers: this.startingPlayers,
      gliding: this.gliding,
      busProgress: +this.busProgress.toFixed(3),
      placement: this.placement,
      result: this.result,
      stats: { ...this.stats },
    };
  }

  dispose() { if (this.busMesh) this.busMesh.parent.remove(this.busMesh); }
}

function paintMesh(mesh, hex) {
  const g = mesh.geometry;
  const n = g.getAttribute('position').count;
  const c = new THREE.Color(hex);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}
