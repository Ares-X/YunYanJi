import {
  ACESFilmicToneMapping, Color, DirectionalLight, FogExp2, HemisphereLight,
  PCFShadowMap, PerspectiveCamera, PMREMGenerator, Scene, SRGBColorSpace, Vector2,
  Vector3, WebGLRenderer,
} from 'three';
import type { WebGLCubeRenderTarget } from 'three';
import type { EnvironmentSnapshot, QualityLevel } from '../core/types';
import type { PoemScene } from '../scenes/types';
import { createProceduralSky } from './ProceduralSky';
import { GroundContactShadows } from './GroundContactShadows';
import { drawingSize, QUALITY } from './quality';

export class WorldRenderer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 1, 0.2, 220);
  private readonly sky = createProceduralSky();
  private readonly sun = new DirectionalLight('#ffe5c3', 1.35);
  private readonly contacts = new GroundContactShadows();
  private environment: WebGLCubeRenderTarget | undefined;
  private quality: QualityLevel;
  private readonly offset = new Vector2();
  private readonly goal = new Vector2();
  private readonly lookAt = new Vector3();
  private width = 1;
  private height = 1;

  constructor(readonly canvas: HTMLCanvasElement, readonly poem: PoemScene, quality: QualityLevel) {
    this.quality = quality;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    // Count nested reflection passes as part of the complete visible frame.
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.scene.background = new Color('#c6d1d4');
    this.scene.fog = new FogExp2('#c6d1d4', 0.018);
    this.scene.environmentIntensity = 0.78;
    this.scene.add(new HemisphereLight('#d1e4f1', '#6b7779', 0.35));
    this.sun.position.set(-7, 11, 4);
    this.sun.target.position.set(-1, 0, -3);
    Object.assign(this.sun.shadow.camera, { left: -13, right: 13, top: 13, bottom: -13, near: 0.5, far: 48 });
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.018;
    this.sun.shadow.radius = 4.5;
    this.sun.shadow.intensity = 0.82;
    this.scene.add(this.sun, this.sun.target, poem.group);
    this.camera.position.copy(poem.cameraPosition);
    this.lookAt.copy(poem.cameraTarget);
    this.camera.lookAt(this.lookAt);
    this.rebuildEnvironment();
    this.setQuality(quality);
  }

  async prepare(): Promise<void> { await this.renderer.compileAsync(this.scene, this.camera); }

  rebuildEnvironment(): void {
    const skyScene = new Scene();
    skyScene.add(this.sky.mesh);
    const generator = new PMREMGenerator(this.renderer);
    this.environment?.dispose();
    this.environment = generator.fromScene(skyScene, 0.08, 0.1, 240, { size: 256 });
    this.scene.environment = this.environment.texture;
    generator.dispose();
    this.scene.add(this.sky.mesh);
    this.poem.invalidateRenderCaches?.();
    this.contacts.bake(this.renderer, this.scene);
  }

  resize(width: number, height: number, dpr = window.devicePixelRatio): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const size = drawingSize(this.width, this.height, dpr, this.quality);
    this.renderer.setSize(size.width, size.height, false);
    this.camera.aspect = this.width / this.height;
    // Narrow screens can use an individual scene's authored portrait composition.
    this.camera.fov = this.camera.aspect < 0.8 ? 55 : 40;
    this.camera.updateProjectionMatrix();
  }

  setQuality(quality: QualityLevel): void {
    this.quality = quality;
    const config = QUALITY[quality];
    this.renderer.shadowMap.enabled = config.shadows;
    this.sun.castShadow = config.shadows;
    if (this.sun.shadow.mapSize.x !== config.shadowSize) {
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      this.sun.shadow.mapSize.set(config.shadowSize, config.shadowSize);
    }
    this.renderer.shadowMap.needsUpdate = true;
    this.poem.setQuality(quality);
    this.resize(this.width, this.height);
  }

  setView(x: number, y: number): void {
    this.goal.set(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)));
  }

  moveView(x: number, y: number): void { this.setView(this.goal.x + x, this.goal.y + y); }

  resetView(): void { this.goal.set(0, 0); this.offset.set(0, 0); }

  render(frame: EnvironmentSnapshot): void {
    const ease = frame.reducedMotion ? 1 : 1 - Math.exp(-Math.max(frame.delta, 0.016) * 4);
    this.offset.lerp(this.goal, ease);
    const portrait = this.camera.aspect < 0.8;
    this.camera.position.copy(portrait ? this.poem.portraitCameraPosition ?? this.poem.cameraPosition : this.poem.cameraPosition);
    this.camera.position.x += this.offset.x * 1.3;
    this.camera.position.y += this.offset.y * 0.45;
    this.lookAt.copy(portrait ? this.poem.portraitCameraTarget ?? this.poem.cameraTarget : this.poem.cameraTarget);
    this.camera.lookAt(this.lookAt);
    this.sky.update(frame.elapsed);
    this.poem.update(frame);
    this.renderer.info.reset();
    this.renderer.render(this.scene, this.camera);
  }

  diagnostics() {
    return { quality: this.quality, viewX: this.goal.x, viewY: this.goal.y, calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries, textures: this.renderer.info.memory.textures,
      contactBakes: this.contacts.bakes, contactResolution: this.contacts.resolution,
      drawingWidth: this.canvas.width, drawingHeight: this.canvas.height, ...this.poem.diagnostics?.() };
  }

  dispose(): void {
    this.poem.dispose();
    this.sky.dispose();
    this.environment?.dispose();
    this.contacts.dispose();
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.scene.clear();
    this.renderer.dispose();
  }
}
