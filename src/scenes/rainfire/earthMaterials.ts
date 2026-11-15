import {
  DataTexture, LinearFilter, LinearMipmapLinearFilter, MeshPhysicalMaterial, RepeatWrapping,
  RGBAFormat, SRGBColorSpace, UnsignedByteType, Vector2,
} from 'three';
import { createRandom, hashSeed } from '../../core/random';
import { createForestEcology, ECOLOGY_BOUNDS } from './forestEcology';

const TILE_METRES = 1.8;
const RESOLUTION = 768;
const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const smooth = (x: number) => { const t = clamp(x); return t * t * (3 - 2 * t); };

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Periodic fields let the physical 1.8 m patch wrap without a seam. */
function periodicNoise(x: number, y: number, frequency: number, seed: number): number {
  const px = x * frequency, py = y * frequency;
  const ix = Math.floor(px), iy = Math.floor(py);
  const u = smooth(px - ix), v = smooth(py - iy);
  const x0 = ((ix % frequency) + frequency) % frequency;
  const y0 = ((iy % frequency) + frequency) % frequency;
  const x1 = (x0 + 1) % frequency, y1 = (y0 + 1) % frequency;
  const a = hash(x0, y0, seed), b = hash(x1, y0, seed);
  const c = hash(x0, y1, seed), d = hash(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function generatedTexture(data: Uint8Array, name: string, color = false): DataTexture {
  const texture = new DataTexture(data, RESOLUTION, RESOLUTION, RGBAFormat, UnsignedByteType);
  texture.name = name;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = 8;
  if (color) texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Soil is assembled as actual little material deposits: compacted silt, mineral
 * grains, flat rotting leaf fragments and needles. Every deposit edits the same
 * height, pigment, wetness and roughness buffers, so its lighting agrees with its
 * colour. These are generated runtime data, never stored image assets.
 */
function bakeEarth(seed: string): { color: DataTexture; normal: DataTexture; surface: DataTexture } {
  const size = RESOLUTION, count = size * size;
  const random = createRandom(`${seed}/earth/deposits`);
  const salt = hashSeed(`${seed}/earth/soil`);
  const heights = new Float32Array(count);
  const pigment = new Float32Array(count * 3);
  const roughness = new Float32Array(count);
  const wetness = new Float32Array(count);
  const occlusion = new Float32Array(count);
  const index = (x: number, y: number) => ((y + size) % size) * size + ((x + size) % size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x, u = x / size, v = y / size;
      const broad = periodicNoise(u, v, 5, salt);
      const hummock = periodicNoise(u, v, 15, salt + 17);
      const aggregate = periodicNoise(u, v, 58, salt + 29);
      const grain = periodicNoise(u, v, 189, salt + 71);
      const grit = hash(x, y, salt + 131);
      // Water occupies compressed hollows; the protruding granules remain rough.
      const wet = smooth((.64 - broad * .57 - hummock * .32) * 2.25);
      const grains = smooth((aggregate - .35) * 2.2);
      const h = (broad - .5) * .0048 + (hummock - .5) * .0032
        + (grains - .5) * .0012 * (1 - wet * .48)
        + (grain - .5) * .00038 + (grit - .5) * .00011;
      heights[i] = h;
      wetness[i] = wet;
      roughness[i] = .87 - wet * .23 + (grains - .5) * .08;
      occlusion[i] = .83 + grains * .14;
      const value = .90 + broad * .12 + hummock * .085 + (grain - .5) * .026 - wet * .14;
      pigment[i * 3] = .235 * value;
      pigment[i * 3 + 1] = .207 * value;
      pigment[i * 3 + 2] = .158 * value;
    }
  }

  // Silt-bound mineral particles. Only the upper dome is exposed, with a damp
  // darker contact rim and the very same dome supplying the normal map.
  for (let n = 0; n < 2700; n += 1) {
    const cx = random() * size, cy = random() * size;
    const big = random() > .91;
    const rx = big ? 2.5 + random() * 6.2 : .45 + random() * 2.1;
    const ry = rx * (.45 + random() * .64);
    const angle = random() * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle);
    const extent = Math.ceil(Math.max(rx, ry) + 1);
    const lift = rx / size * TILE_METRES * (.18 + random() * .28);
    const hue = random(), value = .205 + random() * .13;
    const rgb = hue < .37 ? [value * 1.06, value, value * .83]
      : hue < .83 ? [value * .92, value * .98, value]
        : [value * 1.22, value * 1.12, value * .92];
    for (let y = -extent; y <= extent; y += 1) {
      for (let x = -extent; x <= extent; x += 1) {
        const dx = x + Math.floor(cx) - cx, dy = y + Math.floor(cy) - cy;
        const a = (dx * c - dy * s) / rx, b = (dx * s + dy * c) / ry;
        const radius = a * a + b * b;
        if (radius > 1.3) continue;
        const i = index(Math.floor(cx) + x, Math.floor(cy) + y);
        if (radius > 1) {
          const rim = (1.3 - radius) / .3 * .09;
          pigment[i * 3] = pigment[i * 3]! * (1 - rim);
          pigment[i * 3 + 1] = pigment[i * 3 + 1]! * (1 - rim);
          pigment[i * 3 + 2] = pigment[i * 3 + 2]! * (1 - rim);
          continue;
        }
        const coverage = smooth((1 - radius) * 5);
        const dome = Math.sqrt(1 - radius);
        heights[i] = heights[i]! + dome * lift;
        roughness[i] = roughness[i]! * (1 - coverage) + (.70 + hue * .13 - wetness[i]! * .10) * coverage;
        occlusion[i] = occlusion[i]! * (1 - coverage) + (.82 + dome * .18) * coverage;
        for (let k = 0; k < 3; k += 1) {
          pigment[i * 3 + k] = pigment[i * 3 + k]! * (1 - coverage)
            + rgb[k]! * (.88 + dome * .12) * coverage;
        }
      }
    }
  }

  // Flattened small fragments of decomposed leaves, not a regular patch noise.
  // Broken silhouettes and a central vein survive in all of the material maps.
  for (let n = 0; n < 125; n += 1) {
    const cx = random() * size, cy = random() * size;
    const length = 7 + random() * 24, width = length * (.24 + random() * .28);
    const a = random() * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const extent = Math.ceil(length + 2), age = random(), phase = random() * 30;
    const rgb = [.23 + age * .12, .17 + age * .095, .105 + age * .065];
    for (let y = -extent; y <= extent; y += 1) {
      for (let x = -extent; x <= extent; x += 1) {
        const u = (x * c - y * s) / width, v = (x * s + y * c) / length;
        const taper = Math.pow(Math.max(0, 1 - v * v), .72);
        const ragged = .91 + .07 * Math.sin(v * 35 + phase) + .045 * Math.sin(v * 73 - phase);
        const edge = taper * ragged - Math.abs(u);
        if (Math.abs(v) > 1 || edge < 0) continue;
        if (hash(Math.floor(u * 13), Math.floor(v * 11), n + salt) > .93) continue;
        const coverage = smooth(edge * width * .8);
        const i = index(Math.floor(cx) + x, Math.floor(cy) + y);
        const spine = Math.exp(-Math.abs(u) * width * .85);
        const wrinkle = Math.sin(v * 35 + u * 8) * .00011;
        heights[i] = heights[i]! + coverage * (.00045 + spine * .0004 + wrinkle);
        roughness[i] = roughness[i]! * (1 - coverage) + (.64 + age * .15 - wetness[i]! * .12) * coverage;
        occlusion[i] = occlusion[i]! * (1 - coverage) + .94 * coverage;
        for (let k = 0; k < 3; k += 1) {
          pigment[i * 3 + k] = pigment[i * 3 + k]! * (1 - coverage)
            + rgb[k]! * (1 + spine * .12 + wrinkle * 120) * coverage;
        }
      }
    }
  }

  // Matted needles occur in pockets. Their tapered ridge catches a fine glint,
  // while the compacted organic soil between them is dark and absorbent.
  for (let n = 0; n < 1050; n += 1) {
    const cx = random() * size, cy = random() * size;
    if (periodicNoise(cx / size, cy / size, 7, salt + 197) < .40) continue;
    const a = random() * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const length = 5 + random() * 19, halfWidth = .42 + random() * .36;
    const brightness = .19 + random() * .19;
    for (let t = -length; t <= length; t += .7) {
      const taper = Math.pow(Math.max(0, 1 - Math.abs(t / length)), .35);
      for (let side = -1; side <= 1; side += 1) {
        const px = Math.round(cx + c * t - s * side * halfWidth);
        const py = Math.round(cy + s * t + c * side * halfWidth);
        const i = index(px, py), coverage = taper * (side === 0 ? .9 : .24);
        heights[i] = heights[i]! + .00038 * coverage;
        roughness[i] = roughness[i]! * (1 - coverage) + .64 * coverage;
        pigment[i * 3] = pigment[i * 3]! * (1 - coverage) + brightness * coverage;
        pigment[i * 3 + 1] = pigment[i * 3 + 1]! * (1 - coverage) + brightness * .78 * coverage;
        pigment[i * 3 + 2] = pigment[i * 3 + 2]! * (1 - coverage) + brightness * .48 * coverage;
      }
    }
  }

  const colors = new Uint8Array(count * 4);
  const normals = new Uint8Array(count * 4);
  const surfaces = new Uint8Array(count * 4);
  const metresPerPixel = TILE_METRES / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x, out = i * 4;
      const dx = (heights[index(x + 1, y)]! - heights[index(x - 1, y)]!) / (2 * metresPerPixel);
      const dz = (heights[index(x, y + 1)]! - heights[index(x, y - 1)]!) / (2 * metresPerPixel);
      const inverseLength = 1 / Math.sqrt(dx * dx + dz * dz + 1);
      for (let k = 0; k < 3; k += 1) colors[out + k] = Math.round(clamp(pigment[i * 3 + k]!) * 255);
      colors[out + 3] = 255;
      normals[out] = Math.round((.5 - dx * inverseLength * .5) * 255);
      normals[out + 1] = Math.round((.5 - dz * inverseLength * .5) * 255);
      normals[out + 2] = Math.round((.5 + inverseLength * .5) * 255);
      normals[out + 3] = 255;
      surfaces[out] = Math.round(clamp(roughness[i]!) * 255);
      surfaces[out + 1] = Math.round(clamp(occlusion[i]!) * 255);
      surfaces[out + 2] = Math.round(clamp(wetness[i]!) * 255);
      surfaces[out + 3] = 255;
    }
  }
  return {
    color: generatedTexture(colors, 'generated-earth-pigment', true),
    normal: generatedTexture(normals, 'generated-earth-relief'),
    surface: generatedTexture(surfaces, 'generated-earth-roughness-occlusion-wetness'),
  };
}

