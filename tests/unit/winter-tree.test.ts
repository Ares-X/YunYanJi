import { Box3, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { buildWinterTree } from '../../src/scenes/snow/winterTree';

describe('winter tree generation', () => {
  it('keeps reproducible finite geometry and bounded detail for foreground and background trees', () => {
    const materials = { wood: new MeshStandardMaterial(), snow: new MeshStandardMaterial() };
    const trees = [
      buildWinterTree('qa-snow/main', materials, true),
      buildWinterTree('qa-snow/main', materials, true),
      buildWinterTree('other-snow/main', materials, true),
      buildWinterTree('qa-snow/main', materials, false),
    ];
    try {
      for (const tree of trees) {
        expect(tree.children).toHaveLength(2);
        let triangles = 0;
        for (const child of tree.children) {
          expect(child).toBeInstanceOf(Mesh);
          const mesh = child as Mesh;
          for (const name of ['position', 'normal']) {
            const values = mesh.geometry.getAttribute(name).array;
            expect(values.every(Number.isFinite)).toBe(true);
          }
          triangles += mesh.geometry.index!.count / 3;
          expect(mesh.castShadow).toBe(true);
          expect(mesh.receiveShadow).toBe(true);
        }
        expect(triangles).toBeLessThan(45_000);
        const bounds = new Box3().setFromObject(tree);
        const size = bounds.getSize(new Vector3());
        expect(bounds.min.y).toBeLessThan(0);
        expect(size.y).toBeGreaterThan(4.5);
        expect(size.y).toBeLessThan(6.1);
        expect(size.x).toBeLessThan(6);
        expect(size.z).toBeLessThan(6);
      }
      const positions = (index: number) => (trees[index]!.children[0] as Mesh).geometry.getAttribute('position').array;
      expect(positions(0)).toEqual(positions(1));
      expect(positions(0)).not.toEqual(positions(2));
      expect(trees[3]!.userData.generatedTree.triangles).toBeLessThan(trees[0]!.userData.generatedTree.triangles / 3);
    } finally {
      for (const tree of trees) tree.traverse((object) => { if (object instanceof Mesh) object.geometry.dispose(); });
      materials.wood.dispose();
      materials.snow.dispose();
    }
  });
});
