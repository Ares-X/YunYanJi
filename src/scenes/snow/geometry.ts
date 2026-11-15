import {
  BoxGeometry, BufferGeometry, CatmullRomCurve3, CircleGeometry, CylinderGeometry,
  ExtrudeGeometry, Float32BufferAttribute, Group, Mesh,
  MeshStandardMaterial, Path, PlaneGeometry, PointLight, Shape,
  TorusGeometry, TubeGeometry, Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRandom, randomBetween } from '../../core/random';
import { createRockPair, createRoundedSlab, groundHeight } from './refinedGeometry';
import { mergeStaticMeshes } from './mergeStaticMeshes';

export interface CourtyardMaterials {
  snow: MeshStandardMaterial;
  stone: MeshStandardMaterial;
  wood: MeshStandardMaterial;
  plaster: MeshStandardMaterial;
  tile: MeshStandardMaterial;
}

export interface CourtyardGeometry {
  group: Group;
  tree: Group;
  water: Mesh;
}

const UP = new Vector3(0, 1, 0);

function mesh(geometry: BufferGeometry, material: MeshStandardMaterial, parent: Group): Mesh {
  const result = new Mesh(geometry, material);
  result.castShadow = true;
  result.receiveShadow = true;
  parent.add(result);
  return result;
}

function box(parent: Group, material: MeshStandardMaterial, size: [number, number, number], position: [number, number, number]): Mesh {
  const result = mesh(new BoxGeometry(...size), material, parent);
  result.position.set(...position);
  return result;
}

function rod(parent: Group, material: MeshStandardMaterial, start: Vector3, end: Vector3, radius: number): Mesh {
  const result = mesh(new CylinderGeometry(radius * 0.91, radius, start.distanceTo(end), 14), material, parent);
  result.position.copy(start).add(end).multiplyScalar(0.5);
  result.quaternion.setFromUnitVectors(UP, end.clone().sub(start).normalize());
  return result;
}

/** Curved roof surface. The roof is modelled, including upturned eaves. */
function roofY(x: number, z: number, width: number, depth: number, ridge: number): number {
  const across = Math.abs(z) / (depth * 0.5);
  const corner = Math.abs(x) / (width * 0.5);
  return ridge - across * 0.97 + 0.23 * across ** 3 + 0.32 * corner ** 7 * across ** 2;
}

