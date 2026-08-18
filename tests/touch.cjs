/**
 * touch.cjs — scripted verification that the touch controls actually work.
 *
 * These drive real Chromium touch events through CDP (`Input.dispatchTouchEvent`)
 * rather than injecting input state, so the whole path is covered: browser
 * touch -> pointer events -> TouchInput role assignment -> InputHub ->
 * PlayerController. Multi-touch is dispatched as genuinely simultaneous touch
 * points, which is the only way to catch a control layer that silently lets one
 * finger steal another's role.
 *
 * Simulation is advanced with stepSim between dispatches: the container has no
 * GPU, so letting rAF drive the sim would make the suite minutes long and its
 * timing dependent on software rasterisation speed.
 */
const { startServer, launch, openGame, check, fmt } = require('./harness.cjs');

/**
 * Dispatch a raw touch event with an arbitrary set of simultaneous points.
 * CDP requires touchCancel to carry no points — it cancels every active touch.
 */
async function touch(cdp, type, points) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchCancel' ? [] : points.map((p) => ({
      x: Math.round(p.x), y: Math.round(p.y), id: p.id ?? 0,
      radiusX: 12, radiusY: 12, force: 1,
    })),
  });
}

/** Drag one finger from a to b in `steps` moves, stepping the sim as we go. */
async function drag(cdp, page, id, from, to, steps = 8, simPerStep = 0) {
  await touch(cdp, 'touchStart', [{ ...from, id }]);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await touch(cdp, 'touchMove', [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, id }]);
    if (simPerStep) await page.evaluate((n) => window.__GAME.stepSim(n), simPerStep);
  }
}

async function endTouch(cdp, ids) {
  await touch(cdp, 'touchEnd', ids.map((id) => ({ x: 0, y: 0, id })));
}

const S = (page, n) => page.evaluate((k) => window.__GAME.stepSim(k), n);
const reset = (page) => page.evaluate(() => {
  const G = window.__GAME;
  G.input.releaseAll();
  G.input.clearOverride();
  // A real session boots into a match, which parks the player on the battle bus
  // and drives their position. These tests are about the control layer, so the
  // match director, the storm and the bots are all idled: a firefight in the
  // background would move the player and pollute the weapon counters.
  const md = G.engine.services.peek('match');
  if (md) { md.state = 0; if (md.busMesh) md.busMesh.visible = false; }
  const stormSys = G.engine.services.peek('storm');
  if (stormSys) stormSys.active = false;
  const bots = G.engine.services.peek('bots');
  if (bots) { for (const b of bots.bots) b.alive = false; bots.aliveCount = 0; }
  const p = G.engine.services.get('player');
  const t = G.engine.services.get('terrain');
  const st = G.engine.services.get('structures');
  // Stand on clear, flat ground so movement results are unambiguous.
  for (let r = 0; r < 400; r++) {
    const a = r * 2.399, rad = 12 + r * 1.1;
    const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
    if (t.heightAt(x, z) < 4.5) continue;
    if (t.slopeAt(x, z) < 0.985) continue;
    if (st.insidePoi(x, z, 20)) continue;
    const out = [];
    G.engine.services.get('colliders').query(x - 3, t.heightAt(x, z) - 1, z - 3, x + 3, t.heightAt(x, z) + 4, z + 3, out);
    if (out.length) continue;
    p.spawnAt(x, z, 0);
    break;
  }
  p.yaw = 0; p.pitch = 0;
  p.body.vel.set(0, 0, 0);
  p.crouching = false;
  p.health = 100; p.shield = 0; p.alive = true;
  G.stepSim(10);
  return p.state();
});

