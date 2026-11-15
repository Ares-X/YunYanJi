import { Material, Mesh, MeshStandardMaterial, PMREMGenerator, PointLight, Points, Scene, Vector3 } from 'three';
import type { Object3D, WebGLCubeRenderTarget, WebGLRenderer } from 'three';

/**
 * A local, static radiance probe. The first sky capture lights the forest;
 * a second capture sees the actual canopy, trunks, soil and shelter. This lets
 * damp surfaces reflect their surroundings instead of an unobstructed sky.
 * It is a single local IBL approximation, not dynamic global illumination.
 */
export function captureForestEnvironment(
  renderer: WebGLRenderer, scene: Scene, sky: Object3D, position: Vector3,
): WebGLCubeRenderTarget {
  const generator = new PMREMGenerator(renderer), skyScene = new Scene();
  const previousEnvironment = scene.environment;
  const hidden: Object3D[] = [];
  const emissive = new Map<MeshStandardMaterial, number>();
  let skyProbe: WebGLCubeRenderTarget | undefined;
  try {
    skyScene.add(sky);
    skyProbe = generator.fromScene(skyScene, .045, .1, 1000, { size: 256 });
    scene.add(sky);
    scene.environment = skyProbe.texture;
    scene.traverse(object => {
      // Weather and the flame have their own live reflections. Their current
      // animation time must never be baked into a restored static light field.
      let omit = object instanceof Points || object instanceof PointLight;
      if (object instanceof Mesh) {
        const materials: Material[] = Array.isArray(object.material) ? object.material : [object.material];
        omit ||= materials.some(material => material.transparent);
        for (const material of materials) {
          if (material instanceof MeshStandardMaterial && !emissive.has(material)) {
            emissive.set(material, material.emissiveIntensity);
            material.emissiveIntensity = 0;
          }
        }
      }
      if (omit && object.visible) { hidden.push(object); object.visible = false; }
    });
    return generator.fromScene(scene, .025, .08, 210, { size: 256, position });
  } finally {
    hidden.forEach(object => { object.visible = true; });
    emissive.forEach((intensity, material) => { material.emissiveIntensity = intensity; });
    scene.environment = previousEnvironment;
    scene.add(sky);
    skyProbe?.dispose();
    generator.dispose();
  }
}
