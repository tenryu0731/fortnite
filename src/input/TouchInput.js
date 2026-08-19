import { blankInputState } from './InputState.js';

/**
 * TouchInput — multi-touch controls for phone browsers.
 *
 * Design decisions that matter on a real device:
 *
 *  - The movement stick is *floating*: it appears wherever the thumb lands in
 *    the left zone. A fixed stick forces the player to look at the screen to
 *    find it; a floating one can be grabbed blind, which is what makes
 *    move-and-shoot possible with two thumbs.
 *  - Every pointer is tracked by `pointerId` and owns exactly one role for its
 *    whole lifetime. Without that, a second finger landing while the first is
 *    dragging steals the look camera and the view snaps.
 *  - Buttons capture their pointer, so sliding a thumb off a button keeps it
 *    held rather than releasing mid-fight. Their hit areas are inflated well
 *    past their visual bounds because thumbs are imprecise and the visual size
 *    is limited by how much screen the controls are allowed to eat.
 *  - `pointercancel` (system gesture, notification shade, call) releases the
 *    role immediately; otherwise the player is left sprinting into a wall.
 *  - Look uses raw per-frame deltas with no smoothing filter. Smoothing adds
 *    latency, and on touch the finger is already the low-pass filter.
 */

const ROLE = { NONE: 0, MOVE: 1, LOOK: 2, BUTTON: 3 };

const BUTTONS = [
  // id,      label,  class,        role
  { id: 'fire', label: 'FIRE', cls: 'b-fire' },
  { id: 'jump', label: 'JUMP', cls: 'b-jump' },
  { id: 'aim', label: 'ADS', cls: 'b-aim' },
  { id: 'crouch', label: 'CRCH', cls: 'b-crouch' },
  { id: 'reload', label: 'RLD', cls: 'b-reload' },
  { id: 'harvest', label: 'PICK', cls: 'b-harvest' },
  { id: 'interact', label: 'USE', cls: 'b-interact' },
  { id: 'buildMode', label: 'BUILD', cls: 'b-build', toggle: true },
  { id: 'editMode', label: 'EDIT', cls: 'b-edit', toggle: true },
  { id: 'buildRotate', label: 'ROT', cls: 'b-rotate' },
  { id: 'useItem', label: 'HEAL', cls: 'b-item' },
  { id: 'deploy', label: 'DROP', cls: 'b-deploy' },
];

const SLOTS = 5;
const PIECES = ['WALL', 'FLOOR', 'RAMP', 'CONE'];

export class TouchInput {
  constructor(hub, root, settings) {
    this.hub = hub;
    this.settings = settings;
    this.pointers = new Map();          // pointerId -> { role, ... }
    this.stickActive = false;
    this.stickCentre = { x: 0, y: 0 };
    this.stickRadius = 64;
    this.deadZone = 0.14;
    this.enabled = true;
    this.buildMode = false;
    this.editMode = false;
    this.portrait = null;
    this.activeSlot = 0;
    this.activePiece = 0;
    this._lastTapTime = 0;
    this._lastTapX = 0;
    this._lastTapY = 0;
    this.stats = { downs: 0, moves: 0, ups: 0, cancels: 0 };

    this._buildDom(root);
    this._bind();
    this.layout();
  }

  /* ------------------------------------------------------------------ */
  /* DOM                                                                 */
  /* ------------------------------------------------------------------ */

