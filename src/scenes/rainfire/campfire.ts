import {
  AdditiveBlending, BackSide, BoxGeometry, BufferGeometry, Color, Float32BufferAttribute,
  Group, IcosahedronGeometry, Matrix4, Mesh, MeshStandardMaterial, PointLight, Points,
  ShaderMaterial, UniformsLib, UniformsUtils, Vector2, Vector3,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRandom, randomBetween } from '../../core/random';
import type { EnvironmentSnapshot, QualityLevel } from '../../core/types';
import { createProceduralMaterial } from '../../render/materials/proceduralMaterials';

const TAU = Math.PI * 2;
const STEPS: Record<QualityLevel, number> = { low: 32, medium: 64, high: 96 };
const SPARKS: Record<QualityLevel, number> = { low: 12, medium: 24, high: 40 };

const NOISE = /* glsl */ `
  float fireHash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float fireNoise(vec3 p) {
    vec3 a = floor(p), b = fract(p);
    b = b * b * (3.0 - 2.0 * b);
    return mix(mix(mix(fireHash(a), fireHash(a + vec3(1,0,0)), b.x),
      mix(fireHash(a + vec3(0,1,0)), fireHash(a + vec3(1,1,0)), b.x), b.y),
      mix(mix(fireHash(a + vec3(0,0,1)), fireHash(a + vec3(1,0,1)), b.x),
      mix(fireHash(a + vec3(0,1,1)), fireHash(a + vec3(1,1,1)), b.x), b.y), b.z);
  }
`;

