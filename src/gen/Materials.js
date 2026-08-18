import * as THREE from 'three';
import { TextureGen } from './TextureGen.js';

/**
 * Materials — the single owner of every THREE.Material in the game.
 *
 * Materials are shared aggressively: one material per surface family, reused by
 * every mesh and instanced mesh that needs it. This keeps program count (and
 * therefore shader-switch cost, the dominant mobile draw overhead) in single
 * digits. MeshLambertMaterial is the default because it supports normal maps
 * and vertex colours while costing a fraction of a PBR shader on a phone GPU.
 */
export class Materials {
  constructor(seed, settings) {
    this.settings = settings;
    this.gen = new TextureGen(seed, settings.q.textureSize);
    this.cache = new Map();
  }

  _mat(key, make) {
    let m = this.cache.get(key);
    if (!m) { m = make(); m.name = key; this.cache.set(key, m); }
    return m;
  }

  /** Textured surface with an optional normal map (dropped on the low preset). */
  surface(name, opts = {}) {
    const key = `surf:${name}:${opts.repeat || 1}:${opts.vertexColors ? 1 : 0}`;
    return this._mat(key, () => {
      const s = this.gen.surface(name, opts);
      return new THREE.MeshLambertMaterial({
        map: s.map,
        normalMap: this.settings.q.textureSize >= 256 ? s.normalMap : null,
        normalScale: new THREE.Vector2(opts.normalScale ?? 0.8, opts.normalScale ?? 0.8),
        vertexColors: !!opts.vertexColors,
        side: opts.side || THREE.FrontSide,
        color: opts.color ?? 0xffffff,
      });
    });
  }

  /** Untextured, vertex-coloured material — the workhorse for procedural props. */
  vertex(key = 'vtx', opts = {}) {
    return this._mat(`vtx:${key}`, () => new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: opts.side || THREE.FrontSide,
      flatShading: !!opts.flat,
      transparent: !!opts.transparent,
      opacity: opts.opacity ?? 1,
      alphaTest: opts.alphaTest || 0,
      color: opts.color ?? 0xffffff,
    }));
  }

  /** Alpha-cut foliage. `alphaTest` avoids sorting cost and depth artefacts. */
  foliage(key = 'leaf') {
    return this._mat(`fol:${key}`, () => new THREE.MeshLambertMaterial({
      map: this.gen.leaf(this.settings.q.textureSize, 7),
      vertexColors: true,
      transparent: false,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
    }));
  }

  /** Unlit flat colour — HUD-ish world elements, ghosts, markers. */
  basic(key, opts = {}) {
    return this._mat(`basic:${key}`, () => new THREE.MeshBasicMaterial({
      color: opts.color ?? 0xffffff,
      transparent: !!opts.transparent,
      opacity: opts.opacity ?? 1,
      depthWrite: opts.depthWrite !== false,
      depthTest: opts.depthTest !== false,
      side: opts.side || THREE.FrontSide,
      blending: opts.blending || THREE.NormalBlending,
      vertexColors: !!opts.vertexColors,
      fog: opts.fog !== false,
    }));
  }

  /** Additive emissive material for muzzle flashes, tracers and sparks. */
  additive(key, opts = {}) {
    return this._mat(`add:${key}`, () => new THREE.MeshBasicMaterial({
      color: opts.color ?? 0xffffff,
      transparent: true,
      opacity: opts.opacity ?? 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexColors: !!opts.vertexColors,
      fog: false,
    }));
  }

  get count() { return this.cache.size; }

  dispose() {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
    this.gen.dispose();
  }
}
