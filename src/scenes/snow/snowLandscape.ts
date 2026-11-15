import { BufferGeometry, Float32BufferAttribute, Group, Mesh } from 'three';
import type { MeshStandardMaterial } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRandom } from '../../core/random';
import type { QualityLevel } from '../../core/types';
import { mergeStaticMeshes } from './mergeStaticMeshes';
import { createSnowStream } from './snowStream';
import { buildSnowPine } from './forestTrees';
import { createProceduralMaterial } from '../../render/materials/proceduralMaterials';
import type { StreamObstacle } from './snowStream';

export const STREAM_LEVEL = -0.35;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function hash(x: number, z: number): number {
  let value = Math.imul(x, 374761393) + Math.imul(z, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

/** Fixed geographical noise: placement queries and the visible mesh agree. */
export function landNoise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const tx = x - ix, tz = z - iz;
  const ux = tx * tx * (3 - 2 * tx), uz = tz * tz * (3 - 2 * tz);
  const a = hash(ix, iz) * (1 - ux) + hash(ix + 1, iz) * ux;
  const b = hash(ix, iz + 1) * (1 - ux) + hash(ix + 1, iz + 1) * ux;
  return a * (1 - uz) + b * uz;
}

/** A coherent valley, not an independently perturbed ribbon. Distances are metres. */
export function streamCenter(z: number): number {
  return 1.2 + 3.7 * Math.sin((z + 7) * 0.065) + 1.3 * Math.sin((z - 3) * 0.14);
}

export function streamHalfWidth(z: number): number {
  return 1.05 + 1.95 * smoothstep(-80, 23, z)
    + 0.23 * Math.sin(z * 0.17 + 0.4) + 0.10 * Math.sin(z * 0.53);
}

/** Independent bank erosion prevents a uniform extruded canal silhouette. */
export function streamBankOffset(z: number, side: number): number {
  const shift = side < 0 ? 17.3 : 83.6;
  const erosion = (landNoise(z * 0.26 + shift, shift * 1.7) - 0.5) * 1.35
    + (landNoise(z * 0.85 + shift * 2.7, shift * 0.4) - 0.5) * 0.28
    + (landNoise(z * 2.3 + shift, shift * 3.8) - 0.5) * 0.075;
  return Math.max(0.92 - streamHalfWidth(z), erosion * Math.min(1, streamHalfWidth(z) * 0.5));
}

const LEFT_CUTS = [[6.5, 3.2], [-6, 2.5], [-22, 4.0]] as const;
const RIGHT_CUTS = [[10.0, 3.4], [-1.5, 3.0], [-16, 4.2]] as const;

/** Short eroded stretches alternate with banks carrying an intact snow duvet. */
function bankCut(z: number, side: number): number {
  let cut = 0;
  for (const [centre, spread] of side < 0 ? LEFT_CUTS : RIGHT_CUTS) {
    cut = Math.max(cut, Math.exp(-(((z - centre) / spread) ** 2)));
  }
  return cut;
}

export function terrainHeight(x: number, z: number): number {
  const side = x < streamCenter(z) ? -1 : 1;
  const distance = Math.abs(x - streamCenter(z)) - streamHalfWidth(z) - streamBankOffset(z, side);
  const large = landNoise(x * 0.075 + 19.4, z * 0.063 + 13.7);
  const drift = landNoise(x * 0.24 + 48.7, z * 0.19 - 17.3);
  const wind = landNoise(x * 0.75, z * 0.62);
  const valleySide = smoothstep(2, 34, Math.abs(x - streamCenter(z)));
  const distantRise = smoothstep(-32, -124, z);
  const ground = 0.13 + large * 0.74 + drift * 0.41 + wind * 0.09
    + valleySide * (0.7 + distantRise * 6.8)
    + Math.exp(-((x + 17) ** 2 / 115 + (z + 31) ** 2 / 340)) * 1.2
    + Math.exp(-((x - 24) ** 2 / 210 + (z + 65) ** 2 / 600)) * 2.0;
  const bankRipple = (landNoise(x * 1.7 + 63, z * 1.15) - 0.5) * 0.12;
  const softness = landNoise(z * 0.41 + (side < 0 ? 16 : 97), 73.6);
  const cut = bankCut(z, side) * 0.45;
  const bankStart = -0.72 + cut * 0.30;
  const bankEnd = (1.1 + softness * 1.35) * (1 - cut) + (0.84 + softness * 0.22) * cut;
  const bank = smoothstep(bankStart, bankEnd, distance + bankRipple);
  const bed = -0.94 + landNoise(x * 0.4, z * 0.5) * 0.12;
  const settledDrifts = (landNoise(x * 0.64 + 33.2, z * 0.46 + 22.1) - 0.5) * 0.22
    + (landNoise(x * 1.4 - 3.1, z * 0.82 + 16.7) - 0.5) * 0.07;
  const nearBank = 1 - smoothstep(6, 13, distance);
  return bed + (ground - bed) * bank
    + smoothstep(0.4, 2.3, distance) * settledDrifts * nearBank
    + smoothstep(0.3, 2, distance) * (landNoise(x * 1.45, z * 1.28) - 0.5) * 0.044
    + smoothstep(0.7, 3, distance) * smoothstep(-40, -12, z)
      * (landNoise(x * 3.8, z * 2.7) - 0.5) * 0.014;
}

/** Actual water/land intersection; reflections may safely overlap it by 20 cm. */
export function streamShoreline(z: number, side: number): number {
  const centre = streamCenter(z);
  let inside = streamHalfWidth(z) + streamBankOffset(z, side) - 1;
  let outside = inside + 4;
  for (let i = 0; i < 12; i += 1) {
    const middle = (inside + outside) * 0.5;
    if (terrainHeight(centre + side * middle, z) < STREAM_LEVEL) inside = middle;
    else outside = middle;
  }
  return centre + side * (inside + outside) * 0.5;
}

function makeTerrain(): BufferGeometry {
  // Most triangles describe the nearby snow lip. Broad outer slopes do not
  // need the same sample spacing as a 20 cm rolled edge over an eroded bank.
  const sections = [36, 72, 24, 72, 36] as const;
  const crossSegments = sections.reduce((sum, count) => sum + count, 0);
  const rows: number[] = [];
  for (const [from, to, count] of [[38, 22, 32], [22, -12, 170], [-12, -45, 132], [-45, -144, 66]] as const) {
    for (let i = 0; i < count; i += 1) rows.push(from + (to - from) * i / count);
  }
  rows.push(-144);
  const lengthSegments = rows.length - 1;
  const positions: number[] = [], indices: number[] = [];
  for (let row = 0; row <= lengthSegments; row += 1) {
    const z = rows[row]!;
    const centre = streamCenter(z);
    const leftWidth = streamHalfWidth(z) + streamBankOffset(z, -1);
    const rightWidth = streamHalfWidth(z) + streamBankOffset(z, 1);
    const breaks = [centre - 75, centre - leftWidth - 3.4,
      centre - leftWidth + Math.min(0.9, leftWidth * 0.7),
      centre + rightWidth - Math.min(0.9, rightWidth * 0.7),
      centre + rightWidth + 3.4, centre + 75];
    const rowX: number[] = [breaks[0]!];
    for (let section = 0; section < sections.length; section += 1) {
      const count = sections[section]!;
      for (let i = 1; i <= count; i += 1) {
        const t = i / count;
        // A gradual density change prevents large diagonal facets immediately
        // behind the fine bank mesh. Outer ground becomes coarse only far away.
        const spacing = section === 0 ? 1 - (1 - t) ** 2.35 : section === 4 ? t ** 2.35 : t;
        rowX.push(breaks[section]! + (breaks[section + 1]! - breaks[section]!) * spacing);
      }
    }
    for (let column = 0; column <= crossSegments; column += 1) {
      const x = rowX[column]!;
      positions.push(x, terrainHeight(x, z), z);
      if (row < lengthSegments && column < crossSegments) {
        const a = row * (crossSegments + 1) + column;
        const b = a + 1, c = a + crossSegments + 1, d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** The earth exposed by erosion belongs to the continuous terrain itself. */
function makeTerrainMaterial(seed: string): MeshStandardMaterial {
  const material = createProceduralMaterial('snow', `${seed}/terrain-snow`);
  const compileSurface = material.onBeforeCompile;
  const cacheKey = material.customProgramCacheKey;
  material.name = 'procedural-snow-over-eroded-earth';
  material.onBeforeCompile = (shader, renderer) => {
    compileSurface.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        float yyjBankGaussian(float z, float centre, float spread) {
          float d = (z - centre) / spread;
          return exp(-d * d);
        }
      `)
      .replace('#include <alphatest_fragment>', /* glsl */ `
        #include <alphatest_fragment>
        vec3 yyjBankP = vYyjWorldPosition;
        float yyjCentre = 1.2 + 3.7 * sin((yyjBankP.z + 7.0) * 0.065)
          + 1.3 * sin((yyjBankP.z - 3.0) * 0.14);
        float yyjWidth = 1.05 + 1.95 * smoothstep(-80.0, 23.0, yyjBankP.z)
          + 0.23 * sin(yyjBankP.z * 0.17 + 0.4) + 0.10 * sin(yyjBankP.z * 0.53);
        float yyjLeftCut = max(yyjBankGaussian(yyjBankP.z, 6.5, 3.2),
          max(yyjBankGaussian(yyjBankP.z, -6.0, 2.5), yyjBankGaussian(yyjBankP.z, -22.0, 4.0)));
        float yyjRightCut = max(yyjBankGaussian(yyjBankP.z, 10.0, 3.4),
          max(yyjBankGaussian(yyjBankP.z, -1.5, 3.0), yyjBankGaussian(yyjBankP.z, -16.0, 4.2)));
        float yyjCut = mix(yyjLeftCut, yyjRightCut, step(yyjCentre, yyjBankP.x));
        float yyjBankBand = 1.0 - smoothstep(0.6, 1.5, abs(abs(yyjBankP.x - yyjCentre) - yyjWidth));
        float yyjEarthMottle = yyjFbm(yyjBankP * vec3(3.7, 7.5, 3.7) + uYyjSeedOffset);
        float yyjEarthFine = mix(0.5, yyjNoise(yyjBankP * 75.0 + uYyjSeedOffset), yyjDetailFade);
        // Snow hangs down over most of the face. Only short, low, separated
        // patches of damp earth show near water; a jagged dark wall is avoided.
        float yyjSnowLip = -0.12 + yyjNoise(yyjBankP * vec3(1.9, 0.0, 1.4) + uYyjSeedOffset) * 0.10;
        float yyjEarthBreakup = smoothstep(0.31, 0.59,
          yyjNoise(yyjBankP * vec3(1.8, 0.0, 1.1) + uYyjSeedOffset * 0.7));
        float yyjEarthMask = smoothstep(0.72, 0.94, yyjCut) * yyjBankBand
          * (1.0 - smoothstep(yyjSnowLip - 0.06, yyjSnowLip + 0.06, yyjBankP.y))
          * smoothstep(-0.68, -0.44, yyjBankP.y) * yyjEarthBreakup * 0.84;
        float yyjWetEarth = 1.0 - smoothstep(-0.28, 0.16, yyjBankP.y);
        vec3 yyjEarthColor = vec3(0.13, 0.14, 0.13)
          * (0.78 + yyjEarthMottle * 0.40 + (yyjEarthFine - 0.5) * 0.16)
          * (1.0 - yyjWetEarth * 0.18);
        diffuseColor.rgb = mix(diffuseColor.rgb, yyjEarthColor, yyjEarthMask);
        yyjHeight = mix(yyjHeight, (yyjEarthMottle - 0.5) * 0.035
          + (yyjEarthFine - 0.5) * 0.003, yyjEarthMask);
        yyjRoughness = mix(yyjRoughness, -0.16 - yyjWetEarth * 0.19, yyjEarthMask);
      `);
  };
  material.customProgramCacheKey = () => `${cacheKey.call(material)}/eroded-bank-v3`;
  return material;
}

interface RockShape {
  width: number;
  depth: number;
  height: number;
  phase: number;
  snowDepth: number;
  angularity?: number;
}

function rockRadius(angle: number, phase: number): number {
  return 1 + 0.105 * Math.sin(angle * 3 + phase)
    + 0.048 * Math.sin(angle * 5 - phase * 0.7)
    + 0.014 * Math.sin(angle * 11 + phase * 1.3);
}

function softMinimum(a: number, b: number, radius: number): number {
  const overlap = Math.max(0, radius - Math.abs(a - b)) / radius;
  return Math.min(a, b) - overlap * overlap * radius * 0.25;
}

/** Water-rounded fracture faces and centimetre-scale erosion share one surface. */
function rockTop(u: number, v: number, radial: number, shape: RockShape): number {
  const p = shape.phase;
  const angularity = shape.angularity ?? 0.45;
  const dome = 0.20 + Math.pow(Math.max(0, 1 - radial * radial), 0.51) * 0.80;
  const shoulder = 0.13 * Math.exp(-((u + 0.31) ** 2 / 0.21 + (v - 0.15) ** 2 / 0.34))
    - 0.08 * Math.exp(-((u - 0.27) ** 2 / 0.13 + (v + 0.22) ** 2 / 0.18));
  let top = dome + shoulder + u * 0.075 - v * 0.045;
  const rounding = 0.13 - angularity * 0.045;
  top = softMinimum(top, 1.02 + u * (0.16 + angularity * 0.20) - v * 0.21, rounding);
  top = softMinimum(top, 1.10 - u * 0.28 + v * 0.16, rounding);
  top = softMinimum(top, 1.08 + v * 0.27 + Math.sin(p) * 0.08, rounding);
  const erosion = (landNoise(u * 2.8 + p, v * 3.4 + 37) - 0.5) * 0.14
    + (landNoise(u * 7.7 + 9, v * 7.3 + p) - 0.5) * 0.045;
  const fracture = smoothstep(-0.06, 0.10, u + v * 0.36 - 0.21) * angularity * 0.045;
  return (top + erosion - fracture) * shape.height;
}

function rockGeometry(shape: RockShape, snow: boolean, detail: 'hero' | 'near' | 'far'): BufferGeometry {
  const rings = detail === 'hero' ? 32 : detail === 'near' ? 20 : 9;
  const sectors = detail === 'hero' ? 112 : detail === 'near' ? 64 : 28;
  const detailed = detail !== 'far';
  const positions: number[] = [], indices: number[] = [];
  const p = shape.phase;
  const angularity = shape.angularity ?? 0.45;
  for (let ring = 0; ring <= rings; ring += 1) {
    const ringFraction = ring / rings;
    const s = snow ? 1 - (1 - ringFraction) ** 1.6 : ringFraction;
    for (let sector = 0; sector <= sectors; sector += 1) {
      const angle = sector / sectors * Math.PI * 2;
      const snowEdge = 0.79 + 0.10 * Math.cos(angle - p)
        + 0.043 * Math.sin(angle * 3 + p) + 0.022 * Math.sin(angle * 7 - p);
      const radial = s * (snow ? snowEdge : 1);
      const power = 2 + angularity * 1.5;
      const brokenOutline = Math.pow(Math.abs(Math.cos(angle)) ** power + Math.abs(Math.sin(angle)) ** power, -1 / power);
      const outline = rockRadius(angle, p) * brokenOutline;
      const u = Math.cos(angle) * radial * outline;
      const v = Math.sin(angle) * radial * outline;
      let y = rockTop(u, v, radial, shape);
      if (snow) {
        // Accumulation follows the broken top instead of creating a white
        // hemisphere. The final lip rolls down into the actual rock surface.
        const sampleRadius = 0.085;
        const softened = (rockTop(u + sampleRadius, v, radial, shape)
          + rockTop(u - sampleRadius, v, radial, shape)
          + rockTop(u, v + sampleRadius, radial, shape)
          + rockTop(u, v - sampleRadius, radial, shape) + y * 2) / 6;
        // A rounded mass rolls into the rock along its edge. The previous
        // zero-slope taper looked like a polygon painted flat onto the boulder.
        const powder = Math.pow(Math.max(0, 1 - s * s), 0.48);
        const drift = 0.78 + landNoise(u * 3.7 + p, v * 3.2 + 53) * 0.38;
        const edge = smoothstep(0.96, 1, s);
        y = Math.max(y, softened) + (shape.snowDepth * drift + 0.014) * powder - 0.012 * edge;
      }
      positions.push(u * shape.width * 0.5, y, v * shape.depth * 0.5);
      if (ring < rings && sector < sectors) {
        const a = ring * (sectors + 1) + sector;
        const b = a + 1, c = a + sectors + 1, d = c + 1;
        if (ring === 0) indices.push(a, d, c);
        else indices.push(a, b, c, b, d, c);
      }
    }
  }
  if (!snow) {
    // Distinct water-worn sides continue below the waterline. A truncated,
    // offset lower wall replaces the original single conical underside.
    let previous = rings * (sectors + 1);
    const sideLevels = detailed ? 2 : 1;
    for (let level = 1; level <= sideLevels; level += 1) {
      const next = positions.length / 3;
      const t = level / sideLevels;
      for (let sector = 0; sector <= sectors; sector += 1) {
        const source = (rings * (sectors + 1) + sector) * 3;
        const x = positions[source]!, z = positions[source + 2]!;
        const edge = 1 - t * (0.06 + 0.07 * Math.sin(p + sector * 0.37));
        positions.push(x * edge + t * shape.width * 0.045,
          positions[source + 1]! * (1 - t) - shape.height * 0.46 * t,
          z * edge - t * shape.depth * 0.025);
        if (sector < sectors) {
          const a = previous + sector, b = a + 1, c = next + sector, d = c + 1;
          indices.push(a, b, c, b, d, c);
        }
      }
      previous = next;
    }
    const bottom = positions.length / 3;
    positions.push(0, -shape.height * 0.46, 0);
    const lastRing = previous;
    for (let sector = 0; sector < sectors; sector += 1) {
      indices.push(bottom, lastRing + sector, lastRing + sector + 1);
    }
  }
  const raw = new BufferGeometry();
  raw.setAttribute('position', new Float32BufferAttribute(positions, 3));
  raw.setIndex(indices);
  const geometry = mergeVertices(raw, 0.00001);
  raw.dispose();
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function addRock(group: Group, materials: { snow: MeshStandardMaterial; stone: MeshStandardMaterial },
  x: number, z: number, shape: RockShape, angle: number, embedded = 0.2): void {
  const detail = z > 7 && shape.width > 2.4 ? 'hero' : z > -22 && shape.width > 1.1 ? 'near' : 'far';
  const base = terrainHeight(x, z) - shape.height * embedded;
  const side = x < streamCenter(z) ? -1 : 1;
  const touchesWater = Math.abs(x - streamShoreline(z, side)) < shape.width * 0.42;
  const y = touchesWater ? Math.min(base, STREAM_LEVEL + shape.height * 0.38) : base;
  const rock = new Mesh(rockGeometry(shape, false, detail), materials.stone);
  const snow = new Mesh(rockGeometry(shape, true, detail), materials.snow);
  for (const mesh of [rock, snow]) {
    mesh.position.set(x, y, z);
    mesh.rotation.y = angle;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

function buildBanks(seed: string, materials: { snow: MeshStandardMaterial; stone: MeshStandardMaterial }) {
  const group = new Group();
  group.name = 'weathered-stream-bank-boulders';
  const random = createRandom(`${seed}/stream-geology`);
  const obstacles: StreamObstacle[] = [];

  // A few asymmetrical outcrops provide foreground scale. Their bases sit in
  // terrain; repeated small stones never outline the whole river like a curb.
  const heroRocks: ReadonlyArray<readonly [number, number, number, number, number]> = [
    [12.2, 1, 3.3, 1.55, 1.02], [9.5, 1, 1.65, 1.1, 0.58],
    [5.1, -1, 2.8, 1.7, 1.1], [1.4, -1, 1.45, 1.18, 0.64],
    [-7.9, 1, 3.6, 2.15, 1.6], [-11.3, 1, 1.55, 1.1, 0.71],
    [-17.1, -1, 2.85, 2.2, 1.32], [-26.5, -1, 1.5, 2.4, 0.8],
    [-35.3, 1, 3.7, 2.4, 1.7], [-48.6, -1, 2.5, 1.9, 1.1],
  ];
  for (const [z, side, width, depth, height] of heroRocks) {
    const x = streamCenter(z) + side * (streamHalfWidth(z) + streamBankOffset(z, side) + width * 0.1);
    addRock(group, materials, x, z, { width, depth, height, phase: random() * 43,
      snowDepth: 0.07 + random() * 0.085, angularity: 0.35 + random() * 0.40 },
    z === 12.2 ? 0.63 : random() * 6.28, 0.19);
  }
  for (let i = 0; i < 65; i += 1) {
    const z = 24 - random() * 121;
    const side = random() < 0.5 ? -1 : 1;
    const size = 0.28 + random() ** 2 * 1.05;
    const bankOffset = -0.15 + random() ** 1.6 * 1.55;
    const x = streamCenter(z) + side * (streamHalfWidth(z) + streamBankOffset(z, side) + bankOffset);
    addRock(group, materials, x, z, {
      width: size * (1.05 + random() * 0.8),
      depth: size * (0.8 + random() * 0.9),
      height: size * (0.45 + random() * 0.44),
      phase: random() * 83,
      snowDepth: 0.035 + size * (0.07 + random() * 0.1),
      angularity: random(),
    }, random() * 6.28, 0.12 + random() * 0.3);
  }

  // Eroded pockets contain clustered broken stone rather than a necklace of
  // evenly spaced boulders. Some ledges emerge from beneath the snow cornice.
  for (const [centreZ, side] of [[18.5, -1], [14, 1], [6.2, 1], [-1.2, -1], [-14.4, 1], [-23, -1]] as const) {
    for (let i = 0; i < 4; i += 1) {
      const z = centreZ + (random() - 0.5) * 3.7;
      const x = streamCenter(z) + side * (streamHalfWidth(z) + streamBankOffset(z, side) - 0.45 + (random() - 0.5) * 0.4);
      const size = 0.28 + random() * 0.65;
      addRock(group, materials, x, z, { width: size * (1.1 + random() * 0.9),
        depth: size * (0.7 + random() * 0.6), height: size * (0.45 + random() * 0.6),
        phase: random() * 91, snowDepth: 0.022 + random() * 0.06,
        angularity: 0.3 + random() * 0.7,
      }, random() * 6.28, 0.17);
    }
  }

  // Sparse exposed streambed stones give the current something to flow around.
  for (let i = 0; i < 12; i += 1) {
    const z = 15 - random() * 68;
    const x = streamCenter(z) + (random() * 2 - 1) * streamHalfWidth(z) * 0.65;
    const size = 0.5 + random() * 0.7;
    addRock(group, materials, x, z, { width: size * 1.3, depth: size, height: 0.6 + size * 0.28,
      phase: random() * 91, snowDepth: 0.035 + random() * 0.05, angularity: random() * 0.6 }, random() * 6.28, 0);
    obstacles.push({ x, z, radius: size * 0.45 });
  }
  mergeStaticMeshes(group, new Set());
  return { group, obstacles };
}

function distantHillHeight(x: number, z: number): number {
  const join = smoothstep(-142, -161, z);
  const rightShoulder = 36 * Math.exp(-((x - 57) ** 2 / 2400 + (z + 188) ** 2 / 3600));
  const farSpur = 14 * Math.exp(-((x - 98) ** 2 / 3100 + (z + 242) ** 2 / 2300));
  const leftShoulder = 11 * Math.exp(-((x + 110) ** 2 / 3600 + (z + 219) ** 2 / 2500));
  const broadRelief = 0.88 + landNoise(x * 0.037 + 47, z * 0.042) * 0.20;
  const gullies = (landNoise(x * 0.11 + 27, z * 0.083) - 0.5) * 1.1;
  return terrainHeight(x, z) + join * ((rightShoulder + farSpur + leftShoulder) * broadRelief + gullies);
}

/** A low, asymmetrical enclosing ridge keeps an open sky gap above the stream. */
function buildDistantHills(seed: string, materials: {
  snow: MeshStandardMaterial;
  bark?: MeshStandardMaterial;
  needles?: MeshStandardMaterial;
}): Group {
  const group = new Group();
  group.name = 'distant-snow-valley';
  const xSegments = 136, zSegments = 88;
  const positions: number[] = [], indices: number[] = [];
  for (let row = 0; row <= zSegments; row += 1) {
    const z = -142 - row / zSegments * 148;
    for (let column = 0; column <= xSegments; column += 1) {
      const x = -170 + column / xSegments * 360;
      positions.push(x, distantHillHeight(x, z), z);
      if (row < zSegments && column < xSegments) {
        const a = row * (xSegments + 1) + column;
        const b = a + 1, c = a + xSegments + 1, d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const hillside = new Mesh(geometry, materials.snow);
  hillside.name = 'distant-snow-hillside';
  // Beyond the near shadow cascade; distance fog supplies aerial perspective.
  hillside.castShadow = false;
  hillside.receiveShadow = false;
  group.add(hillside);

  if (materials.bark && materials.needles) {
    const trees = new Group();
    trees.name = 'distant-ridge-pines';
    for (const [x, z, scale] of [[36, -159, 1.03], [63, -180, 1.28], [89, -207, 0.91]] as const) {
      const tree = buildSnowPine(`${seed}/distant-ridge/${x}`, {
        snow: materials.snow, bark: materials.bark, needles: materials.needles,
      }, 'far');
      tree.position.set(x, distantHillHeight(x, z) - 0.1, z);
      tree.scale.set(scale * 0.91, scale, scale);
      tree.rotation.y = x * 0.81;
      tree.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.castShadow = false;
        object.receiveShadow = false;
      });
      trees.add(tree);
    }
    mergeStaticMeshes(trees, new Set());
    group.add(trees);
  }
  return group;
}

/** A traversable-scale valley: geometry, water and sediment all share one bank. */
export function buildSnowLandscape(seed: string,
  materials: { snow: MeshStandardMaterial; stone: MeshStandardMaterial;
    bark?: MeshStandardMaterial; needles?: MeshStandardMaterial }, quality: QualityLevel) {
  const group = new Group();
  group.name = 'snow-valley-landscape';
  const ground = new Mesh(makeTerrain(), makeTerrainMaterial(seed));
  ground.name = 'continuous-snow-terrain';
  ground.castShadow = false;
  ground.receiveShadow = true;
  const banks = buildBanks(seed, materials);
  const water = createSnowStream(seed, quality, banks.obstacles);
  group.add(ground, banks.group, buildDistantHills(seed, materials), water.mesh);
  return { group, water };
}
