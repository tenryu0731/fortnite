import * as THREE from 'three';

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
  day: {
    zenith: new THREE.Color(0x2f68c8),
    horizon: new THREE.Color(0xc3dcf2),
    ground: new THREE.Color(0x7f8f7a),
    sun: new THREE.Color(0xfff3d6),
    sunIntensity: 2.0,
    hemiSky: new THREE.Color(0xbcd6f5),
    hemiGround: new THREE.Color(0x8b9478),
    hemiIntensity: 1.05,
    fogNear: 0.34,
    sunDir: new THREE.Vector3(0.42, 0.72, 0.35).normalize(),
    exposure: 1.0,
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
    this.scene.fog = new THREE.Fog(p.horizon.getHex(), view * p.fogNear, view * 2.2);
    this.scene.background = p.horizon.clone();
    this.renderer.three.toneMappingExposure = p.exposure;

    this._sunOffset = new THREE.Vector3();
  }

  update() {
    const cam = this.camera.position;
    // Dome and sun are anchored to the camera so they never clip the far plane.
    this.dome.position.copy(cam);
    this.dome.updateMatrix();

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
    for (const o of [this.dome, this.sunDisc, this.sunGlow]) {
      if (!o) continue;
      o.geometry.dispose(); o.material.dispose(); this.scene.remove(o);
    }
    if (this.sun) this.scene.remove(this.sun);
    if (this.hemi) this.scene.remove(this.hemi);
    if (this.sunTarget) this.scene.remove(this.sunTarget);
  }
}
