import { Mesh, MeshStandardMaterial } from 'three';
import type { Object3D } from 'three';
import type { EnvironmentSnapshot } from '../../core/types';
import { SHELTER } from './rainLandscape';

/**
 * A thin, patchy coating on upward-facing surfaces. It follows each mesh's
 * world position and wind-deformed normal, including leaves and the canvas.
 * This is surface accumulation, not a second floating terrain or an image.
 */
export function createSnowSurface(root: Object3D) {
  const amount = { value: 0 };
  const installed = new Set<MeshStandardMaterial>();
  let current = 0, capturing = false;
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    let ancestor: Object3D | null = object;
    while (ancestor) {
      if (ancestor.userData.yyjSnowExclude) return;
      ancestor = ancestor.parent;
    }
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!(material instanceof MeshStandardMaterial) || installed.has(material)) continue;
      installed.add(material);
      const previous = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
      material.onBeforeCompile = (shader, renderer) => {
        previous(shader, renderer);
        shader.uniforms.uYyjSnowCover = amount;
        shader.uniforms.uYyjSnowShelter = { value: SHELTER };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vYyjSnowWorld;\nvarying float vYyjSnowUp;')
          .replace('#include <worldpos_vertex>', /* glsl */ `
            #include <worldpos_vertex>
            vec4 yyjSnowWorld = vec4(transformed, 1.0);
            #ifdef USE_BATCHING
              yyjSnowWorld = batchingMatrix * yyjSnowWorld;
            #endif
            #ifdef USE_INSTANCING
              yyjSnowWorld = instanceMatrix * yyjSnowWorld;
            #endif
            vYyjSnowWorld = (modelMatrix * yyjSnowWorld).xyz;
            vYyjSnowUp = inverseTransformDirection(normalize(transformedNormal), viewMatrix).y;
          `);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', /* glsl */ `
            #include <common>
            varying vec3 vYyjSnowWorld;
            varying float vYyjSnowUp;
            uniform float uYyjSnowCover;
            uniform vec4 uYyjSnowShelter;
            float yyjSnowHash(vec2 p) {
              vec3 q = fract(vec3(p.xyx) * .1031);
              q += dot(q, q.yzx + 33.33);
              return fract((q.x + q.y) * q.z);
            }
            float yyjSnowNoise(vec2 p) {
              vec2 cell = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
              return mix(mix(yyjSnowHash(cell), yyjSnowHash(cell+vec2(1,0)), f.x),
                mix(yyjSnowHash(cell+vec2(0,1)), yyjSnowHash(cell+vec2(1,1)), f.x), f.y);
            }
          `)
          .replace('#include <metalnessmap_fragment>', /* glsl */ `
            #include <metalnessmap_fragment>
            float yyjSnowMask = 0.0;
            if (uYyjSnowCover > .0001) {
            vec2 yyjRoofUv = (vYyjSnowWorld.xz-uYyjSnowShelter.xy)/(uYyjSnowShelter.zw-uYyjSnowShelter.xy);
            float yyjRoofHeight = 4.15-(vYyjSnowWorld.z-uYyjSnowShelter.y)*.137
              -sin(yyjRoofUv.x*3.14159265)*(.16+.24*sin(yyjRoofUv.y*3.14159265));
            vec2 yyjRoofQ = abs(vYyjSnowWorld.xz-(uYyjSnowShelter.xy+uYyjSnowShelter.zw)*.5)
              -(uYyjSnowShelter.zw-uYyjSnowShelter.xy)*.5;
            float yyjRoofDistance = length(max(yyjRoofQ,vec2(0)))+min(max(yyjRoofQ.x,yyjRoofQ.y),0.0);
            // Wind scatters a little snow beneath the cloth edge. Feather the
            // footprint over half a metre; irregular deposition avoids a
            // rectangular hard mask on the naturally uneven ground.
            float yyjRoofEdge = (yyjSnowNoise(vYyjSnowWorld.xz*2.8)-.5)*.18;
            float yyjRoofInside = 1.0-smoothstep(-.50,.15,yyjRoofDistance+yyjRoofEdge);
            float yyjExposed = 1.0-yyjRoofInside*(1.0-smoothstep(yyjRoofHeight-.03,yyjRoofHeight+.01,vYyjSnowWorld.y));
            float yyjSnowPatch = yyjSnowNoise(vYyjSnowWorld.xz*.82)*.64
              +yyjSnowNoise(vYyjSnowWorld.xz*5.3+vec2(31.7,8.2))*.36;
            float yyjSnowThreshold = 1.0-uYyjSnowCover*1.12;
            yyjSnowMask = smoothstep(yyjSnowThreshold-.11,yyjSnowThreshold+.05,yyjSnowPatch)
              *smoothstep(.18,.78,vYyjSnowUp)*yyjExposed*smoothstep(0.0,.04,uYyjSnowCover);
            vec3 yyjSnowAlbedo = vec3(.67,.72,.76)*(.92+.08*yyjSnowPatch);
            diffuseColor.rgb = mix(diffuseColor.rgb, yyjSnowAlbedo, yyjSnowMask);
            roughnessFactor = mix(roughnessFactor,.89,yyjSnowMask);
            }
          `)
          .replace('#include <lights_fragment_begin>', /* glsl */ `
            material.roughness = mix(material.roughness,.89,yyjSnowMask);
            #ifdef USE_CLEARCOAT
              material.clearcoat *= 1.0-yyjSnowMask;
            #endif
            #include <lights_fragment_begin>
          `);
      };
      material.customProgramCacheKey = () => `${key}/weather-snow-cover-v1`;
      material.needsUpdate = true;
    }
  });
  return {
    update(frame: EnvironmentSnapshot): void {
      current = Math.max(0, Math.min(1, frame.weather.snowCover));
      amount.value = capturing ? 0 : current;
    },
    setEnvironmentCapture(enabled: boolean): void {
      capturing = enabled;
      amount.value = enabled ? 0 : current;
    },
  };
}