  _buildDom(root) {
    const layer = document.createElement('div');
    layer.id = 'touch-layer';
    layer.className = 'touch-layer';

    // Floating stick, hidden until a thumb lands in the move zone.
    const stick = document.createElement('div');
    stick.className = 'stick';
    stick.innerHTML = '<div class="stick-ring"></div><div class="stick-knob"></div>';
    layer.appendChild(stick);
    const hint = document.createElement('div');
    hint.className = 'stick-hint';
    layer.appendChild(hint);
    this.stickHintEl = hint;
    this.stickEl = stick;
    this.knobEl = stick.querySelector('.stick-knob');

    this.buttonEls = new Map();
    for (const b of BUTTONS) {
      const el = document.createElement('div');
      el.className = `tbtn ${b.cls}`;
      el.dataset.btn = b.id;
      el.innerHTML = `<span class="tbtn-label">${b.label}</span>`;
      layer.appendChild(el);
      this.buttonEls.set(b.id, el);
    }

    // Quickbar doubles as the weapon bar and, in build mode, the piece picker.
    const bar = document.createElement('div');
    bar.className = 'quickbar';
    this.slotEls = [];
    for (let i = 0; i < SLOTS; i++) {
      const s = document.createElement('div');
      s.className = 'qslot';
      s.dataset.slot = String(i);
      s.innerHTML = `<span class="qslot-key">${i + 1}</span><span class="qslot-name"></span>`;
      bar.appendChild(s);
      this.slotEls.push(s);
    }
    layer.appendChild(bar);
    this.quickbarEl = bar;

    const pieceBar = document.createElement('div');
    pieceBar.className = 'piecebar';
    this.pieceEls = [];
    for (let i = 0; i < PIECES.length; i++) {
      const s = document.createElement('div');
      s.className = 'qpiece';
      s.dataset.piece = String(i);
      s.innerHTML = `<span class="qpiece-name">${PIECES[i]}</span>`;
      pieceBar.appendChild(s);
      this.pieceEls.push(s);
    }
    layer.appendChild(pieceBar);
    this.pieceBarEl = pieceBar;

    // Landscape gate. A build-fight needs both thumbs on a wide screen; every
    // control here is laid out for landscape, and squeezing them into a tall
    // viewport puts the fire button on top of the weapon bar. Rather than ship
    // a second cramped layout, portrait is gated with a prompt and input is
    // suspended until the device is turned.
    const gate = document.createElement('div');
    gate.className = 'rotate-gate';
    gate.innerHTML = `
      <div class="rotate-inner">
        <div class="rotate-icon"><div class="rotate-phone"></div></div>
        <div class="rotate-title">画面を横向きにしてください</div>
        <div class="rotate-sub">Rotate your device to landscape</div>
      </div>`;
    root.appendChild(gate);
    this.gateEl = gate;

    root.appendChild(layer);
    this.layerEl = layer;
    this.setBuildMode(false);
    this.setActiveSlot(0);
    this.setActivePiece(0);
  }

  /** Hit areas are inflated past the visual bounds; thumbs are imprecise. */
  _hitRect(el) {
    const r = el.getBoundingClientRect();
    const padX = r.width * 0.25, padY = r.height * 0.25;
    return { l: r.left - padX, t: r.top - padY, r: r.right + padX, b: r.bottom + padY };
  }

  layout() {
    const w = window.innerWidth, h = window.innerHeight;
    this.vw = w; this.vh = h;
    this.setPortrait(h > w * 1.02);
    // Stick radius scales with the short edge, clamped to a comfortable range.
    this.stickRadius = Math.max(48, Math.min(96, Math.min(w, h) * 0.17));
    this.layerEl.style.setProperty('--stick-r', `${this.stickRadius}px`);
    this.layerEl.classList.toggle('left-handed', !!this.settings.user.leftHanded);
    this._rects = null;
  }

  /** Suspend play and show the rotate prompt while the device is upright. */
  setPortrait(isPortrait) {
    if (isPortrait === this.portrait) return;
    this.portrait = isPortrait;
    document.body.classList.toggle('portrait-gate', isPortrait);
    if (isPortrait) {
      this.releaseAll();
      this.hub.enabled = false;
    } else {
      this.hub.enabled = true;
    }
    this._rects = null;
  }

  /** Cached button hit rectangles; invalidated on resize and mode change. */
  _rects_() {
    if (!this._rects) {
      this._rects = [];
      for (const [id, el] of this.buttonEls) {
        if (el.offsetParent === null) continue;   // hidden by class or display
        this._rects.push({ id, kind: 'btn', ...this._hitRect(el) });
      }
      const bar = this.buildMode ? this.pieceEls : this.slotEls;
      bar.forEach((el, i) => {
        if (el.offsetParent === null) return;
        this._rects.push({ id: i, kind: this.buildMode ? 'piece' : 'slot', ...this._hitRect(el) });
      });
    }
    return this._rects;
  }

