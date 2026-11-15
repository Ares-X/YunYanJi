import {
  DepthFormat, DepthTexture, HalfFloatType, LinearSRGBColorSpace,
  UnsignedIntType, Vector2, WebGLRenderTarget,
} from 'three';
import type { Camera, Scene, WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SurfaceOcclusion } from './SurfaceOcclusion';
import type { QualityLevel } from '../core/types';

/**
 * A linear-light finish: opaque depth -> indirect occlusion -> beauty -> bloom -> output.
 * OutputPass performs the renderer's tone mapping and sRGB conversion exactly
 * once. Restrained HDR bloom is reserved for fire and reflected ember radiance;
 * there is no fixed noise image, colour filter or depth-of-field.
 * Low quality skips occlusion, bloom and MSAA, with the same linear colour path.
 */
export class LandscapePostProcessing {
  private readonly composer: EffectComposer;
  private readonly occlusion: SurfaceOcclusion;
  private readonly output = new OutputPass();
  private readonly bloom = new UnrealBloomPass(new Vector2(1, 1), 0.12, 0.42, 1.1);
  private disposed = false;

  constructor(renderer: WebGLRenderer, scene: Scene,
    camera: Camera, quality: QualityLevel = 'high', seed = 'rainfire') {
    const depth = new DepthTexture(1, 1, UnsignedIntType);
    depth.format = DepthFormat;
    const target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      depthBuffer: true,
      depthTexture: depth,
      samples: 4,
    });
    target.texture.name = 'landscape-linear-beauty';
    target.texture.colorSpace = LinearSRGBColorSpace;
    this.composer = new EffectComposer(renderer, target);
    // WorldRenderer already computes a bounded drawing-buffer pixel size.
    this.composer.setPixelRatio(1);
    this.occlusion = new SurfaceOcclusion(scene, camera, seed);
    this.composer.addPass(this.occlusion);
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);
    this.setQuality(quality);
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
  }

  setQuality(quality: QualityLevel): void {
    this.occlusion.setQuality(quality);
    this.bloom.enabled = quality !== 'low';
    this.bloom.strength = quality === 'high' ? 0.12 : 0.09;
    const samples = quality === 'high' ? 4 : quality === 'medium' ? 2 : 0;
    for (const target of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (target.samples !== samples) {
        target.dispose();
        target.samples = samples;
      }
    }
  }

  prepare(): void { this.occlusion.prepare(); }

  get depthField() { return this.occlusion.depthField; }

  render(): void {
    if (this.disposed) return;
    this.composer.render(0);
  }

  /** Call after Three has restored its WebGL context; retained CPU data is reused. */
  invalidate(): void {
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.occlusion.invalidate();
    this.bloom.renderTargetBright.dispose();
    for (const target of [...this.bloom.renderTargetsHorizontal, ...this.bloom.renderTargetsVertical]) target.dispose();
  }

  diagnostics() {
    return { ...this.occlusion.diagnostics(), bloom: this.bloom.enabled };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.occlusion.dispose();
    this.output.dispose();
    this.bloom.dispose();
    // r187 does not release its high-pass material in the addon dispose().
    this.bloom.materialHighPassFilter.dispose();
    this.composer.dispose();
  }
}
