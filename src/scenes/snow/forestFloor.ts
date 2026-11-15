import { BufferGeometry, Float32BufferAttribute, Group, Mesh, Vector3 } from 'three';
import type { MeshStandardMaterial } from 'three';
import { createRandom, hashSeed } from '../../core/random';
import { landNoise, streamBankOffset, streamCenter, streamHalfWidth, terrainHeight } from './snowLandscape';

interface FloorMaterials {
  bark: MeshStandardMaterial;
  snow: MeshStandardMaterial;
  wood: MeshStandardMaterial;
}

class Surface {
  readonly positions: number[] = [];
  readonly indices: number[] = [];
  point(p: Vector3): number {
    const index = this.positions.length / 3;
    this.positions.push(p.x, p.y, p.z);
    return index;
  }
  triangle(a: number, b: number, c: number): void { this.indices.push(a, b, c); }
  geometry(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

const UP = new Vector3(0, 1, 0);
const TAU = Math.PI * 2;
type Curve = (t: number) => Vector3;

/** Physical curved stems and broken limbs, with taper and a closed tip. */
function stem(surface: Surface, curve: Curve, radius: number, rings: number, sides: number,
  phase: number, taper = 0.05): void {
  const first = surface.positions.length / 3;
  for (let row = 0; row <= rings; row += 1) {
    const t = row / rings;
    const p = curve(t);
    const tangent = curve(Math.min(1, t + 0.002)).sub(curve(Math.max(0, t - 0.002))).normalize();
    const side = tangent.clone().cross(UP);
    if (side.lengthSq() < 0.001) side.set(1, 0, 0);
    side.normalize();
    const normal = side.clone().cross(tangent).normalize();
    for (let sector = 0; sector < sides; sector += 1) {
      const angle = sector / sides * TAU;
      const rr = radius * (taper + (1 - taper) * (1 - t) ** 0.82)
        * (1 + 0.05 * Math.sin(angle * 3 + t * 7 + phase));
      surface.point(p.clone().addScaledVector(side, Math.cos(angle) * rr)
        .addScaledVector(normal, Math.sin(angle) * rr));
    }
  }
  for (let row = 0; row < rings; row += 1) for (let sector = 0; sector < sides; sector += 1) {
    const a = first + row * sides + sector, b = first + row * sides + (sector + 1) % sides;
    surface.triangle(a, a + sides, b);
    surface.triangle(b, a + sides, b + sides);
  }
  for (const end of [0, 1]) {
    const centre = surface.point(curve(end));
    const ring = first + end * rings * sides;
    for (let sector = 0; sector < sides; sector += 1) {
      const a = ring + sector, b = ring + (sector + 1) % sides;
      if (end === 0) surface.triangle(centre, a, b);
      else surface.triangle(centre, b, a);
    }
  }
}

function endgrainMaterial(source: MeshStandardMaterial, centre: Vector3, side: Vector3,
  up: Vector3, seed: string): MeshStandardMaterial {
  const material = source.clone();
  material.name = 'generated-weathered-endgrain';
  material.color.set('#8a7b64');
  material.roughness = 0.97;
  const previousCompile = source.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.uFloorEndCentre = { value: centre };
    shader.uniforms.uFloorEndSide = { value: side };
    shader.uniforms.uFloorEndUp = { value: up };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFloorEndWorld;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vFloorEndWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vFloorEndWorld;
        uniform vec3 uFloorEndCentre, uFloorEndSide, uFloorEndUp;`)
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        vec3 endOffset = vFloorEndWorld - uFloorEndCentre;
        vec2 endUv = vec2(dot(endOffset, uFloorEndSide), dot(endOffset, uFloorEndUp));
        float endRadius = length(endUv);
        float endAngle = atan(endUv.y, endUv.x);
        float growth = endRadius * (76.0 + 3.0 * sin(endAngle * 3.0))
          + 0.23 * sin(endAngle * 5.0 + endRadius * 7.0)
          + 0.075 * sin(endAngle * 13.0 - endRadius * 19.0);
        float lateWood = smoothstep(0.34, 0.45, abs(fract(growth) - 0.5));
        float age = 0.5 + 0.5 * sin(endUv.x * 13.0 + sin(endUv.y * 9.0));
        float splits = pow(max(0.0, cos(endAngle * 5.0 + 0.7)), 80.0)
          * smoothstep(0.07, 0.24, endRadius);
        diffuseColor.rgb *= (0.91 - lateWood * 0.17 + age * 0.08) * (1.0 - splits * 0.58);
      `);
  };
  material.customProgramCacheKey = () => `yyj-weathered-endgrain/${hashSeed(seed)}/${source.customProgramCacheKey()}`;
  return material;
}