/** Split firewood: curved, chipped rings and separate end-face vertices. */
function logGeometry(seed: string, length: number, radius: number): BufferGeometry {
  const random = createRandom(seed);
  const phase = random() * TAU, identity = random() * 73;
  const rows = 12, sectors = 24;
  const positions: number[] = [], indices: number[] = [], radii: number[] = [], identities: number[] = [];
  const add = (x: number, y: number, z: number): number => {
    const index = positions.length / 3;
    positions.push(x, y, z); radii.push(radius); identities.push(identity);
    return index;
  };
  for (let row = 0; row <= rows; row++) {
    const t = row / rows;
    const bend = Math.sin(t * Math.PI) * radius * 0.16;
    for (let sector = 0; sector < sectors; sector++) {
      const angle = sector / sectors * TAU;
      const grain = 1 + 0.054 * Math.sin(angle * 7 + phase)
        + 0.023 * Math.sin(angle * 17 - t * 11 + phase);
      const r = radius * (1 - t * 0.10) * grain;
      const fractured = (Math.sin(angle * 7 + phase) * 0.011 + Math.sin(angle * 13) * 0.006)
        * (Math.exp(-t * 30) + Math.exp(-(1 - t) * 30));
      add((t - 0.5) * length + fractured,
        Math.min(Math.cos(angle) * r, radius * 0.55) + bend,
        Math.sin(angle) * r + Math.sin(t * Math.PI) * radius * 0.08);
    }
  }
  for (let row = 0; row < rows; row++) for (let sector = 0; sector < sectors; sector++) {
    const a = row * sectors + sector, b = row * sectors + (sector + 1) % sectors;
    indices.push(a, b, a + sectors, b, b + sectors, a + sectors);
  }
  for (const end of [0, 1]) {
    const ring = positions.length / 3;
    for (let sector = 0; sector < sectors; sector++) {
      const source = (end * rows * sectors + sector) * 3;
      add(positions[source]!, positions[source + 1]!, positions[source + 2]!);
    }
    const centre = add((end - 0.5) * length, -radius * 0.05, 0);
    for (let sector = 0; sector < sectors; sector++) {
      const a = ring + sector, b = ring + (sector + 1) % sectors;
      if (end === 1) indices.push(centre, a, b);
      else indices.push(centre, b, a);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aFuelRadius', new Float32BufferAttribute(radii, 1));
  geometry.setAttribute('aFuelIdentity', new Float32BufferAttribute(identities, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  return geometry;
}

function fuelMaterial(time: { value: number }): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: '#574634', roughness: 0.94, emissive: '#ff510b', emissiveIntensity: 1.6, dithering: true,
  });
  material.name = 'generated-charred-split-firewood';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFireTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aFuelRadius, aFuelIdentity;
        varying vec3 vFuelPosition, vFuelNormal;
        varying float vFuelRadius, vFuelIdentity;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vFuelPosition = position; vFuelNormal = normal;
        vFuelRadius = aFuelRadius; vFuelIdentity = aFuelIdentity;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vFuelPosition, vFuelNormal;
        varying float vFuelRadius, vFuelIdentity;
        uniform float uFireTime;
        ${NOISE}`)
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        vec3 p = vFuelPosition;
        float weather = fireNoise(p * vec3(2.3, 29.0, 29.0) + vFuelIdentity);
        float grain = fireNoise(p * vec3(4.2, 91.0, 91.0) + weather * 0.8 + vFuelIdentity);
        float charred = (1.0 - smoothstep(0.10, 0.46, abs(p.x)))
          * (0.57 + fireNoise(p * 16.0 + vFuelIdentity) * 0.43);
        float exposed = smoothstep(vFuelRadius * 0.43, vFuelRadius * 0.55, p.y);
        float endFace = smoothstep(0.65, 0.93, abs(vFuelNormal.x));
        float ring = length(p.yz) * (120.0 + sin(atan(p.z, p.y) * 5.0) * 4.0)
          + fireNoise(p * 29.0 + vFuelIdentity) * 0.30;
        float lateWood = 1.0 - smoothstep(0.03, 0.13, abs(fract(ring) - 0.5));
        float cracks = (1.0 - smoothstep(0.025, 0.10, abs(grain - 0.48)))
          * smoothstep(0.38, 0.69, weather);
        diffuseColor.rgb *= 0.47 + weather * 0.45 + exposed * 0.26 - grain * 0.13;
        diffuseColor.rgb *= mix(1.0, 0.28, charred);
        diffuseColor.rgb *= 1.0 - endFace * lateWood * 0.48;
        float relief = weather * 0.006 + grain * 0.0018 - cracks * 0.0032;
        float fuelGlow = cracks * charred * (0.68 + 0.12 * sin(uFireTime * 2.3 + vFuelIdentity));
      `)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance *= fuelGlow * 0.52;`)
      .replace('#include <normal_fragment_maps>', /* glsl */ `
        #include <normal_fragment_maps>
        vec3 dx = dFdx(-vViewPosition), dy = dFdy(-vViewPosition);
        vec3 cx = cross(dy, normal), cy = cross(normal, dx);
        float determinant = dot(dx, cx);
        if (abs(determinant) > 0.00000001) {
          vec3 gradient = sign(determinant) * (dFdx(relief) * cx + dFdy(relief) * cy);
          normal = normalize(abs(determinant) * normal - gradient);
        }
      `);
  };
  material.customProgramCacheKey = () => 'rainfire-charred-fuel-v1';
  return material;
}

function emberMaterial(time: { value: number }): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: '#25201b', roughness: 0.99, emissive: '#ff4707', emissiveIntensity: 2.6, dithering: true,
  });
  material.name = 'generated-ember-coals';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCoalTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCoalPosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCoalPosition = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCoalPosition;\nuniform float uCoalTime;\n${NOISE}`)
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        float cells = fireNoise(vCoalPosition * 49.0);
        float patches = fireNoise(vCoalPosition * 15.0 + 11.7);
        float fissure = (1.0 - smoothstep(0.018, 0.10, abs(cells - 0.48)))
          * smoothstep(0.33, 0.68, patches);
        float heat = 0.018 + fissure * 0.95 + smoothstep(0.69, 0.82, patches) * 0.28;
        diffuseColor.rgb *= 0.55 + cells * 0.52;
      `)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance *= heat * (0.85 + 0.13 * sin(uCoalTime * 1.7 + patches * 17.0));`);
  };
  material.customProgramCacheKey = () => 'rainfire-ember-coals-v1';
  return material;
}

