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
import { Physics } from './sim/Physics.js';
import { InputHub } from './input/InputState.js';
import { DesktopInput } from './input/DesktopInput.js';
import { TouchInput } from './input/TouchInput.js';
import { PlayerController } from './player/PlayerController.js';
import { CameraRig } from './player/CameraRig.js';
import { BuildSystem } from './build/BuildSystem.js';
import { CombatSystem } from './combat/CombatSystem.js';
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
  engine.register('combat', new CombatSystem(opts.seed));
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
      setUiVisible: (v) => { engine.services.get('touch').setVisible(v); },
      setYaw: (y) => { engine.services.get('player').yaw = y; },
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
