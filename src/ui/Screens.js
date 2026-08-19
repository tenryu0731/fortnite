import { Settings } from '../core/Settings.js';

/**
 * Screens — everything that is not the in-match HUD: the loading gate, the
 * start screen, settings, and the results card.
 *
 * The start screen exists for a concrete technical reason as well as a
 * presentational one: mobile browsers will not start audio, and cannot request
 * fullscreen, without a user gesture. A tap-to-play gate is the only place
 * those can be requested honestly.
 */

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export class Screens {
  constructor() {
    this.order = 96;
    this.current = null;
  }

  init(services) {
    this.services = services;
    this.settings = services.get('settings');
    this.bus = services.get('bus');
    this.match = services.get('match');
    this.audio = services.peek('audio');
    this.hud = services.peek('hud');
    this.minimap = services.peek('minimap');
    this.touch = services.peek('touch');
    this.input = services.get('input');
    this.renderer = services.get('renderer');

    this._build(document.getElementById('ui-root'));
    this.bus.on('match:result', (r) => this.showResult(r));
    services.set('screens', this);
  }

  _build(root) {
    this.layer = el('div', 'screens');

    /* --- start ------------------------------------------------------- */
    this.start = el('div', 'screen screen-start');
    this.start.append(
      el('div', 'screen-title', 'PROJECT<span>STORMFALL</span>'),
      el('div', 'screen-sub', 'バトルロイヤル · 建築 · モバイル'),
    );
    this.playBtn = el('button', 'screen-btn primary', 'TAP TO PLAY');
    this.settingsBtn = el('button', 'screen-btn', 'SETTINGS');
    this.start.append(this.playBtn, this.settingsBtn);
    this.start.appendChild(el('div', 'screen-hint',
      '左下ドラッグで移動 · 右側ドラッグで視点 · FIRE で射撃 · BUILD で建築'));
    this.layer.appendChild(this.start);

    /* --- settings ----------------------------------------------------- */
    this.settingsPanel = el('div', 'screen screen-settings hidden');
    this.settingsPanel.appendChild(el('div', 'screen-title small', 'SETTINGS'));
    const rows = el('div', 'settings-rows');
    this._sliders = {};
    const addSlider = (key, label, min, max, step, fmt) => {
      const row = el('div', 'settings-row');
      const name = el('div', 'settings-label', label);
      const val = el('div', 'settings-value', fmt(this.settings.user[key]));
      const input = el('input', 'settings-slider');
      input.type = 'range';
      input.min = String(min); input.max = String(max); input.step = String(step);
      input.value = String(this.settings.user[key]);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        this.settings.set(key, v);
        val.textContent = fmt(v);
      });
      row.append(name, input, val);
      rows.appendChild(row);
      this._sliders[key] = input;
    };
    addSlider('lookSensitivity', '視点感度 / Sensitivity', 0.3, 2.5, 0.05, (v) => v.toFixed(2));
    addSlider('adsSensitivityScale', 'ADS 感度倍率', 0.2, 1.0, 0.05, (v) => v.toFixed(2));
    addSlider('fov', '視野角 / FOV', 60, 100, 1, (v) => `${v}°`);
    addSlider('masterVolume', '音量 / Volume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`);

    const addToggle = (key, label) => {
      const row = el('div', 'settings-row');
      const name = el('div', 'settings-label', label);
      const btn = el('button', 'settings-toggle', this.settings.user[key] ? 'ON' : 'OFF');
      btn.classList.toggle('on', !!this.settings.user[key]);
      btn.addEventListener('click', () => {
        const v = !this.settings.user[key];
        this.settings.set(key, v);
        btn.textContent = v ? 'ON' : 'OFF';
        btn.classList.toggle('on', v);
        if (key === 'leftHanded' && this.touch) this.touch.layout();
        if (key === 'adaptiveResolution') this.renderer.adaptive = v;
      });
      row.append(name, btn);
      rows.appendChild(row);
    };
    addToggle('invertY', 'Y 軸反転 / Invert Y');
    addToggle('leftHanded', '左利き / Left-handed');
    addToggle('haptics', '振動 / Haptics');
    addToggle('adaptiveResolution', '解像度自動調整');

    const qualityRow = el('div', 'settings-row');
    qualityRow.appendChild(el('div', 'settings-label', '画質 / Quality'));
    const qualityBtns = el('div', 'settings-choices');
    for (const q of ['auto', ...Settings.presets()]) {
      const b = el('button', 'settings-choice', q.toUpperCase());
      b.classList.toggle('on', this.settings.user.quality === q);
      b.addEventListener('click', () => {
        this.settings.set('quality', q);
        for (const other of qualityBtns.children) other.classList.remove('on');
        b.classList.add('on');
        this.renderer.applyQuality();
      });
      qualityBtns.appendChild(b);
    }
    qualityRow.appendChild(qualityBtns);
    rows.appendChild(qualityRow);

    this.settingsPanel.appendChild(rows);
    this.settingsBack = el('button', 'screen-btn', 'BACK');
    this.settingsPanel.appendChild(this.settingsBack);
    this.layer.appendChild(this.settingsPanel);

    /* --- result -------------------------------------------------------- */
    this.result = el('div', 'screen screen-result hidden');
    this.resultTitle = el('div', 'screen-title', '');
    this.resultPlacement = el('div', 'result-placement', '');
    this.resultStats = el('div', 'result-stats', '');
    this.againBtn = el('button', 'screen-btn primary', 'PLAY AGAIN');
    // A match that can only be replayed traps the player in the loop: there
    // has to be a way back to the title to change settings or simply stop.
    this.titleBtn = el('button', 'screen-btn', 'TITLE');
    const resultBtns = el('div', 'screen-btnrow');
    resultBtns.append(this.againBtn, this.titleBtn);
    this.result.append(this.resultTitle, this.resultPlacement, this.resultStats, resultBtns);
    this.layer.appendChild(this.result);

    root.appendChild(this.layer);

    /* --- wiring --------------------------------------------------------- */
    this.playBtn.addEventListener('click', () => this.beginPlay());
    this.settingsBtn.addEventListener('click', () => this.show('settings'));
    this.settingsBack.addEventListener('click', () => this.show(this.match.state === 0 ? 'start' : null));
    this.againBtn.addEventListener('click', () => { this.match.startMatch(); this.show(null); });
    this.titleBtn.addEventListener('click', () => this.toTitle());

    this.show('start');
  }

  /**
   * The only place audio unlock and fullscreen can be requested: both require a
   * user gesture, and this button is the first one a player ever presses.
   */
  beginPlay() {
    if (this.audio) this.audio.unlock();
    const canvas = document.getElementById('gl');
    if (canvas && canvas.requestFullscreen && !document.fullscreenElement) {
      canvas.requestFullscreen().catch(() => { /* refused: not fatal */ });
    }
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(() => { /* unsupported: the rotate gate covers it */ });
    }
    this.match.startMatch();
    this.show(null);
  }

  /**
   * Back to the title. The match is reset to idle first so the world stops
   * running a finished match behind the screen — otherwise the storm keeps
   * closing and bots keep fighting under the title card.
   */
  toTitle() {
    this.match.reset();
    this.show('start');
  }

  show(which) {
    this.current = which;
    this.start.classList.toggle('hidden', which !== 'start');
    this.settingsPanel.classList.toggle('hidden', which !== 'settings');
    this.result.classList.toggle('hidden', which !== 'result');
    this.layer.classList.toggle('active', !!which);
    // Gameplay input is suspended while a screen is up, so a tap on a button
    // cannot also fire a weapon.
    this.input.enabled = !which;
    if (this.touch) this.touch.setVisible(!which);
    if (this.hud) this.hud.setVisible(!which);
    if (this.minimap) this.minimap.setVisible(!which);
  }

  showResult(r) {
    this.resultTitle.textContent = r.victory ? 'VICTORY ROYALE' : 'ELIMINATED';
    this.resultTitle.classList.toggle('victory', !!r.victory);
    this.resultPlacement.innerHTML = r.victory
      ? '<span class="big">#1</span>'
      : `<span class="big">#${r.placement}</span><span class="of"> / ${r.players}</span>`;
    const mins = Math.floor(r.time / 60), secs = r.time % 60;
    this.resultStats.innerHTML = [
      ['ELIMINATIONS', r.eliminations],
      ['DAMAGE DEALT', r.damage],
      ['ACCURACY', `${Math.round(r.accuracy * 100)}%`],
      ['CHESTS OPENED', r.chests],
      ['DISTANCE', `${r.distance}m`],
      ['SURVIVED', `${mins}:${String(secs).padStart(2, '0')}`],
    ].map(([k, v]) => `<div class="result-row"><span>${k}</span><b>${v}</b></div>`).join('');
    this.show('result');
  }

  snapshot() {
    return {
      current: this.current,
      resultTitle: this.resultTitle.textContent,
      resultPlacement: this.resultPlacement.textContent,
      inputEnabled: this.input.enabled,
    };
  }

  dispose() { if (this.layer.parentNode) this.layer.parentNode.removeChild(this.layer); }
}
