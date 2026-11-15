import { BufferGeometry, Float32BufferAttribute, Group, Mesh, Vector3 } from 'three';
import type { MeshStandardMaterial } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRandom, randomBetween } from '../../core/random';
import { buildWinterTree } from './winterTree';
export { createForestNeedleMaterial } from './forestNeedles';

export type ForestTreeDetail = 'near' | 'mid' | 'far';
export interface ForestTreeOptions { young?: boolean }
export interface ForestTreeMaterials {
  bark: MeshStandardMaterial;
  snow: MeshStandardMaterial;
  needles: MeshStandardMaterial;
}

/** Geometry and runtime needle data are generated here; no authored assets. */
class Surface {
  readonly position: number[] = [];
  readonly index: number[] = [];
  readonly uv: number[] = [];
  vertex(x: number, y: number, z: number, u = 0.5, v = 0.5): number {
    const i = this.position.length / 3;
    this.position.push(x, y, z);
    this.uv.push(u, v);
    return i;
  }
  point(p: Vector3): number { return this.vertex(p.x, p.y, p.z); }
  triangle(a: number, b: number, c: number): void { this.index.push(a, b, c); }
  finish(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.position, 3));
    g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.index);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const UP = new Vector3(0, 1, 0);
const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Cubic branch curves sag under the weight of wet snow, then lift at the tips. */
function cubic(a: Vector3, b: Vector3, c: Vector3, d: Vector3, t: number): Vector3 {
  const u = 1 - t;
  return a.clone().multiplyScalar(u * u * u)
    .addScaledVector(b, 3 * u * u * t)
    .addScaledVector(c, 3 * u * t * t)
    .addScaledVector(d, t * t * t);
}

type Curve = (t: number) => Vector3;

function tube(surface: Surface, curve: Curve, radius: number, rings: number, sides: number, phase: number, rooted = false): void {
  const first = surface.position.length / 3;
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const p = curve(t);
    const tangent = curve(Math.min(1, t + 0.005)).sub(curve(Math.max(0, t - 0.005))).normalize();
    let side = tangent.clone().cross(UP);
    if (side.lengthSq() < 0.001) side = tangent.clone().cross(new Vector3(0, 0, 1));
    side.normalize();
    const normal = side.clone().cross(tangent).normalize();
    const taper = radius * (0.018 + 0.982 * (1 - t) ** 0.87);
    for (let k = 0; k < sides; k++) {
      const angle = k * TAU / sides;
      const fluting = 1 + 0.10 * Math.sin(angle * 7 + phase + t * 2.1)
        + 0.038 * Math.sin(angle * 13 - t * 8.4 + phase);
      const root = rooted ? radius * 0.72 * Math.exp(-t * 27) * (0.65 + 0.35 * Math.cos(angle * 5 + phase)) : 0;
      const rr = taper * fluting + root;
      surface.point(p.clone().addScaledVector(side, Math.cos(angle) * rr).addScaledVector(normal, Math.sin(angle) * rr));
    }
  }
  for (let r = 0; r < rings; r++) for (let k = 0; k < sides; k++) {
    const a = first + r * sides + k;
    const b = first + r * sides + (k + 1) % sides;
    surface.triangle(a, a + sides, b);
    surface.triangle(b, a + sides, b + sides);
  }
  for (const end of [0, 1]) {
    const center = surface.point(curve(end));
    const ring = first + end * rings * sides;
    for (let k = 0; k < sides; k++) {
      const a = ring + k;
      const b = ring + (k + 1) % sides;
      if (end === 0) surface.triangle(center, a, b);
      else surface.triangle(center, b, a);
    }
  }
}

/**
 * Curved, crossed branchlet surfaces carry a seed-generated needle cutout.
 * Their empty texels stay genuinely empty, while each view sees a dense three-
 * dimensional needle mass instead of a single broad leaf or a subpixel line.
 */
