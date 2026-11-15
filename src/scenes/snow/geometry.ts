import {
  BufferGeometry, CatmullRomCurve3, Color, Float32BufferAttribute, Group, Mesh,
  MeshStandardMaterial, PlaneGeometry, TubeGeometry, Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRandom, randomBetween } from '../../core/random';
import { createRockPair, createRoundedSlab, createSteppingStone, groundHeight } from './refinedGeometry';
import { mergeStaticMeshes } from './mergeStaticMeshes';
import { buildCourtyardArchitecture } from './courtyardArchitecture';
import { buildWinterTree } from './winterTree';
import { createProceduralPond, POND, pondRadius } from './ProceduralPond';
import type { QualityLevel } from '../../core/types';

export interface CourtyardMaterials {
  snow: MeshStandardMaterial;
  stone: MeshStandardMaterial;
  wood: MeshStandardMaterial;
  bark: MeshStandardMaterial;
  plaster: MeshStandardMaterial;
  tile: MeshStandardMaterial;
}

export interface CourtyardGeometry {
  group: Group;
  tree: Group;
  pond: ReturnType<typeof createProceduralPond>;
}

function mesh(geometry: BufferGeometry, material: MeshStandardMaterial, parent: Group): Mesh {
  const result = new Mesh(geometry, material);
  result.castShadow = true;
  result.receiveShadow = true;
  parent.add(result);
  return result;
}

function buildRocks(parent: Group, seed: string, m: CourtyardMaterials): void {
  const random = createRandom(`${seed}/rocks`);
  const stoneParts: BufferGeometry[] = [];
  const snowParts: BufferGeometry[] = [];
  const addRock = (x: number, z: number, sx: number, height: number, sz: number): void => {
    const { rock, snow } = createRockPair(sx, height, sz, random() * Math.PI * 2);
    const rotation = random() * Math.PI;
    const base = groundHeight(x, z) - height * 0.21;
    rock.rotateY(rotation);
    rock.translate(x, base, z);
    stoneParts.push(rock);
    snow.rotateY(rotation);
    snow.translate(x, base, z);
    snowParts.push(snow);
  };
  // Unequal clusters leave stretches of soft snow bank between exposed stones.
  // A continuous necklace of equal boulders made the water look ornamental.
  for (const angle of [-2.94, -2.72, -2.43, -1.68, -1.43, -0.28, -0.02, 0.22, 0.91, 1.10, 1.37, 2.19, 2.43]) {
    const radius = pondRadius(angle) + randomBetween(random, 0.04, 0.14);
    addRock(POND.x + Math.cos(angle) * POND.rx * radius, POND.z - Math.sin(angle) * POND.rz * radius,
      randomBetween(random, 0.18, 0.44), randomBetween(random, 0.10, 0.26), randomBetween(random, 0.16, 0.35));
  }
  addRock(-4.17, -3.12, 0.83, 0.62, 0.63);
  addRock(-4.92, -3.72, 0.48, 0.40, 0.41);
  addRock(-3.95, 2.18, 0.67, 0.43, 0.52);
  addRock(-4.4, 2.37, 0.36, 0.25, 0.31);
  addRock(-3.65, 2.74, 0.30, 0.19, 0.29);
  addRock(0.05, -12.3, 0.68, 0.44, 0.52);
  addRock(-0.55, -12.55, 0.35, 0.25, 0.32);
  const stones = mergeGeometries(stoneParts);
  if (stones) mesh(stones, m.stone, parent);
  const snow = mergeGeometries(snowParts);
  if (snow) mesh(snow, m.snow, parent);
  [...stoneParts, ...snowParts].forEach((geometry) => geometry.dispose());
}

