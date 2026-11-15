import {
  BoxGeometry, BufferGeometry, CatmullRomCurve3, CylinderGeometry, ExtrudeGeometry,
  Float32BufferAttribute, Group, Mesh, MeshStandardMaterial, Path, PointLight, Shape,
  TubeGeometry, Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRandom, randomBetween } from '../../core/random';
import type { CourtyardMaterials } from './geometry';

function add(parent: Group, geometry: BufferGeometry, material: MeshStandardMaterial): Mesh {
  const object = new Mesh(geometry, material);
  object.castShadow = true;
  object.receiveShadow = true;
  parent.add(object);
  return object;
}

function block(parent: Group, material: MeshStandardMaterial, size: [number, number, number], at: [number, number, number]): Mesh {
  const object = add(parent, new BoxGeometry(...size), material);
  object.position.set(...at);
  return object;
}

function column(parent: Group, material: MeshStandardMaterial, x: number, z: number, bottom: number, top: number, radius: number): void {
  const object = add(parent, new CylinderGeometry(radius * 0.90, radius, top - bottom, 18), material);
  object.position.set(x, (top + bottom) * 0.5, z);
}

function roofHeight(x: number, z: number, width: number, depth: number, ridge: number, rise: number): number {
  const t = Math.abs(z) / (depth * 0.5);
  const corner = Math.min(1, Math.abs(x) / (width * 0.5));
  return ridge - rise * Math.pow(t, 0.75) + (0.075 + 0.13 * corner ** 9) * t ** 4;
}

