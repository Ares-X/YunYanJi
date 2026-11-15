import {
  BufferGeometry, DataTexture, Float32BufferAttribute, LinearFilter, LinearMipmapLinearFilter,
  Mesh, MeshDepthMaterial, MeshPhysicalMaterial, RepeatWrapping,
  RGBAFormat, SRGBColorSpace, UnsignedByteType, Vector2,
} from 'three';
import { createRandom, hashSeed } from '../../core/random';
import { createForestEcology, ECOLOGY_BOUNDS } from './forestEcology';

const TILE_METRES = 1.28;
const RESOLUTION = 1024;
const CONTACT_BOUNDS = { left: -4.7, right: 4.7, back: -7.2, front: 6.0 };
const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const smooth = (x: number) => { const t = clamp(x); return t * t * (3 - 2 * t); };

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Periodic fields let the physical 1.28 m patch wrap without a seam. */
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

/** Separable periodic filtering separates centimetre geometry from millimetre normals. */
function blurRelief(input: Float32Array, radius: number): Float32Array {
  const n = RESOLUTION, span = radius * 2 + 1, temporary = new Float32Array(input.length);
  const output = new Float32Array(input.length);
  for (let y = 0; y < n; y += 1) {
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) sum += input[y * n + (x + n) % n]!;
    for (let x = 0; x < n; x += 1) {
      temporary[y * n + x] = sum / span;
      sum += input[y * n + (x + radius + 1) % n]! - input[y * n + (x - radius + n) % n]!;
    }
  }
  for (let x = 0; x < n; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) sum += temporary[((y + n) % n) * n + x]!;
    for (let y = 0; y < n; y += 1) {
      output[y * n + x] = sum / span;
      sum += temporary[((y + radius + 1) % n) * n + x]! - temporary[((y - radius + n) % n) * n + x]!;
    }
  }
  return output;
}

interface EarthMaps {
  color: DataTexture;
  normal: DataTexture;
  surface: DataTexture;
  coarseRelief: Float32Array;
}

/**
 * Soil is assembled as actual little material deposits: compacted silt, mineral
 * grains, flat rotting leaf fragments and needles. Every deposit edits the same
 * height, pigment, wetness and roughness buffers, so its lighting agrees with its
 * colour. These are generated runtime data, never stored image assets.
 */
