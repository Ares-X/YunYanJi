import {
  Color, DataTexture, DepthFormat, DepthTexture, DoubleSide, Mesh, MeshDepthMaterial,
  MeshStandardMaterial, Points, RepeatWrapping, RGBAFormat, UnsignedByteType,
  UnsignedIntType, Vector2, WebGLRenderTarget,
} from 'three';
import type { Camera, Material, Object3D, Scene, Texture, WebGLRenderer } from 'three';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { createRandom } from '../core/random';
import type { QualityLevel } from '../core/types';

/** A depth field belongs to one camera and must not leak into reflection views. */
export interface SceneDepthField {
  readonly texture: DepthTexture;
  readonly size: Vector2;
  readonly camera: Camera;
  available: boolean;
}

function denoiseNoise(seed: string): DataTexture {
  const noise = new SimplexNoise({ random: createRandom(`${seed}/ambient-occlusion`) });
  const data = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) for (let c = 0; c < 4; c++) {
    data[(y * 64 + x) * 4 + c] = (noise.noise(x + c % 2 * 64, y + Math.floor(c / 2) * 64) * .5 + .5) * 255;
  }
  const texture = new DataTexture(data, 64, 64, RGBAFormat, UnsignedByteType);
  texture.name = 'generated-surface-ao-denoise';
  texture.wrapS = texture.wrapT = RepeatWrapping; texture.needsUpdate = true;
  return texture;
}

interface AmbientUniforms {
  map: { value: Texture };
  enabled: { value: number };
  inverseSize: { value: Vector2 };
}