/** A continuous tile bed; the small ridges are geometry, not a painted texture. */
function roofSheet(width: number, depth: number, ridge: number, rise: number, snow: boolean): BufferGeometry {
  const nx = Math.ceil(width / 0.075);
  const nz = Math.max(16, Math.ceil(depth / 0.12));
  const positions: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= nz; j += 1) {
    const v = j / nz * 2 - 1;
    for (let i = 0; i <= nx; i += 1) {
      const x = (i / nx - 0.5) * width;
      const lip = snow ? 0.025 + Math.sin(x * 3.7) * 0.012 + Math.sin(x * 8.3) * 0.006 : 0;
      const z = v * (depth * 0.5 + lip * Math.abs(v) ** 8);
      const tide = Math.sin(x * 0.8 + z * 1.4) * 0.018 + Math.sin(x * 2.4 - z * 0.7) * 0.009;
      const blanket = snow ? 0.085 + tide - 0.018 * Math.abs(v) ** 8 : Math.cos(x / 0.175 * Math.PI * 2) * 0.018;
      positions.push(x, roofHeight(x, z, width, depth, ridge, rise) + blanket, z);
    }
  }
  for (let j = 0; j < nz; j += 1) for (let i = 0; i < nx; i += 1) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  if (snow) {
    for (const side of [-1, 1]) {
      const row = side < 0 ? 0 : nz;
      const lower = positions.length / 3;
      for (let i = 0; i <= nx; i += 1) {
        const k = (row * (nx + 1) + i) * 3;
        const x = positions[k]!, z = positions[k + 2]!;
        positions.push(x, roofHeight(x, z, width, depth, ridge, rise) + 0.013, z - side * 0.008);
      }
      for (let i = 0; i < nx; i += 1) {
        const a = row * (nx + 1) + i, b = lower + i;
        if (side > 0) indices.push(a, b, a + 1, a + 1, b, b + 1);
        else indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Hollow half-round clay ends replace the old row of solid circular discs. */
function tileEnd(radius: number, length: number): BufferGeometry {
  const positions: number[] = [], indices: number[] = [];
  const segments = 10;
  for (let end = 0; end < 2; end += 1) for (let surface = 0; surface < 2; surface += 1) {
    const r = radius - surface * 0.012;
    for (let i = 0; i <= segments; i += 1) {
      const angle = i / segments * Math.PI;
      positions.push(Math.cos(angle) * r, Math.sin(angle) * r, end * length);
    }
  }
  const ring = segments + 1;
  for (let i = 0; i < segments; i += 1) {
    indices.push(i, i + 1, 2 * ring + i, i + 1, 2 * ring + i + 1, 2 * ring + i);
    indices.push(ring + i, 3 * ring + i, ring + i + 1, ring + i + 1, 3 * ring + i, 3 * ring + i + 1);
    indices.push(i, ring + i, i + 1, i + 1, ring + i, ring + i + 1);
    indices.push(2 * ring + i, 2 * ring + i + 1, 3 * ring + i, 2 * ring + i + 1, 3 * ring + i + 1, 3 * ring + i);
  }
  // Close the thin clay wall along both lower cut edges.
  for (const i of [0, segments]) {
    const a = i, b = ring + i, c = 2 * ring + i, d = 3 * ring + i;
    if (i === 0) indices.push(a, c, b, b, c, d);
    else indices.push(a, b, c, b, d, c);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildRoof(parent: Group, m: CourtyardMaterials, width: number, depth: number, ridge: number, rise: number): void {
  add(parent, roofSheet(width, depth, ridge, rise, false), m.tile);
  const underside = roofSheet(width - 0.03, depth - 0.03, ridge - 0.10, rise, false);
  const faces = underside.getIndex()!;
  for (let i = 0; i < faces.count; i += 3) {
    const a = faces.getX(i), b = faces.getX(i + 1);
    faces.setX(i, b); faces.setX(i + 1, a);
  }
  underside.computeVertexNormals();
  add(parent, underside, m.wood);
  add(parent, roofSheet(width - 0.02, depth - 0.025, ridge, rise, true), m.snow);
  const ends: BufferGeometry[] = [];
  const tiles = Math.round(width / 0.175);
  for (const side of [-1, 1]) {
    const points: Vector3[] = [];
    for (let i = 0; i <= 40; i += 1) {
      const x = (i / 40 - 0.5) * width;
      const z = side * depth * 0.5;
      points.push(new Vector3(x, roofHeight(x, z, width, depth, ridge, rise) - 0.075, z - side * 0.02));
    }
    add(parent, new TubeGeometry(new CatmullRomCurve3(points), 56, 0.032, 6, false), m.wood);
    for (let i = 0; i < tiles; i += 1) {
      const x = (i + 0.5) / tiles * width - width * 0.5;
      const z = side * depth * 0.5;
      const tile = tileEnd(0.065, 0.26);
      if (side > 0) tile.rotateY(Math.PI);
      tile.translate(x, roofHeight(x, z, width, depth, ridge, rise) - 0.045, z + side * 0.035);
      ends.push(tile);
    }
  }
  const combined = mergeGeometries(ends, false);
  if (combined) add(parent, combined, m.tile);
  ends.forEach(part => part.dispose());
  const ridgeRail = new CylinderGeometry(0.068, 0.068, width, 14);
  ridgeRail.rotateZ(Math.PI / 2);
  ridgeRail.translate(0, ridge + 0.03, 0);
  add(parent, ridgeRail, m.tile);
}

function gateMasonry(parent: Group, m: CourtyardMaterials): void {
  const count = 40;
  const parts: BufferGeometry[] = [];
  const inner = 1.355, outer = 1.515;
  for (let i = 0; i < count; i += 1) {
    const a = i / count * Math.PI * 2 + 0.0025;
    const b = (i + 1) / count * Math.PI * 2 - 0.0025;
    const face = new Shape();
    face.moveTo(Math.cos(a) * outer, Math.sin(a) * outer);
    face.absarc(0, 0, outer, a, b, false);
    face.lineTo(Math.cos(b) * inner, Math.sin(b) * inner);
    face.absarc(0, 0, inner, b, a, true);
    face.closePath();
    const brick = new ExtrudeGeometry(face, { depth: 0.43, steps: 1, bevelEnabled: true, bevelSize: 0.0025, bevelThickness: 0.003, bevelSegments: 2, curveSegments: 4 });
    brick.translate(3, 1.7, -7.82);
    parts.push(brick);
  }
  const combined = mergeGeometries(parts, false);
  if (combined) add(parent, combined, m.stone);
  parts.forEach(part => part.dispose());
}

function buildWalls(parent: Group, m: CourtyardMaterials): void {
  const shape = new Shape();
  shape.moveTo(-8.6, 0.24); shape.lineTo(8.6, 0.24);
  shape.lineTo(8.6, 3.46); shape.lineTo(-8.6, 3.46); shape.closePath();
  const hole = new Path();
  hole.absarc(3, 1.7, 1.38, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const wall = add(parent, new ExtrudeGeometry(shape, { depth: 0.36, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.01, bevelSegments: 2, curveSegments: 64 }), m.plaster);
  wall.position.z = -7.8;
  gateMasonry(parent, m);
  // Individual courses in the damp stone plinth give the wall a human scale.
  for (let course = 0; course < 2; course += 1) {
    for (let x = -8.55 - course * 0.28; x < 8.55; x += 0.61) {
      const left = Math.max(-8.6, x), right = Math.min(8.6, x + 0.60);
      if (left > 1.45 && right < 4.55) continue;
      if (right <= left) continue;
      block(parent, m.stone, [right - left, 0.13, 0.41], [(left + right) * 0.5, 0.08 + course * 0.14, -7.61]);
    }
  }
  const roof = new Group();
  roof.position.z = -7.62;
  parent.add(roof);
  buildRoof(roof, m, 17.7, 1.08, 3.84, 0.43);
  // The left boundary is largely sheltered by the open gallery.
  block(parent, m.plaster, [0.34, 2.7, 10.7], [-8.6, 1.6, -2.55]);
  block(parent, m.stone, [0.42, 0.34, 10.7], [-8.6, 0.18, -2.55]);
  const left = new Group();
  left.position.set(-8.6, 0, -2.55);
  left.rotation.y = Math.PI / 2;
  parent.add(left);
  buildRoof(left, m, 11, 0.98, 3.39, 0.40);
}

function hangingLantern(parent: Group, m: CourtyardMaterials, x: number, z: number): void {
  const group = new Group();
  group.position.set(x, 2.57, z);
  parent.add(group);
  const paper = new MeshStandardMaterial({ color: 0xe6c48a, emissive: 0xffbb65, emissiveIntensity: 1.35, roughness: 0.85 });
  const body = add(group, new CylinderGeometry(0.17, 0.15, 0.40, 8), paper);
  body.castShadow = false;
  for (const y of [-0.22, 0.22]) {
    const cap = add(group, new CylinderGeometry(0.19, 0.19, 0.045, 8), m.wood);
    cap.position.y = y;
  }
  for (let i = 0; i < 8; i += 1) {
    const a = i / 8 * Math.PI * 2;
    column(group, m.wood, Math.cos(a) * 0.162, Math.sin(a) * 0.162, -0.20, 0.20, 0.008);
  }
  column(group, m.wood, 0, 0, 0.23, 0.86, 0.008);
  const glow = new PointLight(0xffb45c, 7, 5, 2);
  glow.position.set(0, 0.05, 0.08);
  group.add(glow);
}

/** A glimpse of the gathering indoors, rather than an isolated garden prop. */
function buildGallery(parent: Group, seed: string, m: CourtyardMaterials): void {
  const random = createRandom(seed + '/gallery');
  const group = new Group();
  group.position.set(-7.0, 0, -3.2);
  group.rotation.y = Math.PI / 2;
  parent.add(group);
  block(group, m.stone, [7.0, 0.36, 3.35], [0, 0.18, 0]);
  block(group, m.plaster, [6.8, 2.9, 0.22], [0, 1.90, -1.47]);
  block(group, m.plaster, [0.22, 2.9, 3.0], [-3.32, 1.90, 0]);
  block(group, m.plaster, [0.22, 2.9, 3.0], [3.32, 1.90, 0]);
  const paper = new MeshStandardMaterial({ color: 0xb59b74, emissive: 0xe2a55e, emissiveIntensity: 0.42, roughness: 1 });
  paper.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPaperPosition;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvPaperPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPaperPosition;')
      .replace('#include <emissivemap_fragment>', /* glsl */ `
        #include <emissivemap_fragment>
        float panelGlow = 0.5 + 0.5 * cos((vPaperPosition.z + 3.2) * 2.804993);
        float lampFalloff = exp(-pow((vPaperPosition.y - 1.90) / 0.88, 2.0));
        totalEmissiveRadiance *= 0.80 + panelGlow * lampFalloff * 0.24;
      `);
  };
  paper.customProgramCacheKey = () => 'yyj-warm-paper-v1';
  for (const x of [-2.24, 0, 2.24]) {
    block(group, m.wood, [2.08, 2.26, 0.12], [x, 1.74, 0.52]);
    block(group, paper, [1.86, 1.60, 0.03], [x, 2.02, 0.60]);
    // Mortise-like framing and thin staggered lattice are real geometry.
    for (let i = 0; i <= 8; i += 1) block(group, m.wood, [0.027, 1.66, 0.045], [x - 0.94 + i * 0.235, 2.02, 0.63]);
    for (let i = 0; i <= 7; i += 1) block(group, m.wood, [1.91, 0.026, 0.045], [x, 1.20 + i * 0.235, 0.635]);
    for (let i = 0; i < 8; i += 1) block(group, m.wood, [0.18, 0.34, 0.03], [x - 0.8 + i * 0.23, 0.91, 0.60]);
  }
  for (const x of [-3.2, -1.08, 1.08, 3.2]) {
    column(group, m.wood, x, 1.36, 0.36, 3.43, 0.10);
    const foot = add(group, new CylinderGeometry(0.18, 0.20, 0.24, 16), m.stone);
    foot.position.set(x, 0.42, 1.36);
    block(group, m.wood, [0.55, 0.10, 0.18], [x, 3.24, 1.36]);
  }
  block(group, m.wood, [7.0, 0.18, 0.18], [0, 3.35, 1.36]);
  for (let x = -3.3; x <= 3.31; x += 0.28) {
    block(group, m.wood, [0.055, 0.07, 0.7], [x, 3.44 + randomBetween(random, -0.008, 0.008), 1.5]);
  }
  buildRoof(group, m, 7.6, 4.05, 4.51, 1.13);
  hangingLantern(group, m, -2.1, 1.53);
  hangingLantern(group, m, 2.1, 1.53);
}

export function buildCourtyardArchitecture(parent: Group, seed: string, m: CourtyardMaterials): void {
  buildWalls(parent, m);
  buildGallery(parent, seed, m);
}