function bakeEarth(seed: string): EarthMaps {
  const size = RESOLUTION, count = size * size;
  const random = createRandom(`${seed}/earth/deposits`);
  const salt = hashSeed(`${seed}/earth/soil`);
  const heights = new Float32Array(count);
  const pigment = new Float32Array(count * 3);
  const roughness = new Float32Array(count);
  const wetness = new Float32Array(count);
  const siltCoverage = new Float32Array(count);
  const occlusion = new Float32Array(count);
  const index = (x: number, y: number) => ((y + size) % size) * size + ((x + size) % size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x, u = x / size, v = y / size;
      const broad = periodicNoise(u, v, 4, salt);
      const hummock = periodicNoise(u, v, 11, salt + 17);
      const aggregate = periodicNoise(u, v, 58, salt + 29);
      const grain = periodicNoise(u, v, 189, salt + 71);
      const grit = hash(x, y, salt + 131);
      // Water occupies compressed hollows; the protruding granules remain rough.
      const wet = smooth((.64 - broad * .57 - hummock * .32) * 2.25);
      const silt = smooth((.63 - broad * .54 - hummock * .29) * 3.2);
      const grains = smooth((aggregate - .35) * 2.2);
      const h = (broad - .5) * .0030 + (hummock - .5) * .0014 * (1 - silt * .75)
        + (grains - .5) * .0006 * (1 - silt * .82)
        + ((grain - .5) * .00024 + (grit - .5) * .00008) * (1 - silt * .73);
      heights[i] = h;
      wetness[i] = wet;
      siltCoverage[i] = silt;
      roughness[i] = .88 - wet * .095 + (grains - .5) * .06;
      occlusion[i] = .83 + grains * .14;
      const value = .90 + broad * .12 + hummock * .085 + (grain - .5) * .026 - wet * .14;
      pigment[i * 3] = .253 * value;
      pigment[i * 3 + 1] = .218 * value;
      pigment[i * 3 + 2] = .167 * value;
    }
  }

  // Eroded soil aggregates have an irregular physical dome, a sheltered moist
  // foot and a coarser, drier upper skin. Their 2–12 cm bodies drive the mesh too.
  const packedHeight = heights.slice();
  for (let deposit = 0; deposit < 185; deposit += 1) {
    const cx = random() * size, cy = random() * size, angle = random() * Math.PI * 2;
    const depositSite = index(Math.floor(cx), Math.floor(cy));
    const habitat = smooth((periodicNoise(cx / size, cy / size, 3, salt + 211) - .28) / .46);
    if (random() > .10 + .83 * habitat * (1 - siltCoverage[depositSite]! * .77)) continue;
    const rx = 5 + Math.pow(random(), 1.9) * 67, ry = rx * (.38 + random() * .82);
    const c = Math.cos(angle), s = Math.sin(angle), extent = Math.ceil(Math.max(rx, ry) * 1.18);
    const relief = .0012 + Math.pow(rx / 72, 1.45) * .018;
    const phase = random() * 20, identity = .91 + random() * .15;
    for (let yy = -extent; yy <= extent; yy += 1) for (let xx = -extent; xx <= extent; xx += 1) {
      const u = (xx * c - yy * s) / rx, v = (xx * s + yy * c) / ry;
      const theta = Math.atan2(v, u), edge = 1 + .10 * Math.sin(theta * 3 + phase) + .055 * Math.sin(theta * 7 - phase);
      const radial = (u * u + v * v) / (edge * edge);
      if (radial > 1.18) continue;
      const i = index(Math.floor(cx) + xx, Math.floor(cy) + yy);
      if (radial > 1) {
        const contact = (1.18 - radial) / .18;
        occlusion[i] = occlusion[i]! * (1 - contact * .11);
        wetness[i] = Math.max(wetness[i]!, contact * .72);
        continue;
      }
      const dome = Math.pow(1 - radial, .72), covering = smooth((1 - radial) * 8);
      const rise = relief * dome;
      heights[i] = Math.max(heights[i]!, packedHeight[i]! + rise);
      roughness[i] = roughness[i]! * (1 - covering) + (.85 + dome * .07) * covering;
      wetness[i] = wetness[i]! * (1 - covering * .52);
      const tint = identity * (.95 + dome * .07);
      pigment[i * 3] = pigment[i * 3]! * (1 + (tint - 1) * covering);
      pigment[i * 3 + 1] = pigment[i * 3 + 1]! * (1 + (tint - 1) * covering);
      pigment[i * 3 + 2] = pigment[i * 3 + 2]! * (1 + (tint - 1) * covering);
    }
  }

  // Short, slightly curved drainage marks are actual depressions in the same
  // field. They contain darker fine silt rather than arbitrary painted lines.
  for (let groove = 0; groove < 26; groove += 1) {
    const cx = random() * size, cy = random() * size, angle = .35 + random() * .75 + (random() < .18 ? 1.7 : 0);
    const c = Math.cos(angle), s = Math.sin(angle), length = 30 + random() * 105;
    const width = 1.1 + random() * 2.2, bend = (random() - .5) * 12;
    for (let step = 0; step <= length; step += 1) {
      const t = step / length, along = step - length * .5, across = Math.sin(Math.PI * t) * bend;
      const px = cx + c * along - s * across, py = cy + s * along + c * across;
      const taper = Math.sin(Math.PI * t);
      for (let side = -Math.ceil(width * 2); side <= Math.ceil(width * 2); side += 1) {
        const coverage = Math.exp(-side * side / (width * width)) * taper;
        const i = index(Math.round(px - s * side), Math.round(py + c * side));
        heights[i] = heights[i]! - .00085 * coverage;
        wetness[i] = Math.max(wetness[i]!, coverage * .86);
        roughness[i] = roughness[i]! * (1 - coverage * .24);
        for (let k = 0; k < 3; k += 1) pigment[i * 3 + k] = pigment[i * 3 + k]! * (1 - coverage * .065);
      }
    }
  }

  // Silt-bound mineral particles. Only the upper dome is exposed, with a damp
  // darker contact rim and the very same dome supplying the normal map.
  for (let n = 0; n < 3900; n += 1) {
    const cx = random() * size, cy = random() * size;
    if (random() < siltCoverage[index(Math.floor(cx), Math.floor(cy))]! * .63) continue;
    const big = random() > .91;
    const rx = big ? 2.7 + random() * 7.0 : .50 + random() * 2.4;
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
        roughness[i] = roughness[i]! * (1 - coverage) + (.79 + hue * .11) * coverage;
        occlusion[i] = occlusion[i]! * (1 - coverage) + (.82 + dome * .18) * coverage;
        for (let k = 0; k < 3; k += 1) {
          pigment[i * 3 + k] = pigment[i * 3 + k]! * (1 - coverage)
            + rgb[k]! * (.88 + dome * .12) * coverage;
        }
      }
    }
  }

  // Suspended fine sediment partly fills the interstices in sheltered patches.
  // Large grains retain their crowns; finer areas become smooth, packed mud.
  const sedimentLevel = blurRelief(heights, 10);
  for (let i = 0; i < count; i += 1) {
    const hollow = smooth((sedimentLevel[i]! + .0007 - heights[i]!) / .0018);
    const deposit = siltCoverage[i]! * hollow * .76;
    heights[i] = heights[i]! * (1 - deposit) + (sedimentLevel[i]! + .0003) * deposit;
    roughness[i] = roughness[i]! * (1 - deposit) + .84 * deposit;
    pigment[i * 3] = pigment[i * 3]! * (1 - deposit * .38) + .267 * deposit * .38;
    pigment[i * 3 + 1] = pigment[i * 3 + 1]! * (1 - deposit * .38) + .230 * deposit * .38;
    pigment[i * 3 + 2] = pigment[i * 3 + 2]! * (1 - deposit * .38) + .177 * deposit * .38;
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
        roughness[i] = roughness[i]! * (1 - coverage) + (.64 + age * .15) * coverage;
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

  const coarseRelief = blurRelief(blurRelief(heights, 18), 18);
  let minimum = Infinity;
  for (const h of coarseRelief) minimum = Math.min(minimum, h);
  const highpass = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    highpass[i] = heights[i]! - coarseRelief[i]!;
    coarseRelief[i] = coarseRelief[i]! - minimum;
  }
  const colors = new Uint8Array(count * 4);
  const normals = new Uint8Array(count * 4);
  const surfaces = new Uint8Array(count * 4);
  const metresPerPixel = TILE_METRES / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x, out = i * 4;
      const dx = (highpass[index(x + 1, y)]! - highpass[index(x - 1, y)]!) / (2 * metresPerPixel);
      const dz = (highpass[index(x, y + 1)]! - highpass[index(x, y - 1)]!) / (2 * metresPerPixel);
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
      const poreWater = smooth((-.0001 - highpass[i]!) / .0011);
      surfaces[out + 3] = Math.round(clamp(wetness[i]! * .67 + poreWater * .33) * 255);
    }
  }
  return {
    color: generatedTexture(colors, 'generated-earth-pigment', true),
    normal: generatedTexture(normals, 'generated-earth-relief'),
    surface: generatedTexture(surfaces, 'generated-earth-roughness-occlusion-wetness'),
    coarseRelief,
  };
}

