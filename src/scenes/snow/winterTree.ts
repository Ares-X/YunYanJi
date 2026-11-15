import {
  BufferGeometry, CatmullRomCurve3, Float32BufferAttribute, Group, Mesh,
  Vector3,
} from 'three';
import type { MeshStandardMaterial } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRandom, randomBetween } from '../../core/random';

interface TreeMaterials {
  wood: MeshStandardMaterial;
  snow: MeshStandardMaterial;
}

interface Limb {
  curve: CatmullRomCurve3;
  length: number;
  radius: (t: number) => number;
  phase: number;
  order: number;
}

const UP = new Vector3(0, 1, 0);
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Shared rings have no duplicated seam; the bark stays smooth around the stem. */
function stemGeometry(limb: Limb, segments: number, sides: number, rooted = false): BufferGeometry {
  const frames = limb.curve.computeFrenetFrames(segments, false);
  const positions: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring <= segments; ring += 1) {
    const t = ring / segments;
    const center = limb.curve.getPointAt(t);
    const normal = frames.normals[ring]!;
    const binormal = frames.binormals[ring]!;
    const radius = limb.radius(t);
    for (let side = 0; side < sides; side += 1) {
      const angle = side / sides * Math.PI * 2;
      const rib = Math.sin(angle * 5 + limb.phase + t * 1.4) * 0.035
        + Math.sin(angle * 9 - limb.phase * 0.7 + t * 2.1) * 0.014;
      const buttress = rooted ? Math.cos(angle * 5 + limb.phase) * 0.10 * Math.exp(-t * 19) : 0;
      const r = radius * (1 + rib + buttress);
      const point = center.clone().addScaledVector(normal, Math.cos(angle) * r).addScaledVector(binormal, Math.sin(angle) * r);
      positions.push(point.x, point.y, point.z);
    }
  }
  for (let ring = 0; ring < segments; ring += 1) {
    for (let side = 0; side < sides; side += 1) {
      const a = ring * sides + side;
      const next = ring * sides + (side + 1) % sides;
      indices.push(a, next, a + sides, next, next + sides, a + sides);
    }
  }
  // Closed ends avoid an exposed black hole when a fine twig is silhouetted.
  for (const end of [0, 1]) {
    const center = limb.curve.getPointAt(end);
    const index = positions.length / 3;
    positions.push(center.x, center.y, center.z);
    const first = end * segments * sides;
    for (let side = 0; side < sides; side += 1) {
      const a = first + side;
      const b = first + (side + 1) % sides;
      if (end === 0) indices.push(index, b, a);
      else indices.push(index, a, b);
    }
  }
  return geometry(positions, indices);
}

function geometry(positions: number[], indices: number[]): BufferGeometry {
  const result = new BufferGeometry();
  result.setAttribute('position', new Float32BufferAttribute(positions, 3));
  result.setIndex(indices);
  result.computeVertexNormals();
  result.computeBoundingSphere();
  return result;
}

