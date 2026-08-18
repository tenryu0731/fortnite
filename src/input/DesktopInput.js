/**
 * DesktopInput — keyboard and mouse fallback.
 *
 * Present so the game is playable and debuggable outside a touch device; it
 * produces exactly the same InputState the touch layer does, so nothing above
 * the input layer can tell the difference.
 */
const KEY_SLOT = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4 };
const KEY_PIECE = { KeyZ: 0, KeyX: 1, KeyC: 2, KeyV: 3 };

export class DesktopInput {
  constructor(hub, canvas, settings) {
    this.hub = hub;
    this.canvas = canvas;
    this.settings = settings;
    this.keys = new Set();
    this.locked = false;
    this._bind();
  }

  _bind() {
    this._onKeyDown = (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code in KEY_SLOT) this.hub.setSlot(KEY_SLOT[e.code]);
      if (e.code in KEY_PIECE) { this.hub.setPiece(KEY_PIECE[e.code]); this.hub.setButton('buildMode', true); }
      if (e.code === 'KeyQ') this.hub.setButton('buildMode', !this.hub.raw.buildMode);
      if (e.code === 'KeyG') this.hub.setButton('editMode', !this.hub.raw.editMode);
      if (e.code === 'KeyR') this.hub.setButton('reload', true);
      if (e.code === 'KeyF') this.hub.setButton('interact', true);
      if (e.code === 'KeyE') this.hub.setButton('harvest', true);
      if (e.code === 'KeyT') this.hub.setButton('useItem', true);
      if (e.code === 'KeyB') this.hub.setButton('buildRotate', true);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this._sync();
    };
    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyR') this.hub.setButton('reload', false);
      if (e.code === 'KeyF') this.hub.setButton('interact', false);
      if (e.code === 'KeyE') this.hub.setButton('harvest', false);
      if (e.code === 'KeyT') this.hub.setButton('useItem', false);
      if (e.code === 'KeyB') this.hub.setButton('buildRotate', false);
      this._sync();
    };
    this._onMouseMove = (e) => {
      if (!this.locked) return;
      const s = this.settings.user.lookSensitivity * 0.0022;
      this.hub.addLook(-e.movementX * s, (this.settings.user.invertY ? 1 : -1) * e.movementY * s);
    };
    this._onMouseDown = (e) => {
      if (!this.locked && this.canvas.requestPointerLock) { this.canvas.requestPointerLock(); return; }
      if (e.button === 0) this.hub.setButton('fire', true);
      if (e.button === 2) this.hub.setButton('aim', true);
    };
    this._onMouseUp = (e) => {
      if (e.button === 0) this.hub.setButton('fire', false);
      if (e.button === 2) this.hub.setButton('aim', false);
    };
    this._onLockChange = () => { this.locked = document.pointerLockElement === this.canvas; };
    this._onContext = (e) => e.preventDefault();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    this.canvas.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('pointerlockchange', this._onLockChange);
    this.canvas.addEventListener('contextmenu', this._onContext);
  }

  _sync() {
    const k = this.keys;
    let x = 0, y = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    this.hub.setMove(x, y);
    this.hub.setButton('jump', k.has('Space'));
    this.hub.setButton('sprint', k.has('ShiftLeft') || k.has('ShiftRight'));
    this.hub.setButton('crouch', k.has('ControlLeft') || k.has('KeyC') === false && k.has('AltLeft'));
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    this.canvas.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    this.canvas.removeEventListener('contextmenu', this._onContext);
  }
}
