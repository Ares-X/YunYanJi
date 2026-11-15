import { MeshStandardMaterial, Vector3, Vector4 } from 'three';
import type { Material, Texture } from 'three';
import { createRandom, hashSeed } from '../../core/random';

export type ProceduralMaterialKind = 'snow' | 'stone' | 'wood' | 'bark' | 'plaster' | 'tile';

interface ContactBinding {
  texture: { value: Texture | null };
  bounds: { value: Vector4 };
  enabled: { value: number };
}
const contactBindings = new WeakMap<Material, ContactBinding>();

/** The renderer owns the generated field; materials only sample its live handle. */
export function setContactShadowField(material: Material, texture: Texture, bounds: Vector4): void {
  let binding = contactBindings.get(material);
  // New scene materials keep their own surface shaders. Add only the shared
  // indirect-light contact term, preserving their maps and custom attributes.
  if (!binding && material instanceof MeshStandardMaterial) {
    binding = { texture: { value: texture }, bounds: { value: bounds.clone() }, enabled: { value: 1 } };
    contactBindings.set(material,binding);
    const contact=binding,compile=material.onBeforeCompile.bind(material);
    const key=material.customProgramCacheKey();
    material.onBeforeCompile=(shader,renderer)=>{
      compile(shader,renderer);
      shader.uniforms.uYyjContactMap=contact.texture;
      shader.uniforms.uYyjContactBounds=contact.bounds;
      shader.vertexShader=shader.vertexShader
        .replace('#include <common>',`#include <common>
          varying vec3 vYyjContactPosition;
          attribute float aYyjContactReceiver;
          attribute float aYyjTerrainHeight;
          varying float vYyjTerrainHeight;
          varying float vYyjContactReceiver;`)
        .replace('#include <worldpos_vertex>',`#include <worldpos_vertex>
          vec4 yyjContactWorld=vec4(transformed,1.0);
          #ifdef USE_INSTANCING
            yyjContactWorld=instanceMatrix*yyjContactWorld;
          #endif
          #ifdef USE_BATCHING
            yyjContactWorld=batchingMatrix*yyjContactWorld;
          #endif
          vYyjContactPosition=(modelMatrix*yyjContactWorld).xyz;
          vYyjTerrainHeight=aYyjTerrainHeight;
          vYyjContactReceiver=aYyjContactReceiver;`);
      shader.fragmentShader=shader.fragmentShader
        .replace('#include <common>',`#include <common>
          uniform sampler2D uYyjContactMap;
          uniform vec4 uYyjContactBounds;
          varying vec3 vYyjContactPosition;
          varying float vYyjTerrainHeight;
          varying float vYyjContactReceiver;`)
        .replace('#include <aomap_fragment>',`#include <aomap_fragment>
          vec2 yyjContactUv=(vYyjContactPosition.xz-uYyjContactBounds.xy)/uYyjContactBounds.zw;
          float yyjInside=step(0.0,yyjContactUv.x)*step(yyjContactUv.x,1.0)
            *step(0.0,yyjContactUv.y)*step(yyjContactUv.y,1.0);
          float yyjGround=1.0-smoothstep(.10,.85,vYyjContactPosition.y-vYyjTerrainHeight);
          float yyjAmbient=1.0-texture2D(uYyjContactMap,clamp(yyjContactUv,0.0,1.0)).r
            *yyjInside*yyjGround*vYyjContactReceiver*.34;
          reflectedLight.indirectDiffuse*=yyjAmbient;
          reflectedLight.indirectSpecular*=yyjAmbient;
          #ifdef USE_CLEARCOAT
            clearcoatSpecularIndirect*=yyjAmbient;
          #endif`);
    };
    material.customProgramCacheKey=()=> `${key}/ground-contact-v3`;
    material.needsUpdate=true;
  }
  if (!binding) return;
  binding.texture.value = texture;
  binding.bounds.value.copy(bounds);
  binding.enabled.value = 1;
}

const PALETTES: Record<ProceduralMaterialKind, { color: number; roughness: number }> = {
  snow: { color: 0xf1f3ef, roughness: 0.93 },
  stone: { color: 0x76756d, roughness: 0.87 },
  wood: { color: 0x514337, roughness: 0.84 },
  bark: { color: 0x6b6253, roughness: 0.96 },
  plaster: { color: 0xdadcd5, roughness: 0.97 },
  tile: { color: 0x3e4a4c, roughness: 0.86 },
};

