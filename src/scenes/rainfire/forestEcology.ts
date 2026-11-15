import { ClampToEdgeWrapping, DataTexture, LinearFilter, RGBAFormat, UnsignedByteType } from 'three';
import { createRandom, hashSeed } from '../../core/random';

export const ECOLOGY_BOUNDS = { minX: -16, minZ: -30, width: 32, depth: 38 };
const RESOLUTION = 224;

/** Root collars and the down-slope sides of the existing fallen wood. */
export const FOREST_ORGANIC_POCKETS: readonly (readonly [number, number, number])[] = [
  [-5.15, -2.5, 2.2], [5.85, -6.65, 2.5], [-7.2, -14, 2.7], [8.9, -16.4, 2.7],
  [-4.7, -8.9, 1.65], [5.3, -10.6, 1.8], [-3.8, -20.1, 1.7],
  [-2.6, -4.1, 1.1], [3.55, -7.9, 1.25], [-4.8, 3.2, 1.25],
  [-2.1, 1.1, .85], [2.8, -.35, .9], [-4.8, -16.3, 1.7],
  [-2.65, -5.2, 1.5], [.85, -7.4, 1.6], [-3.4, -12.0, 1.85],
  [-.25, 1.25, .52], [1.7, -.15, .60],
];

export interface EcologySample {
  organicCover: number;
  compactedPath: number;
  rootInfluence: number;
  mossCover: number;
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (lo: number, hi: number, x: number) => {
  const t = clamp((x - lo) / (hi - lo)); return t * t * (3 - 2 * t);
};
function hash(x: number, z: number, salt: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ salt;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise(x: number, z: number, salt: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), u = smooth(0, 1, x - ix), v = smooth(0, 1, z - iz);
  const a = hash(ix, iz, salt), b = hash(ix + 1, iz, salt);
  const c = hash(ix, iz + 1, salt), d = hash(ix + 1, iz + 1, salt);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function segmentDistanceSquared(x: number, z: number, a: readonly number[], b: readonly number[]): number {
  const dx = b[0]! - a[0]!, dz = b[1]! - a[1]!;
  const t = clamp(((x - a[0]!) * dx + (z - a[1]!) * dz) / (dx * dx + dz * dz));
  return (x - a[0]! - dx * t) ** 2 + (z - a[1]! - dz * t) ** 2;
}

/**
 * One metre-based ecology field drives both soil shading and geometric deposits.
 * CPU consumers bilinearly sample the same grid that the material receives as a
 * runtime texture. RGBA = organic litter / foot traffic / roots / moss colonies.
 */
export function createForestEcology(seed: string): {
  sample(x: number, z: number): EcologySample;
  createTexture(): DataTexture;
} {
  const random = createRandom(`${seed}/forest-ecology`), salt = hashSeed(`${seed}/forest-ecology`);
  const ox = random() * 49, oz = random() * 49;
  const path: [number, number][] = [];
  for (let i = 0; i <= 20; i += 1) {
    const t = i / 20, u = 1 - t;
    path.push([u ** 3 - 1.5 * u * u * t - 4.65 * u * t * t - .8 * t ** 3, 4.5 - 6.1 * t]);
  }
  const data = new Uint8Array(RESOLUTION * RESOLUTION * 4);
  for (let row = 0; row < RESOLUTION; row += 1) {
    const z = ECOLOGY_BOUNDS.minZ + row / (RESOLUTION - 1) * ECOLOGY_BOUNDS.depth;
    for (let col = 0; col < RESOLUTION; col += 1) {
      const x = ECOLOGY_BOUNDS.minX + col / (RESOLUTION - 1) * ECOLOGY_BOUNDS.width;
      let root = 0, distance = Infinity;
      for (const [rx, rz, radius] of FOREST_ORGANIC_POCKETS) {
        root = Math.max(root, Math.exp(-((x - rx) ** 2 + (z - rz) ** 2) / (radius * radius * .72)));
      }
      for (let i = 1; i < path.length; i += 1) distance = Math.min(distance,
        segmentDistanceSquared(x, z, path[i - 1]!, path[i]!));
      const broad = noise(x * .37 + ox, z * .37 + oz, salt);
      const seams = noise(x * 1.62 + ox, z * 1.62 + oz, salt + 37);
      const pathWidth = .30 + broad * .21;
      const compact = Math.exp(-distance / (pathWidth * pathWidth))
        * (.82 + noise(x * 2.2 + ox, z * 2.2 + oz, salt + 79) * .18);
      const organic = smooth(.19, .81, .10 + broad * .34 + seams * .17 + root * .65 - compact * .92);
      const moss = organic * smooth(.18, .78, root)
        * smooth(.39, .76, noise(x * 1.25 + ox, z * 1.25 + oz, salt + 131)) * (1 - compact);
      const at = (row * RESOLUTION + col) * 4;
      data[at] = Math.round(organic * 255);
      data[at + 1] = Math.round(compact * 255);
      data[at + 2] = Math.round(root * 255);
      data[at + 3] = Math.round(moss * 255);
    }
  }
  const sample = (x: number, z: number): EcologySample => {
    const px = clamp((x - ECOLOGY_BOUNDS.minX) / ECOLOGY_BOUNDS.width) * (RESOLUTION - 1);
    const pz = clamp((z - ECOLOGY_BOUNDS.minZ) / ECOLOGY_BOUNDS.depth) * (RESOLUTION - 1);
    const ix = Math.floor(px), iz = Math.floor(pz), u = px - ix, v = pz - iz;
    const ix1 = Math.min(ix + 1, RESOLUTION - 1), iz1 = Math.min(iz + 1, RESOLUTION - 1);
    const value = (channel: number) => {
      const a = data[(iz * RESOLUTION + ix) * 4 + channel]!;
      const b = data[(iz * RESOLUTION + ix1) * 4 + channel]!;
      const c = data[(iz1 * RESOLUTION + ix) * 4 + channel]!;
      const d = data[(iz1 * RESOLUTION + ix1) * 4 + channel]!;
      return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) / 255;
    };
    return { organicCover: value(0), compactedPath: value(1), rootInfluence: value(2), mossCover: value(3) };
  };
  return {
    sample,
    createTexture() {
      const texture = new DataTexture(data, RESOLUTION, RESOLUTION, RGBAFormat, UnsignedByteType);
      texture.name = 'generated-shared-forest-ecology';
      texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
      texture.minFilter = texture.magFilter = LinearFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      return texture;
    },
  };
}
