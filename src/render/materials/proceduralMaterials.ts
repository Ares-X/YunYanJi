import { MeshStandardMaterial, Vector3, Vector4 } from 'three';
import type { Material, Texture } from 'three';
import { createRandom, hashSeed } from '../../core/random';

export type ProceduralMaterialKind = 'snow' | 'stone' | 'wood' | 'plaster' | 'tile';

interface ContactBinding {
  texture: { value: Texture | null };
  bounds: { value: Vector4 };
  enabled: { value: number };
}
const contactBindings = new WeakMap<Material, ContactBinding>();

/** The renderer owns the generated field; materials only sample its live handle. */
export function setContactShadowField(material: Material, texture: Texture, bounds: Vector4): void {
  const binding = contactBindings.get(material);
  if (!binding) return;
  binding.texture.value = texture;
  binding.bounds.value.copy(bounds);
  binding.enabled.value = 1;
}

const PALETTES: Record<ProceduralMaterialKind, { color: number; roughness: number }> = {
  snow: { color: 0xe7eeee, roughness: 0.89 },
  stone: { color: 0x737b7e, roughness: 0.88 },
  wood: { color: 0x584335, roughness: 0.82 },
  plaster: { color: 0xcfcfc5, roughness: 0.94 },
  tile: { color: 0x485359, roughness: 0.86 },
};

/** All samples are evaluated analytically: there are no texture resources to load. */
const NOISE = /* glsl */ `
varying vec3 vYyjWorldPosition;
uniform vec3 uYyjSeedOffset;
uniform sampler2D uYyjContactMap;
uniform vec4 uYyjContactBounds;
uniform float uYyjContactEnabled;

float yyjHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float yyjNoise(vec3 p) {
  vec3 cell = floor(p);
  vec3 t = fract(p);
  t = t * t * (3.0 - 2.0 * t);
  return mix(
    mix(mix(yyjHash(cell), yyjHash(cell + vec3(1., 0., 0.)), t.x),
        mix(yyjHash(cell + vec3(0., 1., 0.)), yyjHash(cell + vec3(1., 1., 0.)), t.x), t.y),
    mix(mix(yyjHash(cell + vec3(0., 0., 1.)), yyjHash(cell + vec3(1., 0., 1.)), t.x),
        mix(yyjHash(cell + vec3(0., 1., 1.)), yyjHash(cell + vec3(1., 1., 1.)), t.x), t.y), t.z);
}

float yyjFbm(vec3 p) {
  float result = 0.0;
  result += 0.5333 * yyjNoise(p);
  p = p * 2.03 + vec3(13.2, 7.1, 2.7);
  result += 0.2667 * yyjNoise(p);
  p = p * 2.01 + vec3(6.8, 2.5, 11.7);
  result += 0.1333 * yyjNoise(p);
  p = p * 2.02 + vec3(2.4, 8.6, 4.2);
  result += 0.0667 * yyjNoise(p);
  return result;
}
`;

/** Values multiply Three.js' linear-space diffuse color; roughness/height are data. */
const SURFACES: Record<ProceduralMaterialKind, string> = {
  snow: /* glsl */ `
    float yyjDrifts = yyjFbm(yyjP * vec3(0.6, 2.0, 0.6));
    float yyjFine = mix(0.5, yyjNoise(yyjP * 85.0), yyjDetailFade);
    diffuseColor.rgb *= 0.94 + yyjDrifts * 0.08 + yyjFine * 0.025;
    yyjHeight = (yyjDrifts - 0.5) * 0.012 + (yyjFine - 0.5) * 0.0015;
    yyjRoughness = (yyjFine - 0.5) * 0.11;
  `,
  stone: /* glsl */ `
    float yyjMottle = yyjFbm(yyjP * 2.4);
    float yyjFine = mix(0.5, yyjNoise(yyjP * 43.0), yyjDetailFade);
    float yyjSeam = smoothstep(0.46, 0.50, yyjMottle) * (1.0 - smoothstep(0.50, 0.54, yyjMottle));
    float yyjDamp = 1.0 - smoothstep(0.06, 0.38, vYyjWorldPosition.y);
    diffuseColor.rgb *= (0.76 + yyjMottle * 0.40 + yyjFine * 0.07 - yyjSeam * 0.045) * (1.0 - yyjDamp * 0.16);
    yyjHeight = (yyjMottle - 0.5) * 0.021 + (yyjFine - 0.5) * 0.003;
    yyjRoughness = (yyjMottle - 0.5) * 0.16 - yyjDamp * 0.18;
  `,
  wood: /* glsl */ `
    float yyjWoodWarp = yyjFbm(yyjP * vec3(1.6, 0.32, 1.6));
    float yyjGrain = yyjNoise(yyjP * vec3(27.0, 1.2, 27.0) + yyjWoodWarp * 3.2);
    float yyjLongGrain = yyjFbm(yyjP * vec3(7.0, 0.25, 7.0));
    float yyjPores = smoothstep(0.69, 0.90, yyjGrain) * yyjDetailFade;
    diffuseColor.rgb *= 0.72 + yyjLongGrain * 0.44 + yyjGrain * 0.12 - yyjPores * 0.20;
    yyjHeight = (yyjLongGrain - 0.5) * 0.009 - yyjPores * 0.004;
    yyjRoughness = (yyjGrain - 0.5) * 0.15;
  `,
  plaster: /* glsl */ `
    float yyjWash = yyjFbm(yyjP * vec3(1.4, 0.8, 1.4));
    float yyjGrain = mix(0.5, yyjNoise(yyjP * 58.0), yyjDetailFade);
    float yyjFoot = mix(0.83, 1.0, smoothstep(0.05, 0.85, vYyjWorldPosition.y));
    diffuseColor.rgb *= (0.91 + yyjWash * 0.15 + yyjGrain * 0.025) * yyjFoot;
    yyjHeight = (yyjGrain - 0.5) * 0.0018 + (yyjWash - 0.5) * 0.004;
    yyjRoughness = (yyjGrain - 0.5) * 0.06;
  `,
  tile: /* glsl */ `
    float yyjClay = yyjFbm(yyjP * 3.7);
    float yyjGrain = mix(0.5, yyjNoise(yyjP * 51.0), yyjDetailFade);
    diffuseColor.rgb *= 0.79 + yyjClay * 0.34 + yyjGrain * 0.05;
    yyjHeight = (yyjClay - 0.5) * 0.006 + (yyjGrain - 0.5) * 0.0017;
    yyjRoughness = (yyjClay - 0.5) * 0.14;
  `,
};