function roofSurface(width: number, depth: number, ridge: number, snow: boolean): BufferGeometry {
  const columns = Math.max(40, Math.ceil(width / 0.17));
  const rows = Math.max(16, Math.ceil(depth / 0.16));
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let iz = 0; iz <= rows; iz += 1) {
    for (let ix = 0; ix <= columns; ix += 1) {
      const x = (ix / columns - 0.5) * width;
      const z = (iz / rows - 0.5) * depth;
      const edge = Math.abs(z) / (depth * 0.5);
      const broadDrift = Math.sin(x * 0.83 + z * 1.1) * 0.022 + Math.sin(x * 1.71 - z * 0.65) * 0.011;
      const edgeRoll = Math.max(0, (edge - 0.83) / 0.17);
      const blanket = snow ? 0.105 + broadDrift + Math.sin(x * 4.6 + z * 3.2) * 0.004 - edgeRoll * edgeRoll * 0.035 : 0;
      vertices.push(x, roofY(x, z, width, depth, ridge) + blanket, z);
    }
  }
  for (let iz = 0; iz < rows; iz += 1) {
    for (let ix = 0; ix < columns; ix += 1) {
      const a = iz * (columns + 1) + ix;
      const b = a + 1;
      const c = a + columns + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  if (snow) {
    // Give the blanket a rounded, descending eave rather than a floating sheet.
    for (const side of [-1, 1]) {
      const row = side < 0 ? 0 : rows;
      const midStart = vertices.length / 3;
      for (let ix = 0; ix <= columns; ix += 1) {
        const topIndex = (row * (columns + 1) + ix) * 3;
        const x = vertices[topIndex]!;
        const z = vertices[topIndex + 2]!;
        vertices.push(x, vertices[topIndex + 1]! - 0.025, z + side * 0.020);
      }
      const lowerStart = vertices.length / 3;
      for (let ix = 0; ix <= columns; ix += 1) {
        const topIndex = (row * (columns + 1) + ix) * 3;
        const x = vertices[topIndex]!;
        const z = vertices[topIndex + 2]!;
        vertices.push(x, roofY(x, z, width, depth, ridge) + 0.012, z + side * 0.006);
      }
      for (let ix = 0; ix < columns; ix += 1) {
        for (let segment = 0; segment < 2; segment += 1) {
          const top = segment === 0 ? row * (columns + 1) + ix : midStart + ix;
          const bottom = segment === 0 ? midStart + ix : lowerStart + ix;
          if (side > 0) indices.push(top, bottom, top + 1, top + 1, bottom, bottom + 1);
          else indices.push(top, top + 1, bottom, top + 1, bottom + 1, bottom);
        }
      }
    }
  }
  const result = new BufferGeometry();
  result.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  result.setIndex(indices);
  result.computeVertexNormals();
  return result;
}

function buildRoof(parent: Group, materials: CourtyardMaterials, x: number, z: number, width: number, depth: number, ridge: number): void {
  const roof = new Group();
  roof.position.set(x, 0, z);
  parent.add(roof);
  mesh(roofSurface(width, depth, ridge, false), materials.tile, roof);
  mesh(roofSurface(width - 0.06, depth - 0.11, ridge, true), materials.snow, roof);

  // A visible dark lip beneath the white blanket makes the thickness readable.
  for (const side of [-1, 1]) {
    const points: Vector3[] = [];
    for (let i = 0; i <= 24; i += 1) {
      const rx = (i / 24 - 0.5) * width;
      const rz = side * depth * 0.5;
      points.push(new Vector3(rx, roofY(rx, rz, width, depth, ridge) - 0.045, rz));
    }
    mesh(new TubeGeometry(new CatmullRomCurve3(points), 48, 0.07, 6, false), materials.wood, roof);
  }
  const caps: BufferGeometry[] = [];
  const count = Math.ceil(width / 0.235);
  for (const side of [-1, 1]) {
    for (let i = 0; i < count; i += 1) {
      const rx = -width * 0.5 + (i + 0.5) * width / count;
      const rz = side * depth * 0.5;
      const cap = new CylinderGeometry(0.102, 0.108, 0.19, 16);
      cap.rotateX(Math.PI / 2);
      cap.translate(rx, roofY(rx, rz, width, depth, ridge) - 0.02, rz + side * 0.025);
      caps.push(cap);
    }
  }
  const mergedCaps = mergeGeometries(caps);
  if (mergedCaps) mesh(mergedCaps, materials.tile, roof);
  caps.forEach((geometry) => geometry.dispose());
  rod(roof, materials.tile, new Vector3(-width * 0.5, ridge + 0.04, 0), new Vector3(width * 0.5, ridge + 0.04, 0), 0.095);
  rod(roof, materials.snow, new Vector3(-width * 0.5 + 0.12, ridge + 0.11, 0), new Vector3(width * 0.5 - 0.12, ridge + 0.11, 0), 0.075);
}

function buildWalls(parent: Group, m: CourtyardMaterials): void {
  // Moon gate is an actual opening through a solid wall, not a painted circle.
  const wall = new Shape();
  wall.moveTo(-8.6, 0.25);
  wall.lineTo(8.6, 0.25);
  wall.lineTo(8.6, 3.15);
  wall.lineTo(-8.6, 3.15);
  wall.closePath();
  const portal = new Path();
  portal.absarc(3.0, 1.7, 1.35, 0, Math.PI * 2, true);
  wall.holes.push(portal);
  const wallMesh = mesh(new ExtrudeGeometry(wall, { depth: 0.34, bevelEnabled: false, curveSegments: 48 }), m.plaster, parent);
  wallMesh.position.z = -7.8;
  const rim = mesh(new TorusGeometry(1.39, 0.075, 6, 64), m.stone, parent);
  rim.position.set(3.0, 1.7, -7.43);
  box(parent, m.stone, [9.95, 0.30, 0.43], [-3.63, 0.15, -7.61]);
  box(parent, m.stone, [4.25, 0.30, 0.43], [6.47, 0.15, -7.61]);
  buildRoof(parent, m, 0, -7.62, 17.9, 1.15, 3.86);

  // Left enclosure is deliberately low so its roof leaves the main view open.
  box(parent, m.plaster, [0.34, 2.5, 10.7], [-8.6, 1.45, -2.55]);
  box(parent, m.stone, [0.45, 0.45, 10.9], [-8.6, 0.23, -2.55]);
  const leftCap = new Group();
  leftCap.position.set(-8.6, 0, -2.55);
  leftCap.rotation.y = Math.PI / 2;
  parent.add(leftCap);
  buildRoof(leftCap, m, 0, 0, 11.3, 1.05, 3.35);
}

function buildHall(parent: Group, m: CourtyardMaterials): void {
  const hall = new Group();
  hall.position.set(-4.55, 0, -9.9);
  parent.add(hall);
  box(hall, m.stone, [7.2, 0.40, 4.3], [0, 0.2, 0]);
  box(hall, m.plaster, [6.8, 3.1, 0.25], [0, 1.95, -1.95]);
  box(hall, m.plaster, [0.25, 3.1, 4.05], [-3.35, 1.95, 0]);
  box(hall, m.plaster, [0.25, 3.1, 4.05], [3.35, 1.95, 0]);
  const amber = new MeshStandardMaterial({ color: 0xc19a58, emissive: 0xe6a94b, emissiveIntensity: 0.52, roughness: 0.95 });
  for (const x of [-2.6, 0, 2.6]) {
    box(hall, amber, [1.6, 1.9, 0.07], [x, 2.0, 1.62]);
    for (const dx of [-0.78, -0.39, 0, 0.39, 0.78]) box(hall, m.wood, [0.045, 2.05, 0.10], [x + dx, 2.0, 1.72]);
    for (const y of [1.06, 1.53, 2.0, 2.47, 2.94]) box(hall, m.wood, [1.65, 0.045, 0.10], [x, y, 1.73]);
  }
  for (const x of [-3.25, -1.1, 1.1, 3.25]) {
    rod(hall, m.wood, new Vector3(x, 0.3, 1.95), new Vector3(x, 3.8, 1.95), 0.13);
    box(hall, m.stone, [0.38, 0.22, 0.38], [x, 0.42, 1.95]);
  }
  box(hall, m.wood, [7.25, 0.22, 0.25], [0, 3.65, 1.93]);
  buildRoof(hall, m, 0, 0, 8.5, 5.55, 5.08);
  const warmLight = new PointLight(0xffce83, 4.5, 9, 2);
  warmLight.position.set(0, 2.4, 2.1);
  hall.add(warmLight);
}

/** A tapered, curved branch with rings oriented along its centreline. */
function taperedBranch(points: Vector3[], radius: number, endRadius: number, detailed = false): BufferGeometry {
  const path = new CatmullRomCurve3(points);
  const segments = detailed ? (radius > 0.08 ? 22 : 13) : 9;
  const sides = detailed ? (radius > 0.14 ? 18 : radius > 0.05 ? 12 : 8) : (radius > 0.08 ? 9 : 6);
  const frames = path.computeFrenetFrames(segments, false);
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring <= segments; ring += 1) {
    const t = ring / segments;
    const centre = path.getPointAt(t);
    const n = frames.normals[ring]!;
    const b = frames.binormals[ring]!;
    const r = (radius + (endRadius - radius) * t) * (1 + 0.09 * (1 - t) ** 6);
    for (let side = 0; side <= sides; side += 1) {
      const angle = side / sides * Math.PI * 2;
      const v = centre.clone().addScaledVector(n, Math.cos(angle) * r).addScaledVector(b, Math.sin(angle) * r);
      vertices.push(v.x, v.y, v.z);
    }
  }
  for (let ring = 0; ring < segments; ring += 1) {
    for (let side = 0; side < sides; side += 1) {
      const a = ring * (sides + 1) + side;
      const b = a + sides + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const result = new BufferGeometry();
  result.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  result.setIndex(indices);
  result.computeVertexNormals();
  return result;
}

function buildTree(seed: string, m: CourtyardMaterials, detailed = false): Group {
  const random = createRandom(`${seed}/tree`);
  const tree = new Group();
  const woodParts: BufferGeometry[] = [];
  const snowParts: BufferGeometry[] = [];
  const grow = (start: Vector3, direction: Vector3, length: number, radius: number, depth: number, parentDirection = direction): void => {
    const end = start.clone().addScaledVector(direction, length);
    const bend = new Vector3(randomBetween(random, -0.23, 0.23), randomBetween(random, 0.0, 0.18), randomBetween(random, -0.24, 0.24));
    const entrance = start.clone().addScaledVector(parentDirection, length * 0.18);
    const middle = start.clone().lerp(end, 0.64).add(bend);
    woodParts.push(taperedBranch([start, entrance, middle, end], radius, radius * 0.46, detailed));
    if (radius > 0.045 && Math.abs(direction.y) < 0.88) {
      const up = new Vector3(0, radius * 0.70, 0);
      const snowStart = start.clone().lerp(middle, 0.14).add(up);
      const snowMiddle = middle.clone().add(up);
      const snowEnd = middle.clone().lerp(end, 0.87).addScaledVector(up, 0.6);
      snowParts.push(taperedBranch([snowStart, snowMiddle, snowEnd], radius * 0.65, radius * 0.27, detailed));
    }
    if (depth === 0) return;
    const count = depth > 2 ? 3 : 2;
    for (let i = 0; i < count; i += 1) {
      const theta = (i / count) * Math.PI * 2 + random() * 1.9;
      const outward = new Vector3(Math.cos(theta), randomBetween(random, 0.22, 0.74), Math.sin(theta));
      const next = direction.clone().multiplyScalar(0.58).addScaledVector(outward, 0.85).normalize();
      grow(end, next, length * randomBetween(random, 0.56, 0.75), radius * 0.52, depth - 1, direction);
    }
  };
  grow(new Vector3(0, 0.0, 0), new Vector3(-0.12, 0.97, -0.12).normalize(), 2.6, 0.25, 4);
  const mergedWood = mergeGeometries(woodParts);
  if (mergedWood) mesh(mergedWood, m.wood, tree);
  const mergedSnow = mergeGeometries(snowParts);
  if (mergedSnow) mesh(mergedSnow, m.snow, tree);
  [...woodParts, ...snowParts].forEach((geometry) => geometry.dispose());
  return tree;
}

function buildRocks(parent: Group, seed: string, m: CourtyardMaterials): void {
  const random = createRandom(`${seed}/rocks`);
  const stoneParts: BufferGeometry[] = [];
  const snowParts: BufferGeometry[] = [];
  const addRock = (x: number, z: number, sx: number, height: number, sz: number): void => {
    const { rock, snow } = createRockPair(sx, height, sz, random() * Math.PI * 2);
    const rotation = random() * Math.PI;
    const base = groundHeight(x, z) + height * 0.13;
    rock.rotateY(rotation);
    rock.translate(x, base, z);
    stoneParts.push(rock);
    snow.rotateY(rotation);
    snow.translate(x, base, z);
    snowParts.push(snow);
  };
  for (let i = 0; i < 22; i += 1) {
    const angle = i / 22 * Math.PI * 2;
    const radius = 1 + random() * 0.12;
    addRock(-1.25 + Math.cos(angle) * 2.5 * radius, 0.9 + Math.sin(angle) * 1.72 * radius,
      randomBetween(random, 0.25, 0.50), randomBetween(random, 0.16, 0.34), randomBetween(random, 0.22, 0.42));
  }
  addRock(-4.17, -3.12, 0.83, 0.62, 0.63);
  addRock(-4.92, -3.72, 0.48, 0.40, 0.41);
  addRock(-5.9, 2.3, 0.67, 0.42, 0.52);
  const stones = mergeGeometries(stoneParts);
  if (stones) mesh(stones, m.stone, parent);
  const snow = mergeGeometries(snowParts);
  if (snow) mesh(snow, m.snow, parent);
  [...stoneParts, ...snowParts].forEach((geometry) => geometry.dispose());
}

function buildPath(parent: Group, seed: string, m: CourtyardMaterials): void {
  const random = createRandom(`${seed}/stepping-stones`);
  for (let i = 0; i < 12; i += 1) {
    const t = i / 11;
    const z = 7.3 - t * 14.4;
    const x = 1.5 + Math.sin(t * Math.PI) * 2.2;
    const width = randomBetween(random, 1.06, 1.42);
    const phase = random() * Math.PI * 2;
    const surface = groundHeight(x, z);
    // Half of the slab lies below the snow surface; only its worn upper rim is
    // exposed, avoiding the previous row of thick blocks sitting above ground.
    const slab = mesh(createRoundedSlab(width, 0.13, 0.83, phase), m.stone, parent);
    slab.position.set(x, surface + 0.005, z);
    slab.rotation.y = randomBetween(random, -0.11, 0.11);
    const cap = mesh(createRoundedSlab(width * 0.93, 0.025, 0.76, phase, 0.012), m.snow, parent);
    cap.position.set(x - 0.01, surface + 0.077, z);
    cap.rotation.y = slab.rotation.y;
  }
  for (let i = 0; i < 3; i += 1) {
    const phase = random() * Math.PI * 2;
    const height = 0.18 + i * 0.10;
    const top = 0.13 + i * 0.10;
    const z = -6.5 - i * 0.44;
    const step = mesh(createRoundedSlab(2.95, height, 0.59, phase, 0.035), m.stone, parent);
    step.position.set(3, top - height * 0.5, z);
    const snow = mesh(createRoundedSlab(2.88, 0.028, 0.53, phase, 0.013), m.snow, parent);
    snow.position.set(3, top + 0.009, z);
  }
}

function buildLantern(parent: Group, m: CourtyardMaterials): void {
  const lantern = new Group();
  lantern.position.set(-5.4, 0, 3.45);
  parent.add(lantern);
  box(lantern, m.stone, [0.70, 0.17, 0.70], [0, 0.10, 0]);
  box(lantern, m.stone, [0.44, 0.75, 0.44], [0, 0.55, 0]);
  box(lantern, m.stone, [0.76, 0.14, 0.76], [0, 0.99, 0]);
  const glow = new MeshStandardMaterial({ color: 0xf2cc8b, emissive: 0xffbd69, emissiveIntensity: 1.6, roughness: 0.85 });
  box(lantern, glow, [0.43, 0.47, 0.43], [0, 1.29, 0]);
  for (const x of [-0.26, 0.26]) for (const z of [-0.26, 0.26]) box(lantern, m.stone, [0.1, 0.65, 0.1], [x, 1.29, z]);
  box(lantern, m.stone, [0.76, 0.13, 0.76], [0, 1.63, 0]);
  const roof = mesh(new CylinderGeometry(0.10, 0.64, 0.40, 4), m.stone, lantern);
  roof.position.y = 1.89;
  roof.rotation.y = Math.PI / 4;
  const snow = mesh(new CylinderGeometry(0.11, 0.64, 0.32, 4), m.snow, lantern);
  snow.position.y = 1.97;
  snow.rotation.y = Math.PI / 4;
  const light = new PointLight(0xffbb68, 4.0, 7, 2);
  light.position.set(0, 1.30, 0);
  lantern.add(light);
}

function buildReeds(parent: Group, seed: string): void {
  const random = createRandom(`${seed}/reeds`);
  const material = new MeshStandardMaterial({ color: 0x847b65, roughness: 0.98 });
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 45; i += 1) {
    const x = -3.6 + random() * 1.25;
    const z = 2.2 + random() * 0.75;
    const height = randomBetween(random, 0.28, 0.68);
    const curve = new CatmullRomCurve3([
      new Vector3(x, 0.03, z),
      new Vector3(x + 0.05, height * 0.65, z - 0.015),
      new Vector3(x + random() * 0.20, height, z - 0.06),
    ]);
    parts.push(new TubeGeometry(curve, 3, 0.0065, 3, false));
  }
  const reeds = mergeGeometries(parts);
  if (reeds) mesh(reeds, material, parent);
  parts.forEach((geometry) => geometry.dispose());
}

function buildDistance(parent: Group, seed: string, m: CourtyardMaterials): void {
  const random = createRandom(`${seed}/distant-hills`);
  const phase = random() * Math.PI * 2;
  // A continuous horizontal heightfield gives mountains depth. It extends beyond
  // the camera frustum and blends into the ground, so no upright board edges show.
  const terrain = new PlaneGeometry(320, 100, 128, 56);
  terrain.rotateX(-Math.PI / 2);
  terrain.translate(0, 0, -70);
  const positions = terrain.getAttribute('position');
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i);
    const distance = -positions.getZ(i);
    const frontBlend = Math.max(0, Math.min(1, (distance - 20) / 12));
    const smoothBlend = frontBlend * frontBlend * (3 - 2 * frontBlend);
    const nearRidge = (6.5 + Math.sin(x * 0.071 + phase) * 3.0 + Math.sin(x * 0.17 + 1.2) * 1.8)
      * Math.exp(-(((distance - 43) / 13) ** 2));
    const farRidge = (13.0 + Math.sin(x * 0.048 + phase + 1.6) * 5.2 + Math.sin(x * 0.094) * 2.5)
      * Math.exp(-(((distance - 78) / 21) ** 2));
    const detail = Math.sin(x * 0.31 + distance * 0.19) * Math.sin(distance * 0.32) * 0.16;
    positions.setY(i, -0.03 + (Math.max(nearRidge, farRidge) + detail) * smoothBlend);
  }
  terrain.computeVertexNormals();
  const mountainMaterial = new MeshStandardMaterial({ color: 0x8fa3a8, roughness: 1 });
  const mountains = mesh(terrain, mountainMaterial, parent);
  mountains.name = 'continuous-distant-terrain';
  mountains.castShadow = false;
  mountains.receiveShadow = false;

  // Keep distant roots behind the enclosure. Previously tall isolated trunks in
  // the open, unshadowed snow read as floating against the distant mountains.
  const distantPositions = [[-7, -14.5], [-2.5, -15.8], [6.2, -14.2]] as const;
  for (let i = 0; i < distantPositions.length; i += 1) {
    const [x, z] = distantPositions[i]!;
    const tree = buildTree(`${seed}/distant/${i}`, m);
    tree.position.set(x, -0.04, z);
    tree.scale.setScalar(randomBetween(random, 0.86, 1.10));
    parent.add(tree);
  }
}

