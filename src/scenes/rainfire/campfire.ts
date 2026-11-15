import {
  BackSide, BoxGeometry, BufferGeometry, Color, Float32BufferAttribute,
  Group, IcosahedronGeometry, Matrix4, Mesh, MeshStandardMaterial, PointLight, Points,
  ShaderMaterial, UniformsLib, UniformsUtils, Vector2, Vector3,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRandom, randomBetween } from '../../core/random';
import type { EnvironmentSnapshot, QualityLevel } from '../../core/types';
import type { SceneDepthField } from '../../render/SurfaceOcclusion';
import { createRainMaterial } from './rainMaterials';
import { createFireIllumination } from './fireIllumination';
import type { FireIlluminationState } from './fireIllumination';

const TAU = Math.PI * 2;
const STEPS: Record<QualityLevel, number> = { low: 32, medium: 64, high: 96 };
const SPARKS: Record<QualityLevel, number> = { low: 12, medium: 24, high: 40 };

interface FireUniforms {
  uFireHeat: { value: number };
  uFlameHeight: { value: number };
  uCoalHeat: { value: number };
  uSmoke: { value: number };
  uFirePosition: { value: Vector3 };
  uFireColor: { value: Color };
  uFireIntensity: { value: number };
}

// Two samples preserve the broad source's 30/70 split and fixed separation.
// Their weighted offsets sum to zero, so the combustion state remains the
// actual radiant centroid used by flame shape, smoke and atmospheric scattering.
const LIGHT_SAMPLES = [
  { weight: .30, x: -.182, y: -.196, z: .077 },
  { weight: .70, x: .078, y: .084, z: -.033 },
] as const;

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

const CHAR_PLATES = /* glsl */ `
  // Shrinking charcoal breaks across the grain as well as along it. Distances
  // to unequal jittered cells give broken plates instead of luminous stripes.
  vec2 charPlate(vec2 p) {
    vec2 cell=floor(p), local=fract(p);
    float first=10.0, second=10.0;
    for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++) {
      vec2 neighbour=vec2(float(x),float(y)), id=cell+neighbour;
      vec2 centre=.14+.72*vec2(fireHash(vec3(id,3.7)),fireHash(vec3(id,19.3)));
      vec2 delta=neighbour+centre-local;
      float distance=dot(delta,delta);
      if(distance<first){second=first;first=distance;}
      else second=min(second,distance);
    }
    return vec2(sqrt(first),sqrt(second)-sqrt(first));
  }
`;