/** One half-buried fallen trunk with gravity-aligned accumulation and a split end. */
function fallenLog(group: Group, bark: Surface, snow: Surface, materials: FloorMaterials,
  seed: string): void {
  const random = createRandom(`${seed}/fallen-log`);
  const phase = random() * TAU;
  const a = new Vector3(-5.1, 0, -1.1), b = new Vector3(-0.75, 0, 3.15);
  a.y = terrainHeight(a.x, a.z) + 0.015;
  b.y = terrainHeight(b.x, b.z) + 0.035;
  const axis = b.clone().sub(a).normalize();
  const side = axis.clone().cross(UP).normalize();
  const up = side.clone().cross(axis).normalize();
  const centre = (t: number): Vector3 => a.clone().lerp(b, t)
    .addScaledVector(up, Math.sin(t * Math.PI) * 0.095)
    .addScaledVector(side, Math.sin(t * Math.PI) * 0.075);
  const radius = (t: number, angle: number): number => (0.335 - t * 0.083)
    * (1 + 0.075 * Math.sin(angle * 5 + phase + t * 0.8)
      + 0.046 * Math.sin(angle * 11 - t * 4.2 + phase)
      + 0.019 * Math.sin(angle * 29 + t * 16))
    + (landNoise(t * 14 + phase, angle * 3.8 + 51) - 0.5) * 0.014;
  const edgeShift = (end: number, angle: number): number => (end ? 1 : -1)
    * (0.025 + 0.052 * Math.sin(angle * 7 + phase) + 0.030 * Math.sin(angle * 13 - phase));
  const rings = 62, sectors = 64;
  const first = bark.positions.length / 3;
  for (let row = 0; row <= rings; row += 1) {
    const t = row / rings;
    for (let sector = 0; sector < sectors; sector += 1) {
      const angle = sector / sectors * TAU;
      const rr = radius(t, angle);
      const fractured = edgeShift(0, angle) * Math.exp(-t * 40)
        + edgeShift(1, angle) * Math.exp(-(1 - t) * 40);
      bark.point(centre(t).addScaledVector(side, Math.cos(angle) * rr)
        .addScaledVector(up, Math.sin(angle) * rr).addScaledVector(axis, fractured));
    }
  }
  for (let row = 0; row < rings; row += 1) for (let sector = 0; sector < sectors; sector += 1) {
    const aa = first + row * sectors + sector, bb = first + row * sectors + (sector + 1) % sectors;
    bark.triangle(aa, aa + sectors, bb);
    bark.triangle(bb, aa + sectors, bb + sectors);
  }
  const buriedEnd = bark.point(centre(0).addScaledVector(axis, -0.035));
  for (let sector = 0; sector < sectors; sector += 1) {
    bark.triangle(buriedEnd, first + sector, first + (sector + 1) % sectors);
  }

  // The front is broken, not a flat sawn disc. Warped concentric fibres share
  // the trunk's ragged rim, while the centre recedes a few centimetres.
  const end = new Surface();
  const capRings = 16;
  for (let row = 0; row <= capRings; row += 1) {
    const s = row / capRings;
    for (let sector = 0; sector <= sectors; sector += 1) {
      const angle = sector / sectors * TAU;
      const rr = radius(1, angle) * s;
      const crack = Math.max(0, Math.cos(angle * 5 + 0.7)) ** 80;
      const depth = edgeShift(1, angle) * s ** 2 - 0.038 * (1 - s)
        + Math.sin(s * 13 + angle * 3 + phase) * 0.006 * s
        - crack * 0.025 * s;
      end.point(centre(1).addScaledVector(side, Math.cos(angle) * rr)
        .addScaledVector(up, Math.sin(angle) * rr).addScaledVector(axis, depth));
      if (row < capRings && sector < sectors) {
        const aa = row * (sectors + 1) + sector;
        const bb = aa + 1, cc = aa + sectors + 1, dd = cc + 1;
        if (row === 0) end.triangle(aa, dd, cc);
        else { end.triangle(aa, bb, cc); end.triangle(bb, dd, cc); }
      }
    }
  }
  const endMesh = new Mesh(end.geometry(), endgrainMaterial(materials.wood, centre(1), side, up, seed));
  endMesh.name = 'split-fallen-trunk-end';
  endMesh.castShadow = true;
  endMesh.receiveShadow = true;
  group.add(endMesh);

  // A continuous, soft gravity-aligned ridge, with uneven margins and a rounded
  // lip. It leaves the fractured end and a band of damp lower bark exposed.
  const snowRows = 64, snowColumns = 24;
  const snowFirst = snow.positions.length / 3;
  for (let row = 0; row <= snowRows; row += 1) {
    const t = 0.025 + row / snowRows * 0.925;
    const endFade = Math.sin(row / snowRows * Math.PI) ** 0.22;
    const drift = 0.10 + 0.035 * Math.sin(t * 8 + phase) + 0.018 * Math.sin(t * 23 - phase);
    for (let column = 0; column <= snowColumns; column += 1) {
      const q = column / snowColumns * 2 - 1;
      const extent = 1.40 + Math.sin(t * 17 + phase + q * 2) * 0.065;
      const angle = q * extent;
      const barkAngle = Math.PI / 2 - angle;
      const rr = radius(t, barkAngle);
      const width = rr * 1.018;
      const cap = Math.max(0, Math.cos(angle));
      const y = Math.cos(angle) * rr + drift * cap ** 0.7 * endFade + 0.006;
      snow.point(centre(t).addScaledVector(side, Math.sin(angle) * width)
        .addScaledVector(up, y));
      if (row < snowRows && column < snowColumns) {
        const aa = snowFirst + row * (snowColumns + 1) + column;
        const bb = aa + 1, cc = aa + snowColumns + 1, dd = cc + 1;
        snow.triangle(aa, bb, cc);
        snow.triangle(bb, dd, cc);
      }
    }
  }

  for (const [t, reach, lean] of [[0.27, 0.87, -1], [0.63, 0.62, 1]] as const) {
    const origin = centre(t).addScaledVector(up, 0.13);
    const curve = (u: number): Vector3 => origin.clone()
      .addScaledVector(side, u * reach * lean)
      .addScaledVector(up, Math.sin(u * 1.5) * 0.36)
      .addScaledVector(axis, -u * 0.25);
    stem(bark, curve, t < 0.5 ? 0.068 : 0.046, 9, 9, phase + t, 0.24);
  }
  for (let i = 0; i < 7; i += 1) {
    const angle = random() * TAU;
    const p = centre(1).addScaledVector(side, Math.cos(angle) * radius(1, angle) * 0.94)
      .addScaledVector(up, Math.sin(angle) * radius(1, angle) * 0.94);
    const length = 0.055 + random() * 0.105;
    stem(bark, t => p.clone().addScaledVector(axis, t * length)
      .addScaledVector(up, -0.035 * t * t), 0.010 + random() * 0.008, 3, 4, phase + i);
  }
}

