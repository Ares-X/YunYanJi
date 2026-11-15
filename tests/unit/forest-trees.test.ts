import { Box3, DataTexture, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { buildSnowPine, createForestNeedleMaterial } from '../../src/scenes/snow/forestTrees';

describe('snow forest generation', () => {
  it('keeps metre-scale crowns, valid geometry and a bounded distant forest cost', () => {
    const materials = { bark: new MeshStandardMaterial(), snow: new MeshStandardMaterial(), needles: new MeshStandardMaterial() };
    const trees = [
      buildSnowPine('qa-snow/main', materials, 'near'),
      buildSnowPine('qa-snow/main', materials, 'mid'),
      buildSnowPine('qa-snow/main', materials, 'far'),
      buildSnowPine('qa-snow/main', materials, 'far'),
      buildSnowPine('different-winter', materials, 'far'),
    ];
    try {
      for (const tree of trees) {
        expect(tree.children).toHaveLength(3);
        const size = new Box3().setFromObject(tree).getSize(new Vector3());
        expect(size.y).toBeGreaterThan(13);
        expect(size.y).toBeLessThan(17);
        expect(size.x).toBeGreaterThan(4);
        expect(size.x).toBeLessThan(11);
        for (const child of tree.children) {
          const mesh = child as Mesh;
          for (const attribute of ['position', 'normal']) {
            expect(mesh.geometry.getAttribute(attribute).array.every(Number.isFinite)).toBe(true);
          }
          const vertexCount = mesh.geometry.getAttribute('position').count;
          expect(mesh.geometry.index!.array.every((index) => index >= 0 && index < vertexCount)).toBe(true);
        }
      }
      const counts = trees.map((tree) => tree.userData.generatedTree.triangles as number);
      expect(counts[0]).toBeLessThan(150_000);
      expect(counts[1]).toBeLessThan(38_000);
      expect(counts[2]).toBeLessThan(9_000);
      expect(counts[2]).toBeLessThan(counts[0]! / 15);
      const positions = (index: number) => (trees[index]!.children[0] as Mesh).geometry.getAttribute('position').array;
      expect(positions(2)).toEqual(positions(3));
      expect(positions(2)).not.toEqual(positions(4));
    } finally {
      for (const tree of trees) tree.traverse((object) => { if (object instanceof Mesh) object.geometry.dispose(); });
      for (const material of Object.values(materials)) material.dispose();
    }
  });

  it('creates and shares a procedural needle cutout until its last material is disposed', () => {
    const first = createForestNeedleMaterial('needle-cache-test');
    const second = createForestNeedleMaterial('needle-cache-test');
    const map = first.map! as DataTexture;
    let releases = 0;
    map.addEventListener('dispose', () => { releases++; });
    try {
      expect(second.map).toBe(map);
      expect(map.image.width).toBe(512);
      expect(map.image.height).toBe(512);
      const pixels = map.image.data as Uint8Array;
      let coverage = 0;
      for (let index = 3; index < pixels.length; index += 4) coverage += pixels[index]! / 255;
      expect(coverage / (512 * 512)).toBeGreaterThan(0.08);
      expect(coverage / (512 * 512)).toBeLessThan(0.65);
      first.dispose();
      expect(releases).toBe(0);
      second.dispose();
      expect(releases).toBe(1);
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});
