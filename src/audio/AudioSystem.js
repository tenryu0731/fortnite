import { AudioGen } from '../gen/AudioGen.js';

/**
 * AudioSystem — WebAudio playback of the procedurally synthesised sound library.
 *
 * Three constraints shape this:
 *
 *  1. Mobile browsers refuse to start audio before a user gesture, so the
 *     context is created lazily on the first touch and everything before that
 *     is silently dropped rather than queued.
 *  2. There is no AudioContext at all in the headless verification browser, so
 *     every method must be a safe no-op without one. Nothing above this file
 *     may need to know whether audio exists.
 *  3. A firefight can request dozens of overlapping gunshots. Positional audio
 *     uses cheap distance attenuation and stereo panning rather than a
 *     PannerNode per voice, and identical sounds are capped so the mix cannot
 *     collapse into noise.
 */

const MAX_VOICES_PER_SOUND = 4;
const MAX_TOTAL_VOICES = 24;
const REF_DISTANCE = 12;      // metres at which a sound is at half gain
const MAX_DISTANCE = 220;

export class AudioSystem {
  constructor(opts = {}) {
    this.order = 90;             // late: reacts to everything else
    this.gen = new AudioGen(opts.sampleRate || 44100);
    this.ctx = null;
    this.ready = false;
    this.unlocked = false;
    this.buffers = new Map();
    this.voices = [];
    this.voiceCounts = new Map();
    this.loops = new Map();
    this.muted = false;
    this.stats = { played: 0, dropped: 0, peakVoices: 0 };
  }

  init(services) {
    this.settings = services.get('settings');
    this.camera = services.get('camera');
    this.bus = services.get('bus');
    services.set('audio', this);

    // Unlock on the first real gesture. `once` semantics with removal keeps the
    // listeners from lingering for the whole match.
    this._unlock = () => this.unlock();
    if (typeof window !== 'undefined') {
      for (const ev of ['pointerdown', 'touchstart', 'keydown']) {
        window.addEventListener(ev, this._unlock, { once: true, passive: true });
      }
    }
  }

  /** Create the AudioContext. Safe to call repeatedly and where none exists. */
  unlock() {
    if (this.ready) return true;
    const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!Ctx) return false;
    try {
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.settings ? this.settings.user.masterVolume : 0.8;
      this.master.connect(this.ctx.destination);

      this.busses = {};
      for (const [name, vol] of [['sfx', 1.0], ['ambient', 0.7], ['ui', 0.8]]) {
        const g = this.ctx.createGain();
        g.gain.value = vol;
        g.connect(this.master);
        this.busses[name] = g;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this.ready = true;
      this.unlocked = true;
      return true;
    } catch {
      this.ctx = null;
      return false;
    }
  }

  /** Synthesise (once) and cache an AudioBuffer for a named sound. */
  _buffer(name) {
    if (!this.ready) return null;
    let buf = this.buffers.get(name);
    if (buf) return buf;
    if (!this.gen.has(name)) return null;
    const data = this.gen.get(name);
    buf = this.ctx.createBuffer(1, data.length, this.gen.sampleRate);
    buf.getChannelData(0).set(data);
    this.buffers.set(name, buf);
    return buf;
  }