function ashBed(seed: string): Mesh {
  const random = createRandom(`${seed}/ash-bed`);
  const positions: number[] = [], colors: number[] = [], indices: number[] = [];
  const rings = 9, sectors = 48;
  for (let ring = 0; ring <= rings; ring++) for (let sector = 0; sector < sectors; sector++) {
    const angle = sector / sectors * TAU, radius = ring / rings;
    const edge = 0.62 + Math.sin(angle * 5 + 0.4) * 0.035 + Math.sin(angle * 9) * 0.021;
    positions.push(Math.cos(angle) * radius * edge,
      0.009 + (1 - radius * radius) * 0.023 + random() * 0.007,
      Math.sin(angle) * radius * edge * 0.86);
    const shade = 0.023 + random() * 0.020 + radius * 0.012;
    colors.push(shade * 1.05, shade, shade * 0.88);
    if (ring < rings) {
      const a = ring * sectors + sector, b = ring * sectors + (sector + 1) % sectors;
      indices.push(a, b, a + sectors, b, b + sectors, a + sectors);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 1 }));
  mesh.name = 'irregular-fire-ash-bed'; mesh.receiveShadow = true;
  return mesh;
}

function stoneAndCoalGeometry(seed: string, coals: boolean): BufferGeometry {
  const random = createRandom(`${seed}/${coals ? 'coals' : 'hearth'}`);
  const pieces: BufferGeometry[] = [];
  const count = coals ? 30 : 11;
  for (let i = 0; i < count; i++) {
    const primitive = new IcosahedronGeometry(1, coals ? 1 : 3);
    const geometry = coals ? primitive : mergeVertices(primitive, 1e-5);
    if (!coals) primitive.dispose();
    const position = geometry.getAttribute('position');
    const phase = random() * TAU;
    const sx = coals ? randomBetween(random, 0.035, 0.095) : randomBetween(random, 0.12, 0.19);
    const sy = coals ? randomBetween(random, 0.022, 0.055) : randomBetween(random, 0.07, 0.12);
    const sz = coals ? randomBetween(random, 0.033, 0.083) : randomBetween(random, 0.10, 0.18);
    for (let vertex = 0; vertex < position.count; vertex++) {
      const x = position.getX(vertex), y = position.getY(vertex), z = position.getZ(vertex);
      const wear = 1 + Math.sin(x * 5 + y * 3 + phase) * 0.075 + Math.sin(z * 7 - y * 5) * 0.045;
      position.setXYZ(vertex, x * sx * wear, y * sy * wear, z * sz * wear);
    }
    const angle = coals ? random() * TAU : (i + random() * 0.25) / count * TAU;
    const radius = coals ? Math.sqrt(random()) * 0.46 : randomBetween(random, 0.66, 0.75);
    geometry.rotateY(random() * TAU);
    geometry.translate(Math.cos(angle) * radius, sy * 0.65 + (coals ? 0.035 : 0.004), Math.sin(angle) * radius * 0.90);
    geometry.computeVertexNormals();
    pieces.push(geometry);
  }
  const merged = mergeGeometries(pieces, false)!;
  pieces.forEach(piece => piece.dispose());
  merged.computeBoundingSphere();
  return merged;
}

