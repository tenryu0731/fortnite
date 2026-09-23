import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '../gen/Rng.js';
import { merge } from '../gen/MeshGen.js';

/**
 * Sky — atmosphere, lighting and the shadow-casting sun.
 *
 * A single inverted sphere carries a vertex-coloured gradient (zenith ->
 * horizon -> ground haze) plus a soft sun disc drawn as an additive billboard.
 * There is no skybox texture and no post-processing: fog colour is matched to
 * the horizon band so distant terrain dissolves into the sky.
 *
 * The directional light's shadow camera is small and re-centred on the camera
 * every frame, which is what keeps a 1024-metre map inside a single 1024px
 * shadow map at usable resolution.
 */

const PALETTES = {
  /*
   * Art direction: high-key and saturated, the genre's look. Tuned against
   * colour statistics measured from reference gameplay frames (see
   * tests/style-targets.json): a pale cyan haze at the horizon, a strong blue
   * zenith, warm sun, and a fill light bright and coloured enough that shadows
   * read as cool tinted colour rather than black.
   */
  day: {
    zenith: new THREE.Color(0x3a8ad6),
    horizon: new THREE.Color(0xb6d7e3),
    ground: new THREE.Color(0xa9c2bb),
    sun: new THREE.Color(0xfff0d2),
    sunIntensity: 2.6,
    hemiSky: new THREE.Color(0xbfe0ff),
    hemiGround: new THREE.Color(0x9aa36e),
    hemiIntensity: 1.9,
    fogNear: 0.2,
    fogFar: 1.7,
    sunDir: new THREE.Vector3(0.42, 0.72, 0.35).normalize(),
    exposure: 1.36,
    cloudBase: 0xb3c7da,
  },
  dusk: {
    zenith: new THREE.Color(0x2a3878),
    horizon: new THREE.Color(0xf0a878),
    ground: new THREE.Color(0x4a4038),
    sun: new THREE.Color(0xffc487),
    sunIntensity: 1.7,
    hemiSky: new THREE.Color(0x8f9ed8),
    hemiGround: new THREE.Color(0x3a3228),
    hemiIntensity: 0.55,
    fogNear: 0.26,
    sunDir: new THREE.Vector3(0.86, 0.22, -0.2).normalize(),
    exposure: 1.12,
  },
};

export class Sky {
  constructor(opts = {}) {
    this.order = 15;
    this.paletteName = opts.palette || 'day';
  }

