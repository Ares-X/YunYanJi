import {
  DataTexture, DepthFormat, DepthTexture, HalfFloatType, LinearSRGBColorSpace,
  RepeatWrapping, RGBAFormat, UnsignedByteType, UnsignedIntType, WebGLRenderTarget,
} from 'three';
import type { Camera, Scene, WebGLRenderer } from 'three';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { createRandom } from '../core/random';
import type { QualityLevel } from '../core/types';

function createDenoiseNoise(seed: string): DataTexture {
  const simplex = new SimplexNoise({ random: createRandom(`${seed}/ambient-occlusion`) });
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const start = (y * size + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        data[start + channel] = (simplex.noise(x + (channel % 2) * size,
          y + Math.floor(channel / 2) * size) * 0.5 + 0.5) * 255;
      }
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.name = 'generated-winter-ao-denoise';
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Reuses the beauty pass depth. No extra scene traversal or normal render is
 * needed: r187 GTAO reconstructs normals from this depth texture. The expensive
 * horizon search and its edge-aware denoiser run at half linear resolution.
 */
class SharedDepthGTAOPass extends GTAOPass {
  constructor(scene: Scene, camera: Camera, depth: DepthTexture, seed: string) {
    super(scene, camera, 1, 1, { depthTexture: depth });
    this.pdNoiseTexture.dispose();
    this.pdNoiseTexture = createDenoiseNoise(seed);
    this.pdMaterial.uniforms.tNoise!.value = this.pdNoiseTexture;
    this.blendIntensity = 0.76;
    this.updateGtaoMaterial({
      radius: 0.80,
      thickness: 0.50,
      distanceExponent: 1.3,
      distanceFallOff: 0.9,
      scale: 1,
      samples: 12,
      screenSpaceRadius: false,
    });
    this.updatePdMaterial({
      samples: 8,
      rings: 2,
      radius: 4,
      lumaPhi: 8,
      depthPhi: 1.5,
      normalPhi: 3,
    });
  }

  override setSize(width: number, height: number): void {
    super.setSize(Math.max(1, Math.ceil(width * 0.5)), Math.max(1, Math.ceil(height * 0.5)));
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget, deltaTime: number, maskActive: boolean): void {
    const depth = readBuffer.depthTexture;
    if (!depth) throw new Error('Winter AO requires the beauty pass depth texture.');
    // Composer can swap its buffers when quality/pass choices change. Avoid
    // rebinding every frame, which would needlessly invalidate shader programs.
    if (this.depthTexture !== depth) this.setGBuffer(depth);
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }

  override dispose(): void {
    super.dispose();
    // The installed addon does not release these two owned materials itself.
    this.gtaoMaterial.dispose();
    this.blendMaterial.dispose();
  }
}

/**
 * A restrained, linear-light finish: main image -> local occlusion -> output.
 * OutputPass performs the renderer's tone mapping and sRGB conversion exactly
 * once. There is no bloom, colour filter, fixed noise image or depth-of-field.
 * Low quality skips occlusion and MSAA but retains the same linear colour path.
 */
export class WinterPostProcessing {
  private readonly composer: EffectComposer;
  private readonly occlusion: SharedDepthGTAOPass;
  private readonly output = new OutputPass();
  private quality: QualityLevel;
  private disposed = false;

  constructor(renderer: WebGLRenderer, scene: Scene,
    camera: Camera, quality: QualityLevel = 'high', seed = 'winter') {
    this.quality = quality;
    const depth = new DepthTexture(1, 1, UnsignedIntType);
    depth.format = DepthFormat;
    const target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      depthBuffer: true,
      depthTexture: depth,
      samples: 4,
    });
    target.texture.name = 'winter-linear-beauty';
    target.texture.colorSpace = LinearSRGBColorSpace;
    this.composer = new EffectComposer(renderer, target);
    // WorldRenderer already computes a bounded drawing-buffer pixel size.
    this.composer.setPixelRatio(1);
    this.occlusion = new SharedDepthGTAOPass(scene, camera, depth, seed);
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(this.occlusion);
    this.composer.addPass(this.output);
    this.setQuality(quality);
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
  }

  setQuality(quality: QualityLevel): void {
    this.quality = quality;
    this.occlusion.enabled = quality !== 'low';
    this.occlusion.updateGtaoMaterial({ samples: quality === 'high' ? 12 : 6 });
    const samples = quality === 'high' ? 4 : quality === 'medium' ? 2 : 0;
    for (const target of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (target.samples !== samples) {
        target.dispose();
        target.samples = samples;
      }
    }
  }

  render(): void {
    if (this.disposed) return;
    this.composer.render(0);
  }

  /** Call after Three has restored its WebGL context; retained CPU data is reused. */
  invalidate(): void {
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.occlusion.gtaoRenderTarget.dispose();
    this.occlusion.pdRenderTarget.dispose();
    this.occlusion.gtaoNoiseTexture.needsUpdate = true;
    this.occlusion.pdNoiseTexture.needsUpdate = true;
  }

  diagnostics() {
    return { ambientOcclusion: this.quality !== 'low',
      occlusionWidth: this.occlusion.width, occlusionHeight: this.occlusion.height };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.occlusion.dispose();
    this.output.dispose();
    this.composer.dispose();
  }
}