function buildPath(parent: Group, seed: string, m: CourtyardMaterials): void {
  const random = createRandom(`${seed}/stepping-stones`);
  for (let i = 0; i < 23; i += 1) {
    const t = i / 22;
    const z = 16.2 - t * 22.2 + randomBetween(random, -0.09, 0.09);
    const x = -3.8 + t * 6.8 + Math.sin(t * Math.PI) * 1.5 + randomBetween(random, -0.13, 0.13);
    const width = randomBetween(random, 0.87, 1.31);
    const depth = randomBetween(random, 0.65, 0.85);
    const phase = random() * Math.PI * 2;
    const surface = groundHeight(x, z);
    const { stone, snow } = createSteppingStone(width, depth, phase);
    const slab = mesh(stone, m.stone, parent);
    // Only a few millimetres of the weathered lip emerge from the drifting snow.
    slab.position.set(x, surface - randomBetween(random, 0.018, 0.034), z);
    slab.rotation.y = randomBetween(random, -0.19, 0.19);
    const cap = mesh(snow, m.snow, parent);
    cap.position.copy(slab.position);
    cap.rotation.copy(slab.rotation);
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
  // The route continues through the opening and bends gently out of sight.
  for (let i = 0; i < 13; i += 1) {
    const z = -8.25 - i * 0.83;
    const x = 3 - i * 0.20 + Math.sin(i * 0.35) * 0.18;
    const phase = random() * Math.PI * 2;
    const pieces = createSteppingStone(randomBetween(random, 0.78, 0.98), 0.61, phase);
    const slab = mesh(pieces.stone, m.stone, parent);
    slab.position.set(x, groundHeight(x, z) - 0.022, z);
    slab.rotation.y = randomBetween(random, -0.25, 0.06);
    const snow = mesh(pieces.snow, m.snow, parent);
    snow.position.copy(slab.position);
    snow.rotation.copy(slab.rotation);
  }
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
  const hash = (x: number, z: number): number => {
    const value = Math.sin(x * 127.1 + z * 311.7 + phase * 17.1) * 43758.5453;
    return value - Math.floor(value);
  };
  const noise = (x: number, z: number): number => {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    return (hash(ix, iz) * (1 - u) + hash(ix + 1, iz) * u) * (1 - v)
      + (hash(ix, iz + 1) * (1 - u) + hash(ix + 1, iz + 1) * u) * v;
  };
  // A continuous horizontal heightfield gives mountains depth. It extends beyond
  // the camera frustum and blends into the ground, so no upright board edges show.
  const terrain = new PlaneGeometry(320, 130, 192, 72);
  terrain.rotateX(-Math.PI / 2);
  terrain.translate(0, 0, -85);
  const positions = terrain.getAttribute('position');
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i);
    const distance = -positions.getZ(i);
    const frontBlend = Math.max(0, Math.min(1, (distance - 20) / 12));
    const smoothBlend = frontBlend * frontBlend * (3 - 2 * frontBlend);
    const nearRidge = (3.5 + noise(x * 0.045, 7.4) ** 1.6 * 7.2 + noise(x * 0.18, 2.7) * 0.95)
      * Math.exp(-(((distance - 43 + noise(x * 0.08, 1.7) * 9) / 11) ** 2));
    const farRidge = (7.5 + noise(x * 0.026, 14.8) ** 1.4 * 12.0 + noise(x * 0.12, 8.3) * 1.65)
      * Math.exp(-(((distance - 79 + noise(x * 0.04, 8.4) * 13) / 19) ** 2));
    const detail = (noise(x * 0.26, distance * 0.22) - 0.5) * 0.85
      + (noise(x * 0.61, distance * 0.56) - 0.5) * 0.20;
    positions.setY(i, -0.03 + (Math.max(nearRidge, farRidge) + detail) * smoothBlend);
  }
  terrain.computeVertexNormals();
  const colors: number[] = [];
  const dark = new Color('#627b82');
  const pale = new Color('#bdcbd0');
  const color = new Color();
  const normals = terrain.getAttribute('normal');
  for (let i = 0; i < positions.count; i += 1) {
    const y = positions.getY(i);
    const x = positions.getX(i);
    const z = positions.getZ(i);
    const cover = Math.max(0, normals.getY(i) - 0.4) * 0.65 + y / 32
      + (noise(x * 0.18, z * 0.16) - 0.5) * 0.28;
    color.copy(dark).lerp(pale, Math.min(1, Math.max(0, cover)));
    colors.push(color.r, color.g, color.b);
  }
  terrain.setAttribute('color', new Float32BufferAttribute(colors, 3));
  const mountainMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 1, vertexColors: true });
  const mountains = mesh(terrain, mountainMaterial, parent);
  mountains.name = 'continuous-distant-terrain';
  mountains.castShadow = false;
  mountains.receiveShadow = false;

  // Keep distant roots behind the enclosure. Previously tall isolated trunks in
  // the open, unshadowed snow read as floating against the distant mountains.
  const distantPositions = [[-7, -15.5], [-2.6, -19.8], [5.8, -16.7], [-2.5, -23.0], [10.8, -23.5], [-10.7, -26.2]] as const;
  for (let i = 0; i < distantPositions.length; i += 1) {
    const [x, z] = distantPositions[i]!;
    const tree = buildWinterTree(`${seed}/distant/${i}`, { wood: m.bark, snow: m.snow });
    tree.position.set(x, groundHeight(x, z), z);
    tree.scale.setScalar(randomBetween(random, 0.64, 0.88));
    parent.add(tree);
  }
}

export function buildCourtyard(seed: string, m: CourtyardMaterials, quality: QualityLevel): CourtyardGeometry {
  const group = new Group();
  group.name = 'procedural-snow-courtyard';
  const ground = new PlaneGeometry(2, 2, 192, 192);
  ground.rotateX(-Math.PI / 2);
  const vertices = ground.getAttribute('position');
  for (let i = 0; i < vertices.count; i += 1) {
    const u = vertices.getX(i);
    const v = vertices.getZ(i);
    const x = Math.sign(u) * Math.abs(u) ** 1.8 * 70;
    const z = Math.sign(v) * Math.abs(v) ** 1.8 * 70;
    vertices.setXYZ(i, x, groundHeight(x, z), z);
  }
  ground.computeVertexNormals();
  const groundMesh = mesh(ground, m.snow, group);
  groundMesh.castShadow = false;
  buildCourtyardArchitecture(group, seed, m);
  buildPath(group, seed, m);
  buildRocks(group, seed, m);
  buildReeds(group, seed);
  buildDistance(group, seed, m);
  const tree = buildWinterTree(seed, { wood: m.bark, snow: m.snow }, true);
  // Place the main tree beside the pond, leaving the stepping-stone path and
  // moon gate clear from the authored eye-level camera.
  tree.position.set(-3.9, 0, -3.2);
  tree.scale.set(1.12, 1.23, 1.1);
  tree.rotation.y = -0.45;
  group.add(tree);
  const pond = createProceduralPond(seed, quality);
  group.add(pond.mesh);
  group.userData.staticBatchStats = mergeStaticMeshes(group, new Set([tree, pond.mesh]));
  return { group, tree, pond };
}