async function main() {
  console.log('\n\x1b[1mTouch controls\x1b[0m (real Chromium touch events via CDP)');
  const { server, port } = await startServer();
  const browser = await launch();
  let ok = true;

  try {
    const { context, page, logs, profile } = await openGame(browser, {
      device: 'phoneLandscape', port, query: { adaptive: '0' },
    });
    const cdp = await context.newCDPSession(page);
    await page.evaluate(() => window.__GAME.deterministic(true));

    const rects = await page.evaluate(() => window.__GAME.input.touchRects());
    const VW = rects._viewport.w, VH = rects._viewport.h;
    console.log(`  viewport ${VW}x${VH} css, dpr ${profile.deviceScaleFactor}`);

    // Points that are guaranteed to be in the movement / look zones and clear
    // of every button hit rectangle.
    const MOVE_PT = { x: VW * 0.16, y: VH * 0.66 };
    const LOOK_PT = { x: VW * 0.60, y: VH * 0.22 };

    /* --- 1. movement stick -------------------------------------------- */
    {
      const before = await reset(page);
      await touch(cdp, 'touchStart', [{ ...MOVE_PT, id: 1 }]);
      const stickShown = await page.evaluate(() => window.__GAME.input.touch().stickActive);
      // Push the stick fully "up" = forward.
      await touch(cdp, 'touchMove', [{ x: MOVE_PT.x, y: MOVE_PT.y - 80, id: 1 }]);
      await S(page, 90);
      const moveVec = await page.evaluate(() => window.__GAME.input.raw().move);
      await endTouch(cdp, [1]);
      await S(page, 2);
      const after = await page.evaluate(() => window.__GAME.state().player);
      const released = await page.evaluate(() => window.__GAME.input.raw().move);

      const dx = after.pos[0] - before.pos[0], dz = after.pos[2] - before.pos[2];
      const dist = Math.hypot(dx, dz);
      ok = check('stick appears where the thumb lands', stickShown === true) && ok;
      ok = check('stick pushed forward yields full-magnitude input',
        moveVec.y > 0.9 && Math.abs(moveVec.x) < 0.1, `move=(${fmt(moveVec.x)}, ${fmt(moveVec.y)})`) && ok;
      ok = check('player walks forward at least 2m',
        dist > 2 && -dz > 2, `moved ${fmt(dist)}m (forward ${fmt(-dz)}m)`) && ok;
      ok = check('releasing the stick zeroes movement',
        released.x === 0 && released.y === 0, `move=(${released.x}, ${released.y})`) && ok;
    }

    /* --- 2. look drag --------------------------------------------------- */
    {
      await reset(page);
      const y0 = await page.evaluate(() => window.__GAME.state().player.yaw);
      await drag(cdp, page, 2, LOOK_PT, { x: LOOK_PT.x - 220, y: LOOK_PT.y }, 10);
      await S(page, 2);
      const y1 = await page.evaluate(() => window.__GAME.state().player.yaw);
      await endTouch(cdp, [2]);

      await reset(page);
      const p0 = await page.evaluate(() => window.__GAME.state().player.pitch);
      await drag(cdp, page, 3, LOOK_PT, { x: LOOK_PT.x, y: LOOK_PT.y + 140 }, 10);
      await S(page, 2);
      const p1 = await page.evaluate(() => window.__GAME.state().player.pitch);
      await endTouch(cdp, [3]);

      const dYaw = y1 - y0, dPitch = p1 - p0;
      ok = check('horizontal drag turns the view', Math.abs(dYaw) > 0.3,
        `yaw changed ${fmt(dYaw, 3)} rad`) && ok;
      ok = check('dragging left turns left (not inverted)', dYaw > 0, `sign ${dYaw > 0 ? '+' : '-'}`) && ok;
      ok = check('vertical drag pitches the view', Math.abs(dPitch) > 0.15,
        `pitch changed ${fmt(dPitch, 3)} rad`) && ok;
      ok = check('dragging down looks down (not inverted)', dPitch < 0, `sign ${dPitch > 0 ? '+' : '-'}`) && ok;
    }

    /* --- 3. simultaneous move + look ------------------------------------ */
    {
      const before = await reset(page);
      // Both fingers down at once, then both move in the same dispatches.
      await touch(cdp, 'touchStart', [{ ...MOVE_PT, id: 4 }]);
      await touch(cdp, 'touchStart', [{ ...MOVE_PT, id: 4 }, { ...LOOK_PT, id: 5 }]);
      for (let i = 1; i <= 10; i++) {
        await touch(cdp, 'touchMove', [
          { x: MOVE_PT.x, y: MOVE_PT.y - 80, id: 4 },
          { x: LOOK_PT.x - i * 18, y: LOOK_PT.y, id: 5 },
        ]);
        await S(page, 6);
      }
      const st = await page.evaluate(() => ({
        touch: window.__GAME.input.touch(),
        player: window.__GAME.state().player,
      }));
      await endTouch(cdp, [4, 5]);
      await S(page, 2);

      const roles = st.touch.pointers.map((p) => p.role).sort().join(',');
      const dist = Math.hypot(st.player.pos[0] - before.pos[0], st.player.pos[2] - before.pos[2]);
      const dYaw = Math.abs(st.player.yaw - before.yaw);
      ok = check('two fingers hold distinct roles (move + look)', roles === '1,2', `roles=[${roles}]`) && ok;
      ok = check('moving and looking work at the same time',
        dist > 2 && dYaw > 0.3, `moved ${fmt(dist)}m while turning ${fmt(dYaw, 2)} rad`) && ok;
    }

    /* --- 4. buttons ----------------------------------------------------- */
    const tapButton = async (name, id = 9) => {
      const r = rects[name];
      await touch(cdp, 'touchStart', [{ x: r.x, y: r.y, id }]);
      const down = await page.evaluate((n) => window.__GAME.input.raw()[n], name.startsWith('slot') || name.startsWith('piece') ? 'fire' : name);
      await touch(cdp, 'touchEnd', [{ x: r.x, y: r.y, id }]);
      return down;
    };

    {
      await reset(page);
      // Arm a rifle so the button's effect on the weapon can be observed.
      const before = await page.evaluate(async () => {
        const { makeWeapon } = await import('/src/combat/Weapons.js');
        const c = window.__GAME.engine.services.get('combat');
        c.slots[1] = makeWeapon('ar', 'rare');
        c.selectSlot(1);
        c.reserveAmmo.medium = 200;
        c.weapon.ammo = c.weapon.magSize;
        c.weapon.cooldown = 0;
        return c.state();
      });
      const r = rects.fire;
      await touch(cdp, 'touchStart', [{ x: r.x, y: r.y, id: 10 }]);
      const heldDown = await page.evaluate(() => window.__GAME.input.raw().fire);
      await S(page, 4);
      const stateDuring = await page.evaluate(() => window.__GAME.input.state().fire);
      const during = await page.evaluate(() => window.__GAME.state().combat);
      await touch(cdp, 'touchEnd', [{ x: r.x, y: r.y, id: 10 }]);
      await S(page, 2);
      const afterUp = await page.evaluate(() => window.__GAME.input.raw().fire);
      ok = check('FIRE is held while pressed and released on lift',
        heldDown === true && stateDuring === true && afterUp === false,
        `down=${heldDown} state=${stateDuring} up=${afterUp}`) && ok;
      ok = check('FIRE actually discharges the weapon',
        during.ammo < before.ammo && during.stats.playerShots > 0,
        `ammo ${before.ammo} -> ${during.ammo}, ${during.stats.playerShots} shot(s)`) && ok;

      // Holding fire must keep firing, bounded by the weapon's fire rate.
      await touch(cdp, 'touchStart', [{ x: r.x, y: r.y, id: 30 }]);
      await S(page, 60);
      const held = await page.evaluate(() => window.__GAME.state().combat);
      await touch(cdp, 'touchEnd', [{ x: r.x, y: r.y, id: 30 }]);
      const fired = held.stats.playerShots - during.stats.playerShots;
      ok = check('holding FIRE sustains automatic fire at the weapon rate',
        fired >= 4 && fired <= 7, `${fired} shots in 1s (AR fires 5.5/s)`) && ok;
    }

    {
      await reset(page);
      const r = rects.jump;
      const y0 = await page.evaluate(() => window.__GAME.state().player.pos[1]);
      await touch(cdp, 'touchStart', [{ x: r.x, y: r.y, id: 11 }]);
      await S(page, 6);
      const mid = await page.evaluate(() => window.__GAME.state().player);
      await touch(cdp, 'touchEnd', [{ x: r.x, y: r.y, id: 11 }]);
      await S(page, 80);
      const end = await page.evaluate(() => window.__GAME.state().player);
      ok = check('JUMP leaves the ground and lands again',
        mid.grounded === false && mid.pos[1] > y0 + 0.2 && end.grounded === true,
        `rose ${fmt(mid.pos[1] - y0)}m, airborne=${!mid.grounded}, landed=${end.grounded}`) && ok;
    }

    {
      await reset(page);
      const r = rects.crouch;
      const h0 = await page.evaluate(() => window.__GAME.state().player.height);
      await touch(cdp, 'touchStart', [{ x: r.x, y: r.y, id: 12 }]);
      await S(page, 10);
      const h1 = await page.evaluate(() => window.__GAME.state().player.height);
      await touch(cdp, 'touchEnd', [{ x: r.x, y: r.y, id: 12 }]);
      await S(page, 10);
      const h2 = await page.evaluate(() => window.__GAME.state().player.height);
      ok = check('CROUCH lowers the capsule and standing restores it',
        h1 < h0 - 0.3 && Math.abs(h2 - h0) < 0.01, `height ${fmt(h0)} -> ${fmt(h1)} -> ${fmt(h2)}`) && ok;
    }

    {
      await reset(page);
      const r = rects.aim;
      await touch(cdp, 'touchStart', [{ x: r.x, y: r.y, id: 13 }]);
      await S(page, 6);
      const aiming = await page.evaluate(() => window.__GAME.state().player.aiming);
      await touch(cdp, 'touchEnd', [{ x: r.x, y: r.y, id: 13 }]);
      await S(page, 4);
      const after = await page.evaluate(() => window.__GAME.state().player.aiming);
      ok = check('ADS engages while held', aiming === true && after === false,
        `aiming ${aiming} -> ${after}`) && ok;
    }

    {
      await reset(page);
      const before = await page.evaluate(async () => {
        const { makeWeapon } = await import('/src/combat/Weapons.js');
        const c = window.__GAME.engine.services.get('combat');
        c.slots[1] = makeWeapon('ar', 'common');
        c.selectSlot(1);
        c.reserveAmmo.medium = 200;
        c.weapon.ammo = 4;                 // partially spent magazine
        c.reloading = false;
        return c.state();
      });
      const r = rects.reload;
      await touch(cdp, 'touchStart', [{ x: r.x, y: r.y, id: 14 }]);
      const down = await page.evaluate(() => window.__GAME.input.raw().reload);
      await S(page, 3);
      const started = await page.evaluate(() => window.__GAME.state().combat.reloading);
      await touch(cdp, 'touchEnd', [{ x: r.x, y: r.y, id: 14 }]);
      await S(page, 160);                  // longer than any reload
      const after = await page.evaluate(() => window.__GAME.state().combat);
      ok = check('RELOAD registers press and release', down === true) && ok;
      ok = check('RELOAD refills the magazine from reserve',
        started === true && after.reloading === false && after.ammo === after.magSize
        && after.reserve.medium === before.reserve.medium - (after.magSize - before.ammo),
        `ammo ${before.ammo} -> ${after.ammo}/${after.magSize}, reserve ${before.reserve.medium} -> ${after.reserve.medium}`) && ok;
    }

    /* --- 5. quickbar ---------------------------------------------------- */
    {
      await reset(page);
      const r = rects.slot2;
      await touch(cdp, 'touchStart', [{ x: r.x, y: r.y, id: 15 }]);
      const sel = await page.evaluate(() => ({
        slot: window.__GAME.input.raw().slot,
        active: window.__GAME.input.touch().activeSlot,
      }));
      await touch(cdp, 'touchEnd', [{ x: r.x, y: r.y, id: 15 }]);
      await S(page, 2);
      ok = check('quickbar tap selects that slot',
        sel.slot === 2 && sel.active === 2, `slot=${sel.slot} highlighted=${sel.active}`) && ok;
    }

    /* --- 6. build mode toggle ------------------------------------------- */
    {
      await reset(page);
      const r = rects.buildMode;
      await touch(cdp, 'touchStart', [{ x: r.x, y: r.y, id: 16 }]);
      await touch(cdp, 'touchEnd', [{ x: r.x, y: r.y, id: 16 }]);
      await S(page, 2);
      const onState = await page.evaluate(() => ({
        build: window.__GAME.input.state().buildMode,
        touch: window.__GAME.input.touch().buildMode,
      }));
      // The piece bar replaces the weapon bar while building.
      const barsWhileBuilding = await page.evaluate(() => {
        const t = window.__GAME.input.touchRects();
        return { piece0: !t.piece0.hidden, slot0: !t.slot0.hidden };
      });
      await touch(cdp, 'touchStart', [{ x: r.x, y: r.y, id: 17 }]);
      await touch(cdp, 'touchEnd', [{ x: r.x, y: r.y, id: 17 }]);
      await S(page, 2);
      const offState = await page.evaluate(() => window.__GAME.input.state().buildMode);
      ok = check('BUILD toggles build mode on and off',
        onState.build === true && onState.touch === true && offState === false,
        `on=${onState.build} off=${offState}`) && ok;
      ok = check('build mode swaps the weapon bar for the piece bar',
        barsWhileBuilding.piece0 === true && barsWhileBuilding.slot0 === false,
        `pieceBar=${barsWhileBuilding.piece0} weaponBar=${barsWhileBuilding.slot0}`) && ok;
    }

    /* --- 7. interrupted touches must not stick -------------------------- */
    {
      await reset(page);
      const r = rects.fire;
      await touch(cdp, 'touchStart', [{ ...MOVE_PT, id: 20 }]);
      await touch(cdp, 'touchMove', [{ x: MOVE_PT.x, y: MOVE_PT.y - 80, id: 20 }]);
      await touch(cdp, 'touchStart', [{ x: MOVE_PT.x, y: MOVE_PT.y - 80, id: 20 }, { x: r.x, y: r.y, id: 21 }]);
      await S(page, 4);
      const before = await page.evaluate(() => window.__GAME.input.raw());
      // A system gesture or incoming call cancels every active touch.
      await touch(cdp, 'touchCancel', []);
      await S(page, 4);
      const after = await page.evaluate(() => ({
        raw: window.__GAME.input.raw(),
        touch: window.__GAME.input.touch(),
      }));
      ok = check('a cancelled touch releases movement and buttons',
        before.move.y > 0.5 && before.fire === true
        && after.raw.move.x === 0 && after.raw.move.y === 0 && after.raw.fire === false
        && after.touch.pointers.length === 0 && after.touch.stickActive === false,
        `before move.y=${fmt(before.move.y)} fire=${before.fire}; after move=(${after.raw.move.x},${after.raw.move.y}) fire=${after.raw.fire} pointers=${after.touch.pointers.length}`) && ok;
    }

    /* --- 8. sliding off a button releases it ---------------------------- */
    {
      await reset(page);
      const r = rects.fire;
      await touch(cdp, 'touchStart', [{ x: r.x, y: r.y, id: 22 }]);
      const held = await page.evaluate(() => window.__GAME.input.raw().fire);
      await touch(cdp, 'touchMove', [{ x: r.x - 220, y: r.y - 120, id: 22 }]);
      const slid = await page.evaluate(() => window.__GAME.input.raw().fire);
      await touch(cdp, 'touchMove', [{ x: r.x, y: r.y, id: 22 }]);
      const back = await page.evaluate(() => window.__GAME.input.raw().fire);
      await touch(cdp, 'touchEnd', [{ x: r.x, y: r.y, id: 22 }]);
      ok = check('sliding off a held button releases it, sliding back re-arms',
        held === true && slid === false && back === true,
        `held=${held} slidOff=${slid} slidBack=${back}`) && ok;
    }

    /* --- 9. dead zone and range ----------------------------------------- */
    {
      await reset(page);
      await touch(cdp, 'touchStart', [{ ...MOVE_PT, id: 23 }]);
      await touch(cdp, 'touchMove', [{ x: MOVE_PT.x + 4, y: MOVE_PT.y - 4, id: 23 }]);
      const tiny = await page.evaluate(() => window.__GAME.input.raw().move);
      await touch(cdp, 'touchMove', [{ x: MOVE_PT.x + 400, y: MOVE_PT.y, id: 23 }]);
      const huge = await page.evaluate(() => window.__GAME.input.raw().move);
      await endTouch(cdp, [23]);
      const mag = Math.hypot(huge.x, huge.y);
      ok = check('tiny stick movement is inside the dead zone',
        tiny.x === 0 && tiny.y === 0, `move=(${tiny.x}, ${tiny.y})`) && ok;
      ok = check('stick magnitude is clamped to 1',
        mag > 0.95 && mag <= 1.001 && huge.x > 0.95, `|move|=${fmt(mag, 3)}`) && ok;
    }

    /* --- 10. buttons never steal the look zone -------------------------- */
    {
      await reset(page);
      const y0 = await page.evaluate(() => window.__GAME.state().player.yaw);
      const r = rects.fire;
      // Press fire, then drag a *different* finger in the look zone.
      await touch(cdp, 'touchStart', [{ x: r.x, y: r.y, id: 24 }]);
      await touch(cdp, 'touchStart', [{ x: r.x, y: r.y, id: 24 }, { ...LOOK_PT, id: 25 }]);
      for (let i = 1; i <= 8; i++) {
        await touch(cdp, 'touchMove', [
          { x: r.x, y: r.y, id: 24 },
          { x: LOOK_PT.x - i * 22, y: LOOK_PT.y, id: 25 },
        ]);
      }
      await S(page, 3);
      const st = await page.evaluate(() => ({ yaw: window.__GAME.state().player.yaw, fire: window.__GAME.input.raw().fire }));
      await endTouch(cdp, [24, 25]);
      ok = check('firing and turning at the same time both register',
        st.fire === true && Math.abs(st.yaw - y0) > 0.3,
        `fire=${st.fire}, yaw moved ${fmt(Math.abs(st.yaw - y0), 2)} rad`) && ok;
    }

    const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
    ok = check('no page errors during touch interaction', errs.length === 0, errs.slice(0, 2).join(' | ')) && ok;

    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