  init(services) {
    this.services = services;
    this.scene = services.get('scene');
    this.camera = services.get('camera');
    this.settings = services.get('settings');
    this.renderer = services.get('renderer');
    const p = this.palette = PALETTES[this.paletteName] || PALETTES.day;

    /* --- gradient dome ------------------------------------------------ */
    const geo = new THREE.SphereGeometry(1, 24, 16);
    const pos = geo.getAttribute('position');
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i); // -1..1
      if (y >= 0) c.copy(p.horizon).lerp(p.zenith, Math.pow(y, 0.55));
      else c.copy(p.horizon).lerp(p.ground, Math.pow(-y, 0.7));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
    });
    this.dome = new THREE.Mesh(geo, mat);
    this.dome.scale.setScalar(900);
    this.dome.renderOrder = -100;
    this.dome.frustumCulled = false;
    this.dome.matrixAutoUpdate = false;
    this.scene.add(this.dome);

    /* --- sun disc + glow ---------------------------------------------- */
    const sunGeo = new THREE.CircleGeometry(1, 20);
    const sunMat = new THREE.MeshBasicMaterial({
      color: p.sun, fog: false, depthWrite: false, depthTest: false,
      transparent: true, blending: THREE.AdditiveBlending, opacity: 0.95,
    });
    this.sunDisc = new THREE.Mesh(sunGeo, sunMat);
    this.sunDisc.scale.setScalar(26);
    this.sunDisc.renderOrder = -99;
    this.sunDisc.frustumCulled = false;
    this.scene.add(this.sunDisc);

    const glowGeo = new THREE.CircleGeometry(1, 20);
    const glowCol = new Float32Array(glowGeo.getAttribute('position').count * 3);
    const gp = glowGeo.getAttribute('position');
    for (let i = 0; i < gp.count; i++) {
      const r = Math.hypot(gp.getX(i), gp.getY(i));
      const k = 1 - Math.min(1, r);
      glowCol[i * 3] = p.sun.r * k; glowCol[i * 3 + 1] = p.sun.g * k; glowCol[i * 3 + 2] = p.sun.b * k;
    }
    glowGeo.setAttribute('color', new THREE.BufferAttribute(glowCol, 3));
    this.sunGlow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({
      vertexColors: true, fog: false, depthWrite: false, depthTest: false,
      transparent: true, blending: THREE.AdditiveBlending, opacity: 0.55,
    }));
    this.sunGlow.scale.setScalar(150);
    this.sunGlow.renderOrder = -98;
    this.sunGlow.frustumCulled = false;
    this.scene.add(this.sunGlow);

    /* --- clouds ------------------------------------------------------- */
    this.clouds = this._buildClouds(p);
    this.scene.add(this.clouds);

    /* --- lighting ------------------------------------------------------ */
    this.sun = new THREE.DirectionalLight(p.sun, p.sunIntensity);
    this.sun.position.copy(p.sunDir).multiplyScalar(120);
    this.sun.castShadow = this.settings.q.shadows;
    if (this.sun.castShadow) {
      const d = this.settings.q.shadowDistance;
      const cam = this.sun.shadow.camera;
      cam.left = -d; cam.right = d; cam.top = d; cam.bottom = -d;
      cam.near = 1; cam.far = 400;
      this.sun.shadow.mapSize.set(this.settings.q.shadowMapSize, this.settings.q.shadowMapSize);
      this.sun.shadow.bias = -0.0008;
      this.sun.shadow.normalBias = 0.05;
    }
    this.scene.add(this.sun);
    this.sunTarget = new THREE.Object3D();
    this.scene.add(this.sunTarget);
    this.sun.target = this.sunTarget;

    this.hemi = new THREE.HemisphereLight(p.hemiSky, p.hemiGround, p.hemiIntensity);
    this.scene.add(this.hemi);

    /* --- fog ----------------------------------------------------------- */
    // Fog is aerial perspective, not a view limiter. Ending it well beyond the
    // draw distance keeps far terrain readable as silhouette and haze instead
    // of dissolving it into a flat white wall, which matters in a game where
    // spotting a distant player or build is the whole point.
    const view = this.settings.q.viewDistance;
    this.scene.fog = new THREE.Fog(p.horizon.getHex(), view * p.fogNear, view * (p.fogFar || 2.2));
    this.scene.background = p.horizon.clone();
    this.renderer.three.toneMappingExposure = p.exposure;

    this._sunOffset = new THREE.Vector3();
  }

  /**
   * Stylised cumulus. The genre's skies are defined by big, soft, flat-bottomed
   * clouds; a bare gradient reads as unfinished. Each cloud is a cluster of
   * squashed spheres whose bases are clipped flat, shaded by vertex colour
   * (sunlit white tops, cool grey-blue undersides) and drawn unlit, so the
   * whole layer is one merged mesh and one draw call.
   *
   * The layer is anchored to the camera like the dome: clouds are scenery at
   * effectively infinite distance, and must never be flown into or parallax.
   */
  _buildClouds(p) {
    const rng = new Rng(0x5eed + 17);
    const parts = [];
    const top = new THREE.Color(0xffffff);
    const base = new THREE.Color(p.cloudBase || 0xb9cadb);
    const warm = new THREE.Color(p.sun);
    const sun = p.sunDir;
    const c = new THREE.Color();
    const COUNT = 14;
    for (let i = 0; i < COUNT; i++) {
      // Spread around the horizon, biased away from straight overhead where a
      // flat-bottomed cloud would be seen from below and look like a disc.
      const az = (i / COUNT) * Math.PI * 2 + rng.range(-0.18, 0.18);
      const elev = rng.range(0.10, 0.34);
      const dist = rng.range(560, 700);
      const cx = Math.cos(az) * Math.cos(elev) * dist;
      const cz = Math.sin(az) * Math.cos(elev) * dist;
      const cy = Math.sin(elev) * dist;
      const size = rng.range(34, 62);
      const puffs = 5 + rng.int(3);
      for (let k = 0; k < puffs; k++) {
        const g = new THREE.IcosahedronGeometry(1, 1);
        g.deleteAttribute('uv');
        const pos = g.getAttribute('position');
        const r = size * (k === 0 ? 1 : rng.range(0.55, 0.85));
        // Puffs line up along the cloud's long axis, which is tangent to the
        // horizon ring so every cloud is seen broadside.
        const along = (k - (puffs - 1) / 2) * size * 0.9 + rng.range(-6, 6);
        const tx = -Math.sin(az), tz = Math.cos(az);
        const ox = cx + tx * along, oz = cz + tz * along;
        const oy = cy + rng.range(0, size * 0.35) * (k === 0 ? 1.4 : 1);
        const flat = cy - size * 0.28;          // shared flat base per cloud
        for (let v = 0; v < pos.count; v++) {
          let x = pos.getX(v) * r * 1.25, y = pos.getY(v) * r * 0.78, z = pos.getZ(v) * r;
          y = Math.max(oy + y, flat) - 0;
          pos.setXYZ(v, ox + x, y, oz + z);
        }
        parts.push(g);
      }
    }
    let geo = merge(parts);
    geo = mergeVertices(geo);
    geo.computeVertexNormals();
    const pos = geo.getAttribute('position');
    const nrm = geo.getAttribute('normal');
    const col = new Float32Array(pos.count * 3);
    for (let v = 0; v < pos.count; v++) {
      const ny = nrm.getY(v);
      // Height-and-normal shading: the underside goes cool, the crown goes
      // white, and the sun side picks up a touch of the sun's warmth.
      const t = THREE.MathUtils.clamp(ny * 0.6 + 0.45, 0, 1);
      c.copy(base).lerp(top, t);
      const facing = Math.max(0, nrm.getX(v) * sun.x + nrm.getY(v) * sun.y + nrm.getZ(v) * sun.z);
      c.lerp(warm, facing * 0.12);
      col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.deleteAttribute('normal');
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, fog: false, depthWrite: false,
    }));
    mesh.name = 'clouds';
    mesh.renderOrder = -97;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  update(dt = 0) {
    const cam = this.camera.position;
    // Dome and sun are anchored to the camera so they never clip the far plane.
    this.dome.position.copy(cam);
    this.dome.updateMatrix();
    // Clouds ride with the camera too, drifting slowly around the horizon.
    // The drift is simulation-clock driven so captures stay deterministic.
    this._drift = (this._drift || 0) + (dt || 0) * 0.004;
    this.clouds.position.copy(cam);
    this.clouds.rotation.y = this._drift;
    this.clouds.updateMatrix();

    this._sunOffset.copy(this.palette.sunDir).multiplyScalar(700).add(cam);
    this.sunDisc.position.copy(this._sunOffset);
    this.sunDisc.lookAt(cam);
    this.sunGlow.position.copy(this._sunOffset);
    this.sunGlow.lookAt(cam);

    // Keep the shadow volume centred slightly ahead of the camera.
    this.sun.position.copy(this.palette.sunDir).multiplyScalar(140).add(cam);
    this.sunTarget.position.copy(cam);
    this.sunTarget.updateMatrixWorld();
  }

  setPalette(name) {
    if (!PALETTES[name] || name === this.paletteName) return;
    this.paletteName = name;
    this.dispose();
    this.init(this.services);
  }

  dispose() {
    for (const o of [this.dome, this.sunDisc, this.sunGlow, this.clouds]) {
      if (!o) continue;
      o.geometry.dispose(); o.material.dispose(); this.scene.remove(o);
    }
    if (this.sun) this.scene.remove(this.sun);
    if (this.hemi) this.scene.remove(this.hemi);
    if (this.sunTarget) this.scene.remove(this.sunTarget);
  }
}
