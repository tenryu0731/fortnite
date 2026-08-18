import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { Settings } from './core/Settings.js';
import { installTestApi } from './core/TestApi.js';

/** Query-string overrides let the harness pin seed/quality/scenario per run. */
function queryOverrides() {
  const p = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const o = {};
  if (p.has('quality')) o.quality = p.get('quality');
  if (p.has('fov')) o.fov = Number(p.get('fov'));
  if (p.has('adaptive')) o.adaptiveResolution = p.get('adaptive') !== '0';
  return { user: o, seed: p.has('seed') ? Number(p.get('seed')) : 1337, scenario: p.get('scenario') || null };
}

/** Placeholder world — replaced by the terrain subsystem in S2. */
class BootstrapScene {
  constructor() { this.order = 10; }
  init(services) {
    const scene = services.get('scene');
    scene.background = new THREE.Color(0x8fb4dd);
    scene.fog = new THREE.Fog(0x8fb4dd, 60, 500);

    const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
    sun.position.set(60, 90, 40);
    sun.castShadow = services.get('settings').q.shadows;
    if (sun.castShadow) {
      const d = 40;
      sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
      sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.bias = -0.0006;
    }
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0xbcd8ff, 0x4a5340, 1.0));

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400, 1, 1),
      new THREE.MeshLambertMaterial({ color: 0x5a7a44 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const geo = new THREE.BoxGeometry(4, 4, 4);
    const mat = new THREE.MeshLambertMaterial({ color: 0xb08050 });
    const inst = new THREE.InstancedMesh(geo, mat, 24);
    inst.castShadow = true; inst.receiveShadow = true;
    const m = new THREE.Matrix4();
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r = 16 + (i % 4) * 7;
      m.makeTranslation(Math.cos(a) * r, 2 + (i % 3) * 2, Math.sin(a) * r);
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
    this.scene = scene;
  }
  update() {}
}

async function boot() {
  const canvas = document.getElementById('gl');
  const overrides = queryOverrides();
  const settings = new Settings(overrides.user);
  const engine = new Engine(canvas, settings);

  engine.register('bootstrap', new BootstrapScene());

  const ctx = {
    seed: overrides.seed,
    state: () => ({ frame: engine.frame, time: engine.time }),
    scenario: () => false,
    setSeed: () => false,
  };
  const api = installTestApi(engine, ctx);

  api.ready = (async () => {
    await engine.init();
    engine.camera.position.set(0, 14, 42);
    engine.camera.lookAt(0, 2, 0);
    engine.start();
    document.body.dataset.ready = '1';
    return true;
  })();

  await api.ready;
}

boot().catch((err) => {
  console.error('[boot] failed', err);
  document.body.dataset.error = String(err && err.message || err);
});
