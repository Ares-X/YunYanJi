import { BufferGeometry, InstancedBufferGeometry, Material, Mesh, Points } from 'three';
import { describe, expect, it } from 'vitest';
import { createRainfireWorld } from '../../src/scenes/rainfire/createRainfireWorld';
import { createRainHeight, FIRE_X, FIRE_Z, PUDDLE_LEVEL, SHELTER } from '../../src/scenes/rainfire/rainLandscape';

describe('rain forest refuge', () => {
  it('keeps the hearth above the water while the shallow basin and shelter remain usable across seeds', () => {
    for (const seed of ['rainfire-01', 'storm-refuge', 'another-place']) {
      const height = createRainHeight(seed);
      expect(height(FIRE_X, FIRE_Z)).toBeGreaterThan(PUDDLE_LEVEL + .10);
      expect(height(.65, .6)).toBeLessThan(PUDDLE_LEVEL - .012);
      expect(FIRE_X - .86).toBeGreaterThan(SHELTER.x);
      expect(FIRE_X + .86).toBeLessThan(SHELTER.z);
      expect(FIRE_Z - .86).toBeGreaterThan(SHELTER.y);
      expect(height(1, 5.2)).toBeGreaterThan(PUDDLE_LEVEL);
      for (let z = -150; z <= 12; z += 3) for (let x = -70; x <= 70; x += 3) {
        expect(Number.isFinite(height(x, z))).toBe(true);
      }
    }
  });

  it('bounds scene geometry, preserves flame attributes across quality changes, and releases shared resources once', () => {
    const scene = createRainfireWorld({ seed: 'rainfire-01', quality: 'medium' });
    const geometries = new Set<BufferGeometry>(), materials = new Set<Material>();
    let triangles = 0;
    scene.group.traverse(object => {
      if (!(object instanceof Mesh || object instanceof Points)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      const positions = object.geometry.getAttribute('position');
      expect(positions.array.every(Number.isFinite)).toBe(true);
      if (object.geometry.index) {
        expect(object.geometry.index.array.every((index: number) => index < positions.count && index >= 0)).toBe(true);
      }
      if (object instanceof Mesh) triangles += (object.geometry.index?.count ?? positions.count) / 3
        * (object.geometry instanceof InstancedBufferGeometry ? object.geometry.instanceCount : 1);
      if (object.name.startsWith('charred-split-log-')) {
        expect(object.geometry.getAttribute('aFuelRadius').count).toBe(positions.count);
      }
    });
    let geometryReleases = 0, materialReleases = 0;
    geometries.forEach(geometry => geometry.addEventListener('dispose', () => { geometryReleases++; }));
    materials.forEach(material => material.addEventListener('dispose', () => { materialReleases++; }));
    try {
      // Mature full crowns and centimetre-scale foreground relief share a
      // fixed geometry budget; quality switches must not rebuild the world.
      expect(triangles).toBeLessThan(1_500_000);
      for (const quality of ['low', 'high', 'medium'] as const) scene.setQuality(quality);
      expect(geometryReleases).toBe(0);
      expect(materialReleases).toBe(0);
      expect(scene.diagnostics!().generatedTrees).toBeGreaterThanOrEqual(30);
      expect(scene.diagnostics!().generatedTrees).toBeLessThanOrEqual(50);
      expect(scene.diagnostics!().reflectionSize).toBe(384);
    } finally {
      scene.dispose();
      scene.dispose();
    }
    expect(geometryReleases).toBe(geometries.size);
    expect(materialReleases).toBe(materials.size);
    expect(scene.group.children).toHaveLength(0);
  });
});
