import { BufferGeometry, Group, Material, Mesh, PointLight, Points, Vector3 } from 'three';
import type { EnvironmentSnapshot, QualityLevel } from '../../core/types';
import type { LandscapeScene, SceneOptions } from '../types';
import { createCampfire } from './campfire';
import { buildRainLandscape } from './rainLandscape';
import { buildLivingForest } from './livingForest';
import { buildForestDebris } from './forestDebris';
import { PUDDLE_LEVEL, SHELTER } from './rainLandscape';
import { createRainParticles } from './rainParticles';
import { createWetGround } from './wetGround';

/** A sheltered seat beside a small fire, with an uninterrupted wet forest beyond. */
export function createRainfireWorld(options: SceneOptions): LandscapeScene {
  const group = new Group();
  group.name = 'rainfire-forest-refuge';
  const landscape = buildRainLandscape(options.seed);
  group.add(landscape.group);

  const forest = buildLivingForest(options.seed, landscape.height);
  group.add(forest.group, buildForestDebris(options.seed, landscape.height, PUDDLE_LEVEL, SHELTER));

  const fire = createCampfire(options.seed, options.quality);
  fire.group.position.copy(landscape.firePosition);
  // The fire owns custom shader attributes and local log coordinates, so it
  // deliberately remains outside static scene batching.
  const water = createWetGround(options.seed, options.quality, landscape.height);
  const rain = createRainParticles(options.seed, options.quality, landscape.firePosition);
  group.add(fire.group, water.mesh, rain.group);
  // Local fire shadows exclude the distant grove; the forest already splits
  // its nearby opaque geometry from the far canopy before batching.
  group.traverse(object => { if (object instanceof Mesh && object.castShadow) object.layers.enable(2); });
  let disposed = false;
  return {
    group,
    cameraPosition: new Vector3(1, landscape.height(1, 4.5) + 1.25, 4.5),
    cameraTarget: new Vector3(-.4, .95, -4),
    portraitCameraPosition: new Vector3(.30, landscape.height(.30, 4.4) + 1.28, 4.4),
    portraitCameraTarget: new Vector3(-1.1, .95, -4.4),
    invalidateRenderCaches(): void { water.invalidate(); },
    diagnostics: () => ({
      reflectionUpdates: Number(water.mesh.userData.reflectionUpdates),
      reflectionSize: Number(water.mesh.userData.reflectionSize),
      generatedTrees: forest.treeCount,
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
      const materials = new Set<Material>();
      group.traverse(object => {
        if (object instanceof Mesh || object instanceof Points) {
          geometries.add(object.geometry);
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
        }
        if (object instanceof PointLight) object.dispose();
      });
      geometries.forEach(geometry => geometry.dispose());
      // Runtime soil maps are owned and released by their material.
      materials.forEach(material => material.dispose());
      group.clear();
      group.removeFromParent();
    },
  };
}
