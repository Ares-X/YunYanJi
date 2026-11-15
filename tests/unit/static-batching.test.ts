import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { mergeStaticMeshes } from '../../src/scenes/snow/mergeStaticMeshes';

describe('static scene batching', () => {
  it('leaves hidden and excluded subtrees intact while merging visible geometry', () => {
    const root = new Group();
    const material = new MeshStandardMaterial();
    const hiddenGroup = new Group();
    hiddenGroup.visible = false;
    const nestedGroup = new Group();
    const hidden = new Mesh(new BoxGeometry(), material);
    hidden.position.x = 30;
    const onHiddenDispose = vi.fn();
    hidden.geometry.addEventListener('dispose', onHiddenDispose);
    nestedGroup.add(hidden);
    hiddenGroup.add(nestedGroup);

    const movingGroup = new Group();
    const moving = new Mesh(new BoxGeometry(), material);
    moving.position.x = -30;
    movingGroup.add(moving);

    const left = new Mesh(new BoxGeometry(), material);
    const right = new Mesh(new BoxGeometry(), material);
    left.position.x = -1;
    right.position.x = 1;
    root.add(hiddenGroup, movingGroup, left, right);

    try {
      const stats = mergeStaticMeshes(root, new Set([movingGroup]));

      expect(hiddenGroup.visible).toBe(false);
      expect(hiddenGroup.children).toHaveLength(1);
      expect(hiddenGroup.children[0]).toBe(nestedGroup);
      expect(nestedGroup.children).toHaveLength(1);
      expect(nestedGroup.children[0]).toBe(hidden);
      expect(hidden.parent).toBe(nestedGroup);
      expect(onHiddenDispose).not.toHaveBeenCalled();
      expect(movingGroup.children).toHaveLength(1);
      expect(movingGroup.children[0]).toBe(moving);
      expect(moving.parent).toBe(movingGroup);

      const batches = root.children.filter((object): object is Mesh => object instanceof Mesh);
      expect(batches).toHaveLength(1);
      const batch = batches[0]!;
      expect(batch.material).toBe(material);
      expect(batch.geometry.getAttribute('position').count).toBe(48);
      expect(batch.geometry.boundingBox!.min.x).toBe(-1.5);
      expect(batch.geometry.boundingBox!.max.x).toBe(1.5);
      expect(left.parent).toBeNull();
      expect(right.parent).toBeNull();
      expect(stats).toEqual({ meshesBefore: 4, meshesAfter: 3, geometriesBefore: 4, geometriesAfter: 3 });
    } finally {
      root.traverse((object) => {
        if (object instanceof Mesh) object.geometry.dispose();
      });
      material.dispose();
    }
  });
});
