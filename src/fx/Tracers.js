import * as THREE from 'three';

/**
 * Tracers — bullet streaks drawn as a single LineSegments whose vertex buffer
 * is rewritten each frame.
 *
 * A tracer is the only feedback a player gets about where a missed shot went,
 * so it must be visible for a moment but must not read as a laser. Each streak
 * fades over a fixed short life and is drawn additively with a per-vertex
 * gradient from bright at the muzzle to transparent at the tip.
 */
export class Tracers {
  constructor(capacity = 64, material) {
    this.capacity = capacity;
    this.count = 0;
    this.ax = new Float32Array(capacity); this.ay = new Float32Array(capacity); this.az = new Float32Array(capacity);
    this.bx = new Float32Array(capacity); this.by = new Float32Array(capacity); this.bz = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.r = new Float32Array(capacity); this.g = new Float32Array(capacity); this.b = new Float32Array(capacity);

    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(capacity * 6);
    this.colors = new Float32Array(capacity * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.geometry = geo;
    this.mesh = new THREE.LineSegments(geo, material);
    this.mesh.frustumCulled = false;
  }

  spawn(from, to, color = [1, 0.85, 0.55], life = 0.07) {
    let i = this.count;
    // At capacity, recycle the oldest streak rather than dropping the newest:
    // the player cares most about the shot they just took.
    if (i >= this.capacity) {
      let oldest = 0;
      for (let k = 1; k < this.count; k++) if (this.life[k] > this.life[oldest]) oldest = k;
      i = oldest;
    } else {
      this.count++;
    }
    this.ax[i] = from.x; this.ay[i] = from.y; this.az[i] = from.z;
    this.bx[i] = to.x; this.by[i] = to.y; this.bz[i] = to.z;
    this.life[i] = 0;
    this.maxLife[i] = life;
    this.r[i] = color[0]; this.g[i] = color[1]; this.b[i] = color[2];
    return i;
  }

  update(dt) {
    let w = 0;
    for (let i = 0; i < this.count; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) continue;
      if (w !== i) {
        this.ax[w] = this.ax[i]; this.ay[w] = this.ay[i]; this.az[w] = this.az[i];
        this.bx[w] = this.bx[i]; this.by[w] = this.by[i]; this.bz[w] = this.bz[i];
        this.life[w] = this.life[i]; this.maxLife[w] = this.maxLife[i];
        this.r[w] = this.r[i]; this.g[w] = this.g[i]; this.b[w] = this.b[i];
      }
      const t = 1 - this.life[w] / this.maxLife[w];
      const o = w * 6;
      this.positions[o] = this.ax[w]; this.positions[o + 1] = this.ay[w]; this.positions[o + 2] = this.az[w];
      this.positions[o + 3] = this.bx[w]; this.positions[o + 4] = this.by[w]; this.positions[o + 5] = this.bz[w];
      this.colors[o] = this.r[w] * t; this.colors[o + 1] = this.g[w] * t; this.colors[o + 2] = this.b[w] * t;
      this.colors[o + 3] = this.r[w] * t * 0.15;
      this.colors[o + 4] = this.g[w] * t * 0.15;
      this.colors[o + 5] = this.b[w] * t * 0.15;
      w++;
    }
    this.count = w;
    this.geometry.setDrawRange(0, this.count * 2);
    if (this.count > 0) {
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.color.needsUpdate = true;
    }
  }

  clear() { this.count = 0; this.geometry.setDrawRange(0, 0); }

  dispose() { this.geometry.dispose(); }
}
