import { BufferGeometry, Group, Material, Mesh, Vector3 } from 'three';
import { createRandom, randomBetween } from '../../core/random';
import type { EnvironmentSnapshot, QualityLevel } from '../../core/types';
import { createProceduralMaterial } from '../../render/materials/proceduralMaterials';
import type { PoemScene, SceneOptions } from '../types';
import { buildSnowPine, buildForestSnag, createForestNeedleMaterial } from './forestTrees';
import type { ForestTreeDetail } from './forestTrees';
import { buildSnowLandscape, streamCenter, streamHalfWidth, terrainHeight } from './snowLandscape';
import { mergeStaticMeshes } from './mergeStaticMeshes';
import { SnowParticles } from './snowParticles';
import { buildForestFloor } from './forestFloor';

/** A continuous landscape in metres, composed from the bank at human eye height. */
export function createSnowWorld(options: SceneOptions): PoemScene {
  const group = new Group();
  group.name = 'yongxue-winter-world';
  const materials = {
    snow: createProceduralMaterial('snow', options.seed),
    stone: createProceduralMaterial('stone', options.seed),
    bark: createProceduralMaterial('bark', options.seed),
    wood: createProceduralMaterial('wood', options.seed),
    needles: createForestNeedleMaterial(options.seed),
  };
  const landscape = buildSnowLandscape(options.seed, materials, options.quality);
  group.add(landscape.group, buildForestFloor(options.seed, materials));
  const forest = new Group();
  forest.name = 'layered-snow-forest';
  group.add(forest);
  const random = createRandom(`${options.seed}/forest-layout`);
  let treeCount = 0;
  const addPine = (x: number, z: number, scale: number, detail: ForestTreeDetail) => {
    const tree = buildSnowPine(`${options.seed}/pine/${treeCount++}`, materials, detail, { young: scale < 0.67 });
    tree.position.set(x, terrainHeight(x, z) - 0.09, z);
    tree.scale.set(scale * randomBetween(random, 0.88, 1.08), scale, scale * randomBetween(random, 0.90, 1.07));
    tree.rotation.y = random() * Math.PI * 2;
    forest.add(tree);
  };
  // Tall trunks continue beyond the frame. The viewer stands inside the grove.
  addPine(-4.5, 7.5, 1.15, 'near');
  addPine(15.8, 3.5, 1.19, 'near');
  addPine(-11.7, 1.2, 1.04, 'near');
  const middle: [number, number, number][] = [
    [-6.8, -5.5, 1.09], [11.0, -4, 0.91], [-14, -12, 1.06],
    [-8.8, -19, 0.88], [8.5, -18, 1.19], [18, -15, 1.07],
    [-20, -7, 1.13], [-17, -29, 1.25], [13, -31, 0.94],
    [-9.5, -37, 1.13], [9.0, -43, 1.16], [-23, -22, 0.92],
    [24, -27, 1.28], [-4.5, -51, 0.87], [20, -48, 1.12],
  ];
  for (const [x, z, scale] of middle) addPine(x, z, scale, 'mid');
  // Broken, offset rows make the forest close in gradually around the water.
  for (let row = 0; row < 9; row++) for (const bank of [-1, 1]) {
    const z = -27 - row * 9 + randomBetween(random, -3, 3);
    for (let column = 0; column < 4; column++) {
      const x = streamCenter(z) + bank * (streamHalfWidth(z) + 4.5 + column * 6.0 + randomBetween(random, -1.5, 1.5));
      addPine(x, z + randomBetween(random, -3, 3), randomBetween(random, 0.62, 1.48), 'far');
    }
  }
  // Saplings grow in small groups at the light-filled edges, under older crowns.
  for (const [x, z, scale] of [
    [-3.7, -3.4, 0.38], [-6.1, -5.7, 0.55], [-4.8, -7.0, 0.32],
    [7.3, -10.8, 0.46], [8.6, -13.7, 0.63], [10.1, -12.4, 0.35],
    [-7.3, -27.2, 0.48], [3.9, -39.5, 0.59],
  ] as const) addPine(x, z, scale, 'mid');
  for (const [x, z, scale] of [[-3.9, -14, 0.80], [9.5, -31, 0.85], [-15, -46, 1.1]] as const) {
    const snag = buildForestSnag(`${options.seed}/snag/${x}`, materials, 'mid');
    snag.position.set(x, terrainHeight(x, z) - 0.12, z);
    snag.scale.multiplyScalar(scale);
    snag.rotation.y = random() * Math.PI * 2;
    forest.add(snag);
  }
  mergeStaticMeshes(forest, new Set());

  const snow = new SnowParticles(options.seed, options.quality);
  group.add(snow.points);
  let disposed = false;
  return {
    group,
    cameraPosition: new Vector3(9.0, 2.15 + terrainHeight(9.0, 17), 17),
    cameraTarget: new Vector3(-0.8, 2.1, -24),
    portraitCameraPosition: new Vector3(9.5, 1.7 + terrainHeight(9.5, 13.5), 13.5),
    portraitCameraTarget: new Vector3(-1.0, 1.5, -18),
    invalidateRenderCaches(): void { landscape.water.invalidate(); },
    diagnostics: () => ({
      reflectionUpdates: Number(landscape.water.mesh.userData.reflectionUpdates),
      reflectionSize: Number(landscape.water.mesh.userData.reflectionSize),
      generatedTrees: treeCount,
    }),
    update(frame: EnvironmentSnapshot): void {
      if (disposed) return;
      snow.update(frame);
      landscape.water.update(frame);
    },
    setQuality(quality: QualityLevel): void {
      if (!disposed) { snow.setQuality(quality); landscape.water.setQuality(quality); }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      snow.dispose();
      landscape.water.disposeTargets();
      const geometries = new Set<BufferGeometry>();
      const ownedMaterials = new Set<Material>(Object.values(materials));
      group.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) ownedMaterials.add(material);
      });
      geometries.forEach(geometry => geometry.dispose());
      ownedMaterials.forEach(material => material.dispose());
      group.clear();
      group.removeFromParent();
    },
  };
}