function needleSpray(surface: Surface, curve: Curve, width: number, phase: number, detail: ForestTreeDetail): void {
  const patches = detail === 'near' ? 3 : detail === 'mid' ? 2 : 1;
  const segments = detail === 'near' ? 4 : 2;
  const columns = detail === 'far' ? 1 : 2;
  for (let patch = 0; patch < patches; patch++) {
    const from = patches === 1 ? 0 : patch / (patches - 1) * (detail === 'near' ? 0.56 : 0.47);
    const span = patches === 1 ? 1 : detail === 'near' ? 0.44 : 0.53;
    const widthScale = (detail === 'near' ? 0.79 : detail === 'mid' ? 0.92 : 1.26)
      * (0.90 + 0.10 * Math.sin(phase * 1.71 + patch * 4.3));
    for (let card = 0; card < 2; card++) {
      const first = surface.position.length / 3;
      const rotation = (card === 0 ? -0.38 : 0.98) + 0.26 * Math.sin(phase * 1.31 + patch * 3.4);
      for (let ring = 0; ring <= segments; ring++) {
        const v = ring / segments;
        const t = from + v * span;
        const point = curve(t);
        const tangent = curve(Math.min(1, t + 0.01)).sub(curve(Math.max(0, t - 0.01))).normalize();
        const side = tangent.clone().cross(UP).normalize();
        const top = side.clone().cross(tangent).normalize();
        const angle = rotation + 0.20 * Math.sin(v * 4.3 + phase + patch);
        const cross = side.clone().multiplyScalar(Math.cos(angle)).addScaledVector(top, Math.sin(angle));
        for (let column = 0; column <= columns; column++) {
          const u = column / columns;
          const w = (u * 2 - 1) * width * widthScale * (0.86 + 0.14 * Math.sin(Math.PI * v));
          const p = point.clone().addScaledVector(cross, w)
            .addScaledVector(side, width * 0.12 * Math.sin(phase + patch * 2.7) * Math.sin(v * Math.PI))
            .addScaledVector(top, -Math.abs(w) * 0.10 + Math.sin(v * Math.PI) * 0.012);
          surface.vertex(p.x, p.y, p.z, (patch + card) % 2 ? 1 - u : u, v);
        }
      }
      for (let ring = 0; ring < segments; ring++) for (let column = 0; column < columns; column++) {
        const a = first + ring * (columns + 1) + column;
        const b = a + columns + 1;
        surface.triangle(a, a + 1, b);
        surface.triangle(a + 1, b + 1, b);
      }
    }
  }
}

/** Small wind-shaped deposits with shared, rounded end poles. */
function snowBlanket(surface: Surface, curve: Curve, width: number, thickness: number, phase: number, detail: ForestTreeDetail): void {
  const rings = detail === 'near' ? 6 : detail === 'mid' ? 4 : 3;
  const sides = detail === 'near' ? 8 : detail === 'mid' ? 6 : 5;
  const start = surface.point(curve(0).addScaledVector(UP, width * 0.10));
  const first = surface.position.length / 3;
  for (let r = 1; r < rings; r++) {
    const t = 0.5 - 0.5 * Math.cos(Math.PI * r / rings);
    const p = curve(t);
    const tangent = curve(Math.min(1, t + 0.01)).sub(curve(Math.max(0, t - 0.01))).normalize();
    const side = tangent.clone().cross(UP).normalize();
    const envelope = Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2));
    const scallop = 0.91 + 0.13 * Math.sin(t * 11 + phase) + 0.055 * Math.sin(t * 19 - phase * 0.7);
    for (let k = 0; k < sides; k++) {
      const angle = k * TAU / sides;
      const upper = Math.max(0, Math.sin(angle));
      const lower = Math.min(0, Math.sin(angle));
      const edge = 1 + 0.13 * Math.sin(t * 13 + Math.cos(angle) * 3 + phase);
      const lateral = Math.cos(angle) * width * envelope * scallop * edge
        + width * 0.16 * Math.sin(t * 8 + phase) * envelope;
      const drift = thickness * envelope * (upper ** 0.91 + lower * 0.43) * (0.94 + 0.12 * Math.sin(t * 11 + phase));
      surface.point(p.clone().addScaledVector(side, lateral).addScaledVector(UP, drift + width * 0.10));
    }
  }
  const end = surface.point(curve(1).addScaledVector(UP, width * 0.10));
  for (let k = 0; k < sides; k++) {
    const next = (k + 1) % sides;
    surface.triangle(start, first + k, first + next);
    const last = first + (rings - 2) * sides;
    surface.triangle(end, last + next, last + k);
  }
  for (let r = 0; r < rings - 2; r++) for (let k = 0; k < sides; k++) {
    const a = first + r * sides + k;
    const b = first + r * sides + (k + 1) % sides;
    surface.triangle(a, a + sides, b);
    surface.triangle(b, a + sides, b + sides);
  }
}

