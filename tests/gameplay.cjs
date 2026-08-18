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
  const colliders = S.get('colliders');
  const THREE = await import('three');
  const { Colliders } = await import('/src/world/Colliders.js');
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
