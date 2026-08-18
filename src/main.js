import { Engine } from './core/Engine.js';
import { Settings } from './core/Settings.js';
import { installTestApi } from './core/TestApi.js';
import { makeRoot } from './gen/Rng.js';
import { Materials } from './gen/Materials.js';
import { Colliders } from './world/Colliders.js';
import { Terrain } from './world/Terrain.js';
import { Sky } from './world/Sky.js';
import { Vegetation } from './world/Vegetation.js';
import { Structures } from './world/Structures.js';
import * as THREE from 'three';
import { Physics } from './sim/Physics.js';
import { InputHub } from './input/InputState.js';
import { DesktopInput } from './input/DesktopInput.js';
import { TouchInput } from './input/TouchInput.js';
import { PlayerController } from './player/PlayerController.js';
import { CameraRig } from './player/CameraRig.js';
import { BuildSystem } from './build/BuildSystem.js';
import { CombatSystem } from './combat/CombatSystem.js';
import { FxSystem } from './fx/FxSystem.js';
import { BotManager } from './ai/BotManager.js';
import { Storm } from './game/Storm.js';
import { Loot } from './game/Loot.js';
import { MatchDirector } from './game/MatchDirector.js';
import { Hud } from './ui/Hud.js';
import { Minimap } from './ui/Minimap.js';
import { DamageNumbers } from './ui/DamageNumbers.js';
import { Screens } from './ui/Screens.js';
import { AudioSystem } from './audio/AudioSystem.js';
import { makeWeapon as makeWeaponFor } from './combat/Weapons.js';

/** Query-string overrides let the harness pin seed/quality/scenario per run. */
function queryOverrides() {
  const p = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const user = {};
  if (p.has('quality')) user.quality = p.get('quality');
  if (p.has('fov')) user.fov = Number(p.get('fov'));
  if (p.has('adaptive')) user.adaptiveResolution = p.get('adaptive') !== '0';
  return {
    user,
    seed: p.has('seed') ? Number(p.get('seed')) : 1337,
    scenario: p.get('scenario') || null,
    palette: p.get('palette') || 'day',
  };
}