/** All samples are evaluated analytically: there are no texture resources to load. */
const NOISE = /* glsl */ `
varying vec3 vYyjWorldPosition;
varying vec3 vYyjSurfacePosition;
varying float vYyjContactReceiver;
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
  result += 0.5714 * yyjNoise(p);
  p = p * 2.03 + vec3(13.2, 7.1, 2.7);
  result += 0.2857 * yyjNoise(p);
  p = p * 2.01 + vec3(6.8, 2.5, 11.7);
  result += 0.1429 * yyjNoise(p);
  return result;
}
`;

/** Values multiply Three.js' linear-space diffuse color; roughness/height are data. */
const SURFACES: Record<ProceduralMaterialKind, string> = {
  snow: /* glsl */ `
    // Broad wind-combed relief remains visible at walking distance; individual
    // crystals disappear as their projected footprint becomes sub-pixel.
    float yyjDrifts = yyjFbm(yyjP * vec3(0.42, 0.75, 0.42));
    float yyjWindWarp = yyjNoise(yyjP * vec3(2.8, 0.5, 1.1));
    float yyjRidgePhase = dot(yyjP.xz, vec2(10.0, 4.5)) + yyjDrifts * 6.0 + yyjWindWarp * 0.9;
    float yyjRidges = pow(0.5 + 0.5 * sin(yyjRidgePhase), 3.0);
    float yyjCrust = mix(0.5, yyjNoise(yyjP * 26.0 + yyjWindWarp * 2.0), yyjDetailFade);
    float yyjFine = mix(0.5, yyjNoise(yyjP * 130.0), yyjMicroFade);
    float yyjCrystals = smoothstep(0.76, 0.91, yyjFine);
    diffuseColor.rgb *= 0.96 + yyjDrifts * 0.06 + yyjRidges * 0.008
      + (yyjCrust - 0.5) * 0.018 + (yyjFine - 0.5) * 0.018;
    yyjHeight = (yyjDrifts - 0.5) * 0.038 + (yyjRidges - 0.35) * 0.006
      + (yyjCrust - 0.5) * 0.0024 + (yyjFine - 0.5) * 0.00065;
    yyjRoughness = (yyjDrifts - 0.5) * 0.07 + (yyjCrust - 0.5) * 0.08 - yyjCrystals * 0.12;
  `,
  stone: /* glsl */ `
    float yyjMottle = yyjFbm(yyjP * vec3(2.2, 3.1, 2.6));
    float yyjWarp = yyjNoise(yyjP * 0.85);
    float yyjStrata = yyjNoise(yyjP * vec3(3.5, 14.0, 3.2) + yyjWarp * 2.1);
    float yyjFine = mix(0.5, yyjNoise(yyjP * 67.0), yyjDetailFade);
    float yyjQuartz = smoothstep(0.63, 0.76, yyjNoise(yyjP * 12.5 + yyjMottle * 2.0));
    float yyjFracture = (1.0 - smoothstep(0.012, 0.065, abs(yyjStrata - 0.43)))
      * smoothstep(0.24, 0.65, yyjMottle) * yyjDetailFade;
    float yyjDamp = 1.0 - smoothstep(-0.31, 0.12 + yyjMottle * 0.12, vYyjWorldPosition.y);
    diffuseColor.rgb *= 0.62 + yyjMottle * 0.60 + yyjQuartz * 0.15
      + (yyjFine - 0.5) * 0.19 - yyjFracture * 0.15;
    diffuseColor.rgb *= mix(vec3(1.0), vec3(0.55, 0.59, 0.57), yyjDamp);
    yyjHeight = (yyjMottle - 0.5) * 0.026 + (yyjStrata - 0.5) * 0.004
      + (yyjFine - 0.5) * 0.0025 - yyjFracture * 0.003;
    yyjRoughness = (yyjFine - 0.5) * 0.12 - yyjDamp * 0.37;
  `,
  wood: /* glsl */ `
    // Architectural timber has restrained patina. Strong trunk-like grooves on
    // every horizontal beam would make the shared material look implausible.
    float yyjPatina = yyjFbm(yyjP * vec3(1.8, 0.3, 1.8));
    float yyjGrain = mix(0.5, yyjNoise(yyjP * vec3(18.0, 0.8, 18.0) + yyjPatina * 1.7), yyjDetailFade);
    diffuseColor.rgb *= 0.82 + yyjPatina * 0.28 + yyjGrain * 0.06;
    yyjHeight = (yyjPatina - 0.5) * 0.0025 + (yyjGrain - 0.5) * 0.001;
    yyjRoughness = (yyjPatina - 0.5) * 0.08;
  `,
  bark: /* glsl */ `
    float yyjWeather = yyjFbm(yyjP * vec3(2.7, 0.6, 2.7));
    float yyjGrain = yyjNoise(yyjP * vec3(23.0, 1.2, 23.0) + vec3(yyjWeather * 1.6, 0.0, yyjWeather * 0.7));
    float yyjPlates = yyjNoise(yyjP * vec3(8.0, 3.6, 8.0));
    float yyjFissures = (1.0 - smoothstep(0.035, 0.13, abs(yyjGrain - 0.49))) * yyjDetailFade;
    float yyjFine = mix(0.5, yyjNoise(yyjP * vec3(82.0, 9.2, 82.0)), yyjDetailFade);
    float yyjLichen = smoothstep(0.65, 0.77, yyjFbm(yyjP * 5.8 + yyjWeather));
    diffuseColor.rgb *= 0.68 + yyjWeather * 0.47 + yyjPlates * 0.18 - yyjFissures * 0.32;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.23, 0.26, 0.20), yyjLichen * 0.33);
    yyjHeight = (yyjPlates - 0.5) * 0.014 - yyjFissures * 0.008
      + (yyjWeather - 0.5) * 0.007 + (yyjFine - 0.5) * 0.0014;
    yyjRoughness = (yyjWeather - 0.5) * 0.065;
  `,
  plaster: /* glsl */ `
    float yyjWash = yyjFbm(yyjP * vec3(0.65, 0.42, 0.65));
    float yyjStreaks = yyjNoise(yyjP * vec3(4.4, 0.55, 4.4));
    float yyjGrain = mix(0.5, yyjNoise(yyjP * 78.0), yyjMicroFade);
    float yyjCapillaryHeight = 0.20 + yyjStreaks * 0.52;
    float yyjDamp = 1.0 - smoothstep(0.08, yyjCapillaryHeight, vYyjWorldPosition.y);
    diffuseColor.rgb *= 0.985 + (yyjWash - 0.5) * 0.038 + (yyjGrain - 0.5) * 0.013;
    diffuseColor.rgb *= mix(vec3(1.0), vec3(0.85, 0.87, 0.82), yyjDamp);
    yyjHeight = (yyjGrain - 0.5) * 0.0005 + (yyjWash - 0.5) * 0.0035;
    yyjRoughness = (yyjGrain - 0.5) * 0.025 - yyjDamp * 0.06;
  `,
  tile: /* glsl */ `
    float yyjClay = yyjFbm(yyjP * 3.5);
    float yyjGrain = mix(0.5, yyjNoise(yyjP * 51.0), yyjDetailFade);
    diffuseColor.rgb *= 0.80 + yyjClay * 0.33 + yyjGrain * 0.03;
    yyjHeight = (yyjClay - 0.5) * 0.0015 + (yyjGrain - 0.5) * 0.0006;
    yyjRoughness = (yyjClay - 0.5) * 0.12;
  `,
};

