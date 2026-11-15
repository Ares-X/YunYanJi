import { Mesh, MeshStandardMaterial } from 'three';
import type { Material } from 'three';
import { describe, expect, it } from 'vitest';
import { buildSnowLandscape, STREAM_LEVEL, streamCenter, streamHalfWidth, streamShoreline, terrainHeight } from '../../src/scenes/snow/snowLandscape';

describe('continuous snow valley', () => {
  it('keeps running water below the banks throughout its bends', () => {
    for (let z = -130; z <= 30; z += 0.75) {
      const center = streamCenter(z), width = streamHalfWidth(z);
      expect(terrainHeight(center, z)).toBeLessThan(STREAM_LEVEL - 0.25);
      for (const side of [-1, 1]) {
        expect(terrainHeight(center + side * (width + 1.8), z)).toBeGreaterThan(STREAM_LEVEL + 0.5);
        // The reflective ribbon overlaps submerged land: no open seam along
        // the curved bank even at the narrowest distant portion of the stream.
        const shore = streamShoreline(z, side);
        expect(terrainHeight(shore + side * 0.2, z)).toBeGreaterThan(STREAM_LEVEL);
        expect(terrainHeight(shore - side * 0.2, z)).toBeLessThan(STREAM_LEVEL);
      }
    }
  });

  it('provides finite upward terrain matching placement queries and bounded rock geometry', () => {
    const materials = { snow: new MeshStandardMaterial(), stone: new MeshStandardMaterial(),
      bark: new MeshStandardMaterial(), needles: new MeshStandardMaterial() };
    const landscape = buildSnowLandscape('qa-snow', materials, 'high');
    try {
      const ground = landscape.group.getObjectByName('continuous-snow-terrain') as Mesh;
      const positions = ground.geometry.getAttribute('position');
      const normals = ground.geometry.getAttribute('normal');
      for (let i = 0; i < positions.count; i += 37) {
        expect(positions.getY(i)).toBeCloseTo(terrainHeight(positions.getX(i), positions.getZ(i)), 3);
        expect(normals.getY(i)).toBeGreaterThan(0);
      }
      let triangles = 0, meshes = 0;
      landscape.group.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        meshes += 1;
        for (const name of ['position', 'normal']) {
          expect(object.geometry.getAttribute(name).array.every(Number.isFinite)).toBe(true);
        }
        triangles += object.geometry.index!.count / 3;
      });
      expect(meshes).toBeLessThanOrEqual(8);
      // Reserve detail for the rolled bank edge, weathered sides below water,
      // and the distant hillside. This is a bounded landscape, not a flat grid.
      expect(triangles).toBeLessThan(500_000);
      expect(landscape.water.mesh.position.y).toBe(STREAM_LEVEL);
    } finally {
      landscape.water.disposeTargets();
      const ownedMaterials = new Set<Material>(Object.values(materials));
      landscape.group.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.geometry.dispose();
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          ownedMaterials.add(material);
        }
      });
      ownedMaterials.forEach((material) => material.dispose());
    }
  });
});