/**
 * A standard physical material with seeded, world-space surface detail.
 * Supports ordinary and instanced meshes. Its owner must dispose the material.
 */
export function createProceduralMaterial(kind: ProceduralMaterialKind, seed: string): MeshStandardMaterial {
  const palette = PALETTES[kind];
  const material = new MeshStandardMaterial({
    color: palette.color,
    roughness: palette.roughness,
    metalness: 0,
    dithering: true,
  });
  material.name = `procedural-${kind}`;
  const random = createRandom(`${seed}/material/${kind}`);
  const offset = new Vector3(random() * 83, random() * 83, random() * 83);
  const contact: ContactBinding = {
    texture: { value: null }, bounds: { value: new Vector4(0, 0, 1, 1) }, enabled: { value: 0 },
  };
  contactBindings.set(material, contact);

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uYyjSeedOffset = { value: offset };
    shader.uniforms.uYyjContactMap = contact.texture;
    shader.uniforms.uYyjContactBounds = contact.bounds;
    shader.uniforms.uYyjContactEnabled = contact.enabled;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vYyjWorldPosition;')
      .replace('#include <worldpos_vertex>', /* glsl */ `
        #include <worldpos_vertex>
        vec4 yyjWorldPosition = vec4(transformed, 1.0);
        #ifdef USE_BATCHING
          yyjWorldPosition = batchingMatrix * yyjWorldPosition;
        #endif
        #ifdef USE_INSTANCING
          yyjWorldPosition = instanceMatrix * yyjWorldPosition;
        #endif
        vYyjWorldPosition = (modelMatrix * yyjWorldPosition).xyz;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE}`)
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        vec3 yyjP = vYyjWorldPosition + uYyjSeedOffset;
        float yyjPixelFootprint = max(length(dFdx(yyjP)), length(dFdy(yyjP)));
        float yyjDetailFade = 1.0 - smoothstep(0.012, 0.065, yyjPixelFootprint);
        float yyjHeight = 0.0;
        float yyjRoughness = 0.0;
        ${SURFACES[kind]}
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + yyjRoughness, 0.38, 1.0);
      `)
      .replace('#include <aomap_fragment>', /* glsl */ `
        #include <aomap_fragment>
        vec2 yyjContactUv = (vYyjWorldPosition.xz - uYyjContactBounds.xy) / uYyjContactBounds.zw;
        float yyjInside = step(0.0, yyjContactUv.x) * step(yyjContactUv.x, 1.0)
          * step(0.0, yyjContactUv.y) * step(yyjContactUv.y, 1.0);
        float yyjGround = 1.0 - smoothstep(0.10, 0.85, vYyjWorldPosition.y);
        float yyjContact = texture2D(uYyjContactMap, clamp(yyjContactUv, 0.0, 1.0)).r;
        float yyjAmbient = 1.0 - yyjContact * yyjGround * yyjInside * uYyjContactEnabled * 0.72;
        reflectedLight.indirectDiffuse *= yyjAmbient;
        reflectedLight.indirectSpecular *= yyjAmbient;
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */ `
        #include <normal_fragment_maps>
        // Screen-space surface gradient: no UV seams or normal-map lookup.
        vec3 yyjSurfaceX = dFdx(-vViewPosition);
        vec3 yyjSurfaceY = dFdy(-vViewPosition);
        vec3 yyjCrossX = cross(yyjSurfaceY, normal);
        vec3 yyjCrossY = cross(normal, yyjSurfaceX);
        float yyjDeterminant = dot(yyjSurfaceX, yyjCrossX);
        if (abs(yyjDeterminant) > 0.00000001) {
          vec3 yyjGradient = sign(yyjDeterminant) *
            (dFdx(yyjHeight) * yyjCrossX + dFdy(yyjHeight) * yyjCrossY);
          normal = normalize(abs(yyjDeterminant) * normal - yyjGradient);
        }
      `);
  };

  // Each source variation has its own key; no patch depends on mutable globals.
  material.customProgramCacheKey = () => `yyj-surface-v2/${kind}/${hashSeed(seed)}`;
  return material;
}