const volumeVertex = /* glsl */ `
  varying vec3 vFirePosition;
  void main() {
    vFirePosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const volumeFragment = /* glsl */ `
  uniform float uTime, uSteps;
  uniform vec2 uWind;
  uniform vec3 uSeed;
  uniform mat4 uWorldToLocal, uLocalToClip;
  varying vec3 vFirePosition;
  #include <common>
  #include <fog_pars_fragment>
  #include <dithering_pars_fragment>
  ${NOISE}

  vec2 intersectFire(vec3 origin, vec3 ray) {
    vec3 safeRay = mix(vec3(0.00001), ray, step(vec3(0.00001), abs(ray)));
    vec3 a = (vec3(-1.10, 0.02, -0.90) - origin) / safeRay;
    vec3 b = (vec3(1.10, 2.25, 0.90) - origin) / safeRay;
    vec3 lo = min(a, b), hi = max(a, b);
    return vec2(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
  }

  float tongue(vec3 p, vec2 foot, float height, float width, float phase) {
    float h = clamp((p.y - 0.15) / height, 0.0, 1.0);
    vec2 curl = vec2(sin(p.y * 7.3 - uTime * 2.5 + phase),
      cos(p.y * 6.1 - uTime * 2.1 + phase)) * (0.020 + h * 0.085);
    curl += vec2(sin(p.y * 17.7 - uTime * 5.7 + phase),
      cos(p.y * 15.3 - uTime * 5.1 + phase)) * h * 0.031;
    vec2 centre = foot * (1.0 - h * 0.42) + uWind * h * h * 0.20 + curl;
    float radius = width * pow(max(0.0, 1.0 - h), 0.88) + 0.007;
    float shape = 1.0 - length((p.xz - centre) * vec2(1.0, 1.10)) / max(0.015, radius);
    return shape - smoothstep(height * 0.83, height + 0.08, p.y - 0.15) * 2.0;
  }

  void main() {
    vec3 origin = (uWorldToLocal * vec4(cameraPosition, 1.0)).xyz;
    vec3 ray = normalize(vFirePosition - origin);
    vec2 bounds = intersectFire(origin, ray);
    float begin = max(0.0, bounds.x), end = bounds.y;
    if (end <= begin) discard;
    float stepLength = (end - begin) / uSteps;
    // Without temporal accumulation, per-pixel random offsets turn thin
    // reaction sheets into sand. Stable midpoints resolve their real shape.
    float distanceAlongRay = begin + stepLength * 0.5;
    float frontWidth = max(0.196, stepLength * 7.0);
    float microDetail = 1.0 - smoothstep(0.025, 0.070, stepLength);
    float transmittance = 1.0;
    vec3 accumulated = vec3(0.0);
    vec3 firstLight = origin + ray * begin;
    bool foundLight = false;
    float height = 1.19 + 0.11 * sin(uTime * 1.13 + uSeed.x)
      + 0.07 * sin(uTime * 2.37 + uSeed.z);
    for (int sampleIndex = 0; sampleIndex < 96; sampleIndex++) {
      if (float(sampleIndex) >= uSteps || transmittance < 0.018) break;
      vec3 p = origin + ray * distanceAlongRay;
      vec3 moving = p * vec3(5.8, 4.7, 5.8) + uSeed;
      moving.y -= uTime * 2.25;
      moving.xz -= uWind * p.y * 0.28;
      float large = fireNoise(moving);
      float fine = fireNoise(moving * 2.03 + vec3(7.2, 2.6, 11.9));
      float micro = mix(0.5, fireNoise(moving * 4.37 + vec3(17.1, -uTime * 0.7, 5.2)), microDetail);
      float turbulence = large * 0.54 + fine * 0.31 + micro * 0.15;
      vec3 curled = p;
      curled.xz += vec2(large - 0.5, fine - 0.5) * (0.075 + p.y * 0.11);
      float shape = tongue(curled, vec2(0.02, -0.08), height, 0.190, uSeed.x);
      shape = max(shape, tongue(curled, vec2(-0.29, 0.11), height * 0.81, 0.145, uSeed.y + 2.1));
      shape = max(shape, tongue(curled, vec2(0.28, 0.14), height * 0.70, 0.140, uSeed.z + 4.7));
      float field = shape + (large - 0.5) * 1.40 + (fine - 0.5) * 0.82 + (micro - 0.5) * 0.44;
      // Luminous reaction fronts form folded, thin sheets. Filling every
      // positive sample instead would turn the fire into smooth orange wax.
      float reaction = exp(-pow((field - 0.22) / frontWidth, 2.0)) * (0.196 / frontWidth);
      float broken = smoothstep(0.27, 0.59, turbulence + (1.0 - p.y / 1.6) * 0.09);
      float flame = reaction * broken
        * smoothstep(0.19, 0.38, p.y)
        * (1.0 - smoothstep(height + 0.07, height + 0.18, p.y));
      float temperature = clamp(0.36 + fine * 0.53 + (micro - 0.5) * 0.76 - p.y * 0.08, 0.0, 1.0);
      vec3 flameColor = mix(vec3(1.10, 0.055, 0.001), vec3(3.25, 0.83, 0.035), smoothstep(0.20, 0.75, temperature));
      // Heat varies through the folds, so the pale core consists of short
      // irregular filaments instead of one smooth height-based gradient.
      float hotCore = smoothstep(0.74, 0.94, temperature) * reaction
        * (1.0 - smoothstep(0.43, 1.1, p.y));
      flameColor = mix(flameColor, vec3(4.0, 2.0, 0.33), hotCore);
      float fireAlpha = 1.0 - exp(-flame * stepLength * 8.4);

      vec2 smokeCentre = uWind * max(0.0, p.y - 0.5) * 0.30;
      float smokeRadius = 0.16 + p.y * 0.08;
      float smoke = exp(-dot(p.xz - smokeCentre, p.xz - smokeCentre) / (smokeRadius * smokeRadius))
        * smoothstep(0.77, 1.25, p.y) * (1.0 - smoothstep(1.80, 2.22, p.y))
        * smoothstep(0.40, 0.77, turbulence);
      smoke *= 1.0 - smoothstep(0.80, 1.08, abs(p.x));
      float smokeAlpha = 1.0 - exp(-smoke * stepLength * 0.37);
      vec3 smokeColor = vec3(0.018, 0.025, 0.029)
        + vec3(0.13, 0.044, 0.012) * exp(-p.y * 1.4);
      float alpha = 1.0 - (1.0 - fireAlpha) * (1.0 - smokeAlpha);
      vec3 source = flameColor * fireAlpha + smokeColor * smokeAlpha * (1.0 - fireAlpha);
      if (!foundLight && alpha > 0.003) { firstLight = p; foundLight = true; }
      accumulated += transmittance * source;
      transmittance *= 1.0 - alpha;
      distanceAlongRay += stepLength;
    }
    float opacity = 1.0 - transmittance;
    if (opacity < 0.004) discard;
    // Test the luminous volume's near contribution, not its proxy box back face.
    // This keeps foreground rocks in front of the fire without clipping every
    // flame that shares a pixel with wood located inside the bounding volume.
    vec4 clip = uLocalToClip * vec4(firstLight, 1.0);
    gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
    #ifdef USE_FOG
      float viewDistance = length(firstLight - origin);
      #ifdef FOG_EXP2
        float fogAmount = 1.0 - exp(-fogDensity * fogDensity * viewDistance * viewDistance);
      #else
        float fogAmount = smoothstep(fogNear, fogFar, viewDistance);
      #endif
      accumulated = mix(accumulated, fogColor * opacity, fogAmount);
    #endif
    // Front-to-back integration is already premultiplied by accumulated alpha.
    gl_FragColor = vec4(accumulated, opacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <dithering_fragment>
  }
`;

function fireVolume(seed: string, time: { value: number }, wind: { value: Vector2 }, quality: QualityLevel): Mesh {
  const random = createRandom(`${seed}/flame-volume`);
  const inverse = new Matrix4(), clip = new Matrix4();
  const material = new ShaderMaterial({
    name: 'raymarched-campfire-and-smoke', transparent: true, premultipliedAlpha: true,
    side: BackSide, depthWrite: false, depthTest: true, fog: true, dithering: true,
    uniforms: UniformsUtils.merge([UniformsLib.fog, {
      uTime: time, uWind: wind, uSteps: { value: STEPS[quality] },
      uSeed: { value: new Vector3(random() * 31, random() * 31, random() * 31) },
      uWorldToLocal: { value: inverse }, uLocalToClip: { value: clip },
    }]),
    vertexShader: volumeVertex, fragmentShader: volumeFragment,
  });
  // UniformsUtils clones values. Rebind the shared live weather handles once.
  material.uniforms.uTime = time; material.uniforms.uWind = wind;
  material.uniforms.uWorldToLocal = { value: inverse };
  material.uniforms.uLocalToClip = { value: clip };
  const geometry = new BoxGeometry(2.20, 2.23, 1.80).translate(0, 1.135, 0);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'fire-volume'; mesh.renderOrder = 2; mesh.frustumCulled = false;
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
    inverse.copy(mesh.matrixWorld).invert();
    clip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(mesh.matrixWorld);
  };
  return mesh;
}

function sparks(seed: string, time: { value: number }, wind: { value: Vector2 }, quality: QualityLevel): Points<BufferGeometry, ShaderMaterial> {
  const random = createRandom(`${seed}/rising-sparks`);
  const position: number[] = [], phase: number[] = [], life: number[] = [], size: number[] = [];
  for (let i = 0; i < SPARKS.high; i++) {
    position.push(randomBetween(random, -0.25, 0.25), 0.24, randomBetween(random, -0.22, 0.22));
    phase.push(random()); life.push(randomBetween(random, 1.1, 2.7)); size.push(randomBetween(random, 0.007, 0.018));
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
  geometry.setAttribute('aPhase', new Float32BufferAttribute(phase, 1));
  geometry.setAttribute('aLife', new Float32BufferAttribute(life, 1));
  geometry.setAttribute('aSize', new Float32BufferAttribute(size, 1));
  geometry.setDrawRange(0, SPARKS[quality]);
  const material = new ShaderMaterial({
    name: 'generated-flying-fire-embers', transparent: true, depthWrite: false, blending: AdditiveBlending, fog: true,
    uniforms: UniformsUtils.merge([UniformsLib.fog, {
      uTime: time, uWind: wind, uViewport: { value: 1 }, uPixelRatio: { value: 1 },
    }]),
    vertexShader: /* glsl */ `
      uniform float uTime, uViewport, uPixelRatio;
      uniform vec2 uWind;
      attribute float aPhase, aLife, aSize;
      varying float vSparkAlpha, vSparkHeat;
      #include <fog_pars_vertex>
      void main() {
        float age = fract(uTime / aLife + aPhase);
        vec3 p = position;
        p.y += age * (0.78 + aLife * 0.65);
        p.xz += uWind * age * age * 0.45
          + vec2(sin(age * 8.0 + aPhase * 31.0), cos(age * 7.0 + aPhase * 21.0)) * age * 0.085;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        float projected = aSize * 0.5 * uViewport * projectionMatrix[1][1] / max(0.1, -mvPosition.z);
        gl_PointSize = clamp(projected, 0.7 * uPixelRatio, 3.5 * uPixelRatio);
        vSparkAlpha = smoothstep(0.0, 0.10, age) * (1.0 - smoothstep(0.55, 1.0, age))
          * min(1.0, projected / max(0.5, uPixelRatio));
        vSparkHeat = 1.0 - age;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vSparkAlpha, vSparkHeat;
      #include <fog_pars_fragment>
      void main() {
        float distanceToCentre = length(gl_PointCoord - 0.5);
        float edge = 1.0 - smoothstep(0.06, 0.49, distanceToCentre);
        if (edge < 0.01) discard;
        vec3 color = mix(vec3(1.2, 0.08, 0.003), vec3(3.8, 1.65, 0.32), vSparkHeat);
        gl_FragColor = vec4(color, edge * vSparkAlpha * 0.74);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #ifdef USE_FOG
          #ifdef FOG_EXP2
            float fogAmount = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          #else
            float fogAmount = smoothstep(fogNear, fogFar, vFogDepth);
          #endif
          gl_FragColor.a *= 1.0 - fogAmount;
        #endif
      }
    `,
  });
  material.uniforms.uTime = time; material.uniforms.uWind = wind;
  const points = new Points(geometry, material);
  points.name = 'fire-embers'; points.frustumCulled = false; points.renderOrder = 3;
  const drawingSize = new Vector2();
  points.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(drawingSize);
    const height = renderer.getRenderTarget()?.height ?? drawingSize.y;
    material.uniforms.uViewport!.value = height;
    material.uniforms.uPixelRatio!.value = height / Math.max(1, renderer.domElement.clientHeight);
  };
  return points;
}

export interface Campfire {
  readonly group: Group;
  update(frame: EnvironmentSnapshot): void;
  setQuality(quality: QualityLevel): void;
}

/**
 * A compact three-dimensional fire, generated entirely from the scene seed.
 * The owner disposes the group's geometries, materials and light; this module
 * creates no textures, audio nodes, event listeners or private animation loop.
 */
export function createCampfire(seed: string, quality: QualityLevel): Campfire {
  const group = new Group();
  group.name = 'sheltered-campfire';
  const time = { value: 0 }, wind = { value: new Vector2(0.45, 0.12) };
  const random = createRandom(`${seed}/stacked-firewood`);
  const material = fuelMaterial(time);
  group.add(ashBed(seed));
  const placements = [
    [-0.08, 0.13, 0.03, 0.15, 0.03, 0.98, 0.094],
    [0.04, 0.14, -0.15, 2.13, -0.05, 0.88, 0.098],
    [0.05, 0.18, 0.18, -0.77, 0.06, 0.85, 0.084],
    [-0.16, 0.29, 0.00, 0.81, -0.21, 0.82, 0.078],
    [0.17, 0.28, 0.02, -0.92, 0.18, 0.80, 0.075],
    [-0.02, 0.34, -0.06, 1.59, -0.11, 0.65, 0.064],
  ] as const;
  placements.forEach(([x, y, z, yaw, lean, length, radius], index) => {
    const log = new Mesh(logGeometry(`${seed}/log/${index}`, length, radius), material);
    log.name = `charred-split-log-${index}`;
    log.position.set(x + (random() - 0.5) * 0.025, y, z);
    log.rotation.set((random() - 0.5) * 0.25, yaw, lean);
    log.castShadow = true; log.receiveShadow = true;
    group.add(log);
  });
  const hearthMaterial = createProceduralMaterial('stone', `${seed}/hearth`);
  hearthMaterial.color.set('#515452');
  const stones = new Mesh(stoneAndCoalGeometry(seed, false), hearthMaterial);
  stones.name = 'weathered-hearth-stones'; stones.castShadow = true; stones.receiveShadow = true;
  const coals = new Mesh(stoneAndCoalGeometry(seed, true), emberMaterial(time));
  coals.name = 'banked-ember-bed'; coals.castShadow = false; coals.receiveShadow = true;
  const volume = fireVolume(seed, time, wind, quality);
  const embers = sparks(seed, time, wind, quality);
  const light = new PointLight(new Color('#ffb067'), 16, 17, 2);
  light.name = 'campfire-light'; light.position.set(0, 0.67, 0);
  // Its fixed position preserves coherent illumination; optional scene shadow
  // policy must avoid drawing the entire distant forest into six cube faces.
  light.castShadow = false;
  group.add(stones, coals, volume, embers, light);
  group.userData.generatedFire = { flameHeight: 1.4, hearthRadius: 0.86, fixedAssets: 0 };
  const phase = random() * TAU;
  return {
    group,
    update(frame): void {
      time.value = frame.elapsed;
      wind.value.set(Math.max(-1.5, Math.min(1.5, frame.wind.x)), Math.max(-1.0, Math.min(1.0, frame.wind.z)));
      light.intensity = 16 * (0.94 + 0.075 * Math.sin(frame.elapsed * 5.7 + phase)
        + 0.040 * Math.sin(frame.elapsed * 13.1 + phase * 2.3)
        + 0.025 * Math.sin(frame.elapsed * 21.7));
    },
    setQuality(next): void {
      (volume.material as ShaderMaterial).uniforms.uSteps!.value = STEPS[next];
      embers.geometry.setDrawRange(0, SPARKS[next]);
    },
  };
}
