import { BufferGeometry, Group, Material, Mesh, PointLight, Points, Vector3 } from 'three';
import { createRandom, randomBetween } from '../../core/random';
import type { EnvironmentSnapshot, QualityLevel } from '../../core/types';
import type { LandscapeScene, SceneOptions } from '../types';
import { buildSnowPine, createForestNeedleMaterial } from '../snow/forestTrees';
import type { ForestTreeDetail } from '../snow/forestTrees';
import { mergeStaticMeshes } from '../snow/mergeStaticMeshes';
import { createCampfire } from './campfire';
import { buildRainLandscape } from './rainLandscape';
import { createRainMaterial } from './rainMaterials';
import { createRainParticles } from './rainParticles';
import { createWetGround } from './wetGround';

/** A sheltered seat beside a small fire, with an uninterrupted wet forest beyond. */
export function createRainfireWorld(options: SceneOptions): LandscapeScene {
  const group = new Group();
  group.name = 'rainfire-forest-refuge';
  const landscape = buildRainLandscape(options.seed);
  group.add(landscape.group);

  const bark = createRainMaterial('bark', options.seed);
  const needles = createForestNeedleMaterial(`${options.seed}/rain`);
  needles.color.set(0xb9c4b7);
  needles.roughness = .76;
  needles.alphaTest = .28;
  needles.envMapIntensity = .65;
  // The old geometry generator now has an explicit snow-free mode. No snow
  // surface or unused snow material is created for this forest.
  const treeMaterials = { bark, needles, snow: bark };
  const forest = new Group();
  forest.name = 'layered-rain-forest';
  const random = createRandom(`${options.seed}/rain-forest-layout`);
  let treeCount = 0;
  const addTree = (x: number, z: number, scale: number, detail: ForestTreeDetail): void => {
    const tree = buildSnowPine(`${options.seed}/wet-fir/${treeCount++}`, treeMaterials, detail, {
      snowCover: false, young: scale < .67,
    });
    tree.position.set(x, landscape.height(x, z) - .065, z);
    tree.scale.set(scale * randomBetween(random, .88, 1.10), scale, scale * randomBetween(random, .90, 1.08));
    tree.rotation.y = random() * Math.PI * 2;
    forest.add(tree);
  };
  addTree(-6.6, -3.4, 1.10, 'near');
  const middle: readonly [number, number, number][] = [
    [6.7, -4.7, 1.05], [-9.8, -13, 1.15], [9.8, -14, 1.20],
    [-5.4, -20, .94], [5.6, -22, 1.15], [-14, -24, 1.12], [15.3, -29, 1.26],
  ];
  for (const [x, z, scale] of middle) addTree(x, z, scale, 'mid');
  // Increasingly small branch meshes sit behind one another in real depth.
  // Their visibility falls naturally with the same fog as the terrain.
  for (let row = 0; row < 6; row++) {
    for (const column of [-21, -10, 0, 12, 25]) {
      const x = column + randomBetween(random, -3.0, 3.0);
      const z = -34 - row * 9.5 + randomBetween(random, -4, 4);
      addTree(x, z, randomBetween(random, .83, 1.37), 'far');
    }
  }
  addTree(-4.9, -10.4, .39, 'mid');
  addTree(5.3, -12.6, .46, 'mid');
  mergeStaticMeshes(forest, new Set());
  group.add(forest);

  const fire = createCampfire(options.seed, options.quality);
  fire.group.position.copy(landscape.firePosition);
  // The fire owns custom shader attributes and local log coordinates, so it
  // deliberately remains outside static scene batching.
  const water = createWetGround(options.seed, options.quality, landscape.height);
  const rain = createRainParticles(options.seed, options.quality, landscape.firePosition);
  group.add(fire.group, water.mesh, rain.group);
  let disposed = false;
  return {
    group,
    cameraPosition: new Vector3(1, landscape.height(1, 5.2) + 1.40, 5.2),
    cameraTarget: new Vector3(-.7, .85, -6),
    portraitCameraPosition: new Vector3(.55, landscape.height(.55, 4.6) + 1.38, 4.6),
    portraitCameraTarget: new Vector3(-1.3, .83, -5.6),
    invalidateRenderCaches(): void { water.invalidate(); },
    diagnostics: () => ({
      reflectionUpdates: Number(water.mesh.userData.reflectionUpdates),
      reflectionSize: Number(water.mesh.userData.reflectionSize),
      generatedTrees: treeCount,
    }),
    update(frame: EnvironmentSnapshot): void {
      if (disposed) return;
      fire.update(frame);
      rain.update(frame);
      water.update(frame);
    },
    setQuality(quality: QualityLevel): void {
      if (disposed) return;
      fire.setQuality(quality);
      rain.setQuality(quality);
      water.setQuality(quality);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      water.disposeTargets();
      const geometries = new Set<BufferGeometry>();
      const materials = new Set<Material>([bark, needles]);
      group.traverse(object => {
        if (object instanceof Mesh || object instanceof Points) {
          geometries.add(object.geometry);
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
        }
        if (object instanceof PointLight) object.dispose();
      });
      geometries.forEach(geometry => geometry.dispose());
      // The needle generator releases its cached runtime texture on its
      // material's dispose event, after the final scene reference is gone.
      materials.forEach(material => material.dispose());
      group.clear();
      group.removeFromParent();
    },
  };
}