/**
 * A standard physical material with seeded surface detail in scene units.
 * Detail follows a moving mesh; world-space height/contact shading stays fixed.
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
      .replace('#include <common>', '#include <common>\nvarying vec3 vYyjWorldPosition;\nvarying vec3 vYyjSurfacePosition;\nattribute float aYyjContactReceiver;\nvarying float vYyjContactReceiver;')
      .replace('#include <worldpos_vertex>', /* glsl */ `
        #include <worldpos_vertex>
        vec4 yyjWorldPosition = vec4(transformed, 1.0);
        #ifdef USE_BATCHING
          yyjWorldPosition = batchingMatrix * yyjWorldPosition;
        #endif
        #ifdef USE_INSTANCING
          yyjWorldPosition = instanceMatrix * yyjWorldPosition;
        #endif
        vYyjSurfacePosition = yyjWorldPosition.xyz;
        vYyjWorldPosition = (modelMatrix * yyjWorldPosition).xyz;
        vYyjContactReceiver = aYyjContactReceiver;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE}`)
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        vec3 yyjP = vYyjSurfacePosition + uYyjSeedOffset;
        float yyjPixelFootprint = max(length(dFdx(yyjP)), length(dFdy(yyjP)));
        float yyjDetailFade = 1.0 - smoothstep(0.012, 0.065, yyjPixelFootprint);
        float yyjMicroFade = 1.0 - smoothstep(0.002, 0.009, yyjPixelFootprint);
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
        float yyjAmbient = 1.0 - yyjContact * yyjGround * yyjInside
          * uYyjContactEnabled * vYyjContactReceiver * 0.30;
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
  material.customProgramCacheKey = () => `yyj-surface-v6/${kind}/${hashSeed(seed)}`;
  return material;
}