interface EarthResources {
  maps: EarthMaps;
  ecology: ReturnType<typeof createForestEcology>;
  ecologyTexture: DataTexture;
  offset: Vector2;
  references: number;
  contactUsers: number;
  contactEnabled: { value: number };
}
const earthResources = new Map<string, EarthResources>();

function resourcesFor(seed: string): EarthResources {
  const existing = earthResources.get(seed);
  if (existing) return existing;
  const random = createRandom(`${seed}/earth/macro`), ecology = createForestEcology(seed);
  const resources: EarthResources = {
    maps: bakeEarth(seed), ecology, ecologyTexture: ecology.createTexture(),
    offset: new Vector2(random() * 37, random() * 37), references: 0, contactUsers: 0,
    contactEnabled: { value: 0 },
  };
  earthResources.set(seed, resources);
  return resources;
}

const contactDiscard = /* glsl */ `
  if(uEarthContactEnabled>.5 && vEarthWorld.x>${CONTACT_BOUNDS.left.toFixed(1)}
    && vEarthWorld.x<${CONTACT_BOUNDS.right.toFixed(1)} && vEarthWorld.z>${CONTACT_BOUNDS.back.toFixed(1)}
    && vEarthWorld.z<${CONTACT_BOUNDS.front.toFixed(1)}) discard;
`;