/** Mature fir architecture in metres: an uneven leader and individual drooping boughs. */
export function buildSnowPine(seed: string, materials: ForestTreeMaterials, detail: ForestTreeDetail = 'mid', options: ForestTreeOptions = {}): Group {
  const random = createRandom(`${seed}/snow-fir`);
  const wood = new Surface();
  const foliage = new Surface();
  const snow = new Surface();
  const phase = random() * TAU;
  const height = randomBetween(random, 13.5, 16.1);
  const trunkRadius = options.young ? randomBetween(random, 0.17, 0.25) : randomBetween(random, 0.28, 0.41);
  const leanX = randomBetween(random, -0.55, 0.55);
  const leanZ = randomBetween(random, -0.45, 0.45);
  const trunk: Curve = (t) => new Vector3(
    leanX * t ** 1.45 + 0.12 * Math.sin(t * 9 + phase) * Math.sin(t * Math.PI),
    height * t - 0.10,
    leanZ * t ** 1.4 + 0.10 * Math.sin(t * 12 - phase) * Math.sin(t * Math.PI),
  );
  tube(wood, trunk, trunkRadius, detail === 'near' ? 50 : detail === 'mid' ? 27 : 12,
    detail === 'near' ? 20 : detail === 'mid' ? 11 : 7, phase, true);
  if (detail !== 'far') for (let i = 0; i < 6; i++) {
    const a = phase + i * GOLDEN;
    const d = new Vector3(Math.cos(a), 0, Math.sin(a));
    const length = randomBetween(random, 0.55, 1.05);
    const root: Curve = (t) => d.clone().multiplyScalar(length * t).setY(0.14 * (1 - t) - 0.16 * t * t);
    tube(wood, root, trunkRadius * 0.45, detail === 'near' ? 7 : 4, detail === 'near' ? 8 : 5, a);
  }

  const levels = detail === 'near' ? 15 : detail === 'mid' ? 14 : 12;
  let boughCount = 0;
  let sprayCount = 0;
  for (let level = 0; level < levels; level++) {
    const lowest = options.young ? 0.035 : 0.095;
    const heightRatio = lowest + level / (levels - 1) * (0.97 - lowest);
    const branches = detail === 'near' ? 6 : detail === 'mid' ? 5 : 4;
    for (let branch = 0; branch < branches; branch++) {
      if (random() < (level < 3 ? 0.07 : 0.025)) continue;
      const at = Math.min(0.977, heightRatio + randomBetween(random, -0.018, 0.018));
      const angle = phase + level * GOLDEN + branch / branches * TAU + randomBetween(random, -0.32, 0.32);
      const outward = new Vector3(Math.cos(angle), 0, Math.sin(angle));
      const cross = outward.clone().cross(UP);
      const length = (0.28 + 4.0 * (1 - at) ** 0.82) * randomBetween(random, 0.76, 1.18)
        * (1 + 0.22 * Math.cos(angle - phase))
        * (1 + 0.18 * Math.sin(level * 0.77 + phase) + 0.07 * Math.sin(level * 1.83 - phase));
      const start = trunk(at);
      const droop = Math.min(start.y * 0.85, length * (0.20 + 0.21 * (1 - at)) * randomBetween(random, 0.7, 1.3));
      const snowLoad = random() < 0.16 ? randomBetween(random, 0.03, 0.16) : randomBetween(random, 0.55, 0.93);
      const a = start.clone().addScaledVector(outward, -0.08);
      const b = start.clone().addScaledVector(outward, length * 0.30).addScaledVector(UP, 0.14);
      const c = start.clone().addScaledVector(outward, length * 0.74).addScaledVector(UP, -droop);
      const d = start.clone().addScaledVector(outward, length).addScaledVector(UP, -droop * 0.58);
      const branchCurve: Curve = (t) => cubic(a, b, c, d, t).addScaledVector(cross, Math.sin(t * Math.PI) * length * 0.05 * Math.sin(angle * 4));
      const radius = Math.max(0.012, trunkRadius * (1 - at) * randomBetween(random, 0.23, 0.36));
      tube(wood, branchCurve, radius, detail === 'near' ? 9 : detail === 'mid' ? 5 : 3, detail === 'near' ? 7 : detail === 'mid' ? 5 : 4, angle);
      boughCount++;

      const limbDetail = detail === 'near' && at > 0.58 ? 'mid' : detail;
      const shoots = detail === 'near' ? 10 : detail === 'mid' ? 6 : 4;
      for (let k = 0; k < shoots; k++) {
        const t = 0.12 + Math.floor(k / 2) / (Math.ceil(shoots / 2) - 0.25) * 0.82 + randomBetween(random, -0.018, 0.018);
        const attach = branchCurve(t);
        const sign = k % 2 ? 1 : -1;
        const shootLength = length * (0.18 + 0.27 * (1 - t)) * randomBetween(random, 0.83, 1.20);
        const direction = outward.clone().multiplyScalar(0.42).addScaledVector(cross, sign * 0.91).normalize();
        const shootDrop = shootLength * randomBetween(random, 0.22, 0.48);
        const shotEnd = attach.clone().addScaledVector(direction, shootLength).addScaledVector(UP, -shootDrop);
        const shootCurve: Curve = (u) => cubic(
          attach,
          attach.clone().addScaledVector(direction, shootLength * 0.32).addScaledVector(UP, 0.035),
          attach.clone().addScaledVector(direction, shootLength * 0.77).addScaledVector(UP, -shootDrop * 1.06),
          shotEnd,
          u,
        );
        const width = Math.min(0.24, shootLength * 0.29) * randomBetween(random, 0.84, 1.18);
        const localPhase = angle * 2 + k * 1.7;
        needleSpray(foliage, shootCurve, width, localPhase, limbDetail);
        if (random() < snowLoad) {
          // Short, uneven loads sit on individual needle tufts. A long shoot is
          // never covered by one whole metre-long white spindle.
          const fragmentCount = limbDetail === 'near' && shootLength > 0.85 && random() < 0.34 ? 2 : 1;
          for (let fragment = 0; fragment < fragmentCount; fragment++) {
            const worldLength = Math.min(shootLength * 0.54, randomBetween(random, 0.22, 0.43));
            const span = Math.min(0.58, worldLength / shootLength);
            const from = fragmentCount === 2 ? 0.08 + fragment * 0.46 : randomBetween(random, 0.10, Math.max(0.11, 0.82 - span));
            const usedSpan = Math.min(span, 0.96 - from);
            const coverCurve: Curve = (u) => shootCurve(from + u * usedSpan).addScaledVector(UP, width * 0.12);
            const coverWidth = Math.min(worldLength * 0.48, width * randomBetween(random, 0.57, 0.85));
            snowBlanket(snow, coverCurve, coverWidth,
              Math.min(0.15, coverWidth * randomBetween(random, 0.62, 0.99)), localPhase + fragment * 1.9, limbDetail);
          }
        }
        sprayCount++;
      }
      const tipCurve: Curve = (u) => branchCurve(0.63 + u * 0.37);
      const tipWidth = Math.min(0.24, length * 0.095);
      needleSpray(foliage, tipCurve, tipWidth, angle, limbDetail);
      if (random() < snowLoad * 0.75) {
        const from = randomBetween(random, 0.74, 0.85);
        const span = Math.min(0.15, 0.32 / length);
        const capCurve: Curve = (u) => branchCurve(from + span * u);
        const coverWidth = Math.min(0.13, tipWidth * 0.63, length * span * 0.47);
        snowBlanket(snow, capCurve, coverWidth, coverWidth * 0.80, angle, limbDetail);
      }
      if (length > 1.1 && random() < snowLoad * 0.85) {
        const count = limbDetail === 'far' ? 1 : Math.min(4, Math.max(2, Math.ceil(length * 0.54 / 0.43)));
        for (let deposit = 0; deposit < count; deposit++) {
          const from = 0.18 + deposit / count * 0.57 + randomBetween(random, -0.02, 0.02);
          const span = Math.min(0.42 / length, 0.44 / count);
          const ridgeCurve: Curve = (u) => branchCurve(from + u * span).addScaledVector(UP, radius * 0.9);
          const coverWidth = Math.min(0.16, length * span * 0.44) * randomBetween(random, 0.73, 1.0);
          snowBlanket(snow, ridgeCurve, coverWidth, coverWidth * randomBetween(random, 0.63, 0.93), angle + deposit * 1.7, limbDetail);
        }
      }
    }
  }
  const group = new Group();
  group.name = `snow-fir-${detail}`;
  let triangles = 0;
  for (const [surface, material, name] of [
    [wood, materials.bark, 'fir-trunk-and-boughs'],
    [foliage, materials.needles, 'fir-needle-sprays'],
    [snow, materials.snow, 'fir-settled-snow'],
  ] as const) {
    const geometry = surface.finish();
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    triangles += surface.index.length / 3;
  }
  group.userData.generatedTree = { detail, young: Boolean(options.young), height, boughCount, sprayCount, triangles };
  return group;
}

