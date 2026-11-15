import {
  ACESFilmicToneMapping, Color, DirectionalLight, FogExp2, HemisphereLight,
  PCFShadowMap, PerspectiveCamera, PMREMGenerator, Scene, SRGBColorSpace, Vector2,
  Vector3, WebGLRenderer,
} from 'three';
import type { WebGLCubeRenderTarget } from 'three';
import type { EnvironmentSnapshot, QualityLevel } from '../core/types';
import type { PoemScene } from '../scenes/types';
import { createWinterAtmosphere, WINTER_SUN_DIRECTION } from './WinterAtmosphere';
import { GroundContactShadows } from './GroundContactShadows';
import { WinterPostProcessing } from './WinterPostProcessing';
import { drawingSize, QUALITY } from './quality';

export class WorldRenderer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(49, 1, 0.12, 430);
  private readonly sky = createWinterAtmosphere();
  private readonly sun = new DirectionalLight('#f7f5ed', 1.85);
  private readonly contacts = new GroundContactShadows();
  private readonly post: WinterPostProcessing;
  private environment: WebGLCubeRenderTarget | undefined;
  private quality: QualityLevel;
  private readonly offset = new Vector2();
  private readonly goal = new Vector2();
  private readonly lookAt = new Vector3();
  private frameFence: WebGLSync | null = null;
  private deferredFrames = 0;
  private width = 1;
  private height = 1;

  constructor(readonly canvas: HTMLCanvasElement, readonly poem: PoemScene, quality: QualityLevel) {
    this.quality = quality;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.94;
    // Count nested reflection passes as part of the complete visible frame.
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.scene.background = new Color('#9eafb8');
    this.scene.fog = new FogExp2('#9eafb8', 0.0095);
    this.scene.environmentIntensity = 0.52;
    this.scene.add(new HemisphereLight('#dce8ef', '#b7bbb2', 0.08));
    // Keep the shadow volume over the visible foreground as well as the grove.
    this.sun.target.position.set(-1, 0, -8);
    this.sun.position.copy(this.sun.target.position).addScaledVector(WINTER_SUN_DIRECTION, 82);
    Object.assign(this.sun.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 0.5, far: 142 });
    this.sun.shadow.bias = -0.00008;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 2.0;
    this.sun.shadow.intensity = 0.90;
    this.scene.add(this.sun, this.sun.target, poem.group);
    this.camera.position.copy(poem.cameraPosition);
    this.lookAt.copy(poem.cameraTarget);
    this.camera.lookAt(this.lookAt);
    this.post = new WinterPostProcessing(this.renderer, this.scene, this.camera, quality);
    this.rebuildEnvironment();
    this.setQuality(quality);
  }

  async prepare(): Promise<void> { await this.renderer.compileAsync(this.scene, this.camera); }

  rebuildEnvironment(): void {
    const skyScene = new Scene();
    skyScene.add(this.sky.mesh);
    const generator = new PMREMGenerator(this.renderer);
    this.environment?.dispose();
    this.sky.setEnvironmentCapture(true);
    try { this.environment = generator.fromScene(skyScene, 0.08, 0.1, 1000, { size: 256 }); }
    finally { this.sky.setEnvironmentCapture(false); }
    this.scene.environment = this.environment.texture;
    generator.dispose();
    this.scene.add(this.sky.mesh);
    this.poem.invalidateRenderCaches?.();
    this.contacts.bake(this.renderer, this.scene);
    this.post.invalidate();
    this.renderer.shadowMap.needsUpdate = true;
  }

  resize(width: number, height: number, dpr = window.devicePixelRatio): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const size = drawingSize(this.width, this.height, dpr, this.quality);
    this.renderer.setSize(size.width, size.height, false);
    this.post.setSize(size.width, size.height);
    this.camera.aspect = this.width / this.height;
    // Narrow screens can use an individual scene's authored portrait composition.
    this.camera.fov = this.camera.aspect < 0.8 ? 54 : 49;
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
    this.post.setQuality(quality);
    this.resize(this.width, this.height);
  }

  setView(x: number, y: number): void {
    this.goal.set(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)));
  }

  moveView(x: number, y: number): void { this.setView(this.goal.x + x, this.goal.y + y); }

  resetView(): void { this.goal.set(0, 0); this.offset.set(0, 0); }

  /** Context-owned sync objects are invalidated by WebGL itself on loss. */
  forgetPendingFrame(): void { this.frameFence = null; }

  /**
   * Submit at most one GPU frame at a time. Polling never blocks the UI thread;
   * on a slow renderer the next RAF uses the newest simulation/camera state.
   */
  render(frame: EnvironmentSnapshot): boolean {
    const ease = frame.reducedMotion ? 1 : 1 - Math.exp(-Math.max(frame.delta, 0.016) * 4);
    this.offset.lerp(this.goal, ease);
    const portrait = this.camera.aspect < 0.8;
    this.camera.position.copy(portrait ? this.poem.portraitCameraPosition ?? this.poem.cameraPosition : this.poem.cameraPosition);
    this.camera.position.x += this.offset.x * 0.55;
    this.camera.position.y += this.offset.y * 0.18;
    this.lookAt.copy(portrait ? this.poem.portraitCameraTarget ?? this.poem.cameraTarget : this.poem.cameraTarget);
    this.lookAt.x += this.offset.x * 13;
    this.lookAt.y += this.offset.y * 7;
    this.camera.lookAt(this.lookAt);
    this.sky.update(frame.elapsed);
    this.poem.update(frame);
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (gl.isContextLost()) return false;
    if (this.frameFence) {
      const status = gl.clientWaitSync(this.frameFence, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) {
        this.deferredFrames += 1;
        return false;
      }
      // WAIT_FAILED must not leave rendering permanently locked. A context
      // loss is handled separately; otherwise discard this fence and retry.
      gl.deleteSync(this.frameFence);
      this.frameFence = null;
    }
    this.renderer.info.reset();
    this.post.render();
    this.frameFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return true;
  }

  diagnostics() {
    return { quality: this.quality, viewX: this.goal.x, viewY: this.goal.y, calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries, textures: this.renderer.info.memory.textures,
      contactBakes: this.contacts.bakes, contactResolution: this.contacts.resolution,
      deferredFrames: this.deferredFrames,
      drawingWidth: this.canvas.width, drawingHeight: this.canvas.height,
      ...this.post.diagnostics(), ...this.poem.diagnostics?.() };
  }

  dispose(): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (this.frameFence && !gl.isContextLost()) gl.deleteSync(this.frameFence);
    this.frameFence = null;
    this.poem.dispose();
    this.sky.dispose();
    this.environment?.dispose();
    this.contacts.dispose();
    this.post.dispose();
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.scene.clear();
    this.renderer.dispose();
  }
}