function earthDepthMaterial(resources: EarthResources, contact: boolean): MeshDepthMaterial {
  const material = new MeshDepthMaterial();
  material.name = contact ? 'contact-earth-depth' : 'outer-earth-depth';
  if (!contact) {
    material.onBeforeCompile = shader => {
      shader.uniforms.uEarthContactEnabled = resources.contactEnabled;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vEarthWorld;')
        .replace('#include <project_vertex>', /* glsl */ `
          #include <project_vertex>
          vec4 earthWorld=vec4(transformed,1.0);
          #ifdef USE_BATCHING
            earthWorld=batchingMatrix*earthWorld;
          #endif
          #ifdef USE_INSTANCING
            earthWorld=instanceMatrix*earthWorld;
          #endif
          vEarthWorld=(modelMatrix*earthWorld).xyz;
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vEarthWorld;\nuniform float uEarthContactEnabled;')
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${contactDiscard}`);
    };
    material.customProgramCacheKey = () => 'outer-earth-depth-cutout-v1';
  }
  return material;
}

const earthFields = /* glsl */ `
  varying vec3 vEarthWorld;
  uniform sampler2D uEarthPigment;
  uniform sampler2D uEarthRelief;
  uniform sampler2D uEarthSurface;
  uniform sampler2D uForestEcology;
  uniform vec2 uEarthOffset;
  uniform float uEarthWaterLevel;
  uniform float uEarthContactEnabled;
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
export function createEarthMaterial(seed: string, waterLevel = -.018, contact = false): MeshPhysicalMaterial {
  const resources = resourcesFor(seed), maps = resources.maps, ecology = resources.ecologyTexture;
  resources.references += 1;
  if (contact) { resources.contactUsers += 1; resources.contactEnabled.value = 1; }
  const material = new MeshPhysicalMaterial({
    color: 0xffffff, roughness: .84, metalness: 0, specularIntensity: .28,
    ior: 1.45, clearcoat: .18, clearcoatRoughness: .24, dithering: true,
  });
  material.name = contact ? 'generated-contact-forest-earth' : 'generated-wet-forest-earth';
  material.userData.proceduralTextures = [maps.color, maps.normal, maps.surface, ecology];
  material.userData.tileMetres = TILE_METRES;
  const depthMaterial = earthDepthMaterial(resources, contact);
  material.userData.yyjDepthMaterial = depthMaterial;
  const offset = resources.offset;
  material.onBeforeCompile = shader => {
    shader.uniforms.uEarthPigment = { value: maps.color };
    shader.uniforms.uEarthRelief = { value: maps.normal };
    shader.uniforms.uEarthSurface = { value: maps.surface };
    shader.uniforms.uForestEcology = { value: ecology };
    shader.uniforms.uEarthOffset = { value: offset };
    shader.uniforms.uEarthWaterLevel = { value: waterLevel };
    shader.uniforms.uEarthContactEnabled = resources.contactEnabled;
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
        ${contact ? '' : contactDiscard}
        vec2 earthP = vEarthWorld.xz + uEarthOffset;
        vec2 earthUv0 = earthP / ${TILE_METRES.toFixed(4)};
        vec2 earthUv1 = mat2(.8,-.6,.6,.8) * earthP / ${TILE_METRES.toFixed(4)} + vec2(.37,.59);
        float earthBlend = smoothstep(.42,.58,.5+.5*sin(earthP.x*.47+sin(earthP.y*.31))*sin(earthP.y*.39-earthP.x*.14));
        vec3 earthColor = mix(texture2D(uEarthPigment,earthUv0).rgb,
          texture2D(uEarthPigment,earthUv1).rgb,earthBlend);
        vec4 earthSurface = mix(texture2D(uEarthSurface,earthUv0),
          texture2D(uEarthSurface,earthUv1),earthBlend);
        vec2 ecologyUv=clamp((vEarthWorld.xz-vec2(${ECOLOGY_BOUNDS.minX.toFixed(1)},${ECOLOGY_BOUNDS.minZ.toFixed(1)}))
          /vec2(${ECOLOGY_BOUNDS.width.toFixed(1)},${ECOLOGY_BOUNDS.depth.toFixed(1)}),0.0,1.0);
        ecologyUv=ecologyUv*(223.0/224.0)+vec2(.5/224.0);
        vec4 ecologyCover=texture2D(uForestEcology,ecologyUv);
        float earthWater = 1.0-smoothstep(.012,.16,vEarthWorld.y-uEarthWaterLevel);
        float earthLowDepression=1.0-smoothstep(.006,.030,max(0.0,vEarthWorld.y-uEarthWaterLevel));
        float earthFilmPatch=smoothstep(.58,.78,earthNoise(earthP*3.1));
        float earthMudFilm=earthLowDepression*earthFilmPatch;
        float earthFilmCoverage=earthLowDepression*smoothstep(.45,.80,earthSurface.a)
          *(1.0-ecologyCover.r*.60)*(.35+earthFilmPatch*.65);
        float earthMottle = earthNoise(earthP*.52);
        float earthMoss = ecologyCover.a;
        earthColor *= 1.4*(.94+earthMottle*.09)*(1.0-earthWater*.11);
        earthColor=mix(earthColor,earthColor*vec3(.78,.72,.61),ecologyCover.r*.52+ecologyCover.b*.12);
        earthColor=mix(earthColor,earthColor*vec3(1.13,1.15,1.13),ecologyCover.g*.8);
        earthColor = mix(earthColor,earthColor*vec3(.78,.92,.61),earthMoss*.23);
        diffuseColor.rgb *= earthColor * mix(.82,1.0,earthSurface.g);
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = mix(clamp(earthSurface.r+.035+earthMoss*.065,.77,.97),
          .54,earthMudFilm*earthFilmCoverage*.72);
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
        float earthDetailStrength=.86*(1.0-ecologyCover.r*.18);
        normal = normalize(normal*earthBump.z+earthX*earthBump.x*earthDetailStrength+earthZ*earthBump.y*earthDetailStrength);
      `)
      .replace('#include <clearcoat_normal_fragment_maps>', /* glsl */ `
        #include <clearcoat_normal_fragment_maps>
        #ifdef USE_CLEARCOAT
          clearcoatNormal=normalize(clearcoatNormal*earthBump.z+earthX*earthBump.x*.30+earthZ*earthBump.y*.30);
        #endif
      `)
      .replace('#include <lights_physical_fragment>', /* glsl */ `
        #include <lights_physical_fragment>
        vec3 soilNormalDerivative=max(abs(dFdx(normal)),abs(dFdy(normal)));
        float soilNormalVariance=min(.12,max(max(soilNormalDerivative.x,soilNormalDerivative.y),soilNormalDerivative.z)*.36);
        material.roughness=min(1.0,sqrt(material.roughness*material.roughness+soilNormalVariance));
        #ifdef USE_CLEARCOAT
          material.clearcoat=clamp(earthFilmCoverage*.14,0.0,.13);
          material.clearcoatRoughness=.21+(1.0-earthFilmCoverage)*.12+soilNormalVariance;
          material.clearcoatF0=vec3(.0204);
        #endif
      `);
  };
  material.customProgramCacheKey = () => `correlated-contact-earth-v6/${contact ? 'near' : 'outer'}`;
  let released = false;
  material.addEventListener('dispose', () => {
    if (released) return;
    released = true;
    depthMaterial.dispose();
    if (contact) { resources.contactUsers -= 1; resources.contactEnabled.value = resources.contactUsers > 0 ? 1 : 0; }
    resources.references -= 1;
    if (resources.references === 0) {
      maps.color.dispose(); maps.normal.dispose(); maps.surface.dispose(); ecology.dispose();
      earthResources.delete(seed);
    }
  });
  return material;
}

