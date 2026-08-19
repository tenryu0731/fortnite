/**
 * InputHub — the single normalised input surface the gameplay layer reads.
 *
 * Devices (touch, keyboard/mouse) write into `raw`; nothing above this file
 * knows which device produced a value. `look` carries per-frame deltas in
 * radians and is cleared every frame after consumption; everything else is
 * level-triggered state with `pressed`/`released` edges derived here so
 * gameplay code never has to track previous values itself.
 *
 * `override()` lets the headless harness drive the player directly, which
 * keeps logic tests independent of touch-event synthesis (ARCHITECTURE.md 8.3).
 */

function blank() {
  return {
    move: { x: 0, y: 0 },
    look: { dx: 0, dy: 0 },
    fire: false,
    aim: false,
    jump: false,
    sprint: false,
    crouch: false,
    reload: false,
    interact: false,
    harvest: false,
    buildMode: false,
    buildPiece: 0,
    // Selected build material, or null for "leave it alone". A one-shot like
    // `slot`, cleared after publication.
    buildMaterial: null,
    buildRotate: false,
    editMode: false,
    slot: -1,
    useItem: false,
    deploy: false,
  };
}

const BUTTONS = ['fire', 'aim', 'jump', 'sprint', 'crouch', 'reload', 'interact',
  'harvest', 'buildMode', 'buildRotate', 'editMode', 'useItem', 'deploy'];

export class InputHub {
  constructor() {
    this.order = 5;                 // runs before anything that reads input
    this.raw = blank();
    this.state = blank();
    this.prev = blank();
    this.pressed = {};
    this.released = {};
    this._override = null;
    this.sources = [];
    this.enabled = true;
  }

  addSource(src) { this.sources.push(src); return src; }

  /** Accumulate a look delta in radians. Devices may call this many times. */
  addLook(dx, dy) { this.raw.look.dx += dx; this.raw.look.dy += dy; }

  setMove(x, y) { this.raw.move.x = x; this.raw.move.y = y; }
  setButton(name, down) { if (name in this.raw) this.raw[name] = !!down; }
  setSlot(i) { this.raw.slot = i; }
  setPiece(i) { this.raw.buildPiece = i; }
  setMaterial(key) { this.raw.buildMaterial = key; }

  /** Force a partial state for testing; cleared with `clearOverride()`. */
  override(partial) {
    this._override = { ...(this._override || {}), ...partial };
    if (partial && partial.move) this._override.move = { ...partial.move };
    if (partial && partial.look) this._override.look = { ...partial.look };
    return true;
  }

  clearOverride() { this._override = null; return true; }

  /**
   * Publish the current state. This runs as a fixed-step update with the
   * lowest order in the system list, so simulation reads input produced this
   * step rather than last frame's — a one-frame input delay is very visible on
   * touch, where the player is already fighting screen latency.
   */
  fixedUpdate() {
    const s = this.state, r = this.raw, p = this.prev;
    for (const b of BUTTONS) p[b] = s[b];

    s.move.x = r.move.x; s.move.y = r.move.y;
    s.look.dx = r.look.dx; s.look.dy = r.look.dy;
    for (const b of BUTTONS) s[b] = r[b];
    s.slot = r.slot;
    s.buildPiece = r.buildPiece;
    s.buildMaterial = r.buildMaterial;

    if (this._override) {
      const o = this._override;
      if (o.move) { s.move.x = o.move.x || 0; s.move.y = o.move.y || 0; }
      if (o.look) { s.look.dx = o.look.dx || 0; s.look.dy = o.look.dy || 0; }
      for (const b of BUTTONS) if (b in o) s[b] = !!o[b];
      if ('slot' in o) s.slot = o.slot;
      if ('buildPiece' in o) s.buildPiece = o.buildPiece;
      if ('buildMaterial' in o) s.buildMaterial = o.buildMaterial;
    }

    if (!this.enabled) {
      s.move.x = 0; s.move.y = 0; s.look.dx = 0; s.look.dy = 0;
      for (const b of BUTTONS) s[b] = false;
    }

    for (const b of BUTTONS) {
      this.pressed[b] = s[b] && !p[b];
      this.released[b] = !s[b] && p[b];
    }

    // Look is a per-frame delta: consume it so a device that stops sending
    // events does not leave the camera spinning.
    this.raw.look.dx = 0; this.raw.look.dy = 0;
    // One-shot selections clear after publication.
    this.raw.slot = -1;
    this.raw.buildMaterial = null;
  }

  dispose() { for (const s of this.sources) if (s.dispose) s.dispose(); }
}

export { blank as blankInputState, BUTTONS };
