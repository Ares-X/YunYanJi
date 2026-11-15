import { BufferGeometry, Group, InstancedMesh, Material, Matrix4, Mesh, Object3D, SkinnedMesh } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface StaticBatchStats {
  meshesBefore: number;
  meshesAfter: number;
  geometriesBefore: number;
  geometriesAfter: number;
}

function countMeshes(root: Group): { meshes: number; geometries: number } {
  let meshes = 0;
  const geometries = new Set<BufferGeometry>();
  root.traverse((object) => {
    if (object instanceof Mesh) {
      meshes += 1;
      geometries.add(object.geometry);
    }
  });
  return { meshes, geometries: geometries.size };
}

/** Merge static renderables in root space while retaining every lighting flag. */
export function mergeStaticMeshes(root: Group, excluded: ReadonlySet<Object3D>): StaticBatchStats {
  const before = countMeshes(root);
  root.updateMatrixWorld(true);
  const inverseRoot = new Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map<string, { material: Material; meshes: Mesh[] }>();
  const walk = (object: Object3D): void => {
    // Visibility is inherited: never lift a hidden descendant into a visible batch.
    if (!object.visible || excluded.has(object)) return;
    if (object instanceof Mesh && !Array.isArray(object.material) && !(object instanceof InstancedMesh) && !(object instanceof SkinnedMesh)) {
      const key = `${object.material.uuid}/${Number(object.castShadow)}/${Number(object.receiveShadow)}/${object.renderOrder}/${object.layers.mask}`;
      const bucket = buckets.get(key) ?? { material: object.material, meshes: [] as Mesh[] };
      bucket.meshes.push(object);
      buckets.set(key, bucket);
    }
    for (const child of object.children) walk(child);
  };
  walk(root);

  const retiredGeometries = new Set<BufferGeometry>();
  for (const { material, meshes } of buckets.values()) {
    if (meshes.length < 2) continue;
    const parts: BufferGeometry[] = [];
    for (const original of meshes) {
      const part = original.geometry.clone();
      // Analytic surfaces need no UVs. Runtime-generated needle coverage uses a
      // real UV channel; stripping it would turn the cutout canopy into sheets.
      const usesUv = ['map', 'alphaMap', 'normalMap', 'roughnessMap'].some((name) =>
        name in material && Boolean((material as unknown as Record<string, unknown>)[name]));
      for (const attribute of Object.keys(part.attributes)) {
        if (attribute !== 'position' && attribute !== 'normal' && !(usesUv && attribute === 'uv')) part.deleteAttribute(attribute);
      }
      if (!part.getAttribute('normal')) part.computeVertexNormals();
      if (!part.index) part.setIndex(Array.from({ length: part.getAttribute('position').count }, (_, index) => index));
      part.clearGroups();
      part.applyMatrix4(new Matrix4().multiplyMatrices(inverseRoot, original.matrixWorld));
      parts.push(part);
    }
    const geometry = mergeGeometries(parts, false);
    parts.forEach((part) => part.dispose());
    if (!geometry) throw new Error(`Cannot batch static material ${material.name || material.type}`);
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    const first = meshes[0]!;
    const combined = new Mesh(geometry, material);
    combined.name = `static-batch-${material.name || material.type}-${Number(first.castShadow)}`;
    combined.castShadow = first.castShadow;
    combined.receiveShadow = first.receiveShadow;
    combined.renderOrder = first.renderOrder;
    combined.layers.mask = first.layers.mask;
    root.add(combined);
    for (const original of meshes) {
      retiredGeometries.add(original.geometry);
      original.removeFromParent();
    }
  }

  // A geometry may be shared with an excluded moving object; leave it alive.
  root.traverse((object) => {
    if (object instanceof Mesh) retiredGeometries.delete(object.geometry);
  });
  retiredGeometries.forEach((geometry) => geometry.dispose());
  const after = countMeshes(root);
  return { meshesBefore: before.meshes, meshesAfter: after.meshes, geometriesBefore: before.geometries, geometriesAfter: after.geometries };
}