function sampleRelief(field: Float32Array, u: number, v: number): number {
  const x = ((u % 1) + 1) % 1 * RESOLUTION - .5, y = ((v % 1) + 1) % 1 * RESOLUTION - .5;
  const ix = Math.floor(x), iy = Math.floor(y), tx = x - ix, ty = y - iy;
  const at = (xx: number, yy: number) => field[((yy + RESOLUTION) % RESOLUTION) * RESOLUTION + (xx + RESOLUTION) % RESOLUTION]!;
  const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/** The near surface physically replaces the coarse terrain inside this footprint. */
export function createEarthContactSurface(
  seed: string, height: (x: number, z: number) => number, waterLevel: number,
): { mesh: Mesh; height: (x: number, z: number) => number } {
  const material = createEarthMaterial(seed, waterLevel, true), resources = resourcesFor(seed);
  const cols = 160, rows = 200, positions: number[] = [], indices: number[] = [];
  const gridHeight = new Float32Array((cols + 1) * (rows + 1));
  for (let row = 0; row <= rows; row += 1) {
    const z = CONTACT_BOUNDS.back + row / rows * (CONTACT_BOUNDS.front - CONTACT_BOUNDS.back);
    for (let col = 0; col <= cols; col += 1) {
      const x = CONTACT_BOUNDS.left + col / cols * (CONTACT_BOUNDS.right - CONTACT_BOUNDS.left);
      const px = x + resources.offset.x, pz = z + resources.offset.y;
      const blend = smooth((.5 + .5 * Math.sin(px * .47 + Math.sin(pz * .31)) * Math.sin(pz * .39 - px * .14) - .42) / .16);
      const a = sampleRelief(resources.maps.coarseRelief, px / TILE_METRES, pz / TILE_METRES);
      const b = sampleRelief(resources.maps.coarseRelief, (.8 * px + .6 * pz) / TILE_METRES + .37,
        (-.6 * px + .8 * pz) / TILE_METRES + .59);
      const cover = resources.ecology.sample(x, z), base = height(x, z);
      const nearWater = 1 - smooth((Math.abs(base - waterLevel) - .008) / .06);
      const border = Math.min(x - CONTACT_BOUNDS.left, CONTACT_BOUNDS.right - x, z - CONTACT_BOUNDS.back, CONTACT_BOUNDS.front - z);
      const fade = smooth(border / .34);
      const hearth = 1 - .77 * Math.exp(-((x + .8) ** 2 + (z + 1.6) ** 2) / .9);
      const clodRelief = (a + (b - a) * blend) * (1 - cover.compactedPath * .78) * (1 - nearWater * .58) * hearth;
      const displacement = .018 * (1 - Math.exp(-clodRelief / .018));
      const surfaceY = base + .0012 + displacement * fade;
      positions.push(x, surfaceY, z);
      gridHeight[row * (cols + 1) + col] = surfaceY;
      if (row < rows && col < cols) {
        const a0 = row * (cols + 1) + col, b0 = a0 + 1, c0 = a0 + cols + 1, d0 = c0 + 1;
        indices.push(a0, c0, b0, b0, c0, d0);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, material);
  mesh.name = 'centimetre-resolved-contact-soil';
  mesh.receiveShadow = mesh.castShadow = true;
  mesh.userData.yyjContactGround = true;
  const surfaceHeight = (x: number, z: number): number => {
    if (x < CONTACT_BOUNDS.left || x > CONTACT_BOUNDS.right || z < CONTACT_BOUNDS.back || z > CONTACT_BOUNDS.front) return height(x, z);
    const px = (x - CONTACT_BOUNDS.left) / (CONTACT_BOUNDS.right - CONTACT_BOUNDS.left) * cols;
    const pz = (z - CONTACT_BOUNDS.back) / (CONTACT_BOUNDS.front - CONTACT_BOUNDS.back) * rows;
    const col = Math.min(cols - 1, Math.floor(px)), row = Math.min(rows - 1, Math.floor(pz));
    const u = px - col, v = pz - row, at = row * (cols + 1) + col;
    const a = gridHeight[at]!, b = gridHeight[at + 1]!, c = gridHeight[at + cols + 1]!, d = gridHeight[at + cols + 2]!;
    return u + v <= 1 ? a + u * (b - a) + v * (c - a) : d + (1 - u) * (c - d) + (1 - v) * (b - d);
  };
  return { mesh, height: surfaceHeight };
}
