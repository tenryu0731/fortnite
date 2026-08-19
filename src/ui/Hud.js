/**
 * Hud — the in-match heads-up display.
 *
 * DOM rather than canvas or 3D: text stays crisp at any device pixel ratio, the
 * browser does the layout, and nothing competes with the renderer for GPU time.
 *
 * The one rule that makes a DOM HUD viable at 60fps is that it never writes
 * unconditionally. Every field caches its last value and touches the DOM only
 * on change, so a steady-state frame performs zero style recalculations — the
 * cost that makes naive DOM HUDs stutter on phones.
 */

const MAT_KEYS = ['wood', 'brick', 'metal'];
const KILLFEED_MAX = 4;
const KILLFEED_TTL = 4.5;

/** Small helper: create an element with a class and optional HTML. */
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export class Hud {
  constructor() {
    this.order = 92;
    this.cache = {};
    this.killfeed = [];
    this.visible = true;
    this._hitmarkerTimer = 0;
    this._damageFlashTimer = 0;
    this._lowHealthPulse = 0;
  }

  init(services) {
    this.services = services;
    this.player = services.get('player');
    this.combat = services.get('combat');
    this.build = services.get('build');
    this.match = services.get('match');
    this.storm = services.get('storm');
    this.bots = services.get('bots');
    this.loot = services.get('loot');
    this.bus = services.get('bus');
    this.settings = services.get('settings');
    this.camera = services.get('camera');
    this.touch = services.peek('touch');

    this._build(document.getElementById('ui-root'));
    this._subscribe();
    services.set('hud', this);
  }

  _build(root) {
    const hud = el('div', 'hud');
    this.root = hud;

    /* --- top bar --------------------------------------------------- */
    const top = el('div', 'hud-top');
    this.stormBox = el('div', 'hud-storm');
    this.stormLabel = el('div', 'hud-storm-label', 'STORM');
    this.stormTime = el('div', 'hud-storm-time', '--:--');
    this.stormBar = el('div', 'hud-storm-bar');
    this.stormFill = el('div', 'hud-storm-fill');
    this.stormBar.appendChild(this.stormFill);
    this.stormBox.append(this.stormLabel, this.stormTime, this.stormBar);

    this.aliveBox = el('div', 'hud-alive');
    this.aliveCount = el('div', 'hud-alive-count', '—');
    this.aliveLabel = el('div', 'hud-alive-label', 'ALIVE');
    this.aliveBox.append(this.aliveCount, this.aliveLabel);

    this.elimBox = el('div', 'hud-elims');
    this.elimCount = el('div', 'hud-elim-count', '0');
    this.elimLabel = el('div', 'hud-elim-label', 'ELIMS');
    this.elimBox.append(this.elimCount, this.elimLabel);

    top.append(this.stormBox, this.aliveBox, this.elimBox);
    hud.appendChild(top);

    /* --- kill feed --------------------------------------------------- */
    this.feedEl = el('div', 'hud-feed');
    hud.appendChild(this.feedEl);

    /* --- crosshair --------------------------------------------------- */
    const cross = el('div', 'hud-cross');
    this.crossParts = [];
    for (const side of ['t', 'r', 'b', 'l']) {
      const p = el('div', `hud-cross-${side}`);
      cross.appendChild(p);
      this.crossParts.push(p);
    }
    this.crossDot = el('div', 'hud-cross-dot');
    cross.appendChild(this.crossDot);
    this.hitmarker = el('div', 'hud-hitmarker', '<span></span><span></span><span></span><span></span>');
    cross.appendChild(this.hitmarker);
    this.crossEl = cross;
    hud.appendChild(cross);

    /* --- vitals (bottom left) ---------------------------------------- */
    const vitals = el('div', 'hud-vitals');
    this.shieldBar = el('div', 'hud-bar hud-bar-shield');
    this.shieldFill = el('div', 'hud-bar-fill');
    this.shieldText = el('div', 'hud-bar-text', '0');
    this.shieldBar.append(this.shieldFill, this.shieldText);
    this.healthBar = el('div', 'hud-bar hud-bar-health');
    this.healthFill = el('div', 'hud-bar-fill');
    this.healthText = el('div', 'hud-bar-text', '100');
    this.healthBar.append(this.healthFill, this.healthText);
    vitals.append(this.shieldBar, this.healthBar);

    const mats = el('div', 'hud-mats');
    this.matEls = {};
    for (const k of MAT_KEYS) {
      const m = el('div', `hud-mat hud-mat-${k}`);
      const icon = el('div', 'hud-mat-icon');
      const val = el('div', 'hud-mat-val', '0');
      m.append(icon, val);
      mats.appendChild(m);
      this.matEls[k] = val;
    }
    vitals.appendChild(mats);
    hud.appendChild(vitals);

    /* --- weapon (bottom right) --------------------------------------- */
    const weap = el('div', 'hud-weapon');
    this.weaponName = el('div', 'hud-weapon-name', '—');
    this.ammoBox = el('div', 'hud-ammo');
    this.ammoMag = el('span', 'hud-ammo-mag', '—');
    this.ammoSep = el('span', 'hud-ammo-sep', '/');
    this.ammoReserve = el('span', 'hud-ammo-reserve', '—');
    this.ammoBox.append(this.ammoMag, this.ammoSep, this.ammoReserve);
    this.reloadBar = el('div', 'hud-reload');
    this.reloadFill = el('div', 'hud-reload-fill');
    this.reloadBar.appendChild(this.reloadFill);
    weap.append(this.weaponName, this.ammoBox, this.reloadBar);
    hud.appendChild(weap);

    /* --- build readout ------------------------------------------------ */
    this.buildBox = el('div', 'hud-build hidden');
    this.buildMat = el('div', 'hud-build-mat', 'WOOD');
    this.buildPiece = el('div', 'hud-build-piece', 'WALL');
    this.buildState = el('div', 'hud-build-state', '');
    this.buildBox.append(this.buildMat, this.buildPiece, this.buildState);
    hud.appendChild(this.buildBox);

    /* --- consumable use progress -------------------------------------- */
    this.useBox = el('div', 'hud-use hidden');
    this.useLabel = el('div', 'hud-use-label', '');
    this.useBar = el('div', 'hud-use-bar');
    this.useFill = el('div', 'hud-use-fill');
    this.useBar.appendChild(this.useFill);
    this.useBox.append(this.useLabel, this.useBar);
    hud.appendChild(this.useBox);

    /* --- damage vignette + prompt ------------------------------------- */
    this.vignette = el('div', 'hud-vignette');
    hud.appendChild(this.vignette);
    this.promptEl = el('div', 'hud-prompt hidden', '');
    hud.appendChild(this.promptEl);
    this.stateBanner = el('div', 'hud-banner hidden', '');
    hud.appendChild(this.stateBanner);

    root.appendChild(hud);
  }

  _subscribe() {
    const bus = this.bus;
    bus.on('weapon:hit', (e) => {
      if (e.shooter !== this.player) return;
      this._hitmarkerTimer = 0.22;
      this.hitmarker.classList.toggle('head', e.part === 'head');
    });
    bus.on('player:damaged', (e) => {
      if (e.amount > 0) this._damageFlashTimer = 0.45;
    });
    bus.on('entity:eliminated', (e) => this._onEliminated(e));
    bus.on('match:state', (e) => this._onMatchState(e));
    bus.on('storm:phase', (e) => {
      if (e.state === 'shrinking') this._banner('THE STORM IS CLOSING', 2.2, 'warn');
    });
  }

  _onEliminated(e) {
    const byPlayer = e.source && e.source.shooter === this.player;
    const victim = e.isPlayer ? 'YOU' : `Bot ${e.entity ? e.entity.id : '?'}`;
    const killer = byPlayer ? 'YOU' : (e.source && e.source.shooter && e.source.shooter.id !== undefined
      ? `Bot ${e.source.shooter.id}` : (e.source && e.source.type === 'storm' ? 'the storm' : '—'));
    this.killfeed.unshift({ text: `${killer} eliminated ${victim}`, ttl: KILLFEED_TTL, mine: byPlayer });
    if (this.killfeed.length > KILLFEED_MAX) this.killfeed.length = KILLFEED_MAX;
    this._feedDirty = true;
    if (byPlayer) this._banner('ELIMINATED', 1.4, 'good');
  }

  _onMatchState(e) {
    if (e.state === 'bus') this._banner('TAP DROP TO DEPLOY', 3.0, '');
    else if (e.state === 'playing') this._banner('GOOD LUCK', 1.6, 'good');
  }

  _banner(text, ttl, kind) {
    this.stateBanner.textContent = text;
    this.stateBanner.className = `hud-banner ${kind || ''}`;
    this._bannerTimer = ttl;
  }

  /* ------------------------------------------------------------------ */
  /* per-frame                                                           */
  /* ------------------------------------------------------------------ */

  /** Write to the DOM only when the value actually changed. */
  _set(key, value, apply) {
    if (this.cache[key] === value) return false;
    this.cache[key] = value;
    apply(value);
    return true;
  }

  update(dt) {
    if (!this.visible) return;
    const p = this.player;
    const c = this.combat;
    const b = this.build;

    /* --- vitals ---------------------------------------------------- */
    const hp = Math.ceil(p.health);
    const sh = Math.ceil(p.shield);
    this._set('hp', hp, (v) => {
      this.healthText.textContent = String(v);
      this.healthFill.style.width = `${(v / p.maxHealth) * 100}%`;
      this.healthBar.classList.toggle('low', v <= 30);
    });
    this._set('sh', sh, (v) => {
      this.shieldText.textContent = String(v);
      this.shieldFill.style.width = `${(v / p.maxShield) * 100}%`;
      this.shieldBar.classList.toggle('empty', v <= 0);
    });
    for (const k of MAT_KEYS) {
      this._set(`mat_${k}`, b.resources[k] | 0, (v) => { this.matEls[k].textContent = String(v); });
    }

    /* --- weapon ---------------------------------------------------- */
    const w = c.weapon;
    this._set('wname', w ? `${w.def.name}` : '—', (v) => { this.weaponName.textContent = v; });
    this._set('wrarity', w ? w.rarity : 'none', (v) => { this.weaponName.dataset.rarity = v; });
    const mag = w ? (w.ammo === Infinity ? '∞' : String(w.ammo)) : '—';
    const res = w && w.def.ammo ? String(c.reserveAmmo[w.def.ammo] | 0) : '∞';
    this._set('mag', mag, (v) => { this.ammoMag.textContent = v; });
    this._set('res', res, (v) => { this.ammoReserve.textContent = v; });
    this._set('lowammo', !!(w && w.magSize !== Infinity && w.ammo <= Math.max(1, w.magSize * 0.2)),
      (v) => { this.ammoBox.classList.toggle('low', v); });

    /* --- quickbar ----------------------------------------------------
     * The touch quickbar is the only place a player can see what they are
     * carrying, so it has to mirror the loadout rather than wait for a tap.
     * Driven from here because the HUD already polls combat every frame and
     * the change-cache makes a steady loadout cost nothing. */
    if (this.touch) {
      for (let i = 0; i < c.slots.length; i++) {
        const sw = c.slots[i];
        this._set(`slot${i}`, sw ? `${sw.id}:${sw.rarity}` : '', () => {
          this.touch.setSlotLabel(i, sw ? sw.def.name : '', sw ? sw.rarity : '');
        });
        this._set(`slotammo${i}`, sw ? (sw.ammo === Infinity ? -1 : sw.ammo) : -2, () => {
          this.touch.setSlotAmmo(i, sw && sw.ammo !== Infinity ? sw.ammo : null);
        });
      }
      this._set('activeSlot', c.activeSlot, (v) => { this.touch.setActiveSlot(v); });

      // Build material bank, so the selector shows what is actually placeable.
      const mats = this.touch.constructor.MATERIALS || [];
      for (let i = 0; i < mats.length; i++) {
        const key = mats[i].key;
        const have = b.resources[key] | 0;
        this._set(`matbank${i}`, `${have}:${b.canAfford(key)}`, () => {
          this.touch.setMaterialCount(i, have, b.canAfford(key));
        });
      }
      this._set('activeMat', b.material, (v) => {
        const i = mats.findIndex((m) => m.key === v);
        if (i >= 0) this.touch.setActiveMaterial(i);
      });
    }

    const reloading = c.reloading;
    this._set('reloading', reloading, (v) => { this.reloadBar.classList.toggle('active', v); });
    if (reloading && w) {
      const t = 1 - c.reloadTimer / w.def.reloadTime;
      this.reloadFill.style.width = `${Math.max(0, Math.min(1, t)) * 100}%`;
    }

    /* --- consumable use ---------------------------------------------- */
    const using = c.using;
    this._set('using', using, (v) => {
      this.useBox.classList.toggle('hidden', !v);
      this.useLabel.textContent = v === 'shield' ? 'SHIELD POTION' : v === 'medkit' ? 'MEDKIT' : '';
    });
    if (using) {
      const total = using === 'shield' ? 4 : 8;
      this.useFill.style.width = `${Math.max(0, 1 - c.useTimer / total) * 100}%`;
    }

    /* --- build ------------------------------------------------------- */
    this._set('buildmode', b.active, (v) => { this.buildBox.classList.toggle('hidden', !v); });
    if (b.active) {
      this._set('bmat', b.material, (v) => {
        this.buildMat.textContent = v.toUpperCase();
        this.buildMat.dataset.mat = v;
      });
      this._set('bpiece', b.piece, (v) => {
        this.buildPiece.textContent = ['WALL', 'FLOOR', 'RAMP', 'CONE'][v] || '';
      });
      this._set('bvalid', b.preview.valid ? '' : b.preview.reason, (v) => {
        this.buildState.textContent = v ? REASON_TEXT[v] || v : '';
        this.buildState.classList.toggle('bad', !!v);
      });
    }

    /* --- match / storm ------------------------------------------------ */
    const alive = this.bots.aliveCount + (p.alive ? 1 : 0);
    this._set('alive', alive, (v) => { this.aliveCount.textContent = String(v); });
    this._set('elims', this.match.stats.eliminations, (v) => { this.elimCount.textContent = String(v); });

    const st = this.storm;
    if (st.active) {
      const secs = Math.max(0, Math.ceil(st.timeRemaining));
      this._set('stormtime', secs, (v) => {
        this.stormTime.textContent = `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
      });
      this._set('stormmode', st.isShrinking, (v) => {
        this.stormLabel.textContent = v ? 'CLOSING' : 'NEXT CIRCLE';
        this.stormBox.classList.toggle('closing', v);
      });
      const outside = !st.isSafe(p.position.x, p.position.z);
      this._set('outside', outside, (v) => { this.root.classList.toggle('in-storm', v); });
      const total = st.isShrinking ? (st.shrinkDuration || 1) : 1;
      this.stormFill.style.width = `${(1 - Math.min(1, st.timeRemaining / total)) * 100}%`;
    } else {
      this._set('stormtime', -1, () => { this.stormTime.textContent = '--:--'; });
    }

    /* --- crosshair ---------------------------------------------------- */
    // Crosshair gap tracks the actual bullet cone, so the reticle tells the
    // truth about accuracy instead of being decorative.
    if (w) {
      const cone = c.currentSpread(w, p);
      const gap = Math.min(46, 5 + cone * 900);
      this._set('cross', Math.round(gap), (v) => {
        this.crossEl.style.setProperty('--gap', `${v}px`);
      });
    }
    this._set('crossbuild', b.active, (v) => { this.crossEl.classList.toggle('build', v); });

    if (this._hitmarkerTimer > 0) {
      this._hitmarkerTimer -= dt;
      this.hitmarker.classList.add('show');
      if (this._hitmarkerTimer <= 0) this.hitmarker.classList.remove('show');
    }

    /* --- damage vignette ---------------------------------------------- */
    if (this._damageFlashTimer > 0) this._damageFlashTimer -= dt;
    this._lowHealthPulse += dt;
    const lowHealth = p.alive && hp <= 35 ? (0.12 + Math.sin(this._lowHealthPulse * 3.4) * 0.06) : 0;
    const hurt = Math.max(this._damageFlashTimer / 0.45 * 0.55, lowHealth);
    this._set('vig', Math.round(hurt * 100), (v) => { this.vignette.style.opacity = String(v / 100); });

    /* --- interaction prompt -------------------------------------------- */
    const near = this.loot.nearest;
    const promptText = near ? (near.kind === 'chest' ? 'OPEN CHEST' : `PICK UP  ${near.target.label || ''}`) : '';
    this._set('prompt', promptText, (v) => {
      this.promptEl.textContent = v;
      this.promptEl.classList.toggle('hidden', !v);
    });

    /* --- kill feed ------------------------------------------------------ */
    let feedDirty = this._feedDirty;
    for (let i = this.killfeed.length - 1; i >= 0; i--) {
      this.killfeed[i].ttl -= dt;
      if (this.killfeed[i].ttl <= 0) { this.killfeed.splice(i, 1); feedDirty = true; }
    }
    if (feedDirty) {
      this._feedDirty = false;
      this.feedEl.innerHTML = this.killfeed
        .map((k) => `<div class="hud-feed-row${k.mine ? ' mine' : ''}">${k.text}</div>`).join('');
    }

    /* --- banner ---------------------------------------------------------- */
    if (this._bannerTimer > 0) {
      this._bannerTimer -= dt;
      this.stateBanner.classList.remove('hidden');
      if (this._bannerTimer <= 0) this.stateBanner.classList.add('hidden');
    }
  }

  setVisible(v) {
    this.visible = v;
    this.root.classList.toggle('hidden', !v);
  }

  /** Snapshot of what is currently on screen, for verification. */
  snapshot() {
    return {
      health: this.healthText.textContent,
      shield: this.shieldText.textContent,
      materials: Object.fromEntries(MAT_KEYS.map((k) => [k, this.matEls[k].textContent])),
      weapon: this.weaponName.textContent,
      rarity: this.weaponName.dataset.rarity,
      ammo: `${this.ammoMag.textContent}/${this.ammoReserve.textContent}`,
      alive: this.aliveCount.textContent,
      elims: this.elimCount.textContent,
      stormTime: this.stormTime.textContent,
      buildVisible: !this.buildBox.classList.contains('hidden'),
      buildMaterial: this.buildMat.textContent,
      buildPiece: this.buildPiece.textContent,
      prompt: this.promptEl.classList.contains('hidden') ? '' : this.promptEl.textContent,
      killfeed: this.killfeed.map((k) => k.text),
      crossGap: this.crossEl.style.getPropertyValue('--gap'),
      hitmarker: this.hitmarker.classList.contains('show'),
      inStorm: this.root.classList.contains('in-storm'),
      writes: this._writeCount || 0,
    };
  }

  dispose() { if (this.root.parentNode) this.root.parentNode.removeChild(this.root); }
}

const REASON_TEXT = {
  resources: 'NOT ENOUGH MATERIAL',
  occupied: 'SPACE TAKEN',
  bounds: 'OUT OF BOUNDS',
  blocked: 'BLOCKED',
  unsupported: 'NEEDS SUPPORT',
};