/** Fine terminal forks and uneven bark keep the bare trees from reading as poles. */
export function buildForestSnag(seed: string, materials: Pick<ForestTreeMaterials, 'bark' | 'snow'>, detail: ForestTreeDetail = 'mid'): Group {
  const tree = buildWinterTree(`${seed}/forest-snag`, { wood: materials.bark, snow: materials.snow }, detail !== 'far');
  const wood = tree.children.find((child) => child instanceof Mesh && child.name === 'winter-branches') as Mesh | undefined;
  if (wood && detail !== 'far') {
    const geometry = wood.geometry;
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    const index = geometry.index!;
    const largestEdge = new Float64Array(positions.count);
    const a = new Vector3(), b = new Vector3();
    for (let i = 0; i < index.count; i += 3) {
      for (let edge = 0; edge < 3; edge++) {
        const from = index.getX(i + edge), to = index.getX(i + (edge + 1) % 3);
        a.fromBufferAttribute(positions, from); b.fromBufferAttribute(positions, to);
        const distance = a.distanceToSquared(b);
        largestEdge[from] = Math.max(largestEdge[from]!, distance);
        largestEdge[to] = Math.max(largestEdge[to]!, distance);
      }
    }
    const random = createRandom(`${seed}/terminal-twigs`);
    const twigs = new Surface();
    for (let i = 0; i < positions.count; i++) {
      if (largestEdge[i]! > 0.00014 || largestEdge[i]! < 0.0000001 || positions.getY(i) < 1.8) continue;
      const origin = new Vector3().fromBufferAttribute(positions, i);
      const direction = new Vector3().fromBufferAttribute(normals, i).normalize();
      if (direction.y < -0.15) continue;
      const side = direction.clone().cross(UP).normalize();
      for (const sign of [-1, 1]) {
        const length = randomBetween(random, 0.16, 0.38);
        const growth = direction.clone().addScaledVector(side, sign * randomBetween(random, 0.22, 0.54)).addScaledVector(UP, 0.12).normalize();
        const end = origin.clone().addScaledVector(growth, length);
        const curve: Curve = (t) => cubic(origin,
          origin.clone().addScaledVector(direction, length * 0.29),
          origin.clone().addScaledVector(growth, length * 0.72).addScaledVector(side, sign * 0.024), end, t);
        tube(twigs, curve, randomBetween(random, 0.0020, 0.0035), 4, 4, random() * TAU);
      }
    }
    // Small, uneven surface offsets change the silhouette as well as the normal.
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
      const variation = Math.sin(x * 39 + y * 27 + z * 13) * 0.55
        + Math.sin(x * 17 - y * 53 + z * 43) * 0.29 + Math.sin(x * 71 + y * 11 - z * 31) * 0.16;
      const displacement = (0.0014 + 0.0035 * Math.exp(-y * 0.45)) * variation;
      positions.setXYZ(i, x + normals.getX(i) * displacement, y + normals.getY(i) * displacement, z + normals.getZ(i) * displacement);
    }
    const sprigs = twigs.finish();
    sprigs.deleteAttribute('uv');
    const merged = mergeGeometries([geometry, sprigs], false);
    if (!merged) throw new Error('Could not merge forest twig detail.');
    merged.computeVertexNormals(); merged.computeBoundingSphere(); merged.computeBoundingBox();
    geometry.dispose(); sprigs.dispose(); wood.geometry = merged;
  }
  tree.scale.set(1.7, 2.15, 1.7);
  tree.name = 'winter-forest-snag';
  return tree;
}