/** Split firewood: curved, chipped rings and separate end-face vertices. */
function logGeometry(seed: string, length: number, radius: number): BufferGeometry {
  const random = createRandom(seed);
  const phase = random() * TAU, identity = random() * 73;
  const rows = 18, sectors = 28;
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
      const r = radius * (1 - t * 0.10) * grain
        * (1 + .028*Math.sin(t*25+phase)*Math.sin(angle*9+.7));
      const fractured = (Math.sin(angle * 7 + phase) * 0.011 + Math.sin(angle * 13) * 0.006)
        * (Math.exp(-t * 30) + Math.exp(-(1 - t) * 30));
      const split=radius*(.52+.045*Math.sin(t*14+phase))+.003*Math.sin(angle*9+t*28);
      add((t - 0.5) * length + fractured,
        Math.min(Math.cos(angle) * r, split) + bend,
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
  // Preserve each log's grain coordinates when the six pieces are combined.
  geometry.setAttribute('aFuelPosition', geometry.getAttribute('position').clone());
  geometry.setAttribute('aFuelNormal', geometry.getAttribute('normal').clone());
  return geometry;
}

function fuelMaterial(coalHeat: { value: number }): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: '#574634', roughness: 0.94, emissive: '#ff4607', emissiveIntensity: 2.2, dithering: true,
  });
  material.name = 'generated-charred-split-firewood';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCoalHeat = coalHeat;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aFuelRadius, aFuelIdentity;
        attribute vec3 aFuelPosition, aFuelNormal;
        varying vec3 vFuelPosition, vFuelNormal;
        varying float vFuelRadius, vFuelIdentity;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vFuelPosition = aFuelPosition; vFuelNormal = aFuelNormal;
        vFuelRadius = aFuelRadius; vFuelIdentity = aFuelIdentity;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vFuelPosition, vFuelNormal;
        varying float vFuelRadius, vFuelIdentity;
        uniform float uCoalHeat;
        ${NOISE}
        ${CHAR_PLATES}`)
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
        vec2 plateUv=vec2(p.x*23.0,atan(p.z,p.y)*vFuelRadius*35.0);
        plateUv=mix(plateUv,p.yz*32.0,endFace)+vFuelIdentity;
        plateUv+=vec2(weather-.5,grain-.5)*.33;
        vec2 plate=charPlate(plateUv);
        float cracks=1.0-smoothstep(.018,.085,plate.y);
        float ash=smoothstep(.57,.76,fireNoise(p*vec3(7.0,27.0,24.0)+vFuelIdentity+7.2))
          *charred*(.35+.65*max(0.0,vFuelNormal.y));
        diffuseColor.rgb *= 0.47 + weather * 0.45 + exposed * 0.26 - grain * 0.13;
        diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.006,.0065,.006)*(.74+plate.x*.65),charred);
        diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.095,.086,.072),ash*.75);
        diffuseColor.rgb *= 1.0 - endFace * lateWood * 0.48;
        float relief=mix(weather*.0016+grain*.0004,
          (1.0-plate.x)*.0035-cracks*.0030,charred);
        float heat=smoothstep(.41,.72,fireNoise(p*vec3(8.0,17.0,17.0)+vFuelIdentity+21.3))
          *charred*(1.0-ash)*(.35+.65*(1.0-smoothstep(-.025,.065,p.y)));
        float fuelGlow=(cracks*.60+smoothstep(.76,.93,grain)*.10)*heat
          *(.66+.16*uCoalHeat);
      `)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance *= fuelGlow;`)
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
  material.customProgramCacheKey = () => 'rainfire-charred-fuel-v3';
  return material;
}

function emberMaterial(coalHeat: { value: number }): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: '#25201b', roughness: 0.99, emissive: '#ff4707', emissiveIntensity: 2.6, dithering: true,
  });
  material.name = 'generated-ember-coals';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCoalHeat = coalHeat;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCoalPosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCoalPosition = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCoalPosition;\nuniform float uCoalHeat;\n${NOISE}`)
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        float cells = fireNoise(vCoalPosition * 49.0);
        float patches = fireNoise(vCoalPosition * 15.0 + 11.7);
        float crust=fireNoise(vCoalPosition*93.0+vec3(7.1,18.3,2.7));
        float fissure=(1.0-smoothstep(.012,.064,abs(cells-.43)))
          *smoothstep(.40,.70,patches)*(1.0-smoothstep(.47,.72,crust));
        float exposedHeat=smoothstep(.40,.71,patches)*(.60+.40*cells);
        float heat=.005+exposedHeat*.25+fissure*.58;
        float ash=smoothstep(.67,.86,crust)*(1.0-exposedHeat);
        diffuseColor.rgb=mix(diffuseColor.rgb*(.42+cells*.36),vec3(.07,.063,.052),ash);
      `)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance *= heat * .88 * uCoalHeat;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        float coalRelief=(cells-.5)*.0018+(crust-.5)*.00055-fissure*.001;
        vec3 coalDx=dFdx(-vViewPosition),coalDy=dFdy(-vViewPosition);
        vec3 coalCx=cross(coalDy,normal),coalCy=cross(normal,coalDx);
        float coalDet=dot(coalDx,coalCx);
        if(abs(coalDet)>1e-8) normal=normalize(abs(coalDet)*normal
          -sign(coalDet)*(dFdx(coalRelief)*coalCx+dFdy(coalRelief)*coalCy));`);
  };
  material.customProgramCacheKey = () => 'rainfire-ember-coals-v3';
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
  const count = coals ? 30 : 10;
  for (let i = 0; i < count; i++) {
    const primitive = new IcosahedronGeometry(1, coals ? 2 : 3);
    primitive.deleteAttribute('normal'); primitive.deleteAttribute('uv');
    const geometry = mergeVertices(primitive, 1e-5);
    primitive.dispose();
    const position = geometry.getAttribute('position');
    const phase = random() * TAU;
    const sx = coals ? randomBetween(random, 0.035, 0.095) : randomBetween(random, 0.15, 0.24);
    const sy = coals ? randomBetween(random, 0.022, 0.055) : randomBetween(random, 0.055, 0.095);
    const sz = coals ? randomBetween(random, 0.033, 0.083) : randomBetween(random, 0.10, 0.23);
    const colors:number[]=[];
    const pigment=randomBetween(random,.72,1.14);
    for (let vertex = 0; vertex < position.count; vertex++) {
      const x = position.getX(vertex), y = position.getY(vertex), z = position.getZ(vertex);
      const wear = 1 + Math.sin(x * 5 + y * 3 + phase) * 0.115 + Math.sin(z * 7 - y * 5) * 0.055;
      const fractured=coals?1:Math.min(1,.77/Math.max(.01,Math.abs(x*.71+y*.61-z*.35)),
        .79/Math.max(.01,Math.abs(z*.80+y*.45-x*.37)));
      position.setXYZ(vertex, x * sx * wear*fractured, y * sy * wear*fractured, z * sz * wear*fractured);
      colors.push(pigment,pigment*(.97+Math.sin(phase)*.025),pigment*.92);
    }
    const angle = coals ? random() * TAU : (i + random() * 0.50) / count * TAU;
    const radius = coals ? Math.sqrt(random()) * 0.46 : randomBetween(random, 0.66, 0.75);
    geometry.rotateY(random() * TAU);
    geometry.translate(Math.cos(angle) * radius, sy * (coals?.65:.42) + (coals ? 0.035 : 0.004), Math.sin(angle) * radius * 0.90);
    geometry.setAttribute('color',new Float32BufferAttribute(colors,3));
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
  uniform float uTime, uSteps, uFireHeat, uFlameHeight, uSmoke, uFireIntensity;
  uniform vec2 uWind;
  uniform vec3 uSeed, uFirePosition, uFireColor;
  uniform mat4 uWorldToLocal, uLocalToClip;
  uniform sampler2D uSceneDepth;
  uniform vec2 uSceneInverseSize;
  uniform mat4 uSceneInverseProjection, uSceneCameraWorld;
  uniform float uSceneDepthEnabled;
  varying vec3 vFirePosition;
  #include <common>
  #include <fog_pars_fragment>
  #include <dithering_pars_fragment>
  ${NOISE}

  vec2 intersectFire(vec3 origin, vec3 ray) {
    vec3 safeRay = mix(vec3(0.00001), ray, step(vec3(0.00001), abs(ray)));
    vec3 a = (vec3(-1.10, 0.02, -0.90) - origin) / safeRay;
    vec3 b = (vec3(1.10, 2.65, 0.90) - origin) / safeRay;
    vec3 lo = min(a, b), hi = max(a, b);
    return vec2(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
  }

  float tongue(vec3 p, vec2 foot, float height, float width, float phase) {
    float h = clamp((p.y - 0.15) / height, 0.0, 1.0);
    vec2 curl = vec2(sin(p.y * 7.3 - uTime * 2.5 + phase),
      cos(p.y * 6.1 - uTime * 2.1 + phase)) * (0.020 + h * 0.085);
    curl += vec2(sin(p.y * 17.7 - uTime * 5.7 + phase),
      cos(p.y * 15.3 - uTime * 5.1 + phase)) * h * 0.031;
    vec2 centre = foot * (1.0 - h * 0.42) + uWind * h * h * 0.20 + curl
      + uFirePosition.xz * h;
    float radius = width * pow(max(0.0, 1.0 - h), 0.88) + 0.007;
    // Flatten and twist the jets into ribbons; the reaction front below folds
    // their surfaces without filling them into opaque cones.
    float twist = phase + p.y * 1.8;
    vec2 across = p.xz - centre;
    vec2 ribbon = vec2(dot(across, vec2(cos(twist), sin(twist))),
      dot(across, vec2(-sin(twist), cos(twist))) * 1.55);
    float shape = 1.0 - length(ribbon) / max(0.015, radius);
    return shape - smoothstep(height * 0.83, height + 0.08, p.y - 0.15) * 2.0;
  }

  void main() {
    vec3 origin = (uWorldToLocal * vec4(cameraPosition, 1.0)).xyz;
    vec3 ray = normalize(vFirePosition - origin);
    vec2 bounds = intersectFire(origin, ray);
    float begin = max(0.0, bounds.x), end = bounds.y;
    if (uSceneDepthEnabled > .5) {
      vec2 sceneUv=gl_FragCoord.xy*uSceneInverseSize;
      float sceneDepth=texture2D(uSceneDepth,sceneUv).r;
      vec4 viewHit=uSceneInverseProjection*vec4(sceneUv*2.0-1.0,sceneDepth*2.0-1.0,1.0);
      viewHit/=viewHit.w;
      vec3 localHit=(uWorldToLocal*uSceneCameraWorld*viewHit).xyz;
      // Stop integrating at the actual opaque surface. Merely setting the
      // first luminous fragment depth still includes emission behind a log.
      end=min(end,length(localHit-origin)-.003);
    }
    if (end <= begin) discard;
    float stepLength = (end - begin) / uSteps;
    // Without temporal accumulation, per-pixel random offsets turn thin
    // reaction sheets into sand. Stable midpoints resolve their real shape.
    float distanceAlongRay = begin + stepLength * 0.5;
    float frontWidth = max(0.130, stepLength * 6.0);
    float microDetail = 1.0 - smoothstep(0.025, 0.070, stepLength);
    float transmittance = 1.0;
    vec3 accumulated = vec3(0.0);
    vec3 firstLight = origin + ray * begin;
    bool foundLight = false;
    float height = uFlameHeight;
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
      float reaction = exp(-pow((field - 0.22) / frontWidth, 2.0)) * (0.130 / frontWidth);
      float broken = smoothstep(0.27, 0.59, turbulence + (1.0 - p.y / 1.6) * 0.09);
      float flame = reaction * broken
        * smoothstep(0.19, 0.38, p.y)
        * (1.0 - smoothstep(height + 0.07, height + 0.18, p.y));
      float temperature = clamp(0.36 + fine * 0.53 + (micro - 0.5) * 0.76
        - p.y * 0.08 + (uFireHeat - 0.96) * 0.20, 0.0, 1.0);
      vec3 flameColor = mix(vec3(4.5, 0.28, 0.007), vec3(16.0, 4.8, 0.35), smoothstep(0.20, 0.78, temperature));
      // Heat varies through the folds, so the pale core consists of short
      // irregular filaments instead of one smooth height-based gradient.
      float hotCore = smoothstep(0.81, 0.98, temperature) * reaction
        * (1.0 - smoothstep(0.40, 0.78, p.y));
      flameColor = mix(flameColor, vec3(32.0, 18.0, 5.2), hotCore * 0.55);
      float fireAlpha = 1.0 - exp(-flame * stepLength * 1.75 * uFireHeat);
      // Emission and extinction are independent: hot gas shines through the
      // sparse reaction fronts without becoming a solid orange surface.
      float emission = flame * stepLength * 2.2 * (.72 + temperature*.50) * uFireHeat;

      vec2 smokeCentre = uWind * max(0.0, p.y - 0.5) * 0.30 + uFirePosition.xz
        + vec2(large - 0.5, fine - 0.5) * p.y * 0.16;
      float smokeRadius = 0.12 + p.y * 0.10;
      float smoke = exp(-dot(p.xz - smokeCentre, p.xz - smokeCentre) / (smokeRadius * smokeRadius))
        * smoothstep(height * 0.66, height + 0.34, p.y)
        * (1.0 - smoothstep(1.95, 2.61, p.y))
        * smoothstep(0.33, 0.72, turbulence) * uSmoke;
      smoke *= (1.0 - smoothstep(0.80, 1.08, abs(p.x)))
        * (1.0 - smoothstep(0.65, 0.88, abs(p.z)));
      float smokeAlpha = 1.0 - exp(-smoke * stepLength * 0.62);
      vec3 toFire = uFirePosition - p;
      float fireDistanceSquared = max(dot(toFire, toFire), 0.08);
      float scatter = 0.55 + 0.45 * pow(max(dot(toFire * inversesqrt(fireDistanceSquared), -ray), 0.0), 3.0);
      // The low plume scatters the same total fire energy that illuminates the
      // wet ground. Its upper portion fades into cool ambient smoke.
      vec3 incident = uFireColor * (uFireIntensity / (12.56637 * (fireDistanceSquared + 0.18)));
      vec3 smokeColor = vec3(0.035, 0.046, 0.056) + incident * scatter * 0.18;
      float alpha = 1.0 - (1.0 - fireAlpha) * (1.0 - smokeAlpha);
      vec3 source = flameColor * emission + smokeColor * smokeAlpha * (1.0 - fireAlpha);
      if (!foundLight && (alpha > 0.003 || emission > .0008)) { firstLight = p; foundLight = true; }
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

function fireVolume(seed: string, time: { value: number }, wind: { value: Vector2 }, fire: FireUniforms, quality: QualityLevel) {
  const random = createRandom(`${seed}/flame-volume`);
  const inverse = new Matrix4(), clip = new Matrix4();
  let sceneDepth: SceneDepthField | undefined;
  const material = new ShaderMaterial({
    name: 'raymarched-campfire-and-smoke', transparent: true, premultipliedAlpha: true,
    side: BackSide, depthWrite: false, depthTest: true, fog: true, dithering: true,
    uniforms: UniformsUtils.merge([UniformsLib.fog, {
      uTime: time, uWind: wind, uSteps: { value: STEPS[quality] },
      uSeed: { value: new Vector3(random() * 31, random() * 31, random() * 31) },
      uWorldToLocal: { value: inverse }, uLocalToClip: { value: clip },
      uSceneDepth: { value: null }, uSceneInverseSize: { value: new Vector2(1, 1) },
      uSceneInverseProjection: { value: new Matrix4() }, uSceneCameraWorld: { value: new Matrix4() },
      uSceneDepthEnabled: { value: 0 },
    }]),
    vertexShader: volumeVertex, fragmentShader: volumeFragment,
  });
  // UniformsUtils clones values. Rebind the shared live weather handles once.
  material.uniforms.uTime = time; material.uniforms.uWind = wind;
  Object.assign(material.uniforms, fire);
  material.uniforms.uWorldToLocal = { value: inverse };
  material.uniforms.uLocalToClip = { value: clip };
  const geometry = new BoxGeometry(2.20, 2.63, 1.80).translate(0, 1.335, 0);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'fire-volume'; mesh.renderOrder = 2; mesh.frustumCulled = false;
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
    inverse.copy(mesh.matrixWorld).invert();
    clip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(mesh.matrixWorld);
    material.uniforms.uSceneDepthEnabled!.value = Number(sceneDepth?.available && sceneDepth.camera === camera);
    if (sceneDepth) {
      material.uniforms.uSceneDepth!.value = sceneDepth.texture;
      (material.uniforms.uSceneInverseSize!.value as Vector2).set(1 / sceneDepth.size.x, 1 / sceneDepth.size.y);
      (material.uniforms.uSceneInverseProjection!.value as Matrix4).copy(camera.projectionMatrixInverse);
      (material.uniforms.uSceneCameraWorld!.value as Matrix4).copy(camera.matrixWorld);
    }
    material.uniformsNeedUpdate = true;
  };
  return { mesh, setSceneDepth(field: SceneDepthField) { sceneDepth = field; } };
}

function sparks(seed: string, time: { value: number }, wind: { value: Vector2 }, fire: FireUniforms, quality: QualityLevel): Points<BufferGeometry, ShaderMaterial> {
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
    name: 'generated-flying-fire-embers', transparent: true, depthWrite: false, premultipliedAlpha: true, fog: true,
    uniforms: UniformsUtils.merge([UniformsLib.fog, {
      uTime: time, uWind: wind, uViewport: { value: 1 }, uPixelRatio: { value: 1 },
    }]),
    vertexShader: /* glsl */ `
      uniform float uTime, uViewport, uPixelRatio, uFireHeat;
      uniform vec2 uWind;
      uniform vec3 uFirePosition;
      attribute float aPhase, aLife, aSize;
      varying float vSparkAlpha, vSparkHeat, vSparkAsh;
      #include <fog_pars_vertex>
      void main() {
        float age = fract(uTime / aLife + aPhase);
        vec3 p = position;
        p.y += age * (0.78 + aLife * 0.65);
        p.xz += uWind * age * age * 0.45
          + vec2(sin(age * 8.0 + aPhase * 31.0), cos(age * 7.0 + aPhase * 21.0)) * age * 0.085;
        p.xz += uFirePosition.xz * age;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        float projected = aSize * 0.5 * uViewport * projectionMatrix[1][1] / max(0.1, -mvPosition.z);
        vSparkAsh = step(0.79, aPhase) * smoothstep(0.10, 0.45, age);
        gl_PointSize = clamp(projected * (1.0 + vSparkAsh * 0.6), 0.7 * uPixelRatio, 3.5 * uPixelRatio);
        vSparkAlpha = smoothstep(0.0, 0.10, age) * (1.0 - smoothstep(0.55, 1.0, age))
          * min(1.0, projected / max(0.5, uPixelRatio));
        vSparkHeat = clamp((1.0 - age) * (0.9 + uFireHeat * 0.1), 0.0, 1.0);
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vSparkAlpha, vSparkHeat, vSparkAsh;
      #include <fog_pars_fragment>
      void main() {
        float distanceToCentre = length(gl_PointCoord - 0.5);
        float edge = 1.0 - smoothstep(0.06, 0.49, distanceToCentre);
        if (edge < 0.01) discard;
        vec3 color = mix(vec3(1.2, 0.08, 0.003), vec3(3.2, 1.25, 0.19), vSparkHeat);
        color = mix(color, vec3(0.075, 0.066, 0.054), vSparkAsh);
        float alpha = edge * vSparkAlpha * 0.74;
        #ifdef USE_FOG
          #ifdef FOG_EXP2
            float fogAmount = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          #else
            float fogAmount = smoothstep(fogNear, fogFar, vFogDepth);
          #endif
          alpha *= 1.0 - fogAmount;
        #endif
        gl_FragColor = vec4(color * alpha, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  material.uniforms.uTime = time; material.uniforms.uWind = wind;
  Object.assign(material.uniforms, fire);
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
  /** Stable numeric centroid and total intensity of the two area samples. */
  readonly illumination: Readonly<FireIlluminationState>;
  /** Dominant sample, retained for consumers of a single shadow map. */
  readonly light: PointLight;
  /** Fixed 30/70 energy split, updated from one allocation-free envelope. */
  readonly lights: readonly PointLight[];
  update(frame: EnvironmentSnapshot): void;
  setQuality(quality: QualityLevel): void;
  setSceneDepth(field: SceneDepthField): void;
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
  const combustion = createFireIllumination(seed);
  const illumination = combustion.state;
  const fire: FireUniforms = {
    uFireHeat: { value: illumination.heat }, uFlameHeight: { value: illumination.height },
    uCoalHeat: { value: illumination.coalHeat }, uSmoke: { value: illumination.smoke },
    uFirePosition: { value: new Vector3(illumination.localX, illumination.localY, illumination.localZ) },
    uFireColor: { value: new Color().setRGB(illumination.red, illumination.green, illumination.blue) },
    uFireIntensity: { value: illumination.intensity },
  };
  const random = createRandom(`${seed}/stacked-firewood`);
  const material = fuelMaterial(fire.uCoalHeat);
  group.add(ashBed(seed));
  const placements = [
    [-0.08, 0.13, 0.03, 0.15, 0.03, 0.98, 0.094],
    [0.04, 0.14, -0.15, 2.13, -0.05, 0.88, 0.098],
    [0.05, 0.18, 0.18, -0.77, 0.06, 0.85, 0.084],
    [-0.16, 0.29, 0.00, 0.81, -0.21, 0.82, 0.078],
    [0.17, 0.28, 0.02, -0.92, 0.18, 0.80, 0.075],
    [-0.02, 0.34, -0.06, 1.59, -0.11, 0.65, 0.064],
  ] as const;
  const fuelPieces:BufferGeometry[]=[];
  placements.forEach(([x, y, z, yaw, lean, length, radius], index) => {
    const log = new Mesh(logGeometry(`${seed}/log/${index}`, length, radius), material);
    log.name = `charred-split-log-${index}`;
    log.position.set(x + (random() - 0.5) * 0.025, y, z);
    log.rotation.set((random() - 0.5) * 0.25, yaw, lean);
    log.castShadow = true; log.receiveShadow = true;
    log.updateMatrix();
    log.geometry.applyMatrix4(log.matrix);
    fuelPieces.push(log.geometry);
  });
  const fuelGeometry=mergeGeometries(fuelPieces,false)!;
  fuelPieces.forEach(geometry=>geometry.dispose());
  const fuel=new Mesh(fuelGeometry,material);
  fuel.name='charred-split-log-batch';fuel.castShadow=fuel.receiveShadow=true;group.add(fuel);
  const hearthMaterial = createRainMaterial('stone', `${seed}/hearth`);
  hearthMaterial.vertexColors=true;
  hearthMaterial.color.set('#68685e');
  const stones = new Mesh(stoneAndCoalGeometry(seed, false), hearthMaterial);
  stones.name = 'weathered-hearth-stones'; stones.castShadow = true; stones.receiveShadow = true;
  const coals = new Mesh(stoneAndCoalGeometry(seed, true), emberMaterial(fire.uCoalHeat));
  coals.name = 'banked-ember-bed'; coals.castShadow = false; coals.receiveShadow = true;
  const volume = fireVolume(seed, time, wind, fire, quality);
  const embers = sparks(seed, time, wind, fire, quality);
  const lights = LIGHT_SAMPLES.map(sample => {
    const light = new PointLight(fire.uFireColor.value, illumination.intensity * sample.weight, 9, 2);
    light.position.set(illumination.localX + sample.x, illumination.localY + sample.y, illumination.localZ + sample.z);
    return light;
  });
  lights.forEach((light, i) => {
    light.name = `campfire-area-sample-${i}`; light.castShadow = quality !== 'low';
    light.shadow.camera.near = .055; light.shadow.camera.far = 9;
    light.shadow.camera.layers.set(2); light.shadow.bias = -.00009;
    light.shadow.normalBias = .004; light.shadow.radius = 12;
    light.shadow.mapSize.setScalar(512);
  });
  const coalLight=new PointLight('#ff6625',.45 * illumination.coalHeat,3.1,2);
  coalLight.position.set(.08,.15,.12);
  coalLight.name='ember-bounce';
  group.add(stones, coals, volume.mesh, embers, ...lights, coalLight);
  group.userData.generatedFire = { flameHeight: .98, hearthRadius: 0.86, fixedAssets: 0 };
  return {
    group, illumination, light: lights[1]!, lights,
    setSceneDepth: field => volume.setSceneDepth(field),
    update(frame): void {
      time.value = frame.elapsed;
      wind.value.set(Math.max(-1.5, Math.min(1.5, frame.wind.x)), Math.max(-1.0, Math.min(1.0, frame.wind.z)));
      combustion.update(frame.elapsed, wind.value.x, wind.value.y);
      fire.uFireHeat.value = illumination.heat;
      fire.uFlameHeight.value = illumination.height;
      fire.uCoalHeat.value = illumination.coalHeat;
      fire.uSmoke.value = illumination.smoke;
      fire.uFirePosition.value.set(illumination.localX, illumination.localY, illumination.localZ);
      fire.uFireColor.value.setRGB(illumination.red, illumination.green, illumination.blue);
      fire.uFireIntensity.value = illumination.intensity;
      for (let i = 0; i < lights.length; i += 1) {
        const light = lights[i]!, sample = LIGHT_SAMPLES[i]!;
        light.position.set(illumination.localX + sample.x, illumination.localY + sample.y, illumination.localZ + sample.z);
        light.color.copy(fire.uFireColor.value);
        light.intensity = illumination.intensity * sample.weight;
      }
      coalLight.intensity = .45 * illumination.coalHeat;
    },
    setQuality(next): void {
      (volume.mesh.material as ShaderMaterial).uniforms.uSteps!.value = STEPS[next];
      embers.geometry.setDrawRange(0, SPARKS[next]);
      lights.forEach(light => { light.castShadow = next !== 'low'; });
    },
  };
}
