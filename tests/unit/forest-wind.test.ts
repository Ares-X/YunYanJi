import { Material, Mesh, MeshStandardMaterial, PlaneGeometry, ShaderLib } from 'three';
import type { WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import { createForestWind } from '../../src/scenes/rainfire/forestWind';
import { buildLivingForest } from '../../src/scenes/rainfire/livingForest';
import { createRainHeight } from '../../src/scenes/rainfire/rainLandscape';
import type { EnvironmentSnapshot } from '../../src/core/types';

const frame = (elapsed: number, reducedMotion = false): EnvironmentSnapshot => ({
  elapsed, delta: .016, wind: { x: .8, y: .2, z: -.3, strength: .6 },
  precipitation: .8, gust: .4, reducedMotion,
});

describe('forest wind and canopy', () => {
  it('shares the same absolute-time deformation with visible, depth and point-shadow passes', () => {
    const wind = createForestWind();
    const material = new MeshStandardMaterial();
    const geometry = new PlaneGeometry(1, 1);
    geometry.computeBoundingBox();geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry, material);
    wind.install(material);wind.attach(mesh);
    const passes = [
      [material, ShaderLib.standard],
      [mesh.customDepthMaterial!, ShaderLib.depth],
      [mesh.customDistanceMaterial!, ShaderLib.distance],
    ] as const;
    let releases = 0;
    mesh.customDepthMaterial!.addEventListener('dispose', () => { releases++; });
    mesh.customDistanceMaterial!.addEventListener('dispose', () => { releases++; });
    try {
      for (const [pass, source] of passes) {
        const shader = { vertexShader: source.vertexShader, fragmentShader: source.fragmentShader, uniforms: {} };
        pass.onBeforeCompile(shader as Parameters<Material['onBeforeCompile']>[0], {} as WebGLRenderer);
        expect(shader.uniforms).toMatchObject(wind.uniforms);
        expect(shader.vertexShader).toContain('transformed=forestDeform(transformed)');
        expect(shader.vertexShader).toContain('aForestWindAnchor.xyz+forestRotate');
      }
      wind.update(frame(8));
      const previous = wind.uniforms.uForestWind.value.toArray();
      const handle = wind.uniforms.uForestWind.value;
      wind.update({ ...frame(8), delta: 0 });
      expect(wind.uniforms.uForestTime.value).toBe(8);
      expect(wind.uniforms.uForestWind.value.toArray()).toEqual(previous);
      expect(wind.uniforms.uForestWind.value).toBe(handle);
      wind.setEnvironmentCapture(true);
      expect(wind.uniforms.uForestTime.value).toBe(0);
      expect(wind.uniforms.uForestWind.value.toArray()).toEqual([0, 0, 0]);
      expect(wind.uniforms.uForestWind.value).toBe(handle);
      // Repeated setup and simulation updates cannot move a static probe or
      // overwrite the visible pose that must resume after its capture.
      wind.setEnvironmentCapture(true);
      wind.update(frame(9));
      expect(wind.uniforms.uForestTime.value).toBe(0);
      expect(wind.uniforms.uForestWind.value.toArray()).toEqual([0, 0, 0]);
      wind.setEnvironmentCapture(false);
      wind.setEnvironmentCapture(false);
      expect(wind.uniforms.uForestTime.value).toBe(8);
      expect(wind.uniforms.uForestWind.value.toArray()).toEqual(previous);
      expect(wind.uniforms.uForestWind.value).toBe(handle);
      wind.update(frame(2));
      expect(wind.uniforms.uForestTime.value).toBe(2);
      wind.update(frame(2, true));
      expect(wind.uniforms.uForestWind.value.y).toBe(0);
      wind.dispose();wind.dispose();
      expect(releases).toBe(2);
    } finally {
      wind.dispose();material.dispose();geometry.dispose();
    }
  });

  it('keeps leaf attachments and canopy shadow tiers inside the forest geometry budget', () => {
    const forest = buildLivingForest('rainfire-01', createRainHeight('rainfire-01'));
    const materials = new Set<Material>();
    let triangles = 0, roots = 0, leaves = 0, fireSource = 0, firePrefix = 0;
    try {
      expect(forest.group.children).toHaveLength(6);
      for (const object of forest.group.children) {
        const mesh = object as Mesh;
        materials.add(mesh.material as Material);
        const positions = mesh.geometry.getAttribute('position');
        expect(mesh.geometry.getAttribute('aForestRootHeight').count).toBe(positions.count);
        expect(mesh.geometry.getAttribute('aForestIdentity').count).toBe(positions.count);
        expect(mesh.geometry.getAttribute('uv').count).toBe(positions.count);
        const windRoots = mesh.geometry.getAttribute('aForestWindRoot');
        const anchors = mesh.geometry.getAttribute('aForestWindAnchor');
        expect(windRoots.count).toBe(positions.count);
        expect(anchors.count).toBe(positions.count);
        expect(windRoots.array.every(Number.isFinite)).toBe(true);
        expect(anchors.array.every(Number.isFinite)).toBe(true);
        triangles += mesh.geometry.index!.count / 3;
        expect(mesh.geometry.drawRange).toEqual({ start: 0, count: Infinity });
        if (mesh.userData.fireShadow) {
          fireSource += mesh.geometry.index!.count / 3;
          firePrefix += Number(mesh.userData.fireShadowTriangles);
        }
        if (mesh.name.includes('middle')) {
          expect(mesh.castShadow).toBe(true);
          expect(mesh.userData.fireShadow).toBe(false);
        }
        for (let index = 0; index < positions.count; index++) {
          if (anchors.getW(index) === 0 && positions.getY(index) <= windRoots.getY(index)) roots++;
          if (anchors.getW(index) > 0) leaves++;
        }
      }
      expect(roots).toBeGreaterThan(0);
      expect(leaves).toBeGreaterThan(20_000);
      // The upstream space-colonized full crowns use 892,944 triangles for
      // this seed before wind. Preserve them within the new scene's 1.5 M cap.
      expect(triangles).toBeLessThan(1_000_000);
      expect(forest.group.userData.forest.fireShadowTriangles)
        .toBeLessThan(forest.group.userData.forest.shadowTriangles);
      expect(forest.group.userData.forest.fireShadowSourceTriangles).toBe(fireSource);
      expect(forest.group.userData.forest.fireShadowTriangles).toBe(firePrefix);
      expect(firePrefix).toBeGreaterThan(0);
      expect(firePrefix).toBeLessThan(fireSource);
    } finally {
      forest.dispose();
      forest.group.traverse(object => { if (object instanceof Mesh) object.geometry.dispose(); });
      materials.forEach(material => material.dispose());
    }
    // Full procedural crowns are CPU-generated; this is a structural/resource
    // check, not a five-second startup performance claim under parallel tests.
  }, 15_000);
});
