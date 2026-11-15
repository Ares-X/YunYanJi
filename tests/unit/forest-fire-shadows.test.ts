import {
  Box3, BufferGeometry, Float32BufferAttribute, Mesh, MeshDepthMaterial,
  MeshDistanceMaterial, MeshStandardMaterial, PerspectiveCamera, Uint32BufferAttribute, Vector3,
} from 'three';
import type { Material, WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import { forestFireShadowBounds, limitForestFireShadows } from '../../src/scenes/rainfire/forestFireShadows';

type Point = [number, number, number];
type Triangle = [Point, Point, Point];
const box = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
const inside: Triangle = [[0, 0, 0], [.5, 0, 0], [0, .5, 0]];
const outside: Triangle = [[2, 0, 0], [2.5, 0, 0], [2, .5, 0]];

function batch(triangles: Triangle[]): Mesh {
  const positions = triangles.flat(2), geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(new Uint32BufferAttribute(Array.from({ length: positions.length / 3 }, (_, i) => i), 1));
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return new Mesh(geometry, new MeshStandardMaterial());
}

function release(mesh: Mesh): void {
  mesh.geometry.dispose(); (mesh.material as Material).dispose();
}

function shadow(mesh: Mesh, material: Material) {
  const camera = new PerspectiveCamera();
  // Three r187 supplies the object itself and a null group for these batches;
  // @types/three still describes these two parameters as Scene and Group.
  const args = [
    {} as WebGLRenderer, mesh, camera, camera, mesh.geometry, material, null,
  ] as unknown as Parameters<Mesh['onBeforeShadow']>;
  return { before: () => mesh.onBeforeShadow(...args), after: () => mesh.onAfterShadow(...args) };
}

describe('bounded forest fire shadows', () => {
  it('uses a cube including the hearth centroid, both lamp positions and maximum wind', () => {
    const hearth = new Vector3(-.8, 2.006, -1.6);
    const bounds = forestFireShadowBounds(hearth);
    const centre = bounds.getCenter(new Vector3());
    expect(centre.x).toBeCloseTo(-.8); expect(centre.y).toBeCloseTo(2.556); expect(centre.z).toBeCloseTo(-1.6);
    const size = bounds.getSize(new Vector3());
    expect(size.x).toBeCloseTo(21.2); expect(size.y).toBeCloseTo(21.2); expect(size.z).toBeCloseTo(21.2);
    expect(hearth.toArray()).toEqual([-.8, 2.006, -1.6]);
  });

  it('retains boundary contacts and crossing triangles without losing or reversing any index', () => {
    const crossing: Triangle = [[-2, 0, 0], [2, 2, 0], [2, -2, 0]];
    const triangles: Triangle[] = [outside, inside, crossing];
    const retainedIds = [1, 2];
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const touching: Triangle = [[0, 0, 0], [0, .25, .25], [.25, 0, 0]];
      touching.forEach(vertex => { vertex[axis] = sign; });
      retainedIds.push(triangles.length); triangles.push(touching);
      triangles.push(touching.map(vertex => {
        const result: Point = [...vertex]; result[axis] = sign * 1.01; return result;
      }) as Triangle);
    }
    const mesh = batch(triangles), geometry = mesh.geometry, index = geometry.index!;
    const attributes = { ...geometry.attributes };
    const positionValues = Array.from(geometry.getAttribute('position').array);
    const normalValues = Array.from(geometry.getAttribute('normal').array);
    const oldBox = geometry.boundingBox!.clone(), oldSphere = geometry.boundingSphere!.clone();
    try {
      expect(limitForestFireShadows(mesh, box)).toBe(retainedIds.length);
      expect(geometry.index).toBe(index);
      expect(index.count).toBe(triangles.length * 3);
      const ids: number[] = [];
      for (let i = 0; i < index.count; i += 3) {
        const a = index.getX(i); ids.push(a / 3);
        expect([index.getX(i + 1), index.getX(i + 2)]).toEqual([a + 1, a + 2]);
      }
      expect(ids.slice(0, retainedIds.length)).toEqual(retainedIds);
      expect([...ids].sort((a, b) => a - b)).toEqual(triangles.map((_, i) => i));
      expect(geometry.getAttribute('position')).toBe(attributes.position);
      expect(geometry.getAttribute('normal')).toBe(attributes.normal);
      expect(Array.from(geometry.getAttribute('position').array)).toEqual(positionValues);
      expect(Array.from(geometry.getAttribute('normal').array)).toEqual(normalValues);
      expect(geometry.boundingBox!.equals(oldBox)).toBe(true);
      expect(geometry.boundingSphere!.equals(oldSphere)).toBe(true);
    } finally { release(mesh); }
  });

  it('limits only point-shadow ranges and restores finite, empty and infinite ranges exactly', () => {
    const mesh = batch([outside, inside, inside]), point = new MeshDistanceMaterial(), sun = new MeshDepthMaterial();
    try {
      expect(limitForestFireShadows(mesh, box)).toBe(2);
      const index = mesh.geometry.index!, array = index.array, version = index.version;
      const pointPass = shadow(mesh, point), sunPass = shadow(mesh, sun);
      for (const [start, count, limited] of [[0, Infinity, 6], [3, 6, 3], [9, 3, 0], [3, 0, 0]]) {
        mesh.geometry.setDrawRange(start!, count!);
        pointPass.before();
        expect(mesh.geometry.drawRange).toEqual({ start, count: limited });
        pointPass.after();
        expect(mesh.geometry.drawRange).toEqual({ start, count });
        sunPass.before();
        expect(mesh.geometry.drawRange).toEqual({ start, count });
        sunPass.after();
        expect(mesh.geometry.drawRange).toEqual({ start, count });
      }
      expect(mesh.geometry.index).toBe(index); expect(index.array).toBe(array); expect(index.version).toBe(version);
    } finally { point.dispose(); sun.dispose(); release(mesh); }
  });

  it('preserves existing hook pairs and restores an empty fire prefix without touching beauty', () => {
    const mesh = batch([outside]), point = new MeshDistanceMaterial();
    let beforeCalls = 0, afterCalls = 0;
    mesh.onBeforeShadow = () => { beforeCalls++; mesh.geometry.setDrawRange(3, Infinity); };
    mesh.onAfterShadow = () => {
      afterCalls++; expect(mesh.geometry.drawRange).toEqual({ start: 3, count: Infinity });
      mesh.geometry.setDrawRange(0, Infinity);
    };
    try {
      expect(limitForestFireShadows(mesh, box)).toBe(0);
      const pass = shadow(mesh, point);
      pass.before(); expect(mesh.geometry.drawRange).toEqual({ start: 3, count: 0 });
      pass.after(); expect(mesh.geometry.drawRange).toEqual({ start: 0, count: Infinity });
      expect(mesh.geometry.index!.count).toBe(3);
      expect(beforeCalls).toBe(1); expect(afterCalls).toBe(1);
    } finally { point.dispose(); release(mesh); }
  });
});
