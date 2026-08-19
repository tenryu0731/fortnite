import * as THREE from 'three';
import { TextureGen } from '../gen/TextureGen.js';
import * as MeshGen from '../gen/MeshGen.js';
import { Materials } from '../gen/Materials.js';

/**
 * Gallery — a development-only scene that lays out every procedural surface and
 * mesh generator side by side. It exists so the visual-regression suite has a
 * direct view of the generation library: a change in any texture or mesh
 * builder shows up as a pixel diff here, independent of gameplay scenes.
 *
 * Only loaded when the page is opened with `?scenario=gallery`.
 */
export class Gallery {
  constructor() { this.order = 10; }

  init(services) {
    const scene = services.get('scene');
    const settings = services.get('settings');
    const engine = services.get('engine');

    scene.background = new THREE.Color(0x1b2230);
    scene.fog = null;

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(6, 10, 8);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.7);
    fill.position.set(-8, 4, -6);
    scene.add(fill);
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    const mats = new Materials(1337, settings);
    this.materials = mats;

    // Row 1-2: one lit tile per procedural surface, tiled 2x2 to expose seams.
    const names = TextureGen.surfaceNames();
    const cols = 7;
    const tile = new THREE.PlaneGeometry(2.2, 2.2);
    names.forEach((name, i) => {
      const m = new THREE.Mesh(tile, mats.surface(name, { repeat: 2 }));
      m.position.set((i % cols) * 2.5 - (cols - 1) * 1.25, 6.4 - Math.floor(i / cols) * 2.5, 0);
      scene.add(m);
    });

    // Row 3: mesh generators, on a shared vertex-colour material.
    const vtx = mats.vertex('gallery');
    const props = [];
    const t1 = MeshGen.tree({ seed: 3, height: 5.5 });
    props.push(MeshGen.xform(t1.wood, { pos: [-7.5, 0, 0] }));
    props.push(MeshGen.xform(t1.leaves, { pos: [-7.5, 0, 0] }));
    const p1 = MeshGen.pine({ seed: 4, height: 6, radius: 1.3 });
    props.push(MeshGen.xform(p1.wood, { pos: [-4.2, 0, 0] }));
    props.push(MeshGen.xform(p1.leaves, { pos: [-4.2, 0, 0] }));
    props.push(MeshGen.paint(MeshGen.xform(MeshGen.rockLump(1.1, 1, 8), { pos: [-1.2, 1.0, 0] }), 0x8c8c88));
    props.push(MeshGen.xform(MeshGen.stairs(1.8, 2.0, 2.0, 7, 0xb0a898), { pos: [1.6, 1.0, 0] }));
    props.push(MeshGen.xform(MeshGen.roundedBox(1.8, 1.8, 1.8, 0.25, 3, 0x6fa2d8), { pos: [4.4, 0.9, 0] }));
    props.push(MeshGen.xform(MeshGen.frame(1.8, 2.2, 0.16, 0.2, 0xd8d2c4), { pos: [7.2, 1.2, 0] }));
    const merged = MeshGen.merge(props);
    merged.translate(0, -4.6, 0);
    scene.add(new THREE.Mesh(merged, vtx));

    // Grass tufts use the same material and demonstrate the vertical gradient.
    const tufts = [];
    for (let i = 0; i < 9; i++) {
      tufts.push(MeshGen.xform(MeshGen.grassTuft(i + 1, 4, 0.9, 0.2), { pos: [-8 + i * 2, 0, 2.2] }));
    }
    const tuftGeo = MeshGen.merge(tufts);
    tuftGeo.translate(0, -4.6, 0);
    scene.add(new THREE.Mesh(tuftGeo, vtx));

    engine.camera.position.set(0, 1.6, 15.5);
    engine.camera.lookAt(0, 1.4, 0);
    engine.camera.fov = 60;
    engine.camera.updateProjectionMatrix();

    this.scene = scene;
  }

  update() {}

  dispose() { if (this.materials) this.materials.dispose(); }
}
