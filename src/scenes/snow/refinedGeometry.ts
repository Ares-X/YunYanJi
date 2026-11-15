import { BufferGeometry, Float32BufferAttribute, SphereGeometry } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { POND, pondRadius } from './ProceduralPond';

/** The same low snow drift profile used by the courtyard ground. */
export function groundHeight(x: number, z: number): number {
  const drift = Math.sin(x * 0.52 + z * 0.27) * 0.023 + Math.sin(x * 1.09 - z * 0.66) * 0.012;
  const wallDrift = Math.exp(-(((z + 7.30) / 0.54) ** 2)) * 0.085
    + Math.exp(-(((x + 8.35) / 0.70) ** 2)) * 0.09;
  const lowRidges = Math.sin(x * 0.72 - z * 0.31 + Math.sin(z * 0.42)) ** 2 * 0.022;
  const nx = (x - POND.x) / POND.rx;
  const nz = -(z - POND.z) / POND.rz;
  const shore = Math.hypot(nx, nz) / pondRadius(Math.atan2(nz, nx));
  const edge = Math.min(1, Math.max(0, (shore - 0.82) / 0.28));
  const depression = (1 - edge * edge * (3 - 2 * edge)) * 0.27;
  return 0.030 + drift + lowRidges + wallDrift - depression;
}

function smoothGeometry(geometry: BufferGeometry): BufferGeometry {
  // Weld coincident seam/pole vertices before recalculating smooth normals.
  geometry.deleteAttribute('uv');
  geometry.deleteAttribute('normal');
  const result = mergeVertices(geometry, 0.00001);
  result.computeVertexNormals();
  geometry.dispose();
  return result;
}

function rockRadius(x: number, y: number, z: number, phase: number): number {
  return 1 + Math.sin(x * 3.1 + z * 1.8 + phase) * Math.cos(y * 2.4 - phase * 0.4) * 0.10
    + Math.sin(x * 5.2 - y * 3.3 + z * 2.7 + phase * 1.7) * 0.042
    + Math.sin(z * 8.2 + y * 4.1 + phase * 0.7) * Math.cos(x * 6.2 - phase) * 0.016;
}

/** Smooth rock and a snow blanket that follows the exact same rock surface. */
export function createRockPair(sx: number, height: number, sz: number, phase: number): { rock: BufferGeometry; snow: BufferGeometry } {
  const rock = new SphereGeometry(1, 32, 20);
  const position = rock.getAttribute('position');
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const r = rockRadius(x, y, z, phase);
    position.setXYZ(i, x * r * sx, y * r * height, z * r * sz);
  }

  const snow = new SphereGeometry(1, 32, 12, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const snowPositions = snow.getAttribute('position');
  const snowUV = snow.getAttribute('uv');
  for (let i = 0; i < snowPositions.count; i += 1) {
    const phi = snowUV.getX(i) * Math.PI * 2;
    const t = Math.acos(Math.max(-1, Math.min(1, snowPositions.getY(i)))) / (Math.PI * 0.5);
    const edge = Math.PI * (0.42 + Math.sin(phi * 3 + phase) * 0.035 + Math.sin(phi * 7 - phase) * 0.016);
    const theta = t * edge;
    const x = -Math.cos(phi) * Math.sin(theta);
    const y = Math.cos(theta);
    const z = Math.sin(phi) * Math.sin(theta);
    const r = rockRadius(x, y, z, phase);
    const feather = Math.min(1, (1 - t) / 0.24);
    const thickness = 0.003 + (0.018 + height * 0.025) * feather * (0.92 + Math.sin(phi * 2 + phase) * Math.sin(theta) * 0.08);
    snowPositions.setXYZ(i, x * (r + 0.002) * sx, y * r * height + thickness, z * (r + 0.002) * sz);
  }
  return { rock: smoothGeometry(rock), snow: smoothGeometry(snow) };
}

/** Worn corners and slow boundary variation rather than randomly jittered faces. */
export function createRoundedSlab(width: number, height: number, depth: number, phase: number, radius = 0.045): BufferGeometry {
  const geometry = new RoundedBoxGeometry(width, height, depth, 3, Math.min(radius, height * 0.45));
  const positions = geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);
    const nx = x / (width * 0.5);
    const nz = z / (depth * 0.5);
    positions.setXYZ(i,
      x + Math.sin(nz * 3.4 + phase) * 0.012 * Math.abs(nx),
      y + Math.sin(nx * 2.2 + nz * 2.8 + phase) * 0.0025,
      z + Math.sin(nx * 4.1 - phase * 0.7) * 0.011 * Math.abs(nz));
  }
  return smoothGeometry(geometry);
}

/** A worn flagstone and its soft, wind-loaded cover share the same irregular rim. */
export function createSteppingStone(width: number, depth: number, phase: number): { stone: BufferGeometry; snow: BufferGeometry } {
  const segments = 64;
  const outline = (angle: number, radius: number): [number, number] => {
    const c = Math.cos(angle), s = Math.sin(angle);
    const worn = 1 + Math.sin(angle * 3 + phase) * 0.055 + Math.sin(angle * 7 - phase) * 0.022;
    return [Math.sign(c) * Math.abs(c) ** 0.32 * width * 0.5 * radius * worn,
      Math.sign(s) * Math.abs(s) ** 0.32 * depth * 0.5 * radius * worn];
  };
  const make = (cover: boolean): BufferGeometry => {
    const positions: number[] = [], indices: number[] = [];
    const radii = cover ? [0, 0.24, 0.48, 0.71, 0.88, 0.97, 1.025] : [0, 0.28, 0.55, 0.8, 0.96, 1.0, 0.97];
    for (let ring = 0; ring < radii.length; ring += 1) {
      const radius = radii[ring]!;
      for (let j = 0; j < segments; j += 1) {
        const angle = j / segments * Math.PI * 2;
        const [x, z] = outline(angle, radius);
        const warp = Math.sin(x * 2.8 + z * 2 + phase) * 0.005;
        let y: number;
        if (cover) {
          const feather = Math.max(0, 1 - radius ** 4);
          const load = 0.017 + (Math.sin(angle - phase) * 0.5 + 0.5) * radius * 0.018;
          y = 0.037 + warp + feather * load;
          // The outer powder rolls over the edge instead of ending as a second slab.
          if (ring === radii.length - 1) y -= 0.012 + (0.5 + Math.sin(angle * 3 + phase) * 0.5) * 0.011;
        } else {
          y = ring === radii.length - 1 ? -0.035 : ring === radii.length - 2 ? 0.018 : 0.035 + warp;
        }
        positions.push(x, y, z);
      }
    }
    for (let r = 0; r < radii.length - 1; r += 1) for (let j = 0; j < segments; j += 1) {
      const a = r * segments + j, b = r * segments + (j + 1) % segments;
      const c = a + segments, d = b + segments;
      // Clockwise in x/z is upward in world space.
      if (r > 0) indices.push(a, b, c);
      indices.push(b, d, c);
    }
    if (!cover) {
      const center = positions.length / 3, last = (radii.length - 1) * segments;
      positions.push(0, -0.035, 0);
      for (let j = 0; j < segments; j += 1) indices.push(center, last + j, last + (j + 1) % segments);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    return smoothGeometry(geometry);
  };
  return { stone: make(false), snow: make(true) };
}
