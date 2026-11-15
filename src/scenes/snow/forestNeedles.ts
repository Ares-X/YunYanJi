import {
  DataTexture, DoubleSide, LinearFilter, LinearMipmapLinearFilter,
  MeshStandardMaterial, RGBAFormat, SRGBColorSpace, UnsignedByteType,
} from 'three';
import { createRandom, randomBetween } from '../../core/random';

const SIZE = 512;
interface TextureEntry { texture: DataTexture; references: number }
const textures = new Map<string, TextureEntry>();

/** Rasterise algorithmic shoots and needles once, in a physical 0.48 × 0.90 m patch. */
function generateNeedleTexture(seed: string): DataTexture {
  const random = createRandom(`${seed}/fir-needles`);
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  const blend = (x: number, y: number, alpha: number, red: number, green: number, blue: number): void => {
    const at = (y * SIZE + x) * 4;
    const prior = rgba[at + 3]! / 255;
    const combined = alpha + prior * (1 - alpha);
    if (combined <= 0) return;
    rgba[at] = (red * alpha + rgba[at]! * prior * (1 - alpha)) / combined;
    rgba[at + 1] = (green * alpha + rgba[at + 1]! * prior * (1 - alpha)) / combined;
    rgba[at + 2] = (blue * alpha + rgba[at + 2]! * prior * (1 - alpha)) / combined;
    rgba[at + 3] = combined * 255;
  };
  // Antialiased, tapered capsules in metre coordinates. Needle widths remain
  // two to four millimetres; the card gains density through branching, not fat leaves.
  const segment = (x0: number, y0: number, x1: number, y1: number, width: number,
    color: readonly [number, number, number], taper = 0.15): void => {
    const ax = (x0 / 0.48 + 0.5) * SIZE;
    const ay = y0 / 0.90 * SIZE;
    const bx = (x1 / 0.48 + 0.5) * SIZE;
    const by = y1 / 0.90 * SIZE;
    const dx = bx - ax, dy = by - ay;
    const squared = dx * dx + dy * dy;
    if (squared < 0.01) return;
    const radius = width / 0.65 * SIZE * 0.5;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx) - radius - 1));
    const maxX = Math.min(SIZE - 1, Math.ceil(Math.max(ax, bx) + radius + 1));
    const minY = Math.max(0, Math.floor(Math.min(ay, by) - radius - 1));
    const maxY = Math.min(SIZE - 1, Math.ceil(Math.max(ay, by) + radius + 1));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const t = Math.max(0, Math.min(1, ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / squared));
      const distance = Math.hypot(x + 0.5 - ax - dx * t, y + 0.5 - ay - dy * t);
      const localRadius = radius * (1 - t * (1 - taper));
      const coverage = Math.max(0, Math.min(1, localRadius + 0.75 - distance));
      if (coverage <= 0) continue;
      // A convex needle catches a narrow highlight; varied tips do not form flat green planes.
      const ridge = 0.77 + 0.28 * Math.max(0, 1 - distance / Math.max(0.6, localRadius)) + t * 0.09;
      blend(x, y, coverage, color[0] * ridge, color[1] * ridge, color[2] * ridge);
    }
  };
  const needlesAlong = (ax: number, ay: number, bx: number, by: number, count: number, vigor: number): void => {
    const length = Math.hypot(bx - ax, by - ay);
    const dx = (bx - ax) / length, dy = (by - ay) / length;
    for (let i = 0; i < count; i++) {
      const t = (i + randomBetween(random, 0.1, 0.9)) / count;
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      for (const sign of [-1, 1]) {
        const side = sign * randomBetween(random, 0.75, 1.05);
        const forward = randomBetween(random, 0.35, 0.72);
        const norm = Math.hypot(side, forward);
        const needleLength = randomBetween(random, 0.027, 0.055) * vigor * (1 - t * 0.18);
        const nx = (dx * forward - dy * side) / norm;
        const ny = (dy * forward + dx * side) / norm;
        const shade = randomBetween(random, 0.76, 1.20);
        segment(x, y, x + nx * needleLength, y + ny * needleLength,
          randomBetween(random, 0.0020, 0.0035), [43 * shade, 66 * shade, 45 * shade], 0.03);
      }
    }
  };

  // The irregular main axis and paired, feather-like shoots carry another order
  // of short twigs. Around 1,400 needles resolve into small pockets of dark foliage.
  for (let k = 0; k < 16; k++) {
    const t = k / 15;
    const x0 = Math.sin(t * 4.7 + 0.6) * 0.011;
    const x1 = Math.sin((t + 1 / 15) * 4.7 + 0.6) * 0.011;
    segment(x0, 0.035 + t * 0.79, x1, 0.035 + (t + 1 / 15) * 0.79,
      0.007 * (1 - t * 0.75), [69, 63, 42], 0.7);
  }
  for (let level = 0; level < 13; level++) {
    const t = (level + 0.2) / 13;
    for (const sign of [-1, 1]) {
      const startY = 0.08 + t * 0.69 + randomBetween(random, -0.012, 0.012);
      const startX = Math.sin(t * 4.7 + 0.6) * 0.011;
      const spread = 0.17 * Math.sin((0.16 + t * 0.82) * Math.PI) ** 0.58 * randomBetween(random, 0.85, 1.10);
      const endX = startX + sign * spread;
      const endY = startY + randomBetween(random, 0.065, 0.14) * (1 - t * 0.45);
      segment(startX, startY, endX, endY, 0.0036, [61, 62, 41], 0.20);
      needlesAlong(startX, startY, endX, endY, 12, 1);
      const dx = endX - startX, dy = endY - startY;
      const len = Math.hypot(dx, dy);
      for (let branch = 0; branch < 6; branch++) {
        const at = 0.18 + branch / 6 * 0.72;
        const side = branch % 2 ? 1 : -1;
        const x = startX + dx * at, y = startY + dy * at;
        const tipX = x + dx * 0.24 - dy / len * side * randomBetween(random, 0.025, 0.054);
        const tipY = y + dy * 0.24 + dx / len * side * randomBetween(random, 0.025, 0.054);
        segment(x, y, tipX, tipY, 0.0019, [51, 58, 37], 0.15);
        needlesAlong(x, y, tipX, tipY, 5, randomBetween(random, 0.65, 0.86));
      }
    }
  }
  needlesAlong(0.003, 0.72, 0.008, 0.88, 18, 0.85);

  // Expand only RGB into transparent neighbours, keeping alpha exactly empty.
  // This prevents dark seams from bilinear filtering around fine needles.
  for (let pass = 0; pass < 4; pass++) {
    const copy = rgba.slice();
    for (let y = 1; y < SIZE - 1; y++) for (let x = 1; x < SIZE - 1; x++) {
      const at = (y * SIZE + x) * 4;
      if (copy[at + 3]! > 0 || copy[at + 1]! > 0) continue;
      for (const offset of [-SIZE, SIZE, -1, 1]) {
        const other = at + offset * 4;
        if (copy[other + 1]! > 0) {
          rgba[at] = copy[other]!; rgba[at + 1] = copy[other + 1]!; rgba[at + 2] = copy[other + 2]!;
          break;
        }
      }
    }
  }
  const texture = new DataTexture(rgba, SIZE, SIZE, RGBAFormat, UnsignedByteType);
  texture.name = 'runtime-fractal-fir-needles';
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** The material owns one cached generated texture reference; dispose it normally. */
export function createForestNeedleMaterial(seed: string): MeshStandardMaterial {
  let entry = textures.get(seed);
  if (!entry) {
    entry = { texture: generateNeedleTexture(seed), references: 0 };
    textures.set(seed, entry);
  }
  entry.references++;
  const owned = entry;
  const material = new MeshStandardMaterial({
    name: 'procedural-fir-needle-clusters',
    color: '#ffffff', map: owned.texture, roughness: 0.88, metalness: 0,
    side: DoubleSide, alphaTest: 0.20, alphaToCoverage: true, envMapIntensity: 0.60,
  });
  material.userData.ownsProceduralTexture = true;
  let disposed = false;
  material.addEventListener('dispose', () => {
    if (disposed) return;
    disposed = true;
    owned.references--;
    if (owned.references === 0) { owned.texture.dispose(); textures.delete(seed); }
  });
  return material;
}