/** A shallow upper blanket follows the branch; its underside remains bare bark. */
function branchSnow(limb: Limb, detailed: boolean): BufferGeometry | undefined {
  if (limb.radius(0.3) < 0.033 || Math.abs(limb.curve.getTangentAt(0.58).y) > 0.79) return;
  const segments = detailed ? 8 : 6;
  const sides = detailed ? 7 : 5;
  const positions: number[] = [];
  const indices: number[] = [];
  // Wind leaves separate thin deposits, with bark exposed between them.
  const shift = Math.sin(limb.phase) * 0.035;
  const patches = detailed ? [[0.23 + shift, 0.46 + shift], [0.63 - shift, 0.84 - shift]] : [[0.27, 0.64]];
  for (const [from, to] of patches) {
    const first = positions.length / 3;
    for (let ring = 0; ring <= segments; ring += 1) {
      const u = ring / segments;
      const t = from! + u * (to! - from!);
      const center = limb.curve.getPointAt(t);
      const tangent = limb.curve.getTangentAt(t);
      const lateral = tangent.clone().cross(UP).normalize();
      if (lateral.lengthSq() < 0.5) lateral.set(1, 0, 0);
      const top = lateral.clone().cross(tangent).normalize();
      const radius = limb.radius(t) * 1.055;
      const endFeather = Math.sin(Math.PI * u) ** 0.75;
      const slope = Math.min(1, Math.max(0, (0.86 - Math.abs(tangent.y)) / 0.24));
      const depth = (0.007 + radius * 0.08) * endFeather * slope;
      for (let side = 0; side <= sides; side += 1) {
        const v = side / sides * 2 - 1;
        const width = radius * (0.56 + Math.sin(t * 12 + limb.phase) * 0.05);
        const offset = v * width;
        const barkHeight = Math.sqrt(Math.max(0, radius * radius - offset * offset));
        const drift = (1 - v * v) ** 0.6 * depth * (0.94 + Math.sin(t * 19 + v * 2 + limb.phase) * 0.06);
        const point = center.clone().addScaledVector(lateral, offset).addScaledVector(top, barkHeight + drift + 0.001);
        positions.push(point.x, point.y, point.z);
      }
    }
    for (let ring = 0; ring < segments; ring += 1) {
      for (let side = 0; side < sides; side += 1) {
        const a = first + ring * (sides + 1) + side;
        const b = a + sides + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  return geometry(positions, indices);
}

/**
 * A continuous trunk with uneven lateral growth, never an equal recursive fork.
 * Child stems start inside their parent and leave along its tangent. Their
 * gradual taper and fine terminal twigs preserve the large-to-small hierarchy.
 */
export function buildWinterTree(seed: string, materials: TreeMaterials, detailed = false): Group {
  const random = createRandom(`${seed}/winter-tree`);
  const tree = new Group();
  tree.name = 'procedural-winter-tree';
  const wood: BufferGeometry[] = [];
  const snow: BufferGeometry[] = [];
  const phase = random() * Math.PI * 2;
  const lean = randomBetween(random, -0.11, 0.06);
  const trunk: Limb = {
    curve: new CatmullRomCurve3([
      new Vector3(0, -0.10, 0),
      new Vector3(-0.06, 0.72, 0.025),
      new Vector3(-0.22 + lean, 1.65, -0.08),
      new Vector3(-0.55 + lean, 2.66, -0.02),
      new Vector3(-0.74 + lean * 2, 3.64, -0.18),
      new Vector3(-1.02 + lean * 2, 4.68, -0.13),
    ]),
    length: 4.95,
    radius: (t) => 0.255 * (1 - t) ** 0.98 + 0.006 + 0.105 * Math.exp(-t * 24),
    phase,
    order: -1,
  };
  wood.push(stemGeometry(trunk, detailed ? 42 : 23, detailed ? 22 : 11, true));

  // Root toes merge into the snow, with no horizontal cylinder rim at ground level.
  for (let i = 0; i < (detailed ? 7 : 5); i += 1) {
    const angle = i * GOLDEN_ANGLE + phase;
    const direction = new Vector3(Math.cos(angle), 0, Math.sin(angle));
    const length = randomBetween(random, 0.57, 0.92);
    const points = [
      new Vector3(0, 0.14, 0),
      direction.clone().multiplyScalar(length * 0.25).setY(0.10),
      direction.clone().multiplyScalar(length * 0.65).setY(0.005),
      direction.clone().multiplyScalar(length).setY(-0.075),
    ];
    wood.push(stemGeometry({ curve: new CatmullRomCurve3(points), length, radius: (t) => 0.12 * (1 - t) ** 1.4 + 0.003, phase: angle, order: 0 }, detailed ? 10 : 6, detailed ? 10 : 6));
  }

  let branchCount = 0;
  const grow = (parent: Limb, at: number, direction: Vector3, length: number, radius: number, order: number): void => {
    const attach = parent.curve.getPointAt(at);
    const tangent = parent.curve.getTangentAt(at);
    const start = attach.clone().addScaledVector(tangent, -radius * 0.80);
    const localPhase = random() * Math.PI * 2;
    const sideways = direction.clone().cross(UP).normalize().multiplyScalar(Math.sin(localPhase) * length * 0.11);
    const end = attach.clone().addScaledVector(direction, length);
    end.y += length * randomBetween(random, 0.08, order === 0 ? 0.20 : 0.14);
    const terminal = Math.min(radius * 0.30, order === 0 ? 0.008 : order === 1 ? 0.005 : 0.003);
    const bow = randomBetween(random, -0.075, 0.085) * length;
    const limb: Limb = {
      curve: new CatmullRomCurve3([
        start,
        attach.clone().addScaledVector(tangent, Math.min(length * 0.19, 0.38)),
        attach.clone().addScaledVector(direction, length * 0.58).add(sideways).addScaledVector(UP, bow),
        end,
      ]),
      length,
      radius: (t) => (terminal + (radius - terminal) * (1 - t) ** 0.94) * (1 + 0.11 * Math.exp(-t * 16)),
      phase: localPhase,
      order,
    };
    branchCount += 1;
    const segments = detailed ? [22, 16, 10][order]! : [11, 8, 5][order]!;
    const sides = detailed ? [14, 10, 7][order]! : [8, 6, 4][order]!;
    wood.push(stemGeometry(limb, segments, sides));
    const cover = branchSnow(limb, detailed);
    if (cover) snow.push(cover);
    // Three visible orders read as an old deciduous crown at the authored view;
    // a fourth order mostly produced invisible subpixel noise.
    if (order >= 2) return;
    const count = detailed ? (order === 0 ? 4 : 3) : 2;
    for (let i = 0; i < count; i += 1) {
      const childAt = (i + 1.10) / (count + 0.65) + randomBetween(random, -0.055, 0.055);
      const growth = limb.curve.getTangentAt(childAt);
      const side = growth.clone().cross(UP).normalize();
      if (side.lengthSq() < 0.5) side.set(1, 0, 0);
      const outward = side.multiplyScalar(i % 2 ? -1 : 1);
      const next = growth.clone().multiplyScalar(0.70).addScaledVector(outward, randomBetween(random, 0.54, 0.96));
      next.y += randomBetween(random, 0.17, 0.46);
      next.normalize();
      const childLength = length * randomBetween(random, 0.48, 0.64) * (1.09 - childAt * 0.24);
      const childRadius = Math.max(order === 0 ? 0.023 : 0.0105, limb.radius(childAt) * randomBetween(random, 0.58, 0.72));
      grow(limb, childAt, next, childLength, childRadius, order + 1);
    }
  };

  const attachments = detailed ? [0.33, 0.41, 0.46, 0.56, 0.61, 0.70, 0.77, 0.84] : [0.34, 0.46, 0.57, 0.70, 0.82];
  const lifts = [0.72, 0.97, 0.52, 0.84, 0.65, 1.02, 0.58, 0.85];
  const primaryCount = attachments.length;
  for (let i = 0; i < primaryCount; i += 1) {
    const at = attachments[i]! + randomBetween(random, -0.023, 0.023);
    const azimuth = phase + i * GOLDEN_ANGLE + randomBetween(random, -0.40, 0.40);
    const direction = new Vector3(Math.cos(azimuth), lifts[i]! + randomBetween(random, -0.13, 0.13), Math.sin(azimuth)).normalize();
    const length = 2.95 * (1 - at * 0.66) * randomBetween(random, 0.94, 1.08);
    grow(trunk, at, direction, length, Math.max(0.034, trunk.radius(at) * 0.72), 0);
  }

  let triangles = 0;
  for (const [parts, material, name] of [[wood, materials.wood, 'winter-branches'], [snow, materials.snow, 'settled-branch-snow']] as const) {
    if (parts.length === 0) continue;
    const merged = mergeGeometries(parts, false);
    parts.forEach((part) => part.dispose());
    if (!merged) throw new Error('Winter tree geometry could not be merged.');
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    triangles += (merged.index?.count ?? merged.getAttribute('position').count) / 3;
    const mesh = new Mesh(merged, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    tree.add(mesh);
  }
  tree.userData.generatedTree = { branchCount, triangles, detailed };
  return tree;
}