  /**
   * Distance gain and stereo pan for a world position, relative to the camera.
   * An inverse-square curve with a reference distance reads as natural without
   * the cost of a spatialiser per voice.
   */
  _spatial(x, y, z) {
    const cam = this.camera;
    const dx = x - cam.position.x, dy = y - cam.position.y, dz = z - cam.position.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > MAX_DISTANCE) return null;
    const gain = 1 / (1 + (dist / REF_DISTANCE) * (dist / REF_DISTANCE));
    // Pan by the component along the camera's right axis.
    const e = cam.matrixWorld.elements;
    const rx = e[0], ry = e[1], rz = e[2];
    const pan = dist > 0.01 ? Math.max(-1, Math.min(1, (dx * rx + dy * ry + dz * rz) / dist)) : 0;
    return { gain, pan, dist };
  }

  /**
   * Play a one-shot. `opts.position` makes it positional; `opts.volume`,
   * `opts.rate` and `opts.bus` are all optional.
   */
  play(name, opts = {}) {
    if (!this.ready || this.muted) { this.stats.dropped++; return null; }
    const buf = this._buffer(name);
    if (!buf) return null;

    // Voice limiting: identical sounds stacking is what turns a firefight into
    // clipping noise.
    const live = this.voiceCounts.get(name) || 0;
    if (live >= MAX_VOICES_PER_SOUND || this.voices.length >= MAX_TOTAL_VOICES) {
      this.stats.dropped++;
      return null;
    }

    let gain = opts.volume ?? 1;
    let pan = 0;
    if (opts.position) {
      const sp = this._spatial(opts.position.x, opts.position.y, opts.position.z);
      if (!sp) { this.stats.dropped++; return null; }
      gain *= sp.gain;
      pan = sp.pan;
      if (gain < 0.004) { this.stats.dropped++; return null; }
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 1;

    const g = this.ctx.createGain();
    g.gain.value = gain * (this.settings ? this.settings.user.sfxVolume : 1);

    let node = g;
    if (this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      node = p;
    }
    node.connect(this.busses[opts.bus || 'sfx'] || this.busses.sfx);
    src.connect(g);

    const voice = { name, src };
    this.voices.push(voice);
    this.voiceCounts.set(name, live + 1);
    this.stats.peakVoices = Math.max(this.stats.peakVoices, this.voices.length);
    src.onended = () => {
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
      this.voiceCounts.set(name, Math.max(0, (this.voiceCounts.get(name) || 1) - 1));
    };
    src.start(0, opts.offset || 0);
    this.stats.played++;
    return voice;
  }

  /** Start (or retarget) a looping ambient bed such as wind or the storm. */
  loop(name, volume = 0.5) {
    if (!this.ready) return null;
    if (this.loops.has(name)) { this.setLoopVolume(name, volume); return this.loops.get(name); }
    const buf = this._buffer(name);
    if (!buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g);
    g.connect(this.busses.ambient);
    src.start();
    const entry = { src, gain: g };
    this.loops.set(name, entry);
    return entry;
  }

  setLoopVolume(name, volume, rampSeconds = 0.4) {
    const l = this.loops.get(name);
    if (!l) return false;
    if (rampSeconds > 0) {
      l.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      l.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, rampSeconds / 3);
    } else {
      l.gain.gain.value = volume;
    }
    return true;
  }

  stopLoop(name) {
    const l = this.loops.get(name);
    if (!l) return false;
    try { l.src.stop(); } catch { /* already stopped */ }
    this.loops.delete(name);
    return true;
  }

  setMasterVolume(v) { if (this.master) this.master.gain.value = v; }
  setMuted(m) { this.muted = !!m; if (this.master) this.master.gain.value = m ? 0 : (this.settings.user.masterVolume); }

  stopAll() {
    for (const v of this.voices.slice()) { try { v.src.stop(); } catch { /* ignore */ } }
    this.voices.length = 0;
    this.voiceCounts.clear();
    for (const name of [...this.loops.keys()]) this.stopLoop(name);
  }

  state() {
    return {
      ready: this.ready, unlocked: this.unlocked, muted: this.muted,
      voices: this.voices.length, loops: [...this.loops.keys()],
      sounds: this.gen.names().length, stats: { ...this.stats },
    };
  }

  dispose() {
    this.stopAll();
    if (typeof window !== 'undefined' && this._unlock) {
      for (const ev of ['pointerdown', 'touchstart', 'keydown']) window.removeEventListener(ev, this._unlock);
    }
    if (this.ctx && this.ctx.close) { try { this.ctx.close(); } catch { /* ignore */ } }
    this.ctx = null;
    this.ready = false;
  }
}