  _hitTest(x, y) {
    for (const r of this._rects_()) {
      if (x >= r.l && x <= r.r && y >= r.t && y <= r.b) return r;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* pointer handling                                                    */
  /* ------------------------------------------------------------------ */

  _bind() {
    const el = this.layerEl;
    this._onDown = (e) => this.onPointerDown(e);
    this._onMove = (e) => this.onPointerMove(e);
    this._onUp = (e) => this.onPointerUp(e);
    this._onCancel = (e) => this.onPointerCancel(e);
    el.addEventListener('pointerdown', this._onDown, { passive: false });
    el.addEventListener('pointermove', this._onMove, { passive: false });
    el.addEventListener('pointerup', this._onUp, { passive: false });
    el.addEventListener('pointercancel', this._onCancel, { passive: false });
    el.addEventListener('pointerleave', this._onCancel, { passive: false });
    el.addEventListener('lostpointercapture', this._onCancel, { passive: false });
    // Suppress the browser's own gestures inside the control layer.
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('dragstart', (e) => e.preventDefault());
    this._onResize = () => this.layout();
    window.addEventListener('resize', this._onResize, { passive: true });
    window.addEventListener('orientationchange', this._onResize, { passive: true });
    // A tab switch or a call must not leave a button stuck down.
    this._onBlur = () => this.releaseAll();
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
  }

  /** Which zone a fresh pointer belongs to, honouring left-handed layout. */
  _zoneFor(x, y) {
    const lefty = !!this.settings.user.leftHanded;
    const inLeftHalf = x < this.vw * 0.46;
    const moveSide = lefty ? !inLeftHalf : inLeftHalf;
    // The move zone is the lower portion of its half; the upper part is look,
    // so a player can still swing the camera with the movement thumb's hand.
    return (moveSide && y > this.vh * 0.34) ? ROLE.MOVE : ROLE.LOOK;
  }

  onPointerDown(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this.stats.downs++;
    const x = e.clientX, y = e.clientY;

    const hit = this._hitTest(x, y);
    if (hit) {
      this.pointers.set(e.pointerId, { role: ROLE.BUTTON, hit });
      try { this.layerEl.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
      this._activateHit(hit, true);
      return;
    }

    const zone = this._zoneFor(x, y);
    if (zone === ROLE.MOVE && !this.stickActive) {
      this.stickActive = true;
      this.stickCentre.x = x; this.stickCentre.y = y;
      this.pointers.set(e.pointerId, { role: ROLE.MOVE });
      this.stickEl.classList.add('active');
      this.layerEl.classList.add('stick-down');
      this.stickEl.style.left = `${x}px`;
      this.stickEl.style.top = `${y}px`;
      this._setKnob(0, 0);
      this.hub.setMove(0, 0);
      return;
    }

    // Look pointer. A quick double tap in the look zone latches fire, which is
    // the standard mobile shooter shortcut for shooting without the fire thumb.
    // The double-tap window is a human-timing threshold, not simulation state,
    // so it is measured against real elapsed time.
    const now = performance.now(); // allow-wallclock
    const isDoubleTap = now - this._lastTapTime < 260
      && Math.hypot(x - this._lastTapX, y - this._lastTapY) < this.vw * 0.12;
    this._lastTapTime = now; this._lastTapX = x; this._lastTapY = y;
    this.pointers.set(e.pointerId, { role: ROLE.LOOK, lastX: x, lastY: y, tapFire: isDoubleTap, moved: 0 });
    if (isDoubleTap) this.hub.setButton('fire', true);
  }

  onPointerMove(e) {
    if (!this.enabled) return;
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    this.stats.moves++;
    const x = e.clientX, y = e.clientY;

    if (p.role === ROLE.MOVE) {
      let dx = x - this.stickCentre.x;
      let dy = y - this.stickCentre.y;
      const len = Math.hypot(dx, dy);
      const r = this.stickRadius;
      if (len > r) { dx = dx / len * r; dy = dy / len * r; }
      this._setKnob(dx, dy);
      let nx = dx / r, ny = -dy / r;      // screen +y is down; move +y is forward
      const mag = Math.hypot(nx, ny);
      if (mag < this.deadZone) { nx = 0; ny = 0; }
      else {
        // Rescale past the dead zone so the full range stays reachable.
        const scaled = (mag - this.deadZone) / (1 - this.deadZone) / mag;
        nx *= scaled; ny *= scaled;
      }
      this.hub.setMove(nx, ny);
      return;
    }

    if (p.role === ROLE.LOOK) {
      const dx = x - p.lastX, dy = y - p.lastY;
      p.lastX = x; p.lastY = y;
      p.moved += Math.abs(dx) + Math.abs(dy);
      const u = this.settings.user;
      // Aiming scales sensitivity down; the FOV is narrower, so the same
      // finger travel would otherwise sweep far more of the world.
      const aimScale = this.hub.state.aim ? u.adsSensitivityScale : 1;
      const s = u.lookSensitivity * 0.0055 * aimScale;
      this.hub.addLook(-dx * s, (u.invertY ? 1 : -1) * dy * s);
      return;
    }

    if (p.role === ROLE.BUTTON && p.hit.kind === 'btn') {
      // Sliding well outside a held button releases it, so a player can bail
      // out of a mis-press without lifting and re-tapping.
      const el = this.buttonEls.get(p.hit.id);
      if (el) {
        const r = this._hitRect(el);
        const far = x < r.l - 40 || x > r.r + 40 || y < r.t - 40 || y > r.b + 40;
        if (far && !p.released) { this._activateHit(p.hit, false); p.released = true; }
        else if (!far && p.released) { this._activateHit(p.hit, true); p.released = false; }
      }
    }
  }

  onPointerUp(e) { this._release(e, false); }
  onPointerCancel(e) { this.stats.cancels++; this._release(e, true); }

  _release(e, cancelled) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    if (e.preventDefault) e.preventDefault();
    this.stats.ups++;
    this.pointers.delete(e.pointerId);

    if (p.role === ROLE.MOVE) {
      this.stickActive = false;
      this.stickEl.classList.remove('active');
      this.layerEl.classList.remove('stick-down');
      this._setKnob(0, 0);
      this.hub.setMove(0, 0);
    } else if (p.role === ROLE.LOOK) {
      if (p.tapFire) this.hub.setButton('fire', false);
    } else if (p.role === ROLE.BUTTON) {
      if (!p.released) this._activateHit(p.hit, false, cancelled);
    }
    try { this.layerEl.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  }

  /** Force every role off. Used on blur, visibility change and teardown. */
  releaseAll() {
    for (const [, p] of this.pointers) {
      if (p.role === ROLE.BUTTON && !p.released) this._activateHit(p.hit, false, true);
    }
    this.pointers.clear();
    this.stickActive = false;
    this.stickEl.classList.remove('active');
    this.layerEl.classList.remove('stick-down');
    this._setKnob(0, 0);
    this.hub.setMove(0, 0);
    this.hub.setButton('fire', false);
    for (const b of BUTTONS) if (!b.toggle) this.hub.setButton(b.id, false);
    for (const el of this.buttonEls.values()) el.classList.remove('down');
  }

  _activateHit(hit, down, cancelled = false) {
    if (hit.kind === 'slot') {
      if (down) { this.setActiveSlot(hit.id); this.hub.setSlot(hit.id); this._haptic(8); }
      return;
    }
    if (hit.kind === 'piece') {
      if (down) { this.setActivePiece(hit.id); this.hub.setPiece(hit.id); this._haptic(8); }
      return;
    }
    const def = BUTTONS.find((b) => b.id === hit.id);
    const el = this.buttonEls.get(hit.id);
    if (el) el.classList.toggle('down', !!down);
    if (def && def.toggle) {
      if (!down || cancelled) return;
      const next = !this.hub.raw[hit.id];
      this.hub.setButton(hit.id, next);
      if (hit.id === 'buildMode') this.setBuildMode(next);
      if (hit.id === 'editMode') this.editMode = next;
      el.classList.toggle('on', next);
      el.classList.remove('down');
      this._haptic(12);
      return;
    }
    this.hub.setButton(hit.id, !!down);
    if (down) this._haptic(hit.id === 'fire' ? 6 : 10);
  }

  _setKnob(dx, dy) {
    this.knobEl.style.transform = `translate(-50%, -50%) translate(${dx}px, ${dy}px)`;
  }

  _haptic(ms) {
    if (!this.settings.user.haptics) return;
    if (navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* unsupported */ } }
  }

  /* ------------------------------------------------------------------ */
  /* mode / display                                                      */
  /* ------------------------------------------------------------------ */

  setBuildMode(on) {
    this.buildMode = !!on;
    this.layerEl.classList.toggle('build-mode', this.buildMode);
    this.quickbarEl.classList.toggle('hidden', this.buildMode);
    this.pieceBarEl.classList.toggle('hidden', !this.buildMode);
    for (const id of ['aim', 'reload', 'useItem']) {
      const el = this.buttonEls.get(id);
      if (el) el.classList.toggle('hidden', this.buildMode);
    }
    for (const id of ['buildRotate', 'editMode']) {
      const el = this.buttonEls.get(id);
      if (el) el.classList.toggle('hidden', !this.buildMode);
    }
    const fire = this.buttonEls.get('fire');
    if (fire) fire.querySelector('.tbtn-label').textContent = this.buildMode ? 'PLACE' : 'FIRE';
    this._rects = null;
  }

  setActiveSlot(i) {
    this.activeSlot = i;
    this.slotEls.forEach((el, k) => el.classList.toggle('active', k === i));
  }

  setActivePiece(i) {
    this.activePiece = i;
    this.pieceEls.forEach((el, k) => el.classList.toggle('active', k === i));
  }

  /** Label a weapon slot; called by the inventory system. */
  setSlotLabel(i, name, rarity) {
    const el = this.slotEls[i];
    if (!el) return;
    el.querySelector('.qslot-name').textContent = name || '';
    el.dataset.rarity = rarity || '';
    el.classList.toggle('empty', !name);
  }

  /**
   * Contextual buttons (USE, DROP) default to hidden and are revealed by the
   * game only while they apply; everything else toggles the `hidden` class.
   */
  setButtonVisible(id, visible) {
    const el = this.buttonEls.get(id);
    if (!el) return;
    if (id === 'interact' || id === 'deploy') el.classList.toggle('shown', !!visible);
    else el.classList.toggle('hidden', !visible);
    this._rects = null;
  }

  setButtonLabel(id, label) {
    const el = this.buttonEls.get(id);
    if (el) el.querySelector('.tbtn-label').textContent = label;
  }

  setVisible(v) {
    this.layerEl.classList.toggle('hidden', !v);
    // Rectangles measured while the layer was display:none are all empty and
    // every control is skipped, so the cache must be rebuilt on the way back.
    this._rects = null;
  }

  /** Debug snapshot for the touch test suite. */
  debugState() {
    const roles = [];
    for (const [id, p] of this.pointers) roles.push({ id, role: p.role });
    return {
      pointers: roles,
      stickActive: this.stickActive,
      stickCentre: { ...this.stickCentre },
      buildMode: this.buildMode,
      activeSlot: this.activeSlot,
      activePiece: this.activePiece,
      stats: { ...this.stats },
      portrait: !!this.portrait,
      raw: JSON.parse(JSON.stringify(this.hub.raw)),
    };
  }

  dispose() {
    this.releaseAll();
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    window.removeEventListener('blur', this._onBlur);
    if (this.layerEl.parentNode) this.layerEl.parentNode.removeChild(this.layerEl);
    if (this.gateEl && this.gateEl.parentNode) this.gateEl.parentNode.removeChild(this.gateEl);
  }

  static get ROLE() { return ROLE; }
  static get BUTTONS() { return BUTTONS; }
  static get PIECES() { return PIECES; }
  static blank() { return blankInputState(); }
}