async function boot() {
  const canvas = document.getElementById('gl');
  const opts = queryOverrides();
  const settings = new Settings(opts.user);
  const engine = new Engine(canvas, settings);

  // Dev-only scene that showcases the generation library on its own.
  if (opts.scenario === 'gallery') {
    const { Gallery } = await import('./dev/Gallery.js');
    engine.register('gallery', new Gallery());
    const api = installTestApi(engine, { seed: opts.seed, state: () => ({ scenario: 'gallery' }) });
    api.ready = (async () => { await engine.init(); engine.start(); document.body.dataset.ready = '1'; return true; })();
    await api.ready;
    return;
  }

  const rng = makeRoot(opts.seed);
  engine.services.set('rng', rng);
  engine.services.set('materials', new Materials(opts.seed, settings));
  engine.services.set('colliders', new Colliders(1024, 8));

  engine.register('sky', new Sky({ palette: opts.palette }));
  engine.register('terrain', new Terrain(opts.seed, { size: 1024 }));
  engine.register('structures', new Structures(opts.seed, { poiCount: 9 }));
  engine.register('vegetation', new Vegetation(opts.seed));
  engine.register('physics', new Physics());

  const input = new InputHub();
  input.addSource(new DesktopInput(input, canvas, settings));
  const touch = input.addSource(new TouchInput(input, document.getElementById('ui-root'), settings));
  engine.services.set('touch', touch);
  engine.register('input', input);
  engine.register('player', new PlayerController({ seed: opts.seed }));
  engine.register('build', new BuildSystem());
  engine.register('audio', new AudioSystem());
  engine.register('combat', new CombatSystem(opts.seed));
  engine.register('bots', new BotManager(opts.seed, { count: 24 }));
  engine.register('storm', new Storm(opts.seed, { mapRadius: 430 }));
  engine.register('loot', new Loot(opts.seed));
  engine.register('fx', new FxSystem(opts.seed));
  engine.register('match', new MatchDirector(opts.seed));
  engine.register('hud', new Hud());
  engine.register('minimap', new Minimap());
  engine.register('damageNumbers', new DamageNumbers());
  engine.register('screens', new Screens());
  engine.register('cameraRig', new CameraRig());

  /**
   * Named camera setups for visual regression. Each one repositions the camera
   * and forces every streaming system to fully settle, so the captured frame
   * does not depend on how many frames happened to have elapsed.
   */
  const SCENARIOS = {
    terrain_wide: () => {
      const t = engine.services.get('terrain');
      const g = t.findGround(-120, 40, makeRoot(opts.seed).stream('scenario'));
      return { pos: [g.x, Math.max(g.y + 52, 78), g.z + 120], look: [g.x + 20, g.y - 4, g.z - 90] };
    },
    terrain_ground: () => {
      const t = engine.services.get('terrain');
      const g = t.findGround(40, 60, makeRoot(opts.seed).stream('scenario'));
      return { pos: [g.x, g.y + 1.72, g.z], look: [g.x + 30, g.y + 6, g.z + 40] };
    },
    // Frame a POI of a given type from outside, at a fixed bearing.
    ...(() => {
      const mk = (type, dist, height, bearing) => () => {
        const st = engine.services.get('structures');
        const poi = st.pois.find((p) => p.type === type) || st.pois[0];
        const cx = poi.x + Math.cos(bearing) * dist;
        const cz = poi.z + Math.sin(bearing) * dist;
        return { pos: [cx, poi.y + height, cz], look: [poi.x, poi.y + 3, poi.z] };
      };
      return {
        poi_town: mk('town', 46, 16, 2.4),
        poi_factory: mk('factory', 40, 12, 0.7),
        poi_tower: mk('tower', 30, 9, 3.9),
        poi_farm: mk('farm', 40, 12, 1.9),
        poi_street: () => {
          const st = engine.services.get('structures');
          const poi = st.pois.find((p) => p.type === 'town') || st.pois[0];
          return { pos: [poi.x - 16, poi.y + 1.72, poi.z - 16], look: [poi.x + 10, poi.y + 4, poi.z + 10] };
        },
      };
    })(),
    // Standard third-person framing, driven by the real camera rig rather than
    // a fixed pose, so the rig itself is covered by visual regression.
    player_tps: () => null,
    player_ads: () => null,
    build_grid: () => null,
    fx_combat: () => null,
    bots_squad: () => null,
    storm_edge: () => null,
    hud_full: () => null,
    screen_result: () => null,
    match_loot: () => null,
    terrain_coast: () => {
      const t = engine.services.get('terrain');
      // Walk outward from the centre until the ground drops below sea level.
      let bx = 0, bz = 0;
      for (let r = 60; r < 500; r += 6) {
        const x = Math.cos(2.3) * r, z = Math.sin(2.3) * r;
        if (t.heightAt(x, z) < 3.0) { bx = Math.cos(2.3) * (r - 34); bz = Math.sin(2.3) * (r - 34); break; }
      }
      const y = t.heightAt(bx, bz);
      return { pos: [bx, y + 14, bz], look: [bx * 1.6, 0, bz * 1.6] };
    },
  };

  /**
   * Flat, unobstructed ground for scenarios that need a clear stage. Picking a
   * point by coordinates alone can land against a boulder or on a shoreline,
   * which makes a capture depend on terrain luck.
   */
  function findClearGround(startX, startZ) {
    const t = engine.services.get('terrain');
    const st = engine.services.peek('structures');
    const col = engine.services.get('colliders');
    const out = [];
    for (let i = 0; i < 600; i++) {
      const a = i * 2.399, rad = i * 1.3;
      const x = startX + Math.cos(a) * rad, z = startZ + Math.sin(a) * rad;
      if (!t.isInsideMap(x, z)) continue;
      const h = t.heightAt(x, z);
      if (h < 6) continue;
      if (t.slopeAt(x, z) < 0.985) continue;
      if (st && st.insidePoi(x, z, 26)) continue;
      if (col.query(x - 9, h - 2, z - 9, x + 9, h + 8, z + 9, out)) continue;
      return { x, y: h, z };
    }
    return { x: startX, y: t.heightAt(startX, startZ), z: startZ };
  }

  function applyScenario(name) {
    const fn = SCENARIOS[name];
    if (!fn) return false;

    // Build scenario: raise a small fort so the frame covers every piece type,
    // grid alignment, the three material tints and the live ghost preview.
    if (name === 'build_grid') {
      const t = engine.services.get('terrain');
      const player = engine.services.get('player');
      const bld = engine.services.get('build');
      const rig = engine.services.get('cameraRig');
      const r = makeRoot(opts.seed).stream('scenario');
      const g = t.findGround(-60, 120, r);
      bld.resources.wood = 500; bld.resources.brick = 500; bld.resources.metal = 500;
      bld.active = true;

      const place = (piece, material, yaw, pitch) => {
        bld.setPiece(piece);
        bld.setMaterial(material);
        player.yaw = yaw; player.pitch = pitch;
        bld.computeTarget();
        return bld.place();
      };

      player.spawnAt(g.x, g.z, 0);
      engine.stepSim(4);

      // Three walls around the player, each on a different cell boundary.
      place(0, 'brick', 0, -0.12);
      place(0, 'wood', Math.PI / 2, -0.12);
      place(0, 'metal', -Math.PI / 2, -0.12);
      // A floor under the feet, a ramp leading out, and a cone capping a wall.
      place(1, 'wood', 0, -1.35);
      place(2, 'wood', Math.PI, -0.55);
      place(3, 'brick', 0, 0.12);

      // Freeze health at full so the capture does not depend on ramp timing.
      for (const rec of bld.pending) rec.meta.hp = rec.meta.maxHp;
      bld.pending.length = 0;

      // Leave a ghost preview on screen, aimed at an empty boundary.
      bld.setPiece(0);
      bld.setMaterial('metal');
      player.yaw = Math.PI; player.pitch = -0.12;
      bld.computeTarget();
      bld.update(1 / 60);

      engine.camera.position.set(g.x + 12, g.y + 6.5, g.z + 12);
      engine.camera.lookAt(g.x, g.y + 2.0, g.z);
      engine.camera.updateMatrixWorld(true);
      rig.enabled = false;
      t.updateLods(true); t.flushQueue(t.chunks.length); t.updateLods(false);
      engine.services.get('vegetation').repack(true);
      engine.services.get('vegetation').repackGrass(true);
      engine.services.get('sky').update();
      return true;
    }

    // FX scenario: fire into a freshly built wall so the frame carries muzzle
    // flash, tracer, impact sparks, debris and a decal at once.
    if (name === 'fx_combat') {
      const t = engine.services.get('terrain');
      const player = engine.services.get('player');
      const bld = engine.services.get('build');
      const combat = engine.services.get('combat');
      const fxs = engine.services.get('fx');
      const rig = engine.services.get('cameraRig');
      const r = makeRoot(opts.seed).stream('scenario');
      const g = t.findGround(-60, 120, r);

      player.spawnAt(g.x, g.z, 0);
      player.yaw = 0; player.pitch = 0;
      engine.stepSim(4);

      bld.resources.brick = 500;
      bld.active = true;
      bld.setPiece(0); bld.setMaterial('brick');
      bld.computeTarget();
      bld.place();
      for (const rec of bld.pending) rec.meta.hp = rec.meta.maxHp;
      bld.pending.length = 0;
      bld.active = false;

      combat.slots[1] = makeWeaponFor('ar', 'epic');
      combat.selectSlot(1);
      combat.reserveAmmo.medium = 500;

      // The camera must look exactly where the player faces: shots follow the
      // camera axis while the build preview follows the player's yaw, so a
      // mismatch here would put the wall somewhere the bullets never go.
      const eye = player.eyePosition(new THREE.Vector3());
      engine.camera.position.set(eye.x + 0.62, eye.y + 0.2, eye.z + 3.2);
      engine.camera.lookAt(eye.x + 0.62, eye.y + 0.2, eye.z - 40);
      engine.camera.updateMatrixWorld(true);
      rig.enabled = false;

      // A short burst, stepped just enough that the flashes differ in age.
      fxs.clear();
      for (let i = 0; i < 4; i++) {
        combat.weapon.cooldown = 0;
        combat.fire(player);
        engine.bus.flush();
        fxs.update(1 / 90);
      }
      t.updateLods(true); t.flushQueue(t.chunks.length); t.updateLods(false);
      engine.services.get('vegetation').repack(true);
      engine.services.get('vegetation').repackGrass(true);
      engine.services.get('sky').update();
      return true;
    }

    // Bots scenario: a group of opponents arranged at a range of distances, so
    // the frame covers outfit variety, the carry pose and the instanced draw.
    if (name === 'bots_squad') {
      const t = engine.services.get('terrain');
      const player = engine.services.get('player');
      const botMgr = engine.services.get('bots');
      const rig = engine.services.get('cameraRig');
      const r = makeRoot(opts.seed).stream('scenario');
      const g = t.findGround(-60, 120, r);

      player.spawnAt(g.x, g.z, 0);
      player.yaw = 0;
      engine.stepSim(2);

      // Fan the first eight bots out ahead of the player at staggered depths.
      for (let i = 0; i < botMgr.bots.length; i++) {
        const b = botMgr.bots[i];
        if (i >= 8) { b.alive = false; continue; }
        const lane = (i % 4) - 1.5;
        const depth = 10 + Math.floor(i / 4) * 11;
        const bx = g.x + lane * 3.4;
        const bz = g.z - depth;
        b.alive = true;
        b.health = 100;
        b.position.set(bx, t.heightAt(bx, bz), bz);
        b.velocity.set(0, 0, 0);
        b.yaw = Math.PI + lane * 0.12;
        b.speed = 4 + (i % 3);
        b.phase = i * 0.9;
        b.outfit = i % 6;
        b.simple = true;
      }
      botMgr.aliveCount = 8;
      botMgr.update(1 / 60);

      const eye = player.eyePosition(new THREE.Vector3());
      engine.camera.position.set(eye.x + 1.2, eye.y + 1.4, eye.z + 5.5);
      engine.camera.lookAt(eye.x, eye.y + 0.2, eye.z - 30);
      engine.camera.updateMatrixWorld(true);
      rig.enabled = false;
      t.updateLods(true); t.flushQueue(t.chunks.length); t.updateLods(false);
      engine.services.get('vegetation').repack(true);
      engine.services.get('vegetation').repackGrass(true);
      engine.services.get('sky').update();
      return true;
    }

    // Storm scenario: stand just inside the wall looking out at it.
    if (name === 'storm_edge') {
      const t = engine.services.get('terrain');
      const player = engine.services.get('player');
      const st = engine.services.get('storm');
      const rig = engine.services.get('cameraRig');
      const r = makeRoot(opts.seed).stream('scenario');
      const g = t.findGround(-40, 40, r);

      st.start();
      st.centre.set(g.x, g.z);
      st.radius = 70;
      st.dps = 4;
      st.update(0.016);

      // Stand 12m inside the boundary, facing straight out at the wall.
      const bearing = 0.9;
      const px = g.x + Math.cos(bearing) * (st.radius - 12);
      const pz = g.z + Math.sin(bearing) * (st.radius - 12);
      player.spawnAt(px, pz, 0);
      player.yaw = Math.atan2(-Math.cos(bearing), -Math.sin(bearing));
      player.pitch = 0.04;
      rig.enabled = true;
      rig.occlusion = 1;
      for (let i = 0; i < 120; i++) rig.update(1 / 60);
      t.updateLods(true); t.flushQueue(t.chunks.length); t.updateLods(false);
      engine.services.get('vegetation').repack(true);
      engine.services.get('vegetation').repackGrass(true);
      engine.services.get('sky').update();
      for (let i = 0; i < 10; i++) rig.update(1 / 60);
      return true;
    }

    // Loot scenario: a chest surrounded by its contents, at pickup range.
    if (name === 'match_loot') {
      const t = engine.services.get('terrain');
      const player = engine.services.get('player');
      const lootSys = engine.services.get('loot');
      const rig = engine.services.get('cameraRig');
      const g = findClearGround(80, -140);

      lootSys.items.length = 0;
      lootSys.chests.length = 0;
      const chest = { x: g.x, y: g.y, z: g.z, yaw: 0.4, opened: false, kind: 'scenario' };
      lootSys.chests.push(chest);
      // One of each item type, laid out in a ring so all are visible.
      const ring = [
        () => lootSys.spawnWeapon(g.x + 1.8, g.y + 0.5, g.z - 0.4, 'ar', 'legendary'),
        () => lootSys.spawnWeapon(g.x - 1.8, g.y + 0.5, g.z + 0.5, 'shotgun', 'epic'),
        () => lootSys.spawnWeapon(g.x + 0.3, g.y + 0.5, g.z + 2.0, 'sniper', 'rare'),
        () => lootSys.spawnConsumable(g.x - 1.2, g.y + 0.5, g.z - 1.6, 'shield', 2),
        () => lootSys.spawnConsumable(g.x + 2.4, g.y + 0.5, g.z + 1.6, 'medkit', 1),
        () => lootSys.spawnAmmo(g.x - 2.6, g.y + 0.5, g.z - 0.2, 'medium', 30),
        () => lootSys.spawnMaterial(g.x + 1.0, g.y + 0.5, g.z - 2.2, 'metal', 60),
      ];
      for (const f of ring) f();
      lootSys.update(0.4);

      // Park the player behind the camera: this capture is about the loot.
      player.spawnAt(g.x + 5.5, g.z - 9.5, 0);
      player.yaw = 0.6;
      player.pitch = -0.25;
      // Frame the pile directly rather than through the rig: this capture is
      // about the loot's readability, not about camera behaviour.
      rig.enabled = false;
      engine.camera.position.set(g.x + 2.6, g.y + 2.9, g.z - 5.4);
      engine.camera.lookAt(g.x, g.y + 0.45, g.z);
      engine.camera.updateMatrixWorld(true);
      t.updateLods(true); t.flushQueue(t.chunks.length); t.updateLods(false);
      engine.services.get('vegetation').repack(true);
      engine.services.get('vegetation').repackGrass(true);
      engine.services.get('sky').update();
      lootSys.update(0.4);
      return true;
    }

    // HUD scenario: a mid-match state with every readout populated.
    if (name === 'hud_full') {
      const t = engine.services.get('terrain');
      const player = engine.services.get('player');
      const combat = engine.services.get('combat');
      const bld = engine.services.get('build');
      const st = engine.services.get('storm');
      const botMgr = engine.services.get('bots');
      const hud = engine.services.get('hud');
      const rig = engine.services.get('cameraRig');
      const screens = engine.services.get('screens');
      const g = findClearGround(-60, 120);

      screens.show(null);
      player.spawnAt(g.x, g.z, 0);
      player.yaw = 0.6; player.pitch = -0.02;
      player.health = 62;
      player.shield = 45;
      combat.slots[1] = makeWeaponFor('ar', 'epic');
      combat.selectSlot(1);
      combat.weapon.ammo = 7;
      combat.reserveAmmo.medium = 148;
      combat.consumables.shield = 2;
      bld.resources = { wood: 372, brick: 205, metal: 118 };
      bld.active = false;

      st.start();
      // Keep the wall out past the draw distance: this capture is about HUD
      // legibility, and a close storm wall floods the frame with purple.
      st.centre.set(g.x, g.z);
      st.radius = 430;
      st.targetRadius = 280;
      st.state = 1;              // shrinking, so the HUD shows the closing state
      st.shrinkDuration = 60;
      st.timer = 38;
      st.dps = 4;

      // Leave a few bots alive so the counters read like a real match.
      botMgr.bots.forEach((b, i) => { b.alive = i < 11; });
      botMgr.aliveCount = 11;
      engine.services.get('match').stats.eliminations = 4;
      engine.services.get('match').state = 3;   // PLAYING

      // Populate the kill feed and a hitmarker.
      hud.killfeed = [
        { text: 'YOU eliminated Bot 14', ttl: 4, mine: true },
        { text: 'Bot 3 eliminated Bot 21', ttl: 3.2, mine: false },
        { text: 'the storm eliminated Bot 9', ttl: 2.4, mine: false },
      ];
      hud._feedDirty = true;
      hud._hitmarkerTimer = 0.2;

      rig.enabled = true;
      rig.occlusion = 1;
      for (let i = 0; i < 120; i++) rig.update(1 / 60);
      t.updateLods(true); t.flushQueue(t.chunks.length); t.updateLods(false);
      engine.services.get('vegetation').repack(true);
      engine.services.get('vegetation').repackGrass(true);
      engine.services.get('sky').update();
      st.update(1 / 60);
      hud.update(1 / 60);
      engine.services.get('minimap').draw();
      // Damage numbers, projected from a point ahead of the player.
      const dn = engine.services.get('damageNumbers');
      dn.clear();
      const fwd = player.lookDirection(new THREE.Vector3());
      const base = player.eyePosition(new THREE.Vector3()).addScaledVector(fwd, 9);
      dn.spawn({ x: base.x, y: base.y + 0.4, z: base.z }, 33, 'body');
      dn.spawn({ x: base.x + 1.1, y: base.y + 0.9, z: base.z + 0.6 }, 74, 'head');
      dn.update(0.25);
      for (let i = 0; i < 6; i++) rig.update(1 / 60);
      return true;
    }

    // Results screen with a full stat line.
    if (name === 'screen_result') {
      const screens = engine.services.get('screens');
      screens.showResult({
        victory: true, placement: 1, players: 25, eliminations: 7,
        damage: 1842, accuracy: 0.412, chests: 6, distance: 2143, time: 512,
      });
      return true;
    }

    // Rig-driven scenarios: place the player, then let CameraRig settle.
    if (name === 'player_tps' || name === 'player_ads') {
      const t = engine.services.get('terrain');
      const st = engine.services.get('structures');
      const rig = engine.services.get('cameraRig');
      const player = engine.services.get('player');
      const poi = st.pois.find((p) => p.type === 'town') || st.pois[0];
      // Stand just outside the POI pad looking in, so the frame shows the
      // character, the ground detail and the buildings together.
      const bearing = 2.35;
      const dist = poi.radius + 12;
      const px = poi.x + Math.cos(bearing) * dist;
      const pz = poi.z + Math.sin(bearing) * dist;
      player.spawnAt(px, pz, 0);
      player.yaw = Math.atan2(-(poi.x - px), -(poi.z - pz));
      player.pitch = -0.04;
      player.aiming = name === 'player_ads';
      // Arm the player so the third-person weapon model and the ADS pose are
      // part of the visual baseline.
      const combat = engine.services.peek('combat');
      if (combat) {
        combat.slots[1] = combat.slots[1] || makeWeaponFor('ar', 'legendary');
        combat.selectSlot(1);
        engine.services.get('player').mesh.update(0.4, {
          speed: 0, maxSpeed: 7.2, grounded: true, crouch: false,
          aim: name === 'player_ads', pitch: -0.04, strafe: 0, torsoYaw: 0,
        });
      }
      rig.enabled = true;
      rig.occlusion = 1;
      // Settle the rig's exponential smoothing to its steady state.
      for (let i = 0; i < 120; i++) rig.update(1 / 60);
      engine.services.get('vegetation').repack(true);
      engine.services.get('vegetation').repackGrass(true);
      t.updateLods(true);
      t.flushQueue(t.chunks.length);
      t.updateLods(false);
      engine.services.get('sky').update();
      for (let i = 0; i < 20; i++) rig.update(1 / 60);
      void t;
      return true;
    }

    const pose = fn();
    const rig = engine.services.peek('cameraRig');
    if (rig) rig.enabled = false;   // scenario poses are authoritative
    engine.camera.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
    engine.camera.lookAt(pose.look[0], pose.look[1], pose.look[2]);
    engine.camera.updateMatrixWorld(true);
    // Settle streaming so the capture never depends on frame timing.
    const terrain = engine.services.get('terrain');
    terrain.updateLods(true);
    terrain.flushQueue(terrain.chunks.length);
    terrain.updateLods(false);
    engine.services.get('vegetation').repack(true);
    engine.services.get('vegetation').repackGrass(true);
    engine.services.get('sky').update();
    return true;
  }

  const ctx = {
    seed: opts.seed,
    scenario: (name) => applyScenario(name),
    state: () => {
      const t = engine.services.get('terrain');
      const v = engine.services.get('vegetation');
      const c = engine.services.get('colliders');
      return {
        frame: engine.frame,
        time: engine.time,
        camera: engine.camera.position.toArray().map((n) => +n.toFixed(3)),
        player: engine.services.get('player').state(),
        build: engine.services.get('build').state(),
        combat: engine.services.get('combat').state(),
        bots: engine.services.get('bots').state(),
        storm: engine.services.get('storm').snapshot(),
        loot: engine.services.get('loot').state(),
        match: engine.services.get('match').snapshot(),
        hud: engine.services.get('hud').snapshot(),
        screens: engine.services.get('screens').snapshot(),
        fx: engine.services.get('fx').state(),
        audio: engine.services.get('audio').state(),
        terrain: { ...t.stats, maxHeight: +t.field.maxHeight.toFixed(2) },
        vegetation: { ...v.stats },
        structures: { ...engine.services.get('structures').stats,
          drawCalls: engine.services.get('structures').kit.stats.drawCalls },
        colliders: c.count,
      };
    },
    inputApi: {
      override: (partial) => engine.services.get('input').override(partial),
      clearOverride: () => engine.services.get('input').clearOverride(),
      state: () => JSON.parse(JSON.stringify(engine.services.get('input').state)),
      raw: () => JSON.parse(JSON.stringify(engine.services.get('input').raw)),
      pressed: () => ({ ...engine.services.get('input').pressed }),
      touch: () => engine.services.get('touch').debugState(),
      touchRects: () => {
        const t = engine.services.get('touch');
        const out = {};
        for (const [id, el] of t.buttonEls) {
          const r = el.getBoundingClientRect();
          out[id] = { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
            hidden: el.classList.contains('hidden') };
        }
        t.slotEls.forEach((el, i) => {
          const r = el.getBoundingClientRect();
          out['slot' + i] = { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
            hidden: el.offsetParent === null };
        });
        t.pieceEls.forEach((el, i) => {
          const r = el.getBoundingClientRect();
          out['piece' + i] = { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
            hidden: el.offsetParent === null };
        });
        out._viewport = { w: window.innerWidth, h: window.innerHeight };
        return out;
      },
      releaseAll: () => engine.services.get('touch').releaseAll(),
    },
    debug: {
      heightAt: (x, z) => engine.services.get('terrain').heightAt(x, z),
      biomeAt: (x, z) => engine.services.get('terrain').biomeAt(x, z),
      teleport: (x, z, yOff = 0) => engine.services.get('player').spawnAt(x, z, yOff).toArray(),
      setUiVisible: (v) => {
        engine.services.get('touch').setVisible(v);
        engine.services.get('hud').setVisible(v);
        engine.services.get('minimap').setVisible(v);
      },
      showScreen: (name) => engine.services.get('screens').show(name),
      setYaw: (y) => { engine.services.get('player').yaw = y; },
      startMatch: () => engine.services.get('match').startMatch(),
      deploy: () => engine.services.get('match').deploy(),
      setPitch: (p) => { engine.services.get('player').pitch = p; },
    },
  };
  const api = installTestApi(engine, ctx);

  api.ready = (async () => {
    await engine.init();
    // Overlook pose: high enough to see terrain silhouette and vegetation.
    const t = engine.services.get('terrain');
    const eye = t.findGround(40, 60, rng);
    // Stand at eye height until the player controller takes over the camera.
    const player = engine.services.get('player');
    player.spawnAt(eye.x, eye.z, 0.2);
    player.yaw = Math.PI * 0.25;
    // Scenario captures need a populated, non-running world; a real session
    // starts a match instead.
    if (opts.scenario) {
      engine.services.get('bots').spawnAll();
      engine.services.get('loot').populate();
      engine.services.get('screens').show(null);
    } else {
      // A real session waits behind the start screen: audio unlock, fullscreen
      // and orientation lock all require a user gesture.
      engine.services.get('screens').show('start');
    }
    engine.services.get('cameraRig').update(0.016);
    if (opts.scenario && SCENARIOS[opts.scenario]) applyScenario(opts.scenario);
    engine.start();
    document.body.dataset.ready = '1';
    return true;
  })();

  await api.ready;
}

boot().catch((err) => {
  console.error('[boot] failed', err);
  document.body.dataset.error = String((err && err.message) || err);
});