export function buildCourtyard(seed: string, m: CourtyardMaterials): CourtyardGeometry {
  const group = new Group();
  group.name = 'procedural-snow-courtyard';
  const ground = new PlaneGeometry(140, 140, 100, 100);
  ground.rotateX(-Math.PI / 2);
  const vertices = ground.getAttribute('position');
  for (let i = 0; i < vertices.count; i += 1) {
    const x = vertices.getX(i);
    const z = vertices.getZ(i);
    vertices.setY(i, groundHeight(x, z));
  }
  ground.computeVertexNormals();
  const groundMesh = mesh(ground, m.snow, group);
  groundMesh.castShadow = false;
  buildHall(group, m);
  buildWalls(group, m);
  buildPath(group, seed, m);
  buildRocks(group, seed, m);
  buildLantern(group, m);
  buildReeds(group, seed);
  buildDistance(group, seed, m);
  const tree = buildTree(seed, m, true);
  // Place the main tree beside the pond, leaving the stepping-stone path and
  // moon gate clear from the authored eye-level camera.
  tree.position.set(-4.45, 0, -3.6);
  tree.rotation.y = -0.45;
  group.add(tree);
  const waterMaterial = new MeshStandardMaterial({ color: 0x536d77, roughness: 0.23, metalness: 0.36, envMapIntensity: 1.3 });
  const water = mesh(new CircleGeometry(1, 72), waterMaterial, group);
  water.rotation.x = -Math.PI / 2;
  water.scale.set(2.43, 1.62, 1);
  water.position.set(-1.25, 0.075, 0.9);
  water.castShadow = false;
  group.userData.staticBatchStats = mergeStaticMeshes(group, new Set([tree, water]));
  return { group, tree, water };
}
