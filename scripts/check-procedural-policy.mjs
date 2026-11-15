import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const ignored = new Set(['.git', 'node_modules', 'dist', 'coverage', 'test-results', 'playwright-report']);
const fixedAssets = /\.(png|jpe?g|webp|gif|avif|svg|bmp|ico|hdr|exr|ktx2?|basis|mp3|wav|ogg|aac|flac|m4a|mp4|webm|glb|gltf|fbx|obj|woff2?|ttf|otf)$/i;
const violations = [];
const rules = [
  [/\b(?:TextureLoader|ImageLoader|ImageBitmapLoader|CubeTextureLoader|RGBELoader|EXRLoader|GLTFLoader|AudioLoader)\b/, 'fixed-asset loader'],
  [/data:(?:image|audio|video|font)\//i, 'embedded fixed asset'],
  [/https?:\/\//i, 'external runtime dependency'],
  [/\b(?:fetch|atob)\s*\(/, 'remote or encoded runtime content'],
  [/new\s+(?:Image|Audio)\s*\(/, 'media element loader'],
  [/<(?:img|audio|video|iframe)\b/i, 'external media element'],
];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await visit(path); continue; }
    const file = relative(root, path).replaceAll('\\', '/');
    if (fixedAssets.test(file)) violations.push(`${file}: pre-authored media/model/font asset`);
    if (!(file.startsWith('src/') || file.startsWith('public/') || file === 'index.html')) continue;
    if (!['.ts', '.js', '.css', '.html'].includes(extname(file))) continue;
    const source = await readFile(path, 'utf8');
    for (const [pattern, reason] of rules) if (pattern.test(source)) violations.push(`${file}: ${reason}`);
    if (extname(file) === '.css' && /url\s*\(/i.test(source)) violations.push(`${file}: CSS asset reference`);
  }
}

await visit(root);
if (violations.length) {
  console.error(`Procedural-only policy failed:\n${violations.join('\n')}`);
  process.exitCode = 1;
} else console.log('Procedural-only policy passed: no fixed scene/media assets or runtime asset loaders.');
