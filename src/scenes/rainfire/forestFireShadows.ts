import { Box3, MeshDistanceMaterial, Vector3 } from 'three';
import type { Mesh } from 'three';

/** Both 9 m light cubes, including lamp drift and the forest's bounded wind. */
export function forestFireShadowBounds(hearth: Vector3): Box3 {
  const centre = hearth.clone();
  centre.y += .55;
  // The two area samples and combustion centroid stay within +/- .3 m of
  // this point. A further 1.3 m covers every wind-deformed forest vertex.
  const extent = 9 + .3 + 1.3;
  return new Box3(centre.clone().addScalar(-extent), centre.addScalar(extent));
}

/**
 * Partition a forest batch's complete index buffer once. Only point-shadow
 * draws use its conservative near-fire prefix; all other passes retain every
 * triangle, vertex, attribute and the full geometry bounds. These batches use
 * world-metre positions and one material, with no geometry groups.
 */
export function limitForestFireShadows(mesh: Mesh, bounds: Box3): number {
  const geometry = mesh.geometry, index = geometry.index;
  if (!index || index.count % 3 !== 0 || geometry.groups.length !== 0) {
    throw new Error('Forest fire shadows require an ungrouped indexed triangle batch');
  }
  const positions = geometry.getAttribute('position');
  const retained = new Uint8Array(index.count / 3);
  const source = index.array;
  let prefixCount = 0;
  for (let i = 0; i < index.count; i += 3) {
    const a = source[i]!, b = source[i + 1]!, c = source[i + 2]!;
    // Strict outside tests retain boundary contacts and triangles crossing
    // the cube even when all three of their vertices lie outside it.
    const outside = Math.max(positions.getX(a), positions.getX(b), positions.getX(c)) < bounds.min.x
      || Math.min(positions.getX(a), positions.getX(b), positions.getX(c)) > bounds.max.x
      || Math.max(positions.getY(a), positions.getY(b), positions.getY(c)) < bounds.min.y
      || Math.min(positions.getY(a), positions.getY(b), positions.getY(c)) > bounds.max.y
      || Math.max(positions.getZ(a), positions.getZ(b), positions.getZ(c)) < bounds.min.z
      || Math.min(positions.getZ(a), positions.getZ(b), positions.getZ(c)) > bounds.max.z;
    if (!outside) { retained[i / 3] = 1; prefixCount += 3; }
  }
  const ordered = source.slice();
  let near = 0, far = prefixCount;
  for (let i = 0; i < index.count; i += 3) {
    const destination = retained[i / 3] ? near : far;
    ordered[destination] = source[i]!;
    ordered[destination + 1] = source[i + 1]!;
    ordered[destination + 2] = source[i + 2]!;
    if (retained[i / 3]) near += 3; else far += 3;
  }
  source.set(ordered);
  index.needsUpdate = true;
  mesh.userData.fireShadowTriangles = prefixCount / 3;

  const before = mesh.onBeforeShadow, after = mesh.onAfterShadow;
  let start = 0, count = Infinity, limited = false;
  mesh.onBeforeShadow = (renderer, object, camera, shadowCamera, geometry, material, group) => {
    before.call(mesh, renderer, object, camera, shadowCamera, geometry, material, group);
    if (!(material instanceof MeshDistanceMaterial)) return;
    start = geometry.drawRange.start; count = geometry.drawRange.count; limited = true;
    // r187 reads drawRange after this hook, but uploads the index before it.
    // Never replace/upload an index or allocate data during a shadow draw.
    geometry.setDrawRange(start, Math.max(0, Math.min(start + count, prefixCount) - start));
  };
  mesh.onAfterShadow = (renderer, object, camera, shadowCamera, geometry, material, group) => {
    if (limited) { geometry.setDrawRange(start, count); limited = false; }
    after.call(mesh, renderer, object, camera, shadowCamera, geometry, material, group);
  };
  return prefixCount / 3;
}
