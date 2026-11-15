import { BufferGeometry, Group, Material, Mesh, Vector3 } from 'three';
import type { EnvironmentSnapshot, QualityLevel } from '../../core/types';
import { createProceduralMaterial } from '../../render/materials/proceduralMaterials';
import type { PoemScene, SceneOptions } from '../types';
import { buildCourtyard } from './geometry';
import { SnowParticles } from './snowParticles';

/** A small authored composition built entirely from seeded algorithms. */
export function createSnowCourtyard(options: SceneOptions): PoemScene {
  const group = new Group();
  group.name = 'poem-yongxue';
  const materials = {
    snow: createProceduralMaterial('snow', options.seed),
    stone: createProceduralMaterial('stone', options.seed),
    wood: createProceduralMaterial('wood', options.seed),
    bark: createProceduralMaterial('bark', options.seed),
    plaster: createProceduralMaterial('plaster', options.seed),
    tile: createProceduralMaterial('tile', options.seed),
  };
  const courtyard = buildCourtyard(options.seed, materials, options.quality);
  const snow = new SnowParticles(options.seed, options.quality);
  group.add(courtyard.group, snow.points);
  let disposed = false;

  return {
    group,
    cameraPosition: new Vector3(7.8, 2.65, 12.2),
    cameraTarget: new Vector3(-0.4, 1.65, -4.2),
    portraitCameraPosition: new Vector3(-4, 2.7, 20.5),
    portraitCameraTarget: new Vector3(-1.4, 2.8, -5),
    invalidateRenderCaches(): void { courtyard.pond.invalidate(); },
    diagnostics: () => ({
      reflectionUpdates: Number(courtyard.pond.mesh.userData.reflectionUpdates),
      reflectionSize: Number(courtyard.pond.mesh.userData.reflectionSize),
    }),
    update(frame: EnvironmentSnapshot): void {
      if (disposed) return;
      snow.update(frame);
      courtyard.pond.update(frame);
      courtyard.tree.rotation.z = frame.reducedMotion ? 0 : -frame.wind.x * 0.0015;
      courtyard.tree.rotation.x = frame.reducedMotion ? 0 : frame.wind.z * 0.0015;
    },
    setQuality(quality: QualityLevel): void {
      if (!disposed) { snow.setQuality(quality); courtyard.pond.setQuality(quality); }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      snow.dispose();
      courtyard.pond.disposeTargets();
      const geometries = new Set<BufferGeometry>();
      const ownedMaterials = new Set<Material>();
      courtyard.group.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        geometries.add(object.geometry);
        const entries = Array.isArray(object.material) ? object.material : [object.material];
        for (const entry of entries) ownedMaterials.add(entry);
      });
      geometries.forEach((geometry) => geometry.dispose());
      ownedMaterials.forEach((material) => material.dispose());
      group.clear();
      group.removeFromParent();
    },
  };
}
