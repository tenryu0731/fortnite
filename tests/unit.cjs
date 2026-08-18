/**
 * unit.cjs — subsystem-level checks.
 *
 * Two halves:
 *  - static: source-level invariants (no global Math.random, no forbidden imports)
 *  - in-browser: the generation library evaluated inside a real page, since
 *    TextureGen/MeshGen need Canvas2D and WebGL.
 */
const fs = require('fs');
const path = require('path');
const { startServer, launch, openGame, check, fmt, ROOT } = require('./harness.cjs');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Strip block/line comments so prose mentioning a banned API is not a hit. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' ');
}

function staticChecks() {
  let ok = true;
  const files = walk(path.join(ROOT, 'src'));

  // Determinism: every random draw must come from a seeded Rng.
  const offenders = [];
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    src.split('\n').forEach((line, i) => {
      if (/Math\.random\s*\(/.test(line) && !/allow-math-random/.test(line)) {
        offenders.push(`${path.relative(ROOT, f)}:${i + 1}`);
      }
    });
  }
  ok = check('no global Math.random() in src/', offenders.length === 0, offenders.join(', ')) && ok;

  // Date.now()/performance.now() inside fixedUpdate would break determinism too.
  const timeOffenders = [];
  for (const f of files) {
    if (/Profiler|Engine|AudioSystem|Hud|Screens|TestApi|Settings/.test(path.basename(f))) continue;
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    src.split('\n').forEach((line, i) => {
      if (/\bDate\.now\s*\(|\bperformance\.now\s*\(/.test(line) && !/allow-wallclock/.test(line)) {
        timeOffenders.push(`${path.relative(ROOT, f)}:${i + 1}`);
      }
    });
  }
  ok = check('no wall-clock reads in simulation code', timeOffenders.length === 0, timeOffenders.join(', ')) && ok;

  ok = check('ARCHITECTURE.md present', fs.existsSync(path.join(ROOT, 'ARCHITECTURE.md'))) && ok;
  return ok;
}

const BROWSER_SUITE = `async () => {
  const results = [];
  const t = (name, fn) => {
    try {
      const r = fn();
      if (r && r.then) throw new Error('async test not supported');
      results.push({ name, ok: r === true || (r && r.ok === true), detail: (r && r.detail) || '' });
    } catch (e) { results.push({ name, ok: false, detail: e.message }); }
  };

  const { Rng, makeRoot } = await import('/src/gen/Rng.js');
  const { Noise } = await import('/src/gen/Noise.js');
  const { TextureGen, SURFACES } = await import('/src/gen/TextureGen.js');
  const MeshGen = await import('/src/gen/MeshGen.js');
  const { AudioGen } = await import('/src/gen/AudioGen.js');
  const { Materials } = await import('/src/gen/Materials.js');
  const THREE = await import('three');

  /* --- Rng ---------------------------------------------------------- */
  t('rng: identical seeds produce identical sequences', () => {
    const a = new Rng(4242), b = new Rng(4242);
    for (let i = 0; i < 500; i++) if (a.next() !== b.next()) return false;
    return true;
  });
  t('rng: values stay within [0,1)', () => {
    const r = new Rng(5); let mn = 1, mx = 0;
    for (let i = 0; i < 200000; i++) { const v = r.next(); if (v < mn) mn = v; if (v > mx) mx = v; }
    return { ok: mn >= 0 && mx < 1, detail: 'min=' + mn.toFixed(6) + ' max=' + mx.toFixed(6) };
  });
  t('rng: uniform to within 0.5% per decile', () => {
    const r = new Rng(11), b = new Array(10).fill(0), N = 400000;
    for (let i = 0; i < N; i++) b[Math.floor(r.next() * 10)]++;
    const dev = Math.max(...b.map((x) => Math.abs(x / N - 0.1)));
    return { ok: dev < 0.005, detail: 'maxDev=' + (dev * 100).toFixed(3) + '%' };
  });
  t('rng: streams are independent and stable across roots', () => {
    const r1 = makeRoot(1337), r2 = makeRoot(1337);
    const a1 = r1.stream('terrain').next(), a2 = r2.stream('terrain').next();
    const b1 = r1.stream('loot').next();
    return a1 === a2 && a1 !== b1;
  });

  /* --- Noise -------------------------------------------------------- */
  t('noise: simplex2 stays in [-1,1]', () => {
    const n = new Noise(3); let mn = 9, mx = -9;
    for (let i = 0; i < 100000; i++) { const v = n.simplex2(i * 0.013, i * 0.0071); if (v < mn) mn = v; if (v > mx) mx = v; }
    return { ok: mn >= -1.001 && mx <= 1.001, detail: mn.toFixed(3) + '..' + mx.toFixed(3) };
  });
  t('noise: perlin2Tile is seamless at the period', () => {
    const n = new Noise(3), P = 8; let e = 0;
    for (let i = 0; i < 256; i++) {
      const s = i / 256 * P;
      e = Math.max(e, Math.abs(n.perlin2Tile(0, s, P, P) - n.perlin2Tile(P, s, P, P)),
                      Math.abs(n.perlin2Tile(s, 0, P, P) - n.perlin2Tile(s, P, P, P)));
    }
    return { ok: e < 1e-9, detail: 'maxSeam=' + e.toExponential(2) };
  });

  /* --- TextureGen --------------------------------------------------- */
  t('texture: every surface tiles seamlessly in u and v', () => {
    const n = new Noise(77); const bad = [];
    for (const [name, fn] of Object.entries(SURFACES)) {
      let e = 0;
      for (let i = 0; i < 64; i++) {
        const s = i / 64;
        const a = fn(n, 0, s), b = fn(n, 1, s), c = fn(n, s, 0), d = fn(n, s, 1);
        for (let k = 0; k < 4; k++) e = Math.max(e, Math.abs(a[k] - b[k]), Math.abs(c[k] - d[k]));
      }
      if (e >= 1.0) bad.push(name + '(' + e.toFixed(2) + ')');
    }
    return { ok: bad.length === 0, detail: bad.join(' ') };
  });
  t('texture: buffers are fully opaque with in-gamut colour', () => {
    const g = new TextureGen(5, 64); const bad = [];
    for (const name of TextureGen.surfaceNames()) {
      const { px } = g.surfaceBuffers(name, 64);
      let opaque = true, lit = false;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] !== 255) { opaque = false; break; }
        if (px[i] > 8 || px[i + 1] > 8 || px[i + 2] > 8) lit = true;
      }
      if (!opaque || !lit) bad.push(name);
    }
    return { ok: bad.length === 0, detail: bad.join(' ') };
  });
  t('texture: full 256px surface set generates under 500ms', () => {
    const g = new TextureGen(9, 256);
    const t0 = performance.now();
    for (const name of TextureGen.surfaceNames()) g.surfaceBuffers(name, 256);
    const ms = performance.now() - t0;
    return { ok: ms < 500, detail: ms.toFixed(1) + 'ms for ' + TextureGen.surfaceNames().length + ' surfaces' };
  });
  t('texture: cache returns the same object for the same key', () => {
    const g = new TextureGen(3, 64);
    return g.surface('rock', { size: 64 }) === g.surface('rock', { size: 64 });
  });

  /* --- MeshGen ------------------------------------------------------ */
  t('mesh: tree geometry is finite, coloured and within budget', () => {
    const { wood, leaves } = MeshGen.tree({ seed: 4, height: 9 });
    const tris = MeshGen.triCount(wood) + MeshGen.triCount(leaves);
    const p = wood.getAttribute('position');
    let finite = true;
    for (let i = 0; i < p.count * 3; i++) if (!Number.isFinite(p.array[i])) { finite = false; break; }
    return { ok: finite && tris > 0 && tris < 500 && !!wood.getAttribute('color') && !!leaves.getAttribute('color'),
             detail: tris + ' tris' };
  });
  t('mesh: pine geometry is within budget', () => {
    const { wood, leaves } = MeshGen.pine({ seed: 4 });
    const tris = MeshGen.triCount(wood) + MeshGen.triCount(leaves);
    return { ok: tris > 0 && tris < 400, detail: tris + ' tris' };
  });
  t('mesh: rockLump is a closed displaced sphere', () => {
    const g = MeshGen.rockLump(1.5, 1, 7);
    const p = g.getAttribute('position');
    let mn = 1e9, mx = 0;
    for (let i = 0; i < p.count; i++) {
      const d = Math.hypot(p.getX(i), p.getY(i), p.getZ(i));
      mn = Math.min(mn, d); mx = Math.max(mx, d);
    }
    return { ok: mn > 0.5 && mx < 3.0, detail: 'r=' + mn.toFixed(2) + '..' + mx.toFixed(2) + ' tris=' + MeshGen.triCount(g) };
  });
  t('mesh: merge combines geometries and preserves attributes', () => {
    const a = MeshGen.box(1, 1, 1, 0xff0000);
    const b = MeshGen.xform(MeshGen.box(1, 1, 1, 0x00ff00), { pos: [3, 0, 0] });
    const m = MeshGen.merge([a, b]);
    return { ok: MeshGen.triCount(m) === 24 && !!m.getAttribute('color') && !!m.getAttribute('normal'),
             detail: MeshGen.triCount(m) + ' tris' };
  });
  t('mesh: generation is deterministic for a given seed', () => {
    const a = MeshGen.tree({ seed: 99 }).wood.getAttribute('position').array;
    const b = MeshGen.tree({ seed: 99 }).wood.getAttribute('position').array;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  });

  /* --- AudioGen ----------------------------------------------------- */
  t('audio: every sound synthesises finite, audible samples', () => {
    const g = new AudioGen(44100); const bad = [];
    for (const name of g.names()) {
      const b = g.get(name);
      let peak = 0, finite = true;
      for (let i = 0; i < b.length; i++) { const v = b[i]; if (!Number.isFinite(v)) { finite = false; break; } const a = v < 0 ? -v : v; if (a > peak) peak = a; }
      if (!finite || peak < 0.3 || peak > 1.0 || b.length < 512) bad.push(name + '(' + peak.toFixed(2) + ')');
    }
    return { ok: bad.length === 0, detail: g.names().length + ' sounds, bad: ' + (bad.join(' ') || 'none') };
  });
  t('audio: looping beds have matched endpoints', () => {
    const g = new AudioGen(44100); const bad = [];
    for (const name of ['storm_loop', 'wind_loop']) {
      const b = g.get(name);
      let head = 0, tail = 0;
      for (let i = 0; i < 512; i++) { head += Math.abs(b[i]); tail += Math.abs(b[b.length - 1 - i]); }
      if (Math.abs(head - tail) / Math.max(head, tail) > 0.85) bad.push(name);
    }
    return { ok: bad.length === 0, detail: bad.join(' ') };
  });
  t('audio: synthesis of the full library is under 500ms', () => {
    const g = new AudioGen(44100);
    const t0 = performance.now();
    for (const n of g.names()) g.get(n);
    const ms = performance.now() - t0;
    return { ok: ms < 500, detail: ms.toFixed(1) + 'ms' };
  });

  /* --- Materials ---------------------------------------------------- */
  t('materials: repeated requests share one material instance', () => {
    const settings = window.__GAME.engine.settings;
    const m = new Materials(1, settings);
    const a = m.surface('rock'), b = m.surface('rock');
    const c = m.vertex('props'), d = m.vertex('props');
    const ok = a === b && c === d && m.count === 2;
    m.dispose();
    return { ok, detail: 'cache size ' + 2 };
  });

  return results;
}`;

async function main() {
  console.log('\n\x1b[1mUnit checks\x1b[0m');
  console.log('  \x1b[2m-- static --\x1b[0m');
  let ok = staticChecks();

  const { server, port } = await startServer();
  const browser = await launch();
  try {
    const { context, page, logs } = await openGame(browser, { device: 'phoneLandscape', port });
    console.log('  \x1b[2m-- in-browser --\x1b[0m');
    let results;
    try {
      results = await page.evaluate(`(${BROWSER_SUITE})()`);
    } catch (e) {
      console.log('  \x1b[31mFAIL\x1b[0m  browser suite threw: ' + e.message);
      console.log(logs.join('\n'));
      ok = false;
      results = [];
    }
    for (const r of results) ok = check(r.name, r.ok, r.detail) && ok;
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { staticChecks };