/** Apply horizon visibility before direct/indirect light are added together. */
function bindAmbientVisibility(material: MeshStandardMaterial, uniforms: AmbientUniforms): void {
  const compile = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    compile(shader, renderer);
    shader.uniforms.uYyjScreenOcclusion = uniforms.map;
    shader.uniforms.uYyjScreenOcclusionEnabled = uniforms.enabled;
    shader.uniforms.uYyjScreenInverseSize = uniforms.inverseSize;
    const contact = shader.fragmentShader.includes('float yyjAmbient') ? 'yyjAmbient' : '1.0';
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uYyjScreenOcclusion;
        uniform float uYyjScreenOcclusionEnabled;
        uniform vec2 uYyjScreenInverseSize;`)
      .replace('vec3 totalDiffuse =', `
        if (uYyjScreenOcclusionEnabled > .5) {
          float yyjScreenAo=texture2D(uYyjScreenOcclusion,gl_FragCoord.xy*uYyjScreenInverseSize).r;
          yyjScreenAo=mix(1.0,yyjScreenAo,.68);
          float yyjContactAo=${contact};
          float yyjCombinedAo=min(yyjContactAo,yyjScreenAo);
          // The earlier contact term has already been applied. Divide it out
          // so the two estimates do not multiply into an artificial dark rim.
          reflectedLight.indirectDiffuse*=yyjCombinedAo/max(.001,yyjContactAo);
          float yyjSpecularAo=computeSpecularOcclusion(
            saturate(dot(geometryNormal,geometryViewDir)),yyjCombinedAo,material.roughness);
          reflectedLight.indirectSpecular*=yyjSpecularAo/max(.001,yyjContactAo);
          #ifdef USE_CLEARCOAT
            float yyjCoatAo=computeSpecularOcclusion(
              saturate(dot(geometryClearcoatNormal,geometryViewDir)),yyjCombinedAo,material.clearcoatRoughness);
            clearcoatSpecularIndirect*=yyjCoatAo/max(.001,yyjContactAo);
          #endif
        }
        vec3 totalDiffuse =`);
  };
  material.customProgramCacheKey = () => `${key}/indirect-screen-occlusion-v1`;
  material.needsUpdate = true;
}

/**
 * Opaque depth -> GTAO/denoise -> ordinary PBR beauty. AO is never multiplied
 * over a finished image, so flame emission and direct firelight keep their HDR
 * energy. Terrain supplies its own matching depth material for surface cutouts.
 */
export class SurfaceOcclusion extends Pass {
  readonly depthField: SceneDepthField;
  private readonly target: WebGLRenderTarget;
  private readonly gtao: GTAOPass;
  private readonly depthMaterial = new MeshDepthMaterial({ side: DoubleSide });
  private readonly inverseSize = new Vector2(1, 1);
  private readonly uniforms: AmbientUniforms;
  private readonly hooks: { mesh: Mesh; before: Mesh['onBeforeRender'] }[] = [];
  private bound = false;
  private active = true;
  private disposed = false;

  constructor(private readonly scene: Scene, private readonly camera: Camera, seed: string) {
    super();
    this.needsSwap = false;
    const depth = new DepthTexture(1, 1, UnsignedIntType); depth.format = DepthFormat;
    this.target = new WebGLRenderTarget(1, 1, { depthTexture: depth, depthBuffer: true });
    this.target.texture.name = 'opaque-surface-depth-colour'; depth.name = 'opaque-surface-depth';
    this.depthField = { texture: depth, size: new Vector2(1, 1), camera, available: false };
    this.gtao = new GTAOPass(scene, camera, 1, 1, { depthTexture: depth });
    this.gtao.output = GTAOPass.OUTPUT.Off;
    this.gtao.pdNoiseTexture.dispose(); this.gtao.pdNoiseTexture = denoiseNoise(seed);
    this.gtao.pdMaterial.uniforms.tNoise!.value = this.gtao.pdNoiseTexture;
    this.gtao.updateGtaoMaterial({ radius: .30, thickness: .16, distanceExponent: 1.4,
      distanceFallOff: .85, scale: 1, samples: 16, screenSpaceRadius: false });
    this.gtao.updatePdMaterial({ samples: 12, rings: 2, radius: 3, lumaPhi: 8, depthPhi: 1.2, normalPhi: 3 });
    this.uniforms = { map: { value: this.gtao.pdRenderTarget.texture }, enabled: { value: 0 },
      inverseSize: { value: this.inverseSize } };
  }

  prepare(): void {
    if (this.bound || this.disposed) return;
    const materials = new Set<MeshStandardMaterial>();
    this.scene.traverse(object => {
      if (!(object instanceof Mesh)) return;
      const entries = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of entries) if (material instanceof MeshStandardMaterial) materials.add(material);
      if (!entries.some(material => material instanceof MeshStandardMaterial)) return;
      const before = object.onBeforeRender;
      this.hooks.push({ mesh: object, before });
      object.onBeforeRender = (...args) => {
        before.call(object, ...args);
        this.uniforms.enabled.value = Number(this.active && this.depthField.available
          && args[2] === this.camera && args[4] instanceof MeshStandardMaterial);
      };
    });
    materials.forEach(material => bindAmbientVisibility(material, this.uniforms));
    this.bound = true;
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(width, height);
    this.depthField.size.set(width, height); this.inverseSize.set(1 / width, 1 / height);
    this.gtao.setSize(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2)));
    this.depthField.available = false;
  }

  setQuality(quality: QualityLevel): void {
    // Even low quality needs opaque depth to stop fire emission behind wood.
    this.active = quality !== 'low';
    this.depthField.available = false; this.uniforms.enabled.value = 0;
    this.gtao.updateGtaoMaterial({ samples: quality === 'high' ? 16 : 8 });
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget, delta: number, maskActive: boolean): void {
    if (this.disposed) return;
    this.prepare(); this.uniforms.enabled.value = 0; this.depthField.available = false;
    const hidden: Object3D[] = [], replaced: { mesh: Mesh; material: Material | Material[] }[] = [];
    const previous = { target: renderer.getRenderTarget(), color: renderer.getClearColor(new Color()).clone(),
      alpha: renderer.getClearAlpha(), autoClear: renderer.autoClear, background: this.scene.background,
      shadows: renderer.shadowMap.enabled };
    try {
      this.scene.traverse(object => {
        if (!object.visible) return;
        if (object instanceof Points) { hidden.push(object); object.visible = false; return; }
        if (!(object instanceof Mesh)) return;
        const entries = Array.isArray(object.material) ? object.material : [object.material];
        if (entries.some(material => !(material instanceof MeshStandardMaterial) || material.transparent)) {
          hidden.push(object); object.visible = false; return;
        }
        replaced.push({ mesh: object, material: object.material });
        object.material = object.customDepthMaterial
          ?? (entries[0]!.userData.yyjDepthMaterial as Material | undefined) ?? this.depthMaterial;
      });
      renderer.shadowMap.enabled = false; renderer.autoClear = true;
      renderer.setClearColor(0xffffff, 1); this.scene.background = null;
      renderer.setRenderTarget(this.target); renderer.clear();
      renderer.render(this.scene, this.camera);
      if (this.active) this.gtao.render(renderer, writeBuffer, readBuffer, delta, maskActive);
      this.depthField.available = true;
    } finally {
      replaced.forEach(({ mesh, material }) => { mesh.material = material; });
      hidden.forEach(object => { object.visible = true; });
      this.scene.background = previous.background;
      renderer.shadowMap.enabled = previous.shadows; renderer.autoClear = previous.autoClear;
      renderer.setClearColor(previous.color, previous.alpha); renderer.setRenderTarget(previous.target);
    }
  }

  invalidate(): void {
    this.target.dispose(); this.gtao.gtaoRenderTarget.dispose(); this.gtao.pdRenderTarget.dispose();
    this.gtao.gtaoNoiseTexture.needsUpdate = true; this.gtao.pdNoiseTexture.needsUpdate = true;
    this.depthField.available = false; this.uniforms.enabled.value = 0;
  }

  diagnostics() { return { opaqueDepth: this.depthField.available, ambientOcclusion: this.active, occlusionWidth: this.gtao.width,
    occlusionHeight: this.gtao.height, indirectOcclusion: this.active }; }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.depthField.available = false;
    this.hooks.forEach(({ mesh, before }) => { mesh.onBeforeRender = before; }); this.hooks.length = 0;
    this.target.dispose(); this.depthMaterial.dispose(); this.gtao.dispose();
    this.gtao.gtaoMaterial.dispose(); this.gtao.blendMaterial.dispose();
  }
}