const earthFields = /* glsl */ `
  varying vec3 vEarthWorld;
  uniform sampler2D uEarthPigment;
  uniform sampler2D uEarthRelief;
  uniform sampler2D uEarthSurface;
  uniform sampler2D uForestEcology;
  uniform vec2 uEarthOffset;
  uniform float uEarthWaterLevel;
  float earthHash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * .1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }
  float earthNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(earthHash(i), earthHash(i+vec2(1,0)), f.x),
      mix(earthHash(i+vec2(0,1)), earthHash(i+vec2(1,1)), f.x), f.y);
  }
`;

/** World-projected wet forest soil. It works on terrain with no UV attribute. */
export function createEarthMaterial(seed: string, waterLevel = -.018): MeshPhysicalMaterial {
  const maps = bakeEarth(seed);
  const ecology = createForestEcology(seed).createTexture();
  const random = createRandom(`${seed}/earth/macro`);
  const material = new MeshPhysicalMaterial({
    color: 0xffffff, roughness: .84, metalness: 0, specularIntensity: .48,
    ior: 1.45, clearcoat: 1, clearcoatRoughness: .35, dithering: true,
  });
  material.name = 'generated-wet-forest-earth';
  material.userData.proceduralTextures = [maps.color, maps.normal, maps.surface, ecology];
  material.userData.tileMetres = TILE_METRES;
  const offset = new Vector2(random() * 37, random() * 37);
  material.onBeforeCompile = shader => {
    shader.uniforms.uEarthPigment = { value: maps.color };
    shader.uniforms.uEarthRelief = { value: maps.normal };
    shader.uniforms.uEarthSurface = { value: maps.surface };
    shader.uniforms.uForestEcology = { value: ecology };
    shader.uniforms.uEarthOffset = { value: offset };
    shader.uniforms.uEarthWaterLevel = { value: waterLevel };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEarthWorld;')
      .replace('#include <worldpos_vertex>', /* glsl */ `
        #include <worldpos_vertex>
        vec4 earthWorld = vec4(transformed, 1.0);
        #ifdef USE_BATCHING
          earthWorld = batchingMatrix * earthWorld;
        #endif
        #ifdef USE_INSTANCING
          earthWorld = instanceMatrix * earthWorld;
        #endif
        vEarthWorld = (modelMatrix * earthWorld).xyz;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${earthFields}`)
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        vec2 earthP = vEarthWorld.xz + uEarthOffset;
        vec2 earthUv0 = earthP / ${TILE_METRES.toFixed(1)};
        vec2 earthUv1 = mat2(.8,-.6,.6,.8) * earthP / ${TILE_METRES.toFixed(1)} + vec2(.37,.59);
        float earthBlend = smoothstep(.26,.74,earthNoise(earthP*.23));
        vec3 earthColor = mix(texture2D(uEarthPigment,earthUv0).rgb,
          texture2D(uEarthPigment,earthUv1).rgb,earthBlend);
        vec3 earthSurface = mix(texture2D(uEarthSurface,earthUv0).rgb,
          texture2D(uEarthSurface,earthUv1).rgb,earthBlend);
        vec2 ecologyUv=clamp((vEarthWorld.xz-vec2(${ECOLOGY_BOUNDS.minX.toFixed(1)},${ECOLOGY_BOUNDS.minZ.toFixed(1)}))
          /vec2(${ECOLOGY_BOUNDS.width.toFixed(1)},${ECOLOGY_BOUNDS.depth.toFixed(1)}),0.0,1.0);
        ecologyUv=ecologyUv*(223.0/224.0)+vec2(.5/224.0);
        vec4 ecologyCover=texture2D(uForestEcology,ecologyUv);
        float earthWater = 1.0-smoothstep(.012,.16,vEarthWorld.y-uEarthWaterLevel);
        float earthMudFilm = (1.0-smoothstep(.008,.045,abs(vEarthWorld.y-uEarthWaterLevel)))
          *smoothstep(.67,.84,earthNoise(earthP*2.7));
        float earthMottle = earthNoise(earthP*.52);
        float earthMoss = ecologyCover.a;
        // A water film fills compressed micro-hollows, while loose organic
        // litter and moss interrupt it. This is separate from the puddle mesh.
        float earthWet = smoothstep(.13,.72,earthSurface.b+earthWater*.55+earthMudFilm*.38)
          *(1.0-ecologyCover.r*.60)*(1.0-earthMoss*.75);
        earthColor *= 1.4*(.94+earthMottle*.09)*(1.0-earthWater*.11);
        earthColor=mix(earthColor,earthColor*vec3(.78,.72,.61),ecologyCover.r*.52+ecologyCover.b*.12);
        earthColor=mix(earthColor,earthColor*vec3(1.13,1.15,1.13),ecologyCover.g*.8);
        earthColor = mix(earthColor,earthColor*vec3(.78,.92,.61),earthMoss*.23);
        diffuseColor.rgb *= earthColor * mix(.82,1.0,earthSurface.g);
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = mix(clamp(earthSurface.r+.025-earthWater*.08+earthMoss*.10,.52,.94),
          .36,earthMudFilm*.7);
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */ `
        #include <normal_fragment_maps>
        vec3 earthN0 = texture2D(uEarthRelief,earthUv0).xyz*2.0-1.0;
        vec3 earthN1 = texture2D(uEarthRelief,earthUv1).xyz*2.0-1.0;
        earthN1.xy = mat2(.8,.6,-.6,.8)*earthN1.xy;
        vec3 earthBump = normalize(mix(earthN0,earthN1,earthBlend));
        vec3 earthX = (viewMatrix*vec4(1.0,0.0,0.0,0.0)).xyz;
        vec3 earthZ = (viewMatrix*vec4(0.0,0.0,1.0,0.0)).xyz;
        earthX = normalize(earthX-normal*dot(normal,earthX));
        earthZ = normalize(earthZ-normal*dot(normal,earthZ));
        float earthDetailStrength=.68*(1.0-ecologyCover.r*.22);
        normal = normalize(normal*earthBump.z+earthX*earthBump.x*earthDetailStrength+earthZ*earthBump.y*earthDetailStrength);
      `)
      .replace('#include <clearcoat_normal_fragment_begin>', /* glsl */ `
        #include <clearcoat_normal_fragment_begin>
        #ifdef USE_CLEARCOAT
          // Water smooths the finest grain, but follows the terrain and larger
          // fragments. The same relief still breaks its highlights into glints.
          clearcoatNormal=normalize(mix(nonPerturbedNormal,normal,.65-earthWet*.30));
        #endif
      `)
      .replace('#include <lights_physical_fragment>', /* glsl */ `
        #include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
          material.clearcoat=earthWet*.72;
          material.clearcoatRoughness=clamp(mix(.38,.20,earthWet)+geometryRoughness,.045,1.0);
          // Air/water Fresnel reflectance is about 2%, lower than varnish.
          material.clearcoatF0=vec3(.0204);
        #endif
      `);
  };
  material.customProgramCacheKey = () => 'correlated-forest-earth-v5';
  material.addEventListener('dispose', () => {
    maps.color.dispose(); maps.normal.dispose(); maps.surface.dispose(); ecology.dispose();
  });
  return material;
}