/** Sparse clustered stalks preserve broad areas of undisturbed snow. */
function winterUndergrowth(surface: Surface, seed: string): void {
  const random = createRandom(`${seed}/exposed-winter-stems`);
  for (const [z, side, offset, count] of [[7.3, -1, 0.95, 12], [10.4, 1, 1.18, 9],
    [-6.7, -1, 1.0, 13], [-15.9, 1, 0.85, 9]] as const) {
    const bankX = streamCenter(z) + side * (streamHalfWidth(z) + streamBankOffset(z, side) + offset);
    for (let i = 0; i < count; i += 1) {
      const angle = random() * TAU, distance = random() ** 1.7 * 0.42;
      const x = bankX + Math.cos(angle) * distance, zz = z + Math.sin(angle) * distance * 1.4;
      const origin = new Vector3(x, terrainHeight(x, zz) - 0.065, zz);
      const height = 0.17 + random() ** 0.7 * 0.46;
      const lean = new Vector3((random() - 0.7) * 0.27, 0, (random() - 0.45) * 0.3);
      const curve = (t: number): Vector3 => origin.clone().addScaledVector(UP, height * t)
        .addScaledVector(lean, t * t);
      stem(surface, curve, 0.0035 + random() * 0.0035, 5, 3, i + z);
      if (i % 3 === 0) {
        const p = curve(0.71);
        stem(surface, t => p.clone().addScaledVector(UP, height * t * 0.18)
          .add(new Vector3(Math.cos(angle), -0.12, Math.sin(angle)).multiplyScalar(t * 0.14)),
        0.003, 3, 3, angle);
      }
    }
  }
  // Two low shrubs are mostly buried; only the curved older shoots and their
  // irregular forks show above the powder. Their centres do not form a row.
  for (const [z, bank, offset] of [[-3.8, -1, 2.3], [-20.5, 1, 2.2]] as const) {
    const x = streamCenter(z) + bank * (streamHalfWidth(z) + streamBankOffset(z, bank) + offset);
    const origin = new Vector3(x, terrainHeight(x, z) - 0.08, z);
    for (let i = 0; i < 6; i += 1) {
      const angle = random() * TAU, height = 0.34 + random() * 0.44;
      const spread = 0.12 + random() * 0.34;
      const curve = (t: number): Vector3 => origin.clone().addScaledVector(UP, height * t)
        .add(new Vector3(Math.cos(angle), 0, Math.sin(angle)).multiplyScalar(spread * t ** 1.5));
      stem(surface, curve, 0.010 + random() * 0.006, 7, 5, angle);
      for (const t of [0.48, 0.73]) {
        const p = curve(t), branchAngle = angle + (t < 0.6 ? 0.8 : -0.7);
        const direction = new Vector3(Math.cos(branchAngle), 0.9, Math.sin(branchAngle));
        stem(surface, u => p.clone().addScaledVector(direction, u * (0.13 + t * 0.12)),
          0.0045, 3, 3, branchAngle);
      }
    }
  }
}

export function buildForestFloor(seed: string, materials: FloorMaterials): Group {
  const group = new Group();
  group.name = 'half-buried-forest-floor';
  const bark = new Surface(), snow = new Surface(), stems = new Surface();
  fallenLog(group, bark, snow, materials, seed);
  winterUndergrowth(stems, seed);
  // Each surface has already been accumulated into one geometry per material.
  // Keep the endgrain separate so its physical radial coordinates stay valid.
  for (const [surface, material, name] of [[bark, materials.bark, 'fallen-trunk-bark'],
    [snow, materials.snow, 'fallen-trunk-snow'], [stems, materials.wood, 'exposed-winter-stems']] as const) {
    const mesh = new Mesh(surface.geometry(), material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
