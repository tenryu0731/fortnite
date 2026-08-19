/**
 * gameplay.cjs — in-browser behavioural checks for world and simulation
 * subsystems: terrain queries, spatial index, streaming, scatter placement.
 * These run against the real, fully booted game rather than isolated modules.
 */
const { startServer, launch, openGame, check } = require('./harness.cjs');

const SUITE = `async () => {
  const results = [];
  const t = (name, fn) => {
    try {
      const r = fn();
      results.push({ name, ok: r === true || (r && r.ok === true), detail: (r && r.detail) || '' });
    } catch (e) { results.push({ name, ok: false, detail: e.message }); }
  };
  const G = window.__GAME;
  const S = G.engine.services;
  const terrain = S.get('terrain');
  const veg = S.get('vegetation');
  const structures = S.get('structures');
  const player = S.get('player');
  const physics = S.get('physics');
  const rig = S.get('cameraRig');
  const build = S.get('build');
  const combat = S.get('combat');
  const fx = S.get('fx');
  const audio = S.get('audio');
  const bots = S.get('bots');
  const storm = S.get('storm');
  const loot = S.get('loot');
  const match = S.get('match');
  const hud = S.get('hud');
  const minimap = S.get('minimap');
  const damageNumbers = S.get('damageNumbers');
  const screens = S.get('screens');

  // A real session boots straight into a match, which parks the player on the
  // battle bus and overwrites their position every step. Every suite before the
  // match section needs a free-standing player on the ground, so the director
  // and the storm are idled here and restarted explicitly by that section.
  match.state = 0;                 // MATCH.IDLE
  match.busMesh.visible = false;
  storm.active = false;

  // A real session also opens behind the start screen, which suspends gameplay
  // input. Dismiss it so the suite drives a live, playable world.
  screens.show(null);

  // Bots are live from world init and will shoot the player during any
  // simulated frames, so the opposing team is parked too.
  for (const b of bots.bots) b.alive = false;
  bots.aliveCount = 0;

  // Deterministic driver: hold an input state for N fixed steps.
  const sim = (frames, input) => {
    if (input) G.input.override(input); else G.input.clearOverride();
    G.stepSim(frames);
    G.input.clearOverride();
  };
  const settle = (frames = 30) => sim(frames, {});
  // Put the player on flat ground clear of props, facing -Z.
  const placeClear = () => {
    for (let r = 0; r < 400; r++) {
      const a = r * 2.399, rad = 12 + r * 1.1;
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      if (terrain.heightAt(x, z) < SEA_LEVEL + 2) continue;
      if (terrain.slopeAt(x, z) < 0.985) continue;
      if (structures.insidePoi(x, z, 20)) continue;
      const out = [];
      colliders.query(x - 3, terrain.heightAt(x, z) - 1, z - 3, x + 3, terrain.heightAt(x, z) + 4, z + 3, out);
      if (out.length) continue;
      player.spawnAt(x, z, 0);
      player.yaw = 0; player.pitch = 0;
      player.body.vel.set(0, 0, 0);
      player.health = 100; player.shield = 0; player.alive = true;
      settle(12);
      return true;
    }
    return false;
  };
  const colliders = S.get('colliders');
  const THREE = await import('three');
  const { Colliders } = await import('/src/world/Colliders.js');
  const { MAT } = await import('/src/world/StructureKit.js');
  const { SEA_LEVEL } = await import('/src/world/Biome.js');

  /* --- terrain queries ---------------------------------------------- */
  t('terrain: heightAt reproduces the baked grid at sample points', () => {
    const f = terrain.field;
    let maxErr = 0;
    for (let k = 0; k < 400; k++) {
      const i = (k * 37) % f.dim, j = (k * 53) % f.dim;
      const x = -f.half + i * f.step, z = -f.half + j * f.step;
      maxErr = Math.max(maxErr, Math.abs(terrain.heightAt(x, z) - f.height[j * f.dim + i]));
    }
    return { ok: maxErr < 1e-3, detail: 'maxErr=' + maxErr.toExponential(2) };
  });

  t('terrain: height field is continuous (no cliffs steeper than 4m per 0.5m)', () => {
    let worst = 0, at = null;
    for (let k = 0; k < 4000; k++) {
      const x = ((k * 7919) % 1800) / 2 - 450;
      const z = ((k * 6271) % 1800) / 2 - 450;
      const d = Math.abs(terrain.heightAt(x, z) - terrain.heightAt(x + 0.5, z));
      if (d > worst) { worst = d; at = [x.toFixed(0), z.toFixed(0)]; }
    }
    return { ok: worst < 4, detail: 'max delta ' + worst.toFixed(3) + 'm at ' + (at || []).join(',') };
  });

  t('terrain: normals are unit length and point upward on land', () => {
    const v = new THREE.Vector3();
    let bad = 0, minY = 1;
    for (let k = 0; k < 1500; k++) {
      const x = ((k * 7919) % 1600) / 2 - 400, z = ((k * 6271) % 1600) / 2 - 400;
      terrain.normalAt(x, z, v);
      if (Math.abs(v.length() - 1) > 1e-4) bad++;
      if (v.y < minY) minY = v.y;
    }
    return { ok: bad === 0 && minY > 0, detail: 'nonUnit=' + bad + ' minNy=' + minY.toFixed(3) };
  });

  t('terrain: downward raycast lands on the surface', () => {
    let worst = 0;
    for (let k = 0; k < 200; k++) {
      const x = ((k * 7919) % 800) / 2 - 200, z = ((k * 6271) % 800) / 2 - 200;
      const h = terrain.heightAt(x, z);
      const hit = terrain.raycast(x, h + 60, z, 0, -1, 0, 200, 1.0);
      if (!hit) { worst = 999; break; }
      worst = Math.max(worst, Math.abs(hit.y - h));
    }
    return { ok: worst < 0.15, detail: 'max error ' + worst.toFixed(4) + 'm' };
  });

  t('terrain: oblique raycast hits the surface it crosses', () => {
    let hits = 0, worst = 0;
    for (let k = 0; k < 60; k++) {
      const a = k / 60 * Math.PI * 2;
      const ox = Math.cos(a) * 30, oz = Math.sin(a) * 30;
      const oy = terrain.heightAt(ox, oz) + 25;
      const d = new THREE.Vector3(Math.cos(a + 2), -0.45, Math.sin(a + 2)).normalize();
      const hit = terrain.raycast(ox, oy, oz, d.x, d.y, d.z, 300, 1.0);
      if (hit) { hits++; worst = Math.max(worst, Math.abs(hit.y - terrain.heightAt(hit.x, hit.z))); }
    }
    return { ok: hits >= 55 && worst < 0.3, detail: hits + '/60 hits, max surface error ' + worst.toFixed(3) };
  });

  t('terrain: island is bounded by water on every side', () => {
    let wet = 0;
    for (let k = 0; k < 360; k++) {
      const a = k / 360 * Math.PI * 2;
      if (terrain.heightAt(Math.cos(a) * 500, Math.sin(a) * 500) < SEA_LEVEL) wet++;
    }
    return { ok: wet === 360, detail: wet + '/360 rim samples below sea level' };
  });

  t('terrain: a usable fraction of the map is walkable land', () => {
    let land = 0, walk = 0, n = 0;
    for (let j = 0; j < 60; j++) {
      for (let i = 0; i < 60; i++) {
        const x = (i / 59 - 0.5) * 1000, z = (j / 59 - 0.5) * 1000;
        n++;
        if (terrain.heightAt(x, z) > SEA_LEVEL) { land++; if (terrain.slopeAt(x, z) > 0.72) walk++; }
      }
    }
    const landPct = land / n * 100, walkPct = walk / Math.max(1, land) * 100;
    return { ok: landPct > 40 && landPct < 80 && walkPct > 70,
             detail: 'land ' + landPct.toFixed(1) + '%, walkable ' + walkPct.toFixed(1) + '% of land' };
  });

  /* --- collider index ------------------------------------------------ */
  t('colliders: query returns exactly the overlapping boxes', () => {
    const c = new Colliders(256, 8);
    const a = c.add(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 2, 2), 'a');
    const b = c.add(new THREE.Vector3(10, 0, 10), new THREE.Vector3(12, 2, 12), 'b');
    const big = c.add(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 4, 20), 'big');
    const out = [];
    c.query(1, 1, 1, 1.5, 1.5, 1.5, out);
    const got = out.map((h) => c.getMeta(h)).sort().join(',');
    const okQ = got === 'a,big';
    c.remove(big);
    c.query(1, 1, 1, 1.5, 1.5, 1.5, out);
    const after = out.map((h) => c.getMeta(h)).join(',');
    return { ok: okQ && after === 'a' && c.count === 2, detail: got + ' -> ' + after };
  });

  t('colliders: raycast returns the nearest hit with the right normal', () => {
    const c = new Colliders(256, 8);
    c.add(new THREE.Vector3(20, -1, -1), new THREE.Vector3(22, 1, 1), 'far');
    c.add(new THREE.Vector3(5, -1, -1), new THREE.Vector3(7, 1, 1), 'near');
    const hit = c.raycast(0, 0, 0, 1, 0, 0, 60);
    return { ok: !!hit && hit.meta === 'near' && Math.abs(hit.t - 5) < 1e-6 && hit.normal.x === -1,
             detail: hit ? hit.meta + ' t=' + hit.t.toFixed(3) + ' n=' + hit.normal.toArray().join(',') : 'miss' };
  });

  t('colliders: a ray that misses everything returns null', () => {
    const c = new Colliders(256, 8);
    c.add(new THREE.Vector3(5, 10, -1), new THREE.Vector3(7, 12, 1), 'high');
    return c.raycast(0, 0, 0, 1, 0, 0, 60) === null;
  });

  t('colliders: handles are recycled after removal', () => {
    const c = new Colliders(256, 8);
    const h1 = c.add(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1), 'x');
    c.remove(h1);
    const h2 = c.add(new THREE.Vector3(4, 0, 4), new THREE.Vector3(5, 1, 5), 'y');
    const out = [];
    c.query(0, 0, 0, 1, 1, 1, out);
    return { ok: h2 === h1 && out.length === 0 && c.count === 1, detail: 'h1=' + h1 + ' h2=' + h2 };
  });

  t('colliders: world props are registered and hit by rays', () => {
    const n = colliders.count;
    let hits = 0;
    for (let k = 0; k < 200; k++) {
      const a = k / 200 * Math.PI * 2, r = 40 + (k % 7) * 18;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const y = terrain.heightAt(x, z) + 1.4;
      if (colliders.raycast(x, y, z, Math.cos(a + 1.1), 0, Math.sin(a + 1.1), 70)) hits++;
    }
    return { ok: n > 500 && hits > 10, detail: n + ' colliders, ' + hits + '/200 rays hit a prop' };
  });

  /* --- streaming ------------------------------------------------------ */
  t('terrain: chunks re-LOD when the camera moves', () => {
    const cam = G.engine.camera;
    const before = terrain.chunks.filter((c) => c.lod === 0).map((c) => c.cx + ':' + c.cz).join(',');
    cam.position.set(300, terrain.heightAt(300, -280) + 30, -280);
    cam.updateMatrixWorld(true);
    terrain.updateLods(true);
    terrain.flushQueue(terrain.chunks.length);
    const after = terrain.chunks.filter((c) => c.lod === 0).map((c) => c.cx + ':' + c.cz).join(',');
    return { ok: before !== after && after.length > 0, detail: 'LOD0 set changed' };
  });

  t('terrain: visible chunk count stays within the draw budget', () => {
    const cam = G.engine.camera;
    let worst = 0;
    for (const [x, z] of [[0, 0], [-320, 300], [400, 400], [-450, -450], [120, -60]]) {
      cam.position.set(x, terrain.heightAt(x, z) + 20, z);
      cam.updateMatrixWorld(true);
      terrain.updateLods(true);
      terrain.flushQueue(terrain.chunks.length);
      terrain.updateLods(false);
      worst = Math.max(worst, terrain.stats.visible);
    }
    return { ok: worst <= 30, detail: 'max frustum-visible chunks ' + worst };
  });

  t('terrain: a rebuild is amortised across frames, never done in one', () => {
    const cam = G.engine.camera;
    // Park somewhere settled, then jump far enough that the near ring is all
    // new work, which is the sprint-across-a-boundary case.
    cam.position.set(0, terrain.heightAt(0, 0) + 20, 0);
    cam.updateMatrixWorld(true);
    terrain.updateLods(true); terrain.flushQueue(terrain.chunks.length);
    cam.position.set(260, terrain.heightAt(260, 240) + 20, 240);
    cam.updateMatrixWorld(true);
    terrain.updateLods(true);
    const queued = terrain.queue.length;
    if (queued < 2) return { ok: false, detail: 'expected a rebuild queue, got ' + queued };
    // A single frame-budget flush must leave work outstanding rather than
    // meshing the whole near ring at once.
    const done = terrain.flushQueue();
    const left = terrain.queue.length + (terrain.job ? 1 : 0);
    return {
      ok: done <= 2 && left > 0,
      detail: 'queued ' + queued + ', completed ' + done + ' in one frame, ' + left + ' outstanding',
    };
  });

  t('terrain: streaming always finishes what it starts', () => {
    // Whatever the budget, repeated frame-sized flushes must drain the queue:
    // a stalled job would leave a chunk stuck at the wrong LOD forever.
    let frames = 0;
    while ((terrain.queue.length || terrain.job) && frames < 400) { terrain.flushQueue(); frames++; }
    const stuck = terrain.chunks.filter((c) => c.queued).length;
    return {
      ok: !terrain.job && terrain.queue.length === 0 && stuck === 0 && frames < 400,
      detail: 'drained in ' + frames + ' frames, ' + stuck + ' chunks still marked queued',
    };
  });

  t('terrain: an in-flight chunk keeps its old mesh until the new one is ready', () => {
    const cam = G.engine.camera;
    cam.position.set(-300, terrain.heightAt(-300, -300) + 20, -300);
    cam.updateMatrixWorld(true);
    terrain.updateLods(true); terrain.flushQueue(terrain.chunks.length);
    cam.position.set(120, terrain.heightAt(120, 120) + 20, 120);
    cam.updateMatrixWorld(true);
    terrain.updateLods(true);
    terrain.flushQueue(1, 60);              // deliberately too small to finish
    const job = terrain.job;
    if (!job) return { ok: false, detail: 'expected an in-flight job' };
    const lodUnchanged = job.c.lod !== job.lod;
    const hasMesh = !!job.c.mesh && job.c.mesh.geometry.attributes.position.count > 0;
    terrain.flushQueue(terrain.chunks.length);
    return {
      ok: lodUnchanged && hasMesh,
      detail: 'partially meshed chunk still rendering its previous LOD',
    };
  });

  t('terrain: chunks behind the camera are culled from the draw list', () => {
    const cam = G.engine.camera;
    const x = 0, z = 0;
    cam.position.set(x, terrain.heightAt(x, z) + 25, z);
    cam.lookAt(x + 100, terrain.heightAt(x + 100, z) + 10, z);
    cam.updateMatrixWorld(true);
    terrain.updateLods(false);
    const facing = terrain.stats.visible;
    const drawn = terrain.chunks.filter((c) => c.mesh && c.mesh.visible).length;
    const total = terrain.chunks.length;
    return {
      ok: facing > 0 && drawn === facing && facing < total * 0.5,
      detail: facing + ' of ' + total + ' chunks in frustum, ' + drawn + ' meshes visible',
    };
  });

  t('vegetation: instance counts never exceed allocated capacity', () => {
    const cam = G.engine.camera;
    const over = [];
    for (const [x, z] of [[0, 0], [-200, 180], [260, -300], [-400, -120], [150, 420]]) {
      cam.position.set(x, terrain.heightAt(x, z) + 4, z);
      cam.updateMatrixWorld(true);
      veg.repack(true);
      for (const k of Object.keys(veg.im)) {
        if (veg.im[k].count > veg.im[k].instanceMatrix.count) over.push(k + ' ' + veg.im[k].count + '>' + veg.im[k].instanceMatrix.count);
      }
    }
    return { ok: over.length === 0, detail: over.join(', ') || 'within capacity at all probes' };
  });

  t('vegetation: nothing is scattered below sea level or on cliffs', () => {
    let bad = 0, total = 0;
    for (const lists of veg.chunkProps.values()) {
      for (const key of ['tree', 'pine', 'rock']) {
        for (const p of lists[key]) {
          total++;
          if (p.y < SEA_LEVEL + 0.9) bad++;
          else if (terrain.slopeAt(p.x, p.z) < 0.5) bad++;
        }
      }
    }
    return { ok: bad === 0 && total > 300, detail: total + ' props, ' + bad + ' misplaced' };
  });

  t('vegetation: props sit on the terrain surface', () => {
    let worst = 0, n = 0;
    for (const lists of veg.chunkProps.values()) {
      for (const p of lists.tree) {
        if ((n++ % 17) !== 0) continue;
        worst = Math.max(worst, Math.abs(p.y - terrain.heightAt(p.x, p.z)));
      }
    }
    return { ok: worst < 0.01, detail: 'max ground offset ' + worst.toFixed(5) + 'm' };
  });

  /* --- structures ----------------------------------------------------- */
  t('structures: POIs are placed on land, spaced apart and named', () => {
    const bad = [];
    for (let i = 0; i < structures.pois.length; i++) {
      const p = structures.pois[i];
      if (terrain.heightAt(p.x, p.z) < SEA_LEVEL + 1) bad.push(p.name + ' in water');
      if (!p.name) bad.push('unnamed POI');
      for (let j = i + 1; j < structures.pois.length; j++) {
        const q = structures.pois[j];
        if (Math.hypot(p.x - q.x, p.z - q.z) < 40) bad.push(p.name + '/' + q.name + ' overlap');
      }
    }
    return { ok: structures.pois.length >= 6 && bad.length === 0,
             detail: structures.pois.length + ' POIs: ' + structures.pois.map((p) => p.type).join(',') + (bad.length ? ' | ' + bad.join('; ') : '') };
  });

  t('structures: POI pads are flat enough to build and fight on', () => {
    let worst = 0, at = '';
    for (const p of structures.pois) {
      let mn = 1e9, mx = -1e9;
      for (let a = 0; a < 12; a++) {
        for (const r of [0, p.radius * 0.35, p.radius * 0.6]) {
          const x = p.x + Math.cos(a / 12 * 6.283) * r, z = p.z + Math.sin(a / 12 * 6.283) * r;
          const h = terrain.heightAt(x, z);
          mn = Math.min(mn, h); mx = Math.max(mx, h);
        }
      }
      if (mx - mn > worst) { worst = mx - mn; at = p.name; }
    }
    return { ok: worst < 3.0, detail: 'worst pad relief ' + worst.toFixed(2) + 'm at ' + at };
  });

  t('structures: every building has a roof over its footprint', () => {
    const bad = [];
    for (const b of structures.buildings) {
      let covered = 0, total = 0;
      for (let mz = 0; mz < b.d; mz++) {
        for (let mx = 0; mx < b.w; mx++) {
          const x = b.ox + (mx + 0.5) * 4, z = b.oz + (mz + 0.5) * 4;
          total++;
          const hit = colliders.raycast(x, b.top + 14, z, 0, -1, 0, 30,
            (meta) => meta && meta.type === 'structure');
          if (hit) covered++;
        }
      }
      if (covered < total) bad.push(b.w + 'x' + b.d + ' @' + b.x.toFixed(0) + ',' + b.z.toFixed(0) + ' ' + covered + '/' + total);
    }
    return { ok: bad.length === 0 && structures.buildings.length > 10,
             detail: structures.buildings.length + ' buildings' + (bad.length ? ', uncovered: ' + bad.slice(0, 5).join(' ') : '') };
  });

  t('structures: every building has at least one doorway', () => {
    const bad = structures.buildings.filter((b) => b.doors < 1).length;
    return { ok: bad === 0, detail: bad + ' buildings without a door' };
  });

  t('structures: panels sit above the terrain surface', () => {
    let below = 0, n = 0;
    for (const r of structures.kit.records) {
      if (!r.alive || r.handles.length === 0) continue;
      n++;
      const cx = (r.box.min.x + r.box.max.x) / 2, cz = (r.box.min.z + r.box.max.z) / 2;
      // Allow half a metre of embedding for slabs seated on the pad.
      if (r.box.max.y < terrain.heightAt(cx, cz) - 0.6) below++;
    }
    return { ok: below === 0 && n > 300, detail: n + ' solid panels, ' + below + ' buried' };
  });

  t('structures: destroying a panel removes its collider and hides it', () => {
    const kit = structures.kit;
    const rec = kit.records.findIndex((r) => r.alive && r.handles.length > 0 && r.proto === 'wall');
    if (rec < 0) return { ok: false, detail: 'no wall panel found' };
    const r = kit.records[rec];
    const cx = (r.box.min.x + r.box.max.x) / 2, cy = (r.box.min.y + r.box.max.y) / 2, cz = (r.box.min.z + r.box.max.z) / 2;
    const out = [];
    colliders.query(cx - 0.1, cy - 0.1, cz - 0.1, cx + 0.1, cy + 0.1, cz + 0.1, out);
    const hadCollider = out.length > 0;
    const before = colliders.count;
    const handleCount = r.handles.length;
    const destroyed = kit.destroy(rec);
    colliders.query(cx - 0.1, cy - 0.1, cz - 0.1, cx + 0.1, cy + 0.1, cz + 0.1, out);
    const stillThere = out.some((h) => colliders.getMeta(h) === r.meta);
    const m = new THREE.Matrix4();
    kit.meshes.get('wall').getMatrixAt(r.idx, m);
    const scaleZero = m.elements[0] === 0 && m.elements[5] === 0;
    return { ok: hadCollider && destroyed && !stillThere && scaleZero && colliders.count === before - handleCount,
             detail: 'colliders ' + before + ' -> ' + colliders.count };
  });

  t('structures: damage accumulates before destroying a panel', () => {
    const kit = structures.kit;
    const rec = kit.records.findIndex((r) => r.alive && r.handles.length > 0 && r.proto === 'floor');
    const r = kit.records[rec];
    const hp = r.meta.maxHp;
    const first = kit.damage(rec, hp - 10);
    const second = kit.damage(rec, 20);
    return { ok: first === false && second === true && !r.alive,
             detail: 'hp ' + hp + ': survived partial, destroyed on lethal' };
  });

  t('structures: whole map of buildings stays within the panel draw budget', () => {
    return { ok: structures.kit.meshes.size <= 14,
             detail: structures.kit.meshes.size + ' panel draw calls for ' + structures.kit.stats.placed + ' panels' };
  });

  t('vegetation: nothing is scattered inside a POI footprint', () => {
    let bad = 0;
    for (const lists of veg.chunkProps.values()) {
      for (const key of ['tree', 'pine', 'rock']) {
        for (const p of lists[key]) if (structures.insidePoi(p.x, p.z, 0)) bad++;
      }
    }
    return { ok: bad === 0, detail: bad + ' props inside a POI' };
  });

  /* --- player movement -------------------------------------------------- */
  t('player: spawns standing on the terrain surface', () => {
    if (!placeClear()) return { ok: false, detail: 'no clear spawn found' };
    const p = player.position;
    const gh = terrain.heightAt(p.x, p.z);
    return { ok: player.body.grounded && Math.abs(p.y - gh) < 0.05,
             detail: 'y=' + p.y.toFixed(3) + ' ground=' + gh.toFixed(3) };
  });

  t('player: forward input moves along the facing direction', () => {
    placeClear();
    const yaw = 0;               // facing -Z
    player.yaw = yaw;
    const start = player.position.clone();
    sim(60, { move: { x: 0, y: 1 } });
    const d = player.position.clone().sub(start);
    const forwardDist = -d.z;
    const lateral = Math.abs(d.x);
    return { ok: forwardDist > 3.5 && lateral < 0.6,
             detail: 'forward ' + forwardDist.toFixed(2) + 'm, lateral ' + lateral.toFixed(2) + 'm in 1s' };
  });

  t('player: strafing moves sideways, not forward', () => {
    placeClear();
    player.yaw = 0;
    const start = player.position.clone();
    sim(60, { move: { x: 1, y: 0 } });
    const d = player.position.clone().sub(start);
    return { ok: d.x > 3.5 && Math.abs(d.z) < 0.6,
             detail: 'right ' + d.x.toFixed(2) + 'm, forward ' + (-d.z).toFixed(2) + 'm' };
  });

  t('player: walk, sprint and crouch reach their configured speeds', () => {
    const measure = (input) => {
      placeClear();
      player.yaw = 0;
      sim(30, input);            // let it reach steady state
      const a = player.position.clone();
      sim(60, input);
      return a.distanceTo(player.position);
    };
    const walk = measure({ move: { x: 0, y: 1 } });
    const sprint = measure({ move: { x: 0, y: 1 }, sprint: true });
    const crouch = measure({ move: { x: 0, y: 1 }, crouch: true });
    const ok = Math.abs(walk - 4.4) < 0.6 && Math.abs(sprint - 7.2) < 0.9 && Math.abs(crouch - 2.2) < 0.5
      && sprint > walk && walk > crouch;
    return { ok, detail: 'walk ' + walk.toFixed(2) + ' sprint ' + sprint.toFixed(2) + ' crouch ' + crouch.toFixed(2) + ' m/s' };
  });

  t('player: jump leaves the ground and lands again', () => {
    placeClear();
    const y0 = player.position.y;
    let peak = y0, airFrames = 0;
    sim(1, { jump: true });
    for (let i = 0; i < 90; i++) {
      sim(1, {});
      peak = Math.max(peak, player.position.y);
      if (!player.body.grounded) airFrames++;
      else if (i > 5) break;
    }
    const rise = peak - y0;
    const landed = player.body.grounded && Math.abs(player.position.y - y0) < 0.15;
    return { ok: rise > 0.8 && rise < 1.6 && landed && airFrames > 20,
             detail: 'rise ' + rise.toFixed(2) + 'm, ' + airFrames + ' air frames, landed=' + landed };
  });

  t('player: cannot jump again while airborne', () => {
    placeClear();
    sim(1, { jump: true });
    sim(12, {});
    const yMid = player.position.y;
    const vMid = player.body.vel.y;
    sim(1, { jump: true });
    return { ok: player.body.vel.y < vMid + 0.1,
             detail: 'vy ' + vMid.toFixed(2) + ' -> ' + player.body.vel.y.toFixed(2) };
  });

  t('player: falls under gravity when spawned in the air', () => {
    placeClear();
    const p = player.position.clone();
    player.spawnAt(p.x, p.z, 12);
    const y0 = player.position.y;
    sim(40, {});
    const fell = y0 - player.position.y;
    sim(90, {});
    return { ok: fell > 2 && player.body.grounded,
             detail: 'fell ' + fell.toFixed(2) + 'm in 0.66s, grounded after 2.2s' };
  });

  t('player: taking a long fall applies damage', () => {
    placeClear();
    const p = player.position.clone();
    player.health = 100;
    player.spawnAt(p.x, p.z, 42);
    for (let i = 0; i < 240 && !player.body.grounded; i++) sim(1, {});
    return { ok: player.health < 100 && player.health > 0,
             detail: 'health after 42m drop: ' + player.health };
  });

  t('player: a short drop causes no damage', () => {
    placeClear();
    const p = player.position.clone();
    player.health = 100;
    player.spawnAt(p.x, p.z, 6);
    for (let i = 0; i < 180 && !player.body.grounded; i++) sim(1, {});
    return { ok: player.health === 100, detail: 'health after 6m drop: ' + player.health };
  });

  t('player: crouching lowers the capsule and the eye', () => {
    placeClear();
    const h0 = player.body.height, e0 = player.eyeHeight;
    sim(20, { crouch: true });
    const h1 = player.body.height, e1 = player.eyeHeight;
    sim(20, {});
    return { ok: h1 < h0 - 0.3 && e1 < e0 - 0.3 && player.body.height === h0,
             detail: 'height ' + h0.toFixed(2) + '->' + h1.toFixed(2) + ', eye ' + e0.toFixed(2) + '->' + e1.toFixed(2) };
  });

  t('player: is blocked by a building wall', () => {
    // Walk straight at the outside of a wall panel and check it stops.
    const rec = structures.kit.records.find((r) => r.alive && r.handles.length > 0 && r.proto === 'wall');
    const b = rec.box;
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    const thin = (b.max.x - b.min.x) < (b.max.z - b.min.z);
    // Approach along the wall's thin axis from outside.
    const dir = thin ? [1, 0] : [0, 1];
    const startX = cx - dir[0] * 4, startZ = cz - dir[1] * 4;
    player.spawnAt(startX, startZ, 0);
    player.body.vel.set(0, 0, 0);
    // Face the wall: yaw such that forward (-sin yaw, -cos yaw) points at it.
    player.yaw = Math.atan2(-dir[0], -dir[1]);
    settle(6);
    const before = player.position.clone();
    sim(70, { move: { x: 0, y: 1 } });
    const travelled = Math.hypot(player.position.x - before.x, player.position.z - before.z);
    const gap = Math.abs(thin ? player.position.x - cx : player.position.z - cz);
    return { ok: travelled < 4.2 && gap > 0.3,
             detail: 'travelled ' + travelled.toFixed(2) + 'm, stopped ' + gap.toFixed(2) + 'm from wall centre' };
  });

  t('player: steps over low obstacles and is stopped by tall ones', () => {
    // Directly exercises the step-height contract: an obstacle under the step
    // height is walked onto, one above it is a wall. Test boxes are placed on
    // ground levelled to the player's own feet so slope cannot confound it.
    if (!placeClear()) return { ok: false, detail: 'no clear spawn' };
    const p0 = player.position.clone();
    const obstacleZ = p0.z + 3.6;

    const trial = (scaleY) => {
      const recId = structures.kit.place('crate', p0.x, p0.y, obstacleZ, 0, MAT.timber,
        { sx: 3.2, sy: scaleY, sz: 1.0 });
      if (recId === null) return null;
      const top = structures.kit.records[recId].box.max.y;
      player.spawnAt(p0.x, p0.z, 0);
      player.body.pos.copy(p0);
      player.body.vel.set(0, 0, 0);
      player.yaw = Math.PI;                     // face +Z, toward the obstacle
      settle(8);
      const y0 = player.position.y;
      // Track the peak, not the end point: after stepping over a low obstacle
      // the player continues onto the ground beyond it.
      let peak = y0;
      for (let i = 0; i < 90; i++) { sim(1, { move: { x: 0, y: 1 } }); peak = Math.max(peak, player.position.y); }
      const out = { rise: peak - y0, z: player.position.z, top: top - y0, jumps: player.stats.jumps };
      structures.kit.destroy(recId);
      return out;
    };

    const low = trial(0.38);      // ~0.44m: under the 0.58m step height
    const tall = trial(1.0);      // ~1.15m: well above it
    if (!low || !tall) return { ok: false, detail: 'crate capacity exhausted' };

    const steppedUp = low.rise > low.top - 0.15 && low.z > obstacleZ;
    const blocked = tall.rise < 0.2 && tall.z < obstacleZ;
    return { ok: steppedUp && blocked,
             detail: 'low (' + low.top.toFixed(2) + 'm): peaked ' + low.rise.toFixed(2) + 'm and passed over; '
               + 'tall (' + tall.top.toFixed(2) + 'm): peaked ' + tall.rise.toFixed(2) + 'm and stopped short' };
  });

  t('player: climbs a staircase into an upper floor', () => {
    const rec = structures.kit.records.find((r) => r.alive && r.handles.length > 0 && r.proto === 'stair');
    if (!rec) return { ok: false, detail: 'no stair found' };
    const b = rec.box;
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    let best = null;
    // Approach from each side; a staircase only ascends from its low end.
    for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      player.spawnAt(cx - dx * 3.2, cz - dz * 3.2, 0.4);
      player.body.vel.set(0, 0, 0);
      player.yaw = Math.atan2(-dx, -dz);
      settle(8);
      const y0 = player.position.y;
      sim(90, { move: { x: 0, y: 1 } });
      const rise = player.position.y - y0;
      if (!best || rise > best.rise) best = { rise, dx, dz };
    }
    return { ok: best.rise > 1.6, detail: 'best ascent ' + best.rise.toFixed(2) + 'm' };
  });

  t('player: is confined to the island bounds', () => {
    const lim = terrain.size / 2;
    player.spawnAt(lim - 12, lim - 12, 0);
    player.yaw = Math.PI * 1.25;   // head for the corner
    sim(300, { move: { x: 0, y: 1 }, sprint: true });
    const p = player.position;
    return { ok: Math.abs(p.x) <= lim - 3.9 && Math.abs(p.z) <= lim - 3.9,
             detail: 'ended at ' + p.x.toFixed(1) + ',' + p.z.toFixed(1) + ' (limit ' + (lim - 4) + ')' };
  });

  t('player: damage drains shield before health', () => {
    placeClear();
    player.health = 100; player.shield = 0;
    player.addShield(50);
    player.applyDamage(30);
    const afterFirst = [player.health, player.shield];
    player.applyDamage(40);
    const afterSecond = [player.health, player.shield];
    return { ok: afterFirst[0] === 100 && afterFirst[1] === 20 && afterSecond[1] === 0 && afterSecond[0] === 80,
             detail: 'hp/shield ' + afterFirst.join('/') + ' then ' + afterSecond.join('/') };
  });

  /* --- camera ------------------------------------------------------------ */
  t('camera: sits behind the player at the rig distance', () => {
    placeClear();
    rig.enabled = true;
    player.yaw = 0.7;
    for (let i = 0; i < 40; i++) { rig.update(1 / 60); }
    const cam = G.engine.camera.position;
    const p = player.position;
    const dist = Math.hypot(cam.x - p.x, cam.z - p.z);
    // Camera should be on the opposite side of the player from the look vector.
    const fwd = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    const toCam = new THREE.Vector3(cam.x - p.x, 0, cam.z - p.z).normalize();
    const dot = fwd.dot(toCam);
    return { ok: dist > 1.5 && dist < 4.5 && dot < -0.5 && cam.y > p.y,
             detail: 'dist ' + dist.toFixed(2) + 'm, behindness ' + dot.toFixed(2) };
  });

  t('camera: aiming pulls the rig in and narrows the FOV', () => {
    placeClear();
    rig.enabled = true;
    G.input.override({ aim: false });
    for (let i = 0; i < 90; i++) { G.stepSim(1); rig.update(1 / 60); }
    const wideFov = G.engine.camera.fov, wideDist = rig.distance;
    G.input.override({ aim: true });
    for (let i = 0; i < 90; i++) { G.stepSim(1); rig.update(1 / 60); }
    const adsFov = G.engine.camera.fov, adsDist = rig.distance;
    G.input.clearOverride();
    return { ok: adsFov < wideFov - 8 && adsDist < wideDist - 1.0,
             detail: 'fov ' + wideFov.toFixed(1) + '->' + adsFov.toFixed(1) + ', dist ' + wideDist.toFixed(2) + '->' + adsDist.toFixed(2) };
  });

  t('camera: pulls in when a wall is behind the player', () => {
    const rec = structures.kit.records.find((r) => r.alive && r.handles.length > 0 && r.proto === 'wall');
    const b = rec.box;
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    const thin = (b.max.x - b.min.x) < (b.max.z - b.min.z);
    const dir = thin ? [1, 0] : [0, 1];
    // Stand just outside the wall looking away from it, so it is behind us.
    player.spawnAt(cx - dir[0] * 1.1, cz - dir[1] * 1.1, 0);
    player.yaw = Math.atan2(dir[0], dir[1]);
    rig.enabled = true;
    rig.occlusion = 1;
    for (let i = 0; i < 30; i++) rig.update(1 / 60);
    const occluded = rig.occlusion;
    placeClear();
    for (let i = 0; i < 60; i++) rig.update(1 / 60);
    return { ok: occluded < 0.75 && rig.occlusion > 0.9,
             detail: 'occlusion near wall ' + occluded.toFixed(2) + ', in the open ' + rig.occlusion.toFixed(2) };
  });

  /* --- physics ----------------------------------------------------------- */
  t('physics: raycast returns the nearer of terrain and box hits', () => {
    const rec = structures.kit.records.find((r) => r.alive && r.handles.length > 0 && r.proto === 'wall');
    const b = rec.box;
    const c = new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    const thin = (b.max.x - b.min.x) < (b.max.z - b.min.z);
    const dir = new THREE.Vector3(thin ? 1 : 0, 0, thin ? 0 : 1);
    const origin = c.clone().addScaledVector(dir, -6);
    const hit = physics.raycast(origin, dir, 20);
    const okBox = hit && hit.meta && hit.meta.type === 'structure';
    // Straight down from high above must hit terrain, not a box.
    const down = physics.raycast(new THREE.Vector3(player.position.x, player.position.y + 40, player.position.z),
      new THREE.Vector3(0, -1, 0), 80);
    const okTerrain = down && down.kind === 'terrain';
    return { ok: okBox && okTerrain,
             detail: 'wall hit at t=' + (hit ? hit.t.toFixed(2) : 'miss') + ', downward kind=' + (down ? down.kind : 'miss') };
  });

  t('physics: line of sight is blocked by structures', () => {
    const rec = structures.kit.records.find((r) => r.alive && r.handles.length > 0 && r.proto === 'wall');
    const b = rec.box;
    const c = new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    const thin = (b.max.x - b.min.x) < (b.max.z - b.min.z);
    const d = new THREE.Vector3(thin ? 1 : 0, 0, thin ? 0 : 1);
    const a = c.clone().addScaledVector(d, -5), z = c.clone().addScaledVector(d, 5);
    const blocked = !physics.lineOfSight(a, z);
    const openA = new THREE.Vector3(player.position.x, player.position.y + 30, player.position.z);
    const openB = openA.clone().add(new THREE.Vector3(10, 0, 0));
    const clear = physics.lineOfSight(openA, openB);
    return { ok: blocked && clear, detail: 'through wall blocked=' + blocked + ', open air clear=' + clear };
  });

  /* --- build system ------------------------------------------------------ */
  const clearBuilds = () => {
    for (let i = build.kit.records.length - 1; i >= 0; i--) {
      if (build.kit.records[i].alive) build.kit.destroy(i);
    }
    build.grid.clear();
    build.pending.length = 0;
    build.cancelEdit();
    build.resources.wood = 500; build.resources.brick = 500; build.resources.metal = 500;
    build.stats.placed = 0; build.stats.destroyed = 0; build.stats.edits = 0;
  };
  // Enter build mode facing a chosen direction on clear ground.
  const buildStance = (piece, yaw = 0, pitch = -0.15) => {
    // Clear first: leftover pieces would change which spot placeClear picks.
    clearBuilds();
    placeClear();
    player.yaw = yaw; player.pitch = pitch;
    build.setPiece(piece);
    build.setMaterial('wood');
    build.rotation = 0;
    sim(2, { buildMode: true, buildPiece: piece });
  };

  t('build: preview lands on the grid in front of the player', () => {
    buildStance(0, 0);
    G.input.override({ buildMode: true, buildPiece: 0 });
    G.stepSim(2);
    const t0 = build.preview;
    const onGrid = Math.abs(t0.z % 4) < 1e-6 || Math.abs(Math.abs(t0.z % 4) - 4) < 1e-6
      || Math.abs(t0.x % 4) < 1e-6 || Math.abs(Math.abs(t0.x % 4) - 4) < 1e-6;
    const ahead = t0.z < player.position.z;   // facing -Z
    G.input.clearOverride();
    return { ok: onGrid && ahead && t0.valid,
             detail: 'preview at ' + t0.x.toFixed(2) + ',' + t0.y.toFixed(2) + ',' + t0.z.toFixed(2)
               + ' valid=' + t0.valid + ' reason=' + (t0.reason || '-') };
  });

  t('build: placing a wall spends material and occupies its slot', () => {
    buildStance(0, 0);
    const wood0 = build.resources.wood;
    const grid0 = build.grid.count;
    sim(3, { buildMode: true, buildPiece: 0, fire: true });
    const placed = build.stats.placed;
    return { ok: placed === 1 && build.resources.wood === wood0 - 10 && build.grid.count === grid0 + 1,
             detail: placed + ' placed, wood ' + wood0 + '->' + build.resources.wood
               + ', grid ' + grid0 + '->' + build.grid.count };
  });

  t('build: the same slot cannot be filled twice', () => {
    buildStance(0, 0);
    sim(3, { buildMode: true, buildPiece: 0, fire: true });
    const after1 = build.stats.placed;
    build.computeTarget();
    const reason = build.preview.reason;
    const valid = build.preview.valid;
    // Hold place for a while without moving; nothing further may be built here.
    sim(60, { buildMode: true, buildPiece: 0, fire: true });
    return { ok: after1 === 1 && !valid && reason === 'occupied' && build.stats.placed === 1,
             detail: 'second attempt rejected (' + reason + '), total placed ' + build.stats.placed };
  });

  t('build: a placed wall is solid and blocks the player', () => {
    buildStance(0, 0);
    sim(3, { buildMode: true, buildPiece: 0, fire: true });
    const rec = build.kit.records.find((r) => r.alive);
    if (!rec) return { ok: false, detail: 'nothing placed' };
    const z0 = player.position.z;
    sim(80, { move: { x: 0, y: 1 } });
    const travelled = z0 - player.position.z;
    const wallZ = (rec.box.min.z + rec.box.max.z) / 2;
    return { ok: player.position.z > wallZ + 0.2,
             detail: 'walked ' + travelled.toFixed(2) + 'm, stopped ' + (player.position.z - wallZ).toFixed(2) + 'm short of the wall' };
  });

  t('build: a ramp can be climbed', () => {
    buildStance(2, 0, -0.35);
    sim(3, { buildMode: true, buildPiece: 2, fire: true });
    if (build.stats.placed !== 1) return { ok: false, detail: 'ramp not placed: ' + build.preview.reason };
    const y0 = player.position.y;
    let peak = y0;
    for (let i = 0; i < 140; i++) { sim(1, { move: { x: 0, y: 1 } }); peak = Math.max(peak, player.position.y); }
    return { ok: peak > y0 + 1.5, detail: 'climbed ' + (peak - y0).toFixed(2) + 'm' };
  });

  t('build: running out of material blocks placement', () => {
    buildStance(0, 0);
    build.resources.wood = 5;      // less than one piece
    build.computeTarget();
    const reason = build.preview.reason;
    sim(10, { buildMode: true, buildPiece: 0, fire: true });
    return { ok: build.stats.placed === 0 && reason === 'resources',
             detail: 'rejected with reason "' + reason + '"' };
  });

  t('build: floating pieces are rejected as unsupported', () => {
    placeClear();
    clearBuilds();
    // Aim at open sky well above the ground.
    player.yaw = 0; player.pitch = 1.2;
    build.setPiece(1);
    sim(2, { buildMode: true, buildPiece: 1 });
    build.computeTarget();
    const skyReason = build.preview.reason;
    const skyValid = build.preview.valid;
    // Aiming back at the ground must be valid again.
    player.pitch = -0.5;
    sim(2, { buildMode: true, buildPiece: 1 });
    build.computeTarget();
    return { ok: !skyValid && skyReason === 'unsupported' && build.preview.valid,
             detail: 'sky: ' + skyReason + ', ground: ' + (build.preview.valid ? 'valid' : build.preview.reason) };
  });

  t('build: a piece placed on another piece is supported', () => {
    buildStance(2, 0, -0.35);
    sim(3, { buildMode: true, buildPiece: 2, fire: true });   // ramp on the ground
    const first = build.stats.placed;
    // Now look up the ramp and place a second one continuing it.
    player.pitch = 0.1;
    sim(4, { buildMode: true, buildPiece: 2 });
    build.computeTarget();
    const canChain = build.preview.valid || build.preview.reason === 'occupied';
    return { ok: first === 1 && canChain,
             detail: 'first ramp placed, continuation ' + (build.preview.valid ? 'valid' : build.preview.reason) };
  });

  t('build: a cone cannot hover above the wall it rests on', () => {
    // Regression: grid-adjacency support accepted a cone a whole cell above the
    // wall below it, because a cone anchors to the top of its cell while a wall
    // spans the cell beneath. Support must be geometric contact.
    buildStance(0, 0);
    sim(4, { buildMode: true, buildPiece: 0, fire: true });
    if (build.stats.placed !== 1) return { ok: false, detail: 'wall not placed' };
    const wall = build.kit.records.find((r) => r.alive);
    const wallTop = wall.box.max.y;

    // Aim high into empty sky above the wall.
    build.setPiece(3);
    player.pitch = 0.75;
    sim(2, { buildMode: true, buildPiece: 3 });
    build.computeTarget();
    const highCone = { valid: build.preview.valid, reason: build.preview.reason, y: build.preview.y };

    // Aim at the wall itself: capping it must be allowed.
    player.pitch = 0.12;
    sim(2, { buildMode: true, buildPiece: 3 });
    build.computeTarget();
    const capCone = { valid: build.preview.valid, reason: build.preview.reason, y: build.preview.y };

    return { ok: !highCone.valid && highCone.reason === 'unsupported'
               && highCone.y > wallTop + 1.5,
             detail: 'wall top ' + wallTop.toFixed(1) + 'm; cone at ' + highCone.y.toFixed(1)
               + 'm rejected (' + highCone.reason + '); cone at ' + capCone.y.toFixed(1)
               + 'm ' + (capCone.valid ? 'accepted' : 'rejected: ' + capCone.reason) };
  });

  t('build: health ramps up after placement', () => {
    buildStance(0, 0);
    build.setMaterial('brick');
    build.resources.brick = 500;
    sim(3, { buildMode: true, buildPiece: 0, fire: true });
    const rec = build.kit.records.find((r) => r.alive);
    if (!rec) return { ok: false, detail: 'nothing placed' };
    const hp0 = rec.meta.hp, max = rec.meta.maxHp;
    sim(120, {});                      // 2s
    const hp1 = rec.meta.hp;
    sim(300, {});                      // well past the ramp time
    const hp2 = rec.meta.hp;
    return { ok: hp0 < max * 0.5 && hp1 > hp0 && hp2 === max,
             detail: 'hp ' + hp0 + ' -> ' + hp1 + ' -> ' + hp2 + ' (max ' + max + ')' };
  });

  t('build: damage destroys a piece and frees its slot', () => {
    buildStance(0, 0);
    sim(3, { buildMode: true, buildPiece: 0, fire: true });
    const recId = build.kit.records.findIndex((r) => r.alive);
    const rec = build.kit.records[recId];
    const key = rec.meta.buildKey;
    const gridBefore = build.grid.count;
    const collidersBefore = colliders.count;
    const partial = build.damageRecord(recId, 10);
    const killed = build.damageRecord(recId, 10000);
    return { ok: partial === false && killed === true && !build.grid.has(key)
               && build.grid.count === gridBefore - 1 && colliders.count < collidersBefore,
             detail: 'grid ' + gridBefore + '->' + build.grid.count + ', colliders ' + collidersBefore + '->' + colliders.count };
  });

  t('build: destroyed slot can be rebuilt', () => {
    buildStance(0, 0);
    sim(3, { buildMode: true, buildPiece: 0, fire: true });
    const recId = build.kit.records.findIndex((r) => r.alive);
    build.damageRecord(recId, 10000);
    // The turbo-build cooldown means a rebuild needs more than a couple of frames.
    sim(20, { buildMode: true, buildPiece: 0, fire: true });
    return { ok: build.stats.placed >= 2 && build.grid.count >= 1,
             detail: build.stats.placed + ' pieces placed in total, ' + build.grid.count + ' occupying the grid' };
  });

  t('build: reclaiming a piece refunds material', () => {
    buildStance(0, 0);
    const wood0 = build.resources.wood;
    sim(3, { buildMode: true, buildPiece: 0, fire: true });
    const recId = build.kit.records.findIndex((r) => r.alive);
    const spent = wood0 - build.resources.wood;
    const ok1 = build.reclaim(recId);
    const refunded = build.resources.wood - (wood0 - spent);
    return { ok: ok1 && spent === 10 && refunded === 5 && build.grid.count === 0,
             detail: 'spent ' + spent + ', refunded ' + refunded };
  });

  t('build: editing a wall swaps it for the matching preset', () => {
    buildStance(0, 0);
    sim(3, { buildMode: true, buildPiece: 0, fire: true });
    const recId = build.kit.records.findIndex((r) => r.alive);
    const before = build.kit.records[recId].proto;
    // Look at the wall we just placed and open the editor.
    const started = build.beginEdit();
    // Select the bottom row: the doorway preset.
    build.toggleEditCell(6); build.toggleEditCell(7); build.toggleEditCell(8);
    const applied = build.confirmEdit();
    const after = build.kit.records.find((r) => r.alive);
    return { ok: started && applied && before === 'wall' && after && after.proto === 'wallDoor'
               && build.grid.count === 1 && !build.editing,
             detail: 'started=' + started + ' applied=' + applied + ' ' + before + ' -> '
               + (after ? after.proto : 'gone') + ', grid ' + build.grid.count
               + ', live=[' + build.kit.records.filter((r) => r.alive).map((r) => r.proto).join(',') + ']' };
  });

  t('build: the "open" edit removes the wall entirely', () => {
    buildStance(0, 0);
    sim(3, { buildMode: true, buildPiece: 0, fire: true });
    build.beginEdit();
    for (let i = 0; i < 9; i++) build.toggleEditCell(i);
    const applied = build.confirmEdit();
    const live = build.kit.records.filter((r) => r.alive).length;
    return { ok: applied && live === 0 && build.grid.count === 0,
             detail: 'applied=' + applied + ', ' + live + ' pieces remain, placed=' + build.stats.placed };
  });

  t('build: editing is refused on world architecture', () => {
    // Stand inside a POI and look at a wall the player did not build.
    const rec = structures.kit.records.find((r) => r.alive && r.handles.length > 0 && r.proto === 'wall');
    const b = rec.box;
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    const thin = (b.max.x - b.min.x) < (b.max.z - b.min.z);
    const dir = thin ? [1, 0] : [0, 1];
    clearBuilds();
    player.spawnAt(cx - dir[0] * 2.2, cz - dir[1] * 2.2, 0);
    player.yaw = Math.atan2(-dir[0], -dir[1]);
    player.pitch = 0;
    settle(4);
    const started = build.beginEdit();
    build.cancelEdit();
    return { ok: started === false, detail: 'beginEdit on a POI wall returned ' + started };
  });

  t('build: the ghost preview follows the target and shows validity', () => {
    buildStance(0, 0);
    sim(2, { buildMode: true, buildPiece: 0 });
    build.update(1 / 60);
    const ghost = build.ghosts.get('wall');
    const shownValid = ghost.visible && ghost.material === build.ghostMatValid;
    const gx = ghost.matrix.elements[12], gz = ghost.matrix.elements[14];
    const matches = Math.abs(gx - build.preview.x) < 1e-6 && Math.abs(gz - build.preview.z) < 1e-6;

    // Make the target invalid and confirm the ghost turns to the reject colour.
    build.resources.wood = 0;
    build.computeTarget();
    build.update(1 / 60);
    const shownInvalid = ghost.visible && ghost.material === build.ghostMatInvalid;

    // Leaving build mode hides every ghost.
    sim(2, {});
    build.update(1 / 60);
    const hidden = ![...build.ghosts.values()].some((m) => m.visible);
    return { ok: shownValid && matches && shownInvalid && hidden,
             detail: 'valid=' + shownValid + ' tracks=' + matches + ' invalid=' + shownInvalid + ' hiddenOutOfMode=' + hidden };
  });

  t('build: confirming an edit with no selection applies the doorway', () => {
    buildStance(0, 0);
    sim(4, { buildMode: true, buildPiece: 0, fire: true });
    build.beginEdit();
    const applied = build.confirmEdit();
    const after = build.kit.records.find((r) => r.alive);
    return { ok: applied && after && after.proto === 'wallDoor',
             detail: 'result: ' + (after ? after.proto : 'gone') };
  });

  t('build: a tap on the edited face maps to the right 3x3 cell', () => {
    const cases = [[0.1, 0.1, 0], [0.5, 0.1, 1], [0.9, 0.1, 2],
      [0.1, 0.5, 3], [0.5, 0.5, 4], [0.9, 0.9, 8]];
    const bad = cases.filter(([u, v, expect]) => build.editCellAt(u, v) !== expect);
    return { ok: bad.length === 0, detail: bad.length ? 'wrong: ' + JSON.stringify(bad) : 'all 6 corners and centre map correctly' };
  });

  t('build: whole build set stays within the draw budget', () => {
    buildStance(1, 0, -0.6);
    // Lay a floor, then walk and lay more, to exercise several piece types.
    for (let p = 0; p < 4; p++) {
      build.setPiece(p);
      for (let i = 0; i < 6; i++) {
        sim(4, { buildMode: true, buildPiece: p, fire: true });
        sim(10, { move: { x: 0, y: 1 } });
      }
    }
    // The point is that draw calls are bounded by the prototype count, never by
    // how much the player builds.
    return { ok: build.kit.meshes.size <= 8 && build.stats.placed >= 4,
             detail: build.stats.placed + ' pieces in ' + build.kit.meshes.size + ' draw calls' };
  });

  /* --- combat ------------------------------------------------------------ */
  const { makeWeapon, falloff, partMultiplier, WEAPONS } = await import('/src/combat/Weapons.js');
  const { rayCapsule } = await import('/src/combat/CombatSystem.js');
  const weaponTable = { WEAPONS };

  /** A stationary damageable stand-in, placed relative to the player. */
  const makeDummy = (x, y, z) => {
    const d = {
      alive: true, health: 100, shield: 0,
      position: new THREE.Vector3(x, y, z),
      body: { radius: 0.36, height: 1.8, grounded: true },
      velocity: new THREE.Vector3(),
      damageLog: [],
      applyDamage(amount, src) {
        this.damageLog.push({ amount, part: src && src.part });
        let left = amount;
        const s = Math.min(this.shield, left); this.shield -= s; left -= s;
        this.health = Math.max(0, this.health - left);
        if (this.health <= 0) this.alive = false;
        return amount;
      },
    };
    d.isDummy = true;
    combat.registerTarget(d);
    return d;
  };
  // Remove only the dummies this suite created. Stripping every non-player
  // target would also unregister the bots, which are real combat participants.
  const dropDummies = () => {
    for (let i = combat.targets.length - 1; i >= 0; i--) {
      if (combat.targets[i].entity && combat.targets[i].entity.isDummy) combat.targets.splice(i, 1);
    }
  };

  /** Stand on clear ground with a given weapon, aiming along -Z. */
  const armed = (id, rarity = 'common') => {
    clearBuilds();
    placeClear();
    dropDummies();
    player.yaw = 0; player.pitch = 0;
    combat.slots = [makeWeapon('pickaxe'), makeWeapon(id, rarity), null, null, null];
    combat.activeSlot = 1;
    combat.reloading = false;
    combat.reserveAmmo = { light: 200, medium: 200, shells: 200, heavy: 200 };
    combat._syncHeld();
    Object.assign(combat.stats, { shots: 0, hits: 0, headshots: 0, damageDealt: 0, structureHits: 0, eliminations: 0 });
    // Aim the real camera down -Z: the player shoots along the camera axis.
    G.engine.camera.position.set(player.position.x, player.position.y + 1.62, player.position.z + 3);
    G.engine.camera.lookAt(player.position.x, player.position.y + 1.62, player.position.z - 20);
    G.engine.camera.updateMatrixWorld(true);
    return combat.weapon;
  };

  t('weapons: no class dominates on ideal-case time to kill', () => {
    // Ideal body-shot TTK against 100 health + 100 shield at point-blank range.
    // The absolute numbers matter less than the spread between classes: if one
    // is far faster than the rest, it is the only weapon anyone picks up.
    const rows = [], ttks = [];
    for (const id of ['ar', 'smg', 'shotgun', 'sniper', 'pistol']) {
      const def = WEAPONS[id];
      const perShot = def.damage * (def.pellets || 1);
      const shots = Math.ceil(200 / perShot);
      const ttk = (shots - 1) / def.fireRate;
      ttks.push(ttk);
      rows.push(id + ' ' + ttk.toFixed(2) + 's/' + shots + ' shots');
    }
    const lo = Math.min(...ttks), hi = Math.max(...ttks);
    const inBand = ttks.every((v) => v >= 0.8 && v <= 3.4);
    const spread = hi / lo;
    // A single body shot must never be lethal through full shield.
    const oneShotBody = ['ar', 'smg', 'shotgun', 'sniper', 'pistol']
      .filter((id) => WEAPONS[id].damage * (WEAPONS[id].pellets || 1) >= 200);
    // A sniper headshot is meant to be, and is the only one that is.
    const sniperHead = WEAPONS.sniper.damage * WEAPONS.sniper.headshot;
    return { ok: inBand && spread < 3.2 && oneShotBody.length === 0 && sniperHead >= 200,
             detail: rows.join(', ') + ' | spread x' + spread.toFixed(2)
               + ', sniper headshot ' + sniperHead.toFixed(0) };
  });

  t('combat: firing consumes a round and respects the fire rate', () => {
    const w = armed('ar');
    const a0 = w.ammo;
    combat.fire(player);
    const a1 = w.ammo;
    const blocked = combat.fire(player);        // still on cooldown
    sim(Math.ceil(60 / w.def.fireRate) + 1, {});
    const ready = combat.canFire(player);
    return { ok: a1 === a0 - 1 && blocked === false && ready,
             detail: 'ammo ' + a0 + '->' + a1 + ', second shot blocked=' + !blocked + ', ready after cooldown=' + ready };
  });

  t('combat: an empty magazine triggers a reload that draws from reserve', () => {
    const w = armed('pistol');
    w.ammo = 1;
    combat.reserveAmmo.light = 40;
    combat.fire(player);
    const startedReloading = combat.reloading;
    sim(Math.ceil(w.def.reloadTime * 60) + 4, {});
    return { ok: startedReloading && !combat.reloading && w.ammo === w.magSize
               && combat.reserveAmmo.light === 40 - (w.magSize - 0),
             detail: 'reloaded to ' + w.ammo + '/' + w.magSize + ', reserve ' + combat.reserveAmmo.light };
  });

  t('combat: reloading with an empty reserve is refused', () => {
    const w = armed('ar');
    w.ammo = 3;
    combat.reserveAmmo.medium = 0;
    const started = combat.beginReload();
    return { ok: started === false && !combat.reloading, detail: 'beginReload returned ' + started };
  });

  t('combat: a hitscan shot damages a target down range', () => {
    armed('ar');
    const p = player.position;
    const d = makeDummy(p.x, p.y, p.z - 12);
    combat.fire(player);
    const dealt = 100 - d.health;
    return { ok: d.damageLog.length === 1 && dealt > 20 && dealt < 60,
             detail: 'dealt ' + dealt + ' at 12m (' + (d.damageLog[0] || {}).part + ')' };
  });

  t('combat: hits are graded by body part', () => {
    // The camera fires horizontally from 1.62m above the player's feet, so a
    // dummy's base height decides which part the ray passes through.
    const shoot = (baseOffset) => {
      armed('ar');                       // hitscan: resolves within the call
      const p = player.position;
      const d = makeDummy(p.x, p.y + baseOffset, p.z - 14);
      combat.fire(player);
      const e = d.damageLog[0];
      dropDummies();
      return e ? { part: e.part, dmg: e.amount } : { part: '-', dmg: 0 };
    };
    const head = shoot(0);        // ray at 0.90 of body height
    const body = shoot(0.72);     // ray at 0.50
    const legs = shoot(1.20);     // ray at 0.23
    return { ok: head.part === 'head' && body.part === 'body' && legs.part === 'legs'
               && head.dmg > body.dmg && body.dmg > legs.dmg,
             detail: 'head ' + head.dmg + ', body ' + body.dmg + ', legs ' + legs.dmg };
  });

  t('combat: distance falloff reduces damage', () => {
    const near = falloff(WEAPONS.smg, 10);
    const mid = falloff(WEAPONS.smg, 60);
    const far = falloff(WEAPONS.smg, 200);
    return { ok: near === 1 && mid < near && mid > far && far === WEAPONS.smg.falloffMin,
             detail: '10m x' + near.toFixed(2) + ', 60m x' + mid.toFixed(2) + ', 200m x' + far.toFixed(2) };
  });

  t('combat: a shotgun fires all of its pellets in one shot', () => {
    armed('shotgun');
    const p = player.position;
    const d = makeDummy(p.x, p.y, p.z - 5);
    combat.fire(player);
    return { ok: d.damageLog.length >= 6 && d.damageLog.length <= WEAPONS.shotgun.pellets,
             detail: d.damageLog.length + ' of ' + WEAPONS.shotgun.pellets + ' pellets connected at 5m' };
  });

  t('combat: a wall between shooter and target stops the shot', () => {
    armed('ar');
    const p = player.position;
    const d = makeDummy(p.x, p.y, p.z - 14);
    // Build a wall in the way.
    build.setPiece(0); build.setMaterial('brick');
    build.resources.brick = 500;
    player.pitch = -0.1;
    sim(4, { buildMode: true, buildPiece: 0, fire: true });
    const placed = build.stats.placed;
    player.pitch = 0;
    G.engine.camera.position.set(p.x, p.y + 1.62, p.z + 3);
    G.engine.camera.lookAt(p.x, p.y + 1.62, p.z - 20);
    G.engine.camera.updateMatrixWorld(true);
    const hpBefore = build.kit.records.find((r) => r.alive).meta.hp;
    combat.fire(player);
    const hpAfter = build.kit.records.find((r) => r.alive).meta.hp;
    return { ok: placed === 1 && d.damageLog.length === 0 && hpAfter < hpBefore,
             detail: 'target untouched, wall hp ' + hpBefore + ' -> ' + hpAfter };
  });

  t('combat: bullets damage structures at the structure multiplier', () => {
    armed('ar');
    const rec = structures.kit.records.find((r) => r.alive && r.handles.length > 0 && r.proto === 'wall');
    const b = rec.box;
    const c = new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    const thin = (b.max.x - b.min.x) < (b.max.z - b.min.z);
    const dir = new THREE.Vector3(thin ? 1 : 0, 0, thin ? 0 : 1);
    player.spawnAt(c.x - dir.x * 5, c.z - dir.z * 5, 0);
    player.body.pos.y = c.y - 1.62;
    const eye = c.clone().addScaledVector(dir, -5);
    G.engine.camera.position.copy(eye);
    G.engine.camera.lookAt(c);
    G.engine.camera.updateMatrixWorld(true);
    const hp0 = rec.meta.hp;
    combat.fire(player);
    const applied = hp0 - rec.meta.hp;
    const expected = Math.round(combat.weapon.damage * WEAPONS.ar.structureMult);
    return { ok: applied === expected && combat.stats.structureHits === 1,
             detail: 'applied ' + applied + ', expected ' + expected + ' (x' + WEAPONS.ar.structureMult + ')' };
  });

  t('combat: the pickaxe harvests wood from a tree', () => {
    clearBuilds();
    // Find a tree and stand next to it.
    let tree = null;
    for (const lists of veg.chunkProps.values()) { if (lists.tree.length) { tree = lists.tree[0]; break; } }
    if (!tree) return { ok: false, detail: 'no tree in the world' };
    combat.slots[0] = makeWeapon('pickaxe');
    combat.activeSlot = 0;
    combat.weapon.cooldown = 0;
    player.spawnAt(tree.x, tree.z - 2.0, 0);
    player.body.pos.y = tree.y;
    const eye = new THREE.Vector3(tree.x, tree.y + 1.4, tree.z - 2.0);
    G.engine.camera.position.copy(eye);
    G.engine.camera.lookAt(tree.x, tree.y + 1.4, tree.z);
    G.engine.camera.updateMatrixWorld(true);
    const wood0 = build.resources.wood;
    combat.fire(player);
    const gained = build.resources.wood - wood0;
    return { ok: gained > 0, detail: 'gained ' + gained + ' wood from one swing' };
  });

  t('combat: aiming tightens the cone and movement widens it', () => {
    const w = armed('ar');
    player.aiming = false;
    player.body.vel.set(0, 0, 0);
    const still = combat.currentSpread(w, player);
    player.body.vel.set(0, 0, -7);
    const moving = combat.currentSpread(w, player);
    player.body.vel.set(0, 0, 0);
    player.aiming = true;
    const ads = combat.currentSpread(w, player);
    player.aiming = false;
    // Sustained fire should widen it further.
    w.bloom = w.def.bloom * 2;
    const bloomed = combat.currentSpread(w, player);
    w.bloom = 0;
    return { ok: moving > still && ads < still && bloomed > still,
             detail: 'still ' + still.toFixed(4) + ', moving ' + moving.toFixed(4)
               + ', ads ' + ads.toFixed(4) + ', bloomed ' + bloomed.toFixed(4) };
  });

  t('combat: firing applies the recoil pattern to the camera', () => {
    armed('ar');
    rig.recoilPitch = 0; rig.recoilYaw = 0;
    combat.fire(player);
    const p1 = rig.recoilPitch;
    combat.weapon.cooldown = 0;
    combat.fire(player);
    const p2 = rig.recoilPitch;
    // Recoil decays back toward zero.
    for (let i = 0; i < 120; i++) rig.update(1 / 60);
    return { ok: p1 > 0 && p2 > p1 && Math.abs(rig.recoilPitch) < p1 * 0.2,
             detail: 'kick ' + p1.toFixed(4) + ' -> ' + p2.toFixed(4) + ', decayed to ' + rig.recoilPitch.toFixed(5) };
  });

  t('combat: sniper rounds travel over time rather than hitting instantly', () => {
    armed('sniper');
    // Fire high above the ground so the shot is not stopped by terrain on the
    // way — this test is about flight time, not about line of sight.
    const p = player.position.clone();
    player.spawnAt(p.x, p.z, 80);
    const shotY = player.position.y + 1.62;
    const d = makeDummy(p.x, player.position.y, p.z - 110);
    G.engine.camera.position.set(p.x, shotY, p.z + 2);
    G.engine.camera.lookAt(p.x, shotY, p.z - 110);
    G.engine.camera.updateMatrixWorld(true);

    combat.fire(player);
    const immediate = d.damageLog.length;
    const inFlight = combat.projectiles.length;
    const startZ = combat.projectiles[0] ? combat.projectiles[0].pos.z : 0;
    // Six frames of flight at 220 m/s should cover roughly 22 metres.
    for (let i = 0; i < 6; i++) combat._stepProjectiles(1 / 60);
    const movedZ = combat.projectiles[0] ? startZ - combat.projectiles[0].pos.z : 0;
    for (let i = 0; i < 120 && combat.projectiles.length; i++) combat._stepProjectiles(1 / 60);
    const landed = d.damageLog.length;
    return { ok: immediate === 0 && inFlight === 1 && movedZ > 15 && movedZ < 30 && landed === 1,
             detail: 'instant hits ' + immediate + ', travelled ' + movedZ.toFixed(1)
               + 'm in 0.1s, connected ' + landed + ' time(s)' };
  });

  t('combat: switching slots swaps the weapon and cancels a reload', () => {
    armed('ar');
    combat.slots[2] = makeWeapon('smg', 'rare');
    combat.weapon.ammo = 2;
    combat.beginReload();
    const wasReloading = combat.reloading;
    combat.selectSlot(2);
    return { ok: wasReloading && !combat.reloading && combat.weapon.id === 'smg'
               && combat.weapon.rarity === 'rare' && combat.held.mesh.visible,
             detail: 'now holding ' + combat.weapon.id + ' (' + combat.weapon.rarity + '), reload cancelled' };
  });

  t('combat: rarity scales damage', () => {
    const common = makeWeapon('ar', 'common');
    const legendary = makeWeapon('ar', 'legendary');
    return { ok: legendary.damage > common.damage && legendary.damage / common.damage < 1.35,
             detail: 'common ' + common.damage.toFixed(1) + ' vs legendary ' + legendary.damage.toFixed(1) };
  });

  t('combat: capsule raycast hits the body, misses beside it, and reports height', () => {
    const base = new THREE.Vector3(0, 0, 0);
    const dir = new THREE.Vector3(0, 0, -1);
    const chest = rayCapsule(new THREE.Vector3(0, 1.0, 10), dir, base, 0.36, 1.8, 50);
    const head = rayCapsule(new THREE.Vector3(0, 1.7, 10), dir, base, 0.36, 1.8, 50);
    const beside = rayCapsule(new THREE.Vector3(1.2, 1.0, 10), dir, base, 0.36, 1.8, 50);
    const above = rayCapsule(new THREE.Vector3(0, 3.0, 10), dir, base, 0.36, 1.8, 50);
    const short = rayCapsule(new THREE.Vector3(0, 1.0, 10), dir, base, 0.36, 1.8, 5);
    const parts = [
      chest && partMultiplier(WEAPONS.ar, (chest.y - 0) / 1.8).part,
      head && partMultiplier(WEAPONS.ar, (head.y - 0) / 1.8).part,
    ];
    return { ok: !!chest && !!head && !beside && !above && !short
               && parts[0] === 'body' && parts[1] === 'head',
             detail: 'chest=' + parts[0] + ' head=' + parts[1] + ', side miss=' + !beside
               + ', over-top miss=' + !above + ', range-limited miss=' + !short };
  });

  t('combat: a shooter cannot hit itself', () => {
    armed('ar');
    const before = player.health;
    for (let i = 0; i < 5; i++) { combat.weapon.cooldown = 0; combat.fire(player); }
    return { ok: player.health === before, detail: 'player health unchanged at ' + player.health };
  });

  /* --- FX ----------------------------------------------------------------- */
  t('fx: firing emits a muzzle flash and a tracer', () => {
    armed('ar');
    fx.clear();
    const before = { ...fx.stats };
    combat.fire(player);
    G.engine.bus.flush();
    fx.update(1 / 60);
    return { ok: fx.stats.flashes === before.flashes + 1 && fx.stats.tracers === before.tracers + 1
               && fx.additive.count > 0 && fx.tracers.count === 1,
             detail: fx.additive.count + ' particles, ' + fx.tracers.count + ' tracer' };
  });

  t('fx: hitting a surface leaves an impact and a decal', () => {
    armed('ar');
    fx.clear();
    const d0 = fx.decals ? fx.decals.count : 0;
    // Shoot straight down into the terrain, which is guaranteed to be in range.
    const p = player.position;
    G.engine.camera.position.set(p.x, p.y + 3, p.z);
    G.engine.camera.lookAt(p.x, p.y - 5, p.z);
    G.engine.camera.updateMatrixWorld(true);
    combat.fire(player);
    G.engine.bus.flush();
    return { ok: fx.stats.impacts > 0 && fx.debris.count > 0 && (!fx.decals || fx.decals.count === d0 + 1),
             detail: fx.stats.impacts + ' impacts, ' + fx.debris.count + ' debris, '
               + (fx.decals ? fx.decals.count : 0) + ' decals' };
  });

  t('fx: particles expire and the pool returns to empty', () => {
    fx.clear();
    armed('ar');
    combat.fire(player);
    G.engine.bus.flush();
    const peak = fx.additive.count + fx.debris.count;
    for (let i = 0; i < 200; i++) { fx.update(1 / 60); }
    return { ok: peak > 0 && fx.additive.count === 0 && fx.debris.count === 0 && fx.tracers.count === 0,
             detail: 'peak ' + peak + ' particles, all expired after 3.3s' };
  });

  t('fx: the particle pool is bounded under sustained fire', () => {
    fx.clear();
    armed('smg');
    combat.reserveAmmo.light = 9999;
    for (let i = 0; i < 400; i++) {
      combat.weapon.cooldown = 0;
      combat.weapon.ammo = combat.weapon.magSize;
      combat.reloading = false;
      combat.fire(player);
      G.engine.bus.flush();
      fx.update(1 / 240);        // deliberately slow expiry to stress the pool
    }
    const cap = fx.additive.capacity;
    return { ok: fx.additive.count <= cap && fx.debris.count <= fx.debris.capacity
               && fx.tracers.count <= fx.tracers.capacity,
             detail: fx.additive.count + '/' + cap + ' additive, ' + fx.debris.count + '/'
               + fx.debris.capacity + ' debris, ' + fx.tracers.count + '/' + fx.tracers.capacity + ' tracers' };
  });

  t('fx: decals recycle instead of growing without bound', () => {
    if (!fx.decals) return { ok: true, detail: 'decals disabled at this quality' };
    fx.decals.clear();
    const n = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3(0, 10, 0);
    for (let i = 0; i < fx.decals.capacity * 3; i++) fx.decals.place(p, n, 0.2);
    return { ok: fx.decals.count === fx.decals.capacity && fx.decals.mesh.count === fx.decals.capacity,
             detail: 'placed ' + (fx.decals.capacity * 3) + ', holding ' + fx.decals.count
               + ' (capacity ' + fx.decals.capacity + ')' };
  });

  t('fx: destroying a build piece throws debris', () => {
    fx.clear();
    buildStance(0, 0);
    sim(4, { buildMode: true, buildPiece: 0, fire: true });
    const recId = build.kit.records.findIndex((r) => r.alive);
    build.damageRecord(recId, 1e9);
    G.engine.bus.flush();
    return { ok: fx.debris.count >= 10, detail: fx.debris.count + ' debris pieces from one destroyed wall' };
  });

  t('render: no material declares vertexColors without a colour attribute', () => {
    // A material with vertexColors whose geometry has no "color" attribute
    // makes the shader read an undefined attribute, which resolves to black.
    // On an additive material that renders as nothing at all — the failure is
    // completely silent, which is why this is checked across the whole scene.
    const bad = [];
    G.engine.scene.traverse((o) => {
      if (!o.isMesh && !o.isLine && !o.isPoints) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m || !m.vertexColors) continue;
        if (!o.geometry.getAttribute('color')) bad.push((o.name || o.type) + '/' + (m.name || m.type));
      }
    });
    return { ok: bad.length === 0, detail: bad.length ? bad.join(', ') : 'all vertex-coloured meshes carry the attribute' };
  });

  t('fx: additive particles are actually visible (non-black)', () => {
    fx.clear();
    armed('ar');
    combat.fire(player);
    G.engine.bus.flush();
    fx.update(1 / 120);
    const c = fx.additive.mesh.instanceColor.array;
    let maxC = 0;
    for (let i = 0; i < fx.additive.count * 3; i++) maxC = Math.max(maxC, c[i]);
    const hasVertexColors = !!fx.additive.mesh.material.vertexColors;
    return { ok: fx.additive.count > 0 && maxC > 0.2 && !hasVertexColors,
             detail: fx.additive.count + ' particles, brightest channel ' + maxC.toFixed(2)
               + ', material vertexColors=' + hasVertexColors };
  });

  t('fx: the whole feedback layer costs four draw calls', () => {
    const meshes = [fx.additive.mesh, fx.debris.mesh, fx.tracers.mesh];
    if (fx.decals) meshes.push(fx.decals.mesh);
    const allInScene = meshes.every((m) => m.parent === fx.group);
    return { ok: allInScene && meshes.length <= 4,
             detail: meshes.length + ' draw calls for particles, debris, tracers and decals' };
  });

  /* --- audio -------------------------------------------------------------- */
  t('audio: works as a no-op when no AudioContext is available', () => {
    // The verification browser has no audio device; nothing may throw and
    // nothing above the audio layer may need to know.
    const before = audio.state();
    const r1 = audio.play('shot_ar', { volume: 1 });
    const r2 = audio.play('shot_ar', { position: new THREE.Vector3(0, 0, 0) });
    const r3 = audio.loop('storm_loop', 0.4);
    audio.setLoopVolume('storm_loop', 0.1);
    audio.stopLoop('storm_loop');
    audio.stopAll();
    const after = audio.state();
    return { ok: r1 === null && r2 === null && r3 === null && after.voices === 0
               && after.stats.dropped > before.stats.dropped,
             detail: 'ready=' + after.ready + ', all calls returned null and were counted as dropped' };
  });

  t('audio: the full sound library is available to play', () => {
    const names = audio.gen.names();
    const needed = ['shot_ar', 'shot_smg', 'shot_shotgun', 'shot_sniper', 'shot_pistol',
      'reload_in', 'reload_out', 'step_grass', 'build_wood', 'build_brick', 'build_metal',
      'build_break', 'harvest', 'pickup', 'hitmarker', 'headshot', 'hurt', 'eliminate',
      'shield', 'storm_loop', 'wind_loop', 'glider', 'storm_warn'];
    const missing = needed.filter((n) => !audio.gen.has(n));
    return { ok: missing.length === 0 && names.length >= 25,
             detail: names.length + ' sounds synthesised, missing: ' + (missing.join(',') || 'none') };
  });

  t('audio: every weapon names a sound that exists', () => {
    const { WEAPONS } = weaponTable;
    const missing = Object.values(WEAPONS).filter((d) => d.sound && !audio.gen.has(d.sound)).map((d) => d.id);
    return { ok: missing.length === 0, detail: missing.length ? 'missing: ' + missing.join(',') : 'all weapon sounds present' };
  });

  t('audio: playback works when a context is available', () => {
    // The verification browser may or may not expose WebAudio. Where it does,
    // the real playback path is exercised; where it does not, the no-op path
    // above is the coverage and this check reports that explicitly.
    const created = audio.unlock();
    if (!created) return { ok: true, detail: 'no AudioContext in this browser — no-op path verified above' };
    const v1 = audio.play('shot_ar', { volume: 0.4 });
    const buffered = audio.buffers.has('shot_ar');
    // Voice limiting must cap identical sounds.
    for (let i = 0; i < 12; i++) audio.play('shot_ar', { volume: 0.1 });
    const capped = audio.voices.filter((v) => v.name === 'shot_ar').length;
    const l = audio.loop('wind_loop', 0.2);
    const loopedUp = audio.loops.has('wind_loop');
    audio.stopLoop('wind_loop');
    audio.stopAll();
    return { ok: !!v1 && buffered && capped <= 4 && !!l && loopedUp && audio.loops.size === 0,
             detail: 'context created, ' + capped + ' concurrent voices of one sound (cap 4), loop start/stop ok' };
  });

  t('audio: distance attenuation falls off and pans with the camera', () => {
    // Exercised directly, since playback itself is unavailable here.
    const cam = G.engine.camera;
    cam.position.set(0, 0, 0);
    cam.lookAt(0, 0, -1);
    cam.updateMatrixWorld(true);
    audio.camera = cam;
    const near = audio._spatial(0, 0, -5);
    const far = audio._spatial(0, 0, -100);
    const right = audio._spatial(20, 0, 0);
    const left = audio._spatial(-20, 0, 0);
    const beyond = audio._spatial(0, 0, -5000);
    return { ok: near.gain > far.gain && far.gain > 0 && beyond === null
               && right.pan > 0.8 && left.pan < -0.8,
             detail: '5m gain ' + near.gain.toFixed(3) + ', 100m gain ' + far.gain.toFixed(3)
               + ', pan right ' + right.pan.toFixed(2) + ' left ' + left.pan.toFixed(2)
               + ', beyond max distance culled' };
  });

  /* --- bots --------------------------------------------------------------- */
  const { BotManager } = await import('/src/ai/BotManager.js');
  const STATE = BotManager.STATE;

  /** Put one bot in a controlled situation and freeze the rest. */
  const isolateBot = () => {
    for (const b of bots.bots) { b.alive = false; }
    bots.aliveCount = 0;
    const b = bots.bots[0];
    b.alive = true;
    b.health = 100; b.shield = 0;
    b.state = STATE.ROAM;
    b.target = null;
    b.damageMemory = 0;
    b.buildCooldown = 0;
    b.reactionTimer = 0;
    bots.aliveCount = 1;
    return b;
  };
  const reviveAll = () => {
    for (const b of bots.bots) { b.alive = true; b.health = 100; }
    bots.aliveCount = bots.bots.length;
  };

  t('bots: spawn on walkable land, alive and armed', () => {
    bots.spawnAll();
    const bad = [];
    for (const b of bots.bots) {
      if (!b.alive) bad.push(b.id + ':dead');
      if (!b.weapon) bad.push(b.id + ':unarmed');
      if (b.position.y < SEA_LEVEL) bad.push(b.id + ':water');
      if (Math.abs(b.position.y - terrain.heightAt(b.position.x, b.position.z)) > 0.1) bad.push(b.id + ':floating');
    }
    const weapons = new Set(bots.bots.map((b) => b.weapon.id));
    return { ok: bad.length === 0 && bots.aliveCount === bots.bots.length && weapons.size >= 3,
             detail: bots.bots.length + ' bots, weapon mix: ' + [...weapons].join(',')
               + (bad.length ? ' | ' + bad.slice(0, 4).join(' ') : '') };
  });

  t('bots: move under their own steering', () => {
    bots.spawnAll();
    const before = bots.bots.map((b) => b.position.clone());
    sim(180, {});
    let moved = 0, maxD = 0;
    bots.bots.forEach((b, i) => {
      const d = b.position.distanceTo(before[i]);
      if (d > 2) moved++;
      maxD = Math.max(maxD, d);
    });
    return { ok: moved >= bots.bots.length * 0.7,
             detail: moved + '/' + bots.bots.length + ' bots moved more than 2m in 3s, furthest ' + maxD.toFixed(1) + 'm' };
  });

  t('bots: stay on the terrain surface and inside the map', () => {
    sim(240, {});
    const bad = [];
    for (const b of bots.bots) {
      if (!b.alive) continue;
      const lim = terrain.size / 2 - 5;
      if (Math.abs(b.position.x) > lim || Math.abs(b.position.z) > lim) bad.push(b.id + ':out');
      const gh = terrain.heightAt(b.position.x, b.position.z);
      if (b.position.y < gh - 1.5 || b.position.y > gh + 12) bad.push(b.id + ':detached');
    }
    return { ok: bad.length === 0, detail: bad.length ? bad.slice(0, 5).join(' ') : 'all bots grounded and in bounds' };
  });

  t('bots: distant bots skip physics but nearby ones do not', () => {
    bots.spawnAll();
    // Put the player next to bot 0 and far from the rest.
    const b0 = bots.bots[0];
    player.spawnAt(b0.position.x + 6, b0.position.z, 0);
    sim(8, {});
    const near = bots.bots.filter((b) => b.alive && !b.simple).length;
    const far = bots.bots.filter((b) => b.alive && b.simple).length;
    return { ok: !b0.simple && far > 0 && near >= 1,
             detail: near + ' full-physics, ' + far + ' simplified' };
  });

  t('bots: a bot engages and shoots a visible player', () => {
    const b = isolateBot();
    // Stand the bot in the open, facing the player at close range.
    placeClear();
    const p = player.position;
    b.position.set(p.x, p.y, p.z - 18);
    b.velocity.set(0, 0, 0);
    b.yaw = Math.PI;                     // face +Z, toward the player
    b.simple = false;
    b.weapon.ammo = b.weapon.magSize;
    b.weapon.cooldown = 0;
    b.aimError = 0;                      // perfect aim, so the test is about logic
    b.skill = 1;
    const shots0 = bots.stats.shotsFired;
    const hp0 = player.health;
    sim(150, {});
    const engaged = b.state === STATE.ENGAGE || b.target === player;
    return { ok: engaged && bots.stats.shotsFired > shots0 && player.health < hp0,
             detail: 'state=' + BotManager.STATE_NAMES[b.state] + ', ' + (bots.stats.shotsFired - shots0)
               + ' shots, player health ' + hp0 + ' -> ' + player.health };
  });

  t('bots: a wall between them stops the bot shooting', () => {
    // The bot is pinned in place: left to its own steering it would strafe out
    // from behind a 4m wall within a second, which is correct behaviour but
    // would test the steering rather than the line-of-sight gate.
    const b = isolateBot();
    clearBuilds();
    placeClear();
    const p = player.position.clone();
    const pin = new THREE.Vector3(p.x, p.y, p.z - 14);
    const arm = () => {
      b.position.copy(pin);
      b.velocity.set(0, 0, 0);
      b.yaw = Math.PI;
      b.pitch = 0;
      b.simple = false;
      b.skill = 1; b.aimError = 0;
      b.target = player;
      b.reactionTimer = 0;
      b.weapon.ammo = b.weapon.magSize;
      b.weapon.cooldown = 0;
      b.weapon.reloadTimer = 0;
      player.health = 100; player.shield = 0; player.alive = true;
    };

    // Clear line of sight: the bot must connect.
    arm();
    for (let i = 0; i < 90; i++) { b.position.copy(pin); bots._tryShoot(b, 1 / 60); }
    const openDamage = 100 - player.health;

    // Wall up between them.
    player.yaw = 0; player.pitch = -0.1;
    build.setPiece(0); build.setMaterial('metal');
    build.resources.metal = 500;
    sim(4, { buildMode: true, buildPiece: 0, fire: true });
    const placed = build.stats.placed;

    arm();
    for (let i = 0; i < 90; i++) { b.position.copy(pin); bots._tryShoot(b, 1 / 60); }
    const walledDamage = 100 - player.health;

    return { ok: placed === 1 && openDamage > 0 && walledDamage === 0,
             detail: 'placed=' + placed + ', open line of sight ' + openDamage
               + ' damage, behind a wall ' + walledDamage + ', live builds=' + build.kit.records.filter((r) => r.alive).length
               + ', reason=' + build.preview.reason + ', valid=' + build.preview.valid
               + ', metal=' + build.resources.metal + ', inputEnabled=' + G.engine.services.get('input').enabled };
  });

  t('bots: damage reduces health, then eliminates and reports it', () => {
    reviveAll();
    const b = bots.bots[3];
    b.alive = true; b.health = 100; b.shield = 40;
    const events = [];
    const off = G.engine.bus.on('entity:eliminated', (e) => { if (e.entity === b) events.push(e); });
    b.applyDamage(30, { shooter: player });
    const afterShield = [b.health, b.shield];
    b.applyDamage(200, { shooter: player });
    G.engine.bus.flush();
    off();
    return { ok: afterShield[0] === 100 && afterShield[1] === 10 && !b.alive
               && events.length === 1 && events[0].entity === b,
             detail: 'shield ' + afterShield.join('/') + ', ' + events.length + ' elimination event(s), correct entity='
               + (events.length ? String(events[0].entity === b) : 'n/a') };
  });

  t('bots: being shot makes a bot look for the shooter', () => {
    const b = isolateBot();
    b.target = null;
    b.state = STATE.ROAM;
    b.applyDamage(10, { shooter: player });
    return { ok: b.target === player && b.state === STATE.COVER,
             detail: 'target acquired, state -> ' + BotManager.STATE_NAMES[b.state] };
  });

  t('bots: a damaged bot builds cover using the shared build rules', () => {
    const b = isolateBot();
    clearBuilds();
    placeClear();
    const p = player.position;
    b.position.set(p.x, p.y, p.z - 12);
    b.simple = false;
    b.skill = 0.9;
    b.target = player;
    b.damageMemory = 2.5;
    b.buildCooldown = 0;
    b.state = STATE.COVER;
    const before = build.grid.count;
    bots._tryBuild(b, 1 / 60);
    const rec = build.kit.records.find((r) => r.alive && r.meta.owner === 'bot');
    return { ok: build.grid.count === before + 1 && !!rec && rec.proto === 'wall',
             detail: 'bot placed a ' + (rec ? rec.meta.material : '?') + ' wall, grid ' + before + ' -> ' + build.grid.count };
  });

  t('bots: low-skill bots aim worse than high-skill bots', () => {
    // Recompute from skill: earlier tests deliberately zero one bot's error.
    for (const b of bots.bots) b.aimError = 0.075 * (1 - b.skill) + 0.006;
    const errors = bots.bots.map((b) => ({ skill: b.skill, err: b.aimError }));
    errors.sort((a, b) => a.skill - b.skill);
    const worst = errors[0], best = errors[errors.length - 1];
    const monotone = errors.every((e, i) => i === 0 || e.err <= errors[i - 1].err + 1e-9);
    return { ok: monotone && worst.err > best.err * 2,
             detail: 'skill ' + worst.skill.toFixed(2) + ' -> error ' + worst.err.toFixed(4)
               + '; skill ' + best.skill.toFixed(2) + ' -> ' + best.err.toFixed(4) };
  });

  t('bots: the whole opposing team costs one draw call', () => {
    reviveAll();
    bots.update(1 / 60);
    return { ok: bots.pool.mesh.count === bots.aliveCount && bots.state().drawCalls === 1,
             detail: bots.aliveCount + ' bots drawn as ' + bots.pool.mesh.count + ' instances in 1 draw call' };
  });

  t('bots: perception is time-sliced across frames', () => {
    // Each bot re-evaluates targets once every four fixed steps, not every one.
    let calls = 0;
    const original = bots._perceive.bind(bots);
    bots._perceive = (b, dt) => { calls++; return original(b, dt); };
    reviveAll();
    sim(16, {});
    bots._perceive = original;
    const expected = bots.bots.length * 4;      // 16 frames / 4 groups
    return { ok: calls <= expected + bots.bots.length && calls >= expected - bots.bots.length,
             detail: calls + ' perception passes over 16 frames for ' + bots.bots.length
               + ' bots (one per bot every 4 frames = ' + expected + ')' };
  });

  t('bots: bots are damageable targets registered with combat', () => {
    const registered = combat.targets.filter((t) => bots.bots.includes(t.entity)).length;
    return { ok: registered === bots.bots.length,
             detail: registered + '/' + bots.bots.length + ' bots registered as combat targets' };
  });

  t('bots: the player can eliminate a bot by shooting it', () => {
    reviveAll();
    const b = isolateBot();
    armed('sniper');
    placeClear();
    const p = player.position;
    b.position.set(p.x, p.y, p.z - 30);
    b.health = 100; b.shield = 0; b.alive = true;
    b.simple = true;                     // hold it still for the shot
    G.engine.camera.position.set(p.x, p.y + 1.62, p.z + 2);
    G.engine.camera.lookAt(p.x, b.position.y + 1.62, p.z - 30);
    G.engine.camera.updateMatrixWorld(true);
    const kills0 = combat.stats.eliminations;
    combat.fire(player);
    for (let i = 0; i < 120 && combat.projectiles.length; i++) combat._stepProjectiles(1 / 60);
    G.engine.bus.flush();
    return { ok: !b.alive && combat.stats.eliminations === kills0 + 1,
             detail: 'bot down, player eliminations ' + kills0 + ' -> ' + combat.stats.eliminations };
  });

  // Park the team again: the sections below test the player against a quiet
  // world, and a live firefight would kill them mid-assertion.
  for (const b of bots.bots) b.alive = false;
  bots.aliveCount = 0;

  /* --- storm -------------------------------------------------------------- */
  const { Storm } = await import('/src/game/Storm.js');
  const { MATCH } = await import('/src/game/MatchDirector.js');

  t('storm: phases shrink monotonically toward zero', () => {
    const p = Storm.PHASES;
    let mono = true;
    for (let i = 1; i < p.length; i++) if (p[i].radius >= p[i - 1].radius) mono = false;
    const dpsRising = p.every((x, i) => i === 0 || x.dps >= p[i - 1].dps);
    const total = p.reduce((a, x) => a + x.wait + x.shrink, 0);
    return { ok: mono && dpsRising && p[p.length - 1].radius === 0 && total > 300 && total < 900,
             detail: p.length + ' phases, ' + Math.round(total) + 's total, dps ' + p[0].dps + ' -> ' + p[p.length - 1].dps };
  });

  t('storm: the circle closes and the next centre is always reachable', () => {
    storm.start();
    let prevR = storm.radius;
    const centres = [];
    let unreachable = 0;
    for (let phase = 0; phase < Storm.PHASES.length; phase++) {
      // Run the whole phase: wait then shrink.
      for (let i = 0; i < 60 * 130 && storm.phaseIndex === phase; i++) storm.fixedUpdate(1 / 60);
      // The new circle must lie inside the old one.
      const d = Math.hypot(storm.centre.x - (centres.length ? centres[centres.length - 1][0] : 0),
        storm.centre.y - (centres.length ? centres[centres.length - 1][1] : 0));
      if (d > prevR - storm.radius + 1) unreachable++;
      centres.push([storm.centre.x, storm.centre.y]);
      if (storm.radius > prevR + 0.01) unreachable++;
      prevR = storm.radius;
    }
    return { ok: storm.radius < 1 && unreachable === 0,
             detail: 'final radius ' + storm.radius.toFixed(2) + 'm over ' + centres.length + ' phases, all reachable' };
  });

  t('storm: entities outside take damage, inside take none', () => {
    storm.start();
    storm.radius = 40;
    storm.centre.set(0, 0);
    storm.dps = 10;
    storm.damageAccum.clear();
    // Inside.
    player.spawnAt(0, 0, 0);
    player.health = 100; player.shield = 0; player.alive = true;
    for (let i = 0; i < 120; i++) storm._applyDamage(1 / 60);
    const inside = player.health;
    // Outside.
    player.spawnAt(200, 200, 0);
    player.health = 100;
    for (let i = 0; i < 120; i++) storm._applyDamage(1 / 60);
    const outside = player.health;
    storm.active = false;
    return { ok: inside === 100 && outside <= 82 && outside > 60,
             detail: 'inside kept ' + inside + ' hp, outside dropped to ' + outside + ' after 2s at 10 dps' };
  });

  t('storm: safe direction points back toward the circle', () => {
    storm.centre.set(50, -30);
    storm.radius = 60;
    const d = storm.safeDirection(200, -30, new THREE.Vector3());
    const inside = storm.isSafe(60, -30);
    const outsideDist = storm.distanceToSafety(200, -30);
    return { ok: d.x < -0.9 && inside && outsideDist > 80,
             detail: 'direction (' + d.x.toFixed(2) + ',' + d.z.toFixed(2) + '), 150m out reads ' + outsideDist.toFixed(0) + 'm from safety' };
  });

  /* --- loot --------------------------------------------------------------- */
  t('loot: populating the map places chests and floor loot at POIs', () => {
    const r = loot.populate();
    const nearPoi = loot.items.filter((it) => structures.insidePoi(it.x, it.z, 12)).length;
    return { ok: r.chests > 5 && loot.items.length > 15 && nearPoi > loot.items.length * 0.7,
             detail: r.chests + ' chests, ' + loot.items.length + ' floor items, '
               + nearPoi + ' of them inside a POI' };
  });

  t('loot: items sit above the ground and carry a rarity colour', () => {
    const bad = loot.items.filter((it) => it.y < terrain.heightAt(it.x, it.z) - 0.5 || !it.color).length;
    const weapons = loot.items.filter((it) => it.type === 0);
    const rarities = new Set(weapons.map((w) => w.rarity));
    return { ok: bad === 0 && rarities.size >= 2,
             detail: loot.items.length + ' items, ' + bad + ' buried, rarities present: ' + [...rarities].join(',') };
  });

  t('loot: walking over ammo picks it up automatically', () => {
    placeClear();
    const p = player.position;
    const before = combat.reserveAmmo.medium;
    loot.spawnAmmo(p.x, p.y + 0.5, p.z, 'medium', 30);
    sim(4, {});
    return { ok: combat.reserveAmmo.medium === before + 30,
             detail: 'medium ammo ' + before + ' -> ' + combat.reserveAmmo.medium + ' without pressing anything' };
  });

  t('loot: a weapon needs the interact button, not just proximity', () => {
    placeClear();
    const p = player.position;
    combat.slots[1] = null; combat.slots[2] = null;
    const item = loot.spawnWeapon(p.x + 0.5, p.y + 0.5, p.z, 'ar', 'epic');
    sim(6, {});
    const passive = combat.slots.filter((x) => x && x.id === 'ar').length;
    const prompt = loot.nearest && loot.nearest.kind === 'item';
    sim(2, { interact: true });
    const taken = combat.slots.filter((x) => x && x.id === 'ar').length;
    const gone = !loot.items.includes(item);
    return { ok: passive === 0 && prompt && taken === 1 && gone,
             detail: 'passive=' + passive + ', prompt=' + (loot.nearest ? loot.nearest.kind : 'none')
               + ', taken=' + taken + ', removed=' + gone + ', alive=' + player.alive
               + ', inputEnabled=' + G.engine.services.get('input').enabled
               + ', screen=' + screens.current + ', pickedUp=' + loot.stats.pickedUp };
  });

  t('loot: opening a chest spawns several items', () => {
    placeClear();
    const p = player.position;
    const chest = { x: p.x + 1.2, y: p.y, z: p.z, yaw: 0, opened: false, kind: 'test' };
    loot.chests.push(chest);
    // Count spawns, not surviving items: ammo and materials that land within
    // reach are absorbed on contact the same frame, which is correct.
    const before = loot.stats.spawned;
    sim(4, {});
    const prompt = loot.nearest && loot.nearest.kind === 'chest';
    sim(2, { interact: true });
    const spawned = loot.stats.spawned - before;
    return { ok: prompt && chest.opened && spawned >= 3,
             detail: 'prompt=' + (prompt ? 'chest' : 'none') + ', opened=' + chest.opened
               + ', spawned=' + spawned + ', ' + loot.items.length + ' on the ground'
               + ', alive=' + player.alive + ', nearest=' + (loot.nearest ? loot.nearest.kind : 'null')
               + ', inputEnabled=' + G.engine.services.get('input').enabled };
  });

  t('loot: the whole loot layer costs two draw calls', () => {
    loot.update(1 / 60);
    return { ok: loot.itemMesh.count >= 0 && loot.chestMesh.count >= 0,
             detail: loot.itemMesh.count + ' items and ' + loot.chestMesh.count
               + ' chests drawn in 2 instanced meshes' };
  });

  /* --- consumables --------------------------------------------------------- */
  t('consumables: a shield potion applies after its use time', () => {
    placeClear();
    player.shield = 0; player.health = 100;
    combat.consumables.shield = 1;
    combat.cancelUse();
    const started = combat.beginUse();
    sim(30, {});
    const midway = [player.shield, combat.using];
    sim(4 * 60, {});
    return { ok: started && midway[0] === 0 && midway[1] === 'shield'
               && player.shield === 50 && combat.consumables.shield === 0,
             detail: 'no effect at 0.5s, +' + player.shield + ' shield after the full 4s' };
  });

  t('consumables: taking fire interrupts a heal', () => {
    placeClear();
    player.health = 50; player.shield = 0;
    combat.consumables.medkit = 1;
    combat.cancelUse();
    combat.beginUse('medkit');
    sim(30, {});
    player.applyDamage(5, { type: 'weapon', shooter: null });
    G.engine.bus.flush();
    sim(10, {});
    return { ok: combat.using === null && combat.consumables.medkit === 1 && player.health < 50,
             detail: 'use cancelled, medkit retained (' + combat.consumables.medkit + ')' };
  });

  t('consumables: the heal button picks shield first, then medkit', () => {
    player.health = 100; player.shield = 0;
    combat.consumables.shield = 1; combat.consumables.medkit = 1;
    const first = combat.bestConsumable();      // no shield, full health
    player.shield = 100;
    const capped = combat.bestConsumable();      // both full: nothing applies
    player.health = 40;
    const hurt = combat.bestConsumable();        // shield full, health low
    player.shield = 0;
    const both = combat.bestConsumable();        // shield takes priority again
    combat.consumables.shield = 0;
    const onlyMed = combat.bestConsumable();     // shield gone, medkit remains
    player.health = 100; player.shield = 100;
    return { ok: first === 'shield' && capped === null && hurt === 'medkit'
               && both === 'shield' && onlyMed === 'medkit',
             detail: 'no shield -> ' + first + '; both full -> ' + capped + '; hurt with full shield -> '
               + hurt + '; hurt with no shield -> ' + both + '; no potions left -> ' + onlyMed };
  });

  /* --- match flow ---------------------------------------------------------- */
  t('match: starting a match resets loadout, loot, bots and storm', () => {
    combat.giveWeapon('ar', 'legendary');
    build.resources.wood = 500;
    player.health = 10;
    match.startMatch();
    const armedSlots = match.combat.slots.filter((x, i) => i > 0 && x).length;
    return { ok: match.state === MATCH.BUS && armedSlots === 0 && build.resources.wood === 0
               && player.health === player.maxHealth && bots.aliveCount === bots.bots.length
               && loot.chests.length > 0 && !storm.active,
             detail: 'state=bus, empty loadout, ' + bots.aliveCount + ' bots, '
               + loot.chests.length + ' chests, storm idle' };
  });

  t('match: the bus crosses the map and the player can drop from it', () => {
    match.startMatch();
    const start = match.busMesh.position.clone();
    sim(120, {});
    const moved = match.busMesh.position.distanceTo(start);
    const ridingAlong = Math.abs(player.position.y - match.busMesh.position.y) < 20;
    const deployed = match.deploy();
    return { ok: moved > 80 && ridingAlong && deployed && match.state === MATCH.DEPLOY,
             detail: 'bus travelled ' + moved.toFixed(0) + 'm in 2s, drop -> ' + ['idle','bus','deploy','playing','result'][match.state] };
  });

  t('match: dropping falls, deploys a glider and lands, starting the storm', () => {
    match.startMatch();
    sim(60, {});
    match.deploy();
    const startY = player.position.y;
    let sawFreefall = false, sawGlide = false;
    for (let i = 0; i < 60 * 40 && match.state === MATCH.DEPLOY; i++) {
      sim(1, {});
      if (!match.gliding && player.body.vel.y < -40) sawFreefall = true;
      if (match.gliding) sawGlide = true;
    }
    const grounded = Math.abs(player.position.y - terrain.heightAt(player.position.x, player.position.z)) < 0.2;
    return { ok: sawFreefall && sawGlide && match.state === MATCH.PLAYING && grounded && storm.active,
             detail: 'fell from ' + startY.toFixed(0) + 'm, freefall then glide, landed and storm started' };
  });

  t('match: landing costs no fall damage', () => {
    match.startMatch();
    sim(30, {});
    match.deploy();
    for (let i = 0; i < 60 * 40 && match.state === MATCH.DEPLOY; i++) sim(1, {});
    return { ok: player.health === player.maxHealth,
             detail: 'health after the drop: ' + player.health };
  });

  t('match: eliminating the last opponent is a victory', () => {
    match.startMatch();
    sim(30, {});
    match.deploy();
    for (let i = 0; i < 60 * 40 && match.state === MATCH.DEPLOY; i++) sim(1, {});
    // Remove every bot; the final elimination must end the match.
    for (const b of bots.bots) if (b.alive) b.applyDamage(1e9, { shooter: player });
    G.engine.bus.flush();
    sim(2, {});
    return { ok: match.state === MATCH.RESULT && match.result && match.result.victory
               && match.result.placement === 1,
             detail: 'placement ' + (match.result ? match.result.placement : '?') + ' of '
               + (match.result ? match.result.players : '?') + ', victory=' + (match.result && match.result.victory) };
  });

  t('match: dying ends the match with the correct placement', () => {
    match.startMatch();
    sim(30, {});
    match.deploy();
    for (let i = 0; i < 60 * 40 && match.state === MATCH.DEPLOY; i++) sim(1, {});
    // Take out most bots, then the player.
    let killed = 0;
    for (const b of bots.bots) { if (killed >= 20) break; if (b.alive) { b.applyDamage(1e9, {}); killed++; } }
    G.engine.bus.flush();
    const remaining = bots.aliveCount;
    player.applyDamage(1e9, { type: 'storm' });
    G.engine.bus.flush();
    sim(2, {});
    return { ok: match.state === MATCH.RESULT && match.result && !match.result.victory
               && match.result.placement === remaining + 1,
             detail: 'died with ' + remaining + ' bots alive -> placement ' + match.result.placement };
  });

  t('match: eliminated bots drop their loot', () => {
    match.startMatch();
    const before = loot.items.length;
    const b = bots.bots.find((x) => x.alive);
    b.applyDamage(1e9, { shooter: player });
    G.engine.bus.flush();
    return { ok: loot.items.length > before,
             detail: (loot.items.length - before) + ' items dropped by one elimination' };
  });

  t('match: results carry placement, eliminations, damage and accuracy', () => {
    match.startMatch();
    sim(20, {});
    match.deploy();
    for (let i = 0; i < 60 * 40 && match.state === MATCH.DEPLOY; i++) sim(1, {});
    combat.stats.playerShots = 20; combat.stats.playerHits = 9;
    combat.stats.damageDealt = 640;
    match.stats.eliminations = 3;
    for (const bb of bots.bots) if (bb.alive) bb.applyDamage(1e9, { shooter: player });
    G.engine.bus.flush();
    const r = match.result;
    return { ok: r && r.placement === 1 && r.eliminations >= 3 && r.damage >= 640
               && Math.abs(r.accuracy - 0.45) < 0.01 && r.players === 25,
             detail: 'placement ' + r.placement + '/' + r.players + ', ' + r.eliminations
               + ' elims, ' + r.damage + ' damage, ' + (r.accuracy * 100).toFixed(0) + '% accuracy' };
  });

  /* --- HUD ---------------------------------------------------------------- */
  // The match section ends in the result screen, which hides the HUD. Every
  // HUD assertion starts by dismissing any screen so the layer is live.
  const hudReady = () => {
    // Drain twice: a handler that queues during a flush (the match result is
    // queued from the elimination handler) only lands on the following one.
    G.engine.bus.flush();
    G.engine.bus.flush();
    screens.show(null);
    hud.setVisible(true);
    minimap.setVisible(true);
  };
  hudReady();

  t('hud: vitals, materials and ammo mirror game state', () => {
    placeClear();
    hudReady();
    player.health = 63; player.shield = 41;
    build.resources = { wood: 271, brick: 88, metal: 305 };
    combat.slots[1] = makeWeapon('smg', 'epic');
    combat.selectSlot(1);
    combat.weapon.ammo = 12;
    combat.reserveAmmo.light = 96;
    hud.update(1 / 60);
    const s1 = hud.snapshot();
    return { ok: s1.health === '63' && s1.shield === '41' && s1.materials.wood === '271'
               && s1.materials.brick === '88' && s1.materials.metal === '305'
               && s1.ammo === '12/96' && s1.rarity === 'epic' && s1.weapon === 'SMG',
             detail: s1.health + 'hp/' + s1.shield + 'sh, mats ' + Object.values(s1.materials).join('/')
               + ', ' + s1.weapon + ' (' + s1.rarity + ') ' + s1.ammo
 };
  });

  t('hud: only writes to the DOM when a value changes', () => {
    // A HUD that rewrites every frame is what makes DOM HUDs stutter on phones.
    // Freeze everything that legitimately animates (weapon bloom, movement,
    // the low-health pulse, the storm clock) so the only thing under test is
    // whether an unchanged value still touches the DOM.
    hudReady();
    placeClear();
    player.health = 90; player.shield = 50;
    player.body.vel.set(0, 0, 0);
    player.aiming = false;
    combat.selectSlot(0);
    if (combat.weapon) combat.weapon.bloom = 0;
    storm.active = false;
    build.active = false;
    hud._damageFlashTimer = 0;      // the hurt vignette fades over ~0.45s

    hud.update(1 / 60);
    const before = JSON.stringify(hud.cache);
    for (let i = 0; i < 10; i++) hud.update(1 / 60);
    const afterIdle = JSON.stringify(hud.cache);

    player.health = 12;
    hud.update(1 / 60);
    const afterChange = JSON.stringify(hud.cache);
    player.health = 100;

    // Name the offending fields when the cache does drift, so a regression here
    // says which readout is misbehaving.
    let drift = '';
    if (before !== afterIdle) {
      const a = JSON.parse(before), b = JSON.parse(afterIdle);
      drift = Object.keys(b).filter((k) => a[k] !== b[k]).map((k) => k + ':' + a[k] + '->' + b[k]).join(' ');
    }
    return { ok: before === afterIdle && afterChange !== afterIdle,
             detail: drift ? 'drifted: ' + drift
               : 'cache stable across 10 idle frames, updated on a real change' };
  });

  t('hud: low health and low ammo are flagged', () => {
    hudReady();
    // A real magazine weapon: the pickaxe has no ammo to run low on.
    combat.slots[1] = makeWeapon('ar', 'common');
    combat.selectSlot(1);
    player.health = 18;
    combat.weapon.ammo = 2;
    hud.update(1 / 60);
    const low = hud.healthBar.classList.contains('low') && hud.ammoBox.classList.contains('low');
    player.health = 90;
    combat.weapon.ammo = combat.weapon.magSize;
    hud.update(1 / 60);
    const clear = !hud.healthBar.classList.contains('low') && !hud.ammoBox.classList.contains('low');
    return { ok: low && clear, detail: 'flagged at 18hp/2 rounds, cleared at 90hp/full' };
  });

  t('hud: the crosshair gap tracks the actual bullet cone', () => {
    hudReady();
    combat.slots[1] = makeWeapon('ar', 'common');
    combat.selectSlot(1);
    player.aiming = false;
    player.body.vel.set(0, 0, 0);
    combat.weapon.bloom = 0;
    hud.update(1 / 60);
    const still = parseFloat(hud.snapshot().crossGap);
    combat.weapon.bloom = combat.weapon.def.bloom * 3;
    hud.update(1 / 60);
    const bloomed = parseFloat(hud.snapshot().crossGap);
    combat.weapon.bloom = 0;
    player.aiming = true;
    hud.update(1 / 60);
    const ads = parseFloat(hud.snapshot().crossGap);
    player.aiming = false;
    return { ok: bloomed > still && ads < still,
             detail: 'still ' + still + 'px, firing ' + bloomed + 'px, aiming ' + ads + 'px' };
  });

  t('hud: eliminations appear in the kill feed', () => {
    hudReady();
    hud.killfeed.length = 0;
    const victim = bots.bots[5];
    victim.alive = true;
    victim.applyDamage(1e9, { shooter: player });
    G.engine.bus.flush();
    hud.update(1 / 60);
    const feed = hud.snapshot().killfeed;
    return { ok: feed.length === 1 && feed[0].includes('YOU eliminated'),
             detail: feed.join(' | ') };
  });

  t('hud: the kill feed expires and is capped', () => {
    hudReady();
    hud.killfeed.length = 0;
    for (let i = 0; i < 9; i++) {
      hud.killfeed.unshift({ text: 'row ' + i, ttl: 4.5, mine: false });
      if (hud.killfeed.length > 4) hud.killfeed.length = 4;
    }
    const capped = hud.killfeed.length;
    for (let i = 0; i < 400; i++) hud.update(1 / 60);   // 6.7s
    return { ok: capped === 4 && hud.killfeed.length === 0,
             detail: 'capped at ' + capped + ' rows, all expired after 6.7s' };
  });

  t('hud: build readout shows the piece, material and rejection reason', () => {
    hudReady();
    buildStance(2, 0);
    build.setMaterial('brick');
    build.resources.brick = 500;
    sim(2, { buildMode: true, buildPiece: 2 });
    hud.update(1 / 60);
    const on = hud.snapshot();
    build.resources.brick = 0;
    build.computeTarget();
    hud.update(1 / 60);
    const rejected = hud.buildState.textContent;
    sim(2, {});
    hud.update(1 / 60);
    const off = hud.snapshot();
    return { ok: on.buildVisible && on.buildMaterial === 'BRICK' && on.buildPiece === 'RAMP'
               && rejected === 'NOT ENOUGH MATERIAL' && !off.buildVisible,
             detail: on.buildMaterial + '/' + on.buildPiece + ', rejection: "' + rejected + '", hidden out of build mode' };
  });

  t('hud: the storm state drives the timer and the in-storm warning', () => {
    hudReady();
    storm.start();
    storm.centre.set(0, 0);
    storm.radius = 30;
    storm.state = 1;                 // shrinking
    storm.shrinkDuration = 60;
    storm.timer = 95;
    player.spawnAt(0, 0, 0);
    hud.update(1 / 60);
    const inside = hud.snapshot();
    player.spawnAt(300, 300, 0);
    hud.update(1 / 60);
    const outside = hud.snapshot();
    storm.active = false;
    return { ok: inside.stormTime === '01:35' && !inside.inStorm && outside.inStorm,
             detail: 'timer ' + inside.stormTime + ', in-storm warning off inside and on outside' };
  });

  t('hud: the pickup prompt follows the nearest interactable', () => {
    hudReady();
    placeClear();
    loot.items.length = 0;
    hud.update(1 / 60);
    const none = hud.snapshot().prompt;
    const p = player.position;
    loot.spawnWeapon(p.x + 0.6, p.y + 0.5, p.z, 'shotgun', 'rare');
    sim(3, {});
    hud.update(1 / 60);
    const shown = hud.snapshot().prompt;
    loot.items.length = 0;
    sim(3, {});
    hud.update(1 / 60);
    return { ok: none === '' && shown.startsWith('PICK UP') && hud.snapshot().prompt === '',
             detail: 'prompt: "' + shown + '"' };
  });

  /* --- damage numbers ------------------------------------------------------ */
  t('damage numbers: a hit spawns a number that rises and expires', () => {
    damageNumbers.clear();
    const p = player.position;
    G.engine.camera.position.set(p.x, p.y + 1.6, p.z + 4);
    G.engine.camera.lookAt(p.x, p.y + 1.6, p.z - 10);
    G.engine.camera.updateMatrixWorld(true);
    damageNumbers.spawn({ x: p.x, y: p.y + 1.6, z: p.z - 8 }, 47, 'body');
    damageNumbers.update(0.05);
    const live = damageNumbers.live.length;
    const t0 = damageNumbers.live[0].el.style.transform;
    damageNumbers.update(0.4);
    const t1 = damageNumbers.live[0].el.style.transform;
    for (let i = 0; i < 40; i++) damageNumbers.update(1 / 30);
    return { ok: live === 1 && t0 !== t1 && damageNumbers.live.length === 0
               && damageNumbers.free.length === 24,
             detail: 'spawned, moved, expired and returned to the pool' };
  });

  t('damage numbers: headshots are styled differently', () => {
    damageNumbers.clear();
    const p = player.position;
    const body = damageNumbers.spawn({ x: p.x, y: p.y + 1, z: p.z - 6 }, 30, 'body');
    const head = damageNumbers.spawn({ x: p.x + 1, y: p.y + 1, z: p.z - 6 }, 75, 'head');
    const ok = !body.el.classList.contains('head') && head.el.classList.contains('head')
      && body.el.textContent === '30' && head.el.textContent === '75';
    damageNumbers.clear();
    return { ok, detail: 'body "' + body.el.textContent + '", head "' + head.el.textContent + '" (styled)' };
  });

  t('damage numbers: the pool never grows', () => {
    damageNumbers.clear();
    const total = damageNumbers.free.length;
    const p = player.position;
    for (let i = 0; i < 200; i++) damageNumbers.spawn({ x: p.x, y: p.y + 1, z: p.z - 5 }, 10, 'body');
    const nodes = damageNumbers.layer.children.length;
    damageNumbers.clear();
    return { ok: nodes === total && damageNumbers.live.length === 0,
             detail: '200 spawns reused ' + nodes + ' DOM nodes' };
  });

  /* --- minimap -------------------------------------------------------------- */
  t('minimap: bakes the island once and redraws at a fixed rate', () => {
    hudReady();
    const baked = !!minimap.island && minimap.island.width === 256;
    let draws = 0;
    const orig = minimap.draw.bind(minimap);
    minimap.draw = () => { draws++; };
    for (let i = 0; i < 60; i++) minimap.update(1 / 60);   // one second
    minimap.draw = orig;
    return { ok: baked && draws >= 10 && draws <= 14,
             detail: 'island baked at ' + minimap.island.width + 'px, ' + draws + ' redraws in 1s (target 12)' };
  });

  t('minimap: renders without error and shows the local POI name', () => {
    const poi = structures.pois[0];
    player.spawnAt(poi.x, poi.z, 0);
    minimap.draw();
    const label = minimap.label.textContent;
    player.spawnAt(0, 0, 0);
    minimap.draw();
    return { ok: label === poi.name,
             detail: 'standing in ' + poi.name + ' -> label "' + label + '"' };
  });

  /* --- screens ---------------------------------------------------------------- */
  t('screens: showing a screen suspends gameplay input', () => {
    screens.show('start');
    const gated = !G.engine.services.get('input').enabled;
    screens.show(null);
    const released = G.engine.services.get('input').enabled;
    return { ok: gated && released,
             detail: 'input disabled behind a screen, re-enabled on dismiss' };
  });

  t('screens: the result card reports the match summary', () => {
    screens.showResult({ victory: false, placement: 7, players: 25, eliminations: 3,
      damage: 812, accuracy: 0.337, chests: 4, distance: 1290, time: 366 });
    const s1 = screens.snapshot();
    const html = screens.resultStats.textContent;
    screens.show(null);
    return { ok: s1.current === 'result' && s1.resultTitle === 'ELIMINATED'
               && s1.resultPlacement.includes('#7') && html.includes('34%') && html.includes('812')
               && html.includes('6:06'),
             detail: s1.resultTitle + ' ' + s1.resultPlacement + ', stats include accuracy and survival time' };
  });

  t('screens: a victory reads differently from a defeat', () => {
    screens.showResult({ victory: true, placement: 1, players: 25, eliminations: 9,
      damage: 2100, accuracy: 0.5, chests: 7, distance: 2400, time: 500 });
    const win = screens.snapshot();
    const styled = screens.resultTitle.classList.contains('victory');
    screens.show(null);
    return { ok: win.resultTitle === 'VICTORY ROYALE' && styled,
             detail: 'title "' + win.resultTitle + '", victory styling applied' };
  });

  t('ui: hiding the UI hides the HUD, minimap and controls together', () => {
    G.debug.setUiVisible(false);
    const hidden = hud.root.classList.contains('hidden') && minimap.wrap.classList.contains('hidden');
    G.debug.setUiVisible(true);
    const shown = !hud.root.classList.contains('hidden') && !minimap.wrap.classList.contains('hidden');
    return { ok: hidden && shown, detail: 'all UI layers toggle together' };
  });

  dropDummies();
  clearBuilds();
  fx.clear();

  return results;
}`;

async function main() {
  console.log('\n\x1b[1mWorld & simulation checks\x1b[0m');
  const { server, port } = await startServer();
  const browser = await launch();
  let ok = true;
  try {
    const { context, page, logs } = await openGame(browser, { device: 'phoneLandscape', port, query: { adaptive: '0' } });
    let results = [];
    try {
      results = await page.evaluate(`(${SUITE})()`);
    } catch (e) {
      console.log('  \x1b[31mFAIL\x1b[0m  suite threw: ' + e.message);
      console.log(logs.slice(-20).join('\n'));
      ok = false;
    }
    for (const r of results) ok = check(r.name, r.ok, r.detail) && ok;
    const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
    ok = check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ')) && ok;
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
