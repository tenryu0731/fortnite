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
import { PlayerController } from './player/PlayerController.js';
import { CameraRig } from './player/CameraRig.js';

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
  engine.register('input', input);
  engine.register('player', new PlayerController({ seed: opts.seed }));
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
    },
    debug: {
      heightAt: (x, z) => engine.services.get('terrain').heightAt(x, z),
      biomeAt: (x, z) => engine.services.get('terrain').biomeAt(x, z),
      teleport: (x, z, yOff = 0) => engine.services.get('player').spawnAt(x, z, yOff).toArray(),
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
