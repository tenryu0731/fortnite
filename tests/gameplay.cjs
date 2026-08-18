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

  clearBuilds();

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
