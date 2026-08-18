const PRESETS = {
  low: {
    name: 'low',
    textureSize: 128,
    atlasSize: 512,
    shadows: false,
    shadowMapSize: 512,
    shadowDistance: 40,
    viewDistance: 260,
    grassDistance: 0,
    grassDensity: 0,
    vegetationDensity: 0.5,
    particleBudget: 256,
    maxPixelRatio: 1.0,
    antialias: false,
    terrainLodBias: 1.35,
    decalBudget: 32,
  },
  medium: {
    name: 'medium',
    textureSize: 256,
    atlasSize: 1024,
    shadows: true,
    shadowMapSize: 1024,
    shadowDistance: 55,
    viewDistance: 380,
    grassDistance: 34,
    grassDensity: 0.55,
    vegetationDensity: 0.8,
    particleBudget: 512,
    maxPixelRatio: 1.5,
    antialias: false,
    terrainLodBias: 1.0,
    decalBudget: 64,
  },
  high: {
    name: 'high',
    textureSize: 512,
    atlasSize: 1024,
    shadows: true,
    shadowMapSize: 2048,
    shadowDistance: 70,
    viewDistance: 520,
    grassDistance: 48,
    grassDensity: 1.0,
    vegetationDensity: 1.0,
    particleBudget: 1024,
    maxPixelRatio: 2.0,
    antialias: true,
    terrainLodBias: 0.8,
    decalBudget: 96,
  },
};

const USER_DEFAULTS = {
  quality: 'auto',
  lookSensitivity: 1.0,
  adsSensitivityScale: 0.55,
  fov: 75,
  invertY: false,
  haptics: true,
  masterVolume: 0.8,
  sfxVolume: 1.0,
  musicVolume: 0.5,
  showFps: false,
  adaptiveResolution: true,
  leftHanded: false,
  autoSprint: true,
};

const STORAGE_KEY = 'stormfall.settings.v1';

/** Guess a preset from device hints. Conservative: unknown devices get medium. */
function detectQuality() {
  if (typeof navigator === 'undefined') return 'medium';
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  let score = 0;
  score += mem >= 8 ? 2 : mem >= 4 ? 1 : 0;
  score += cores >= 8 ? 2 : cores >= 4 ? 1 : 0;
  score += dpr >= 3 ? 1 : 0;
  if (mobile) score -= 1;
  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

/**
 * Settings — user preferences plus the resolved quality preset.
 * Subsystems read `settings.q.<field>` for graphics budgets and
 * `settings.user.<field>` for player preferences.
 */
export class Settings {
  constructor(overrides = {}) {
    this.user = { ...USER_DEFAULTS, ...this._load(), ...overrides };
    this.resolvedQuality = this.user.quality === 'auto' ? detectQuality() : this.user.quality;
    this.q = { ...PRESETS[this.resolvedQuality] || PRESETS.medium };
    this._listeners = [];
  }

  _load() {
    try {
      const raw = globalThis.localStorage && localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  save() {
    try {
      if (globalThis.localStorage) localStorage.setItem(STORAGE_KEY, JSON.stringify(this.user));
    } catch { /* private mode — preferences simply do not persist */ }
  }

  set(key, value) {
    this.user[key] = value;
    if (key === 'quality') {
      this.resolvedQuality = value === 'auto' ? detectQuality() : value;
      this.q = { ...PRESETS[this.resolvedQuality] || PRESETS.medium };
    }
    this.save();
    for (const fn of this._listeners) fn(key, value);
  }

  onChange(fn) { this._listeners.push(fn); return () => { const i = this._listeners.indexOf(fn); if (i >= 0) this._listeners.splice(i, 1); }; }

  static presets() { return Object.keys(PRESETS); }
}
