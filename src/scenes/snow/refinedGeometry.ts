import { BufferGeometry, SphereGeometry } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/** The same low snow drift profile used by the courtyard ground. */
export function groundHeight(x: number, z: number): number {
  return 0.014 + Math.sin(x * 0.42 + z * 0.19) * 0.028 + Math.sin(x * 0.89 - z * 0.51) * 0.018;
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
