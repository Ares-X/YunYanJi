import {
  AgXToneMapping, Color, DirectionalLight, FogExp2, HemisphereLight,
  PCFShadowMap, PerspectiveCamera, Scene, SRGBColorSpace, Vector2,
  Vector3, WebGLRenderer,
} from 'three';
import type { PointLight, WebGLCubeRenderTarget } from 'three';
import type { EnvironmentSnapshot, QualityLevel } from '../core/types';
import type { LandscapeScene } from '../scenes/types';
import { createRainAtmosphere, CLOUD_LIGHT_DIRECTION } from './RainAtmosphere';
import { GroundContactShadows } from './GroundContactShadows';
import { LandscapePostProcessing } from './LandscapePostProcessing';
import { captureForestEnvironment } from './ForestEnvironment';
import { CanopyLightField } from './CanopyLightField';
import { drawingSize, QUALITY } from './quality';
import { weatherLighting } from './weatherLighting';

export class WorldRenderer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(49, 1, 0.12, 430);
  private readonly sky = createRainAtmosphere();
  private readonly sun = new DirectionalLight('#c3d7e0', 0.80);
  private readonly hemisphere = new HemisphereLight('#a6b4bc', '#484435', .10);
  private readonly rainHaze = new Color('#4d6874');
  private readonly clearHaze = new Color('#abc7d7');
  private readonly snowHaze = new Color('#8d9da8');
  private readonly stormHaze = new Color('#2b3945');
  private readonly sunCool = new Color('#c3d7e0');
  private readonly sunWarm = new Color('#fff0c9');
  private readonly flashColor = new Color('#d3e0ff');
  private readonly contacts = new GroundContactShadows();
  private readonly canopy = new CanopyLightField();
  private readonly fireLights: readonly PointLight[];
  private readonly post: LandscapePostProcessing;
  private environment: WebGLCubeRenderTarget | undefined;
  private quality: QualityLevel;
  private readonly offset = new Vector2();
  private readonly goal = new Vector2();
  private readonly lookAt = new Vector3();
  private frameFence: WebGLSync | null = null;
  private deferredFrames = 0;
  private renderedElapsed = 0;
  private width = 1;
  private height = 1;
  private lastCanopyShadow = -Infinity;
  private lastFireShadow = -Infinity;
  private canopyShadowUpdates = 0;
  private fireShadowUpdates = 0;
  private weatherRevision = -1;
  private fireRevision = -1;

  constructor(readonly canvas: HTMLCanvasElement, readonly landscape: LandscapeScene, quality: QualityLevel) {
    this.quality = quality;
    const primaryFire = landscape.fireLight;
    this.fireLights = primaryFire
      ? [primaryFire, ...(landscape.fireLights ?? []).filter(light => light !== primaryFire)]
      : landscape.fireLights ?? [];
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = AgXToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    // Count nested reflection passes as part of the complete visible frame.
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.scene.background = new Color('#4d6874');
    // Reflections retain only a light far veil; the main view integrates its
    // shadowed, height-dependent mist once after the PBR scene.
    this.scene.fog = new FogExp2('#4d6874', 0.003);
    this.scene.environmentIntensity = 1.55;
    this.scene.add(this.hemisphere);
    // Keep the shadow volume over the visible foreground as well as the grove.
    this.sun.target.position.set(-1, 0, -8);
    this.sun.position.copy(this.sun.target.position).addScaledVector(CLOUD_LIGHT_DIRECTION, 82);
    Object.assign(this.sun.shadow.camera, { left: -18, right: 18, top: 21, bottom: -21, near: 0.5, far: 142 });
    this.sun.shadow.bias = -0.00008;
    this.sun.shadow.normalBias = 0.008;
    this.sun.shadow.radius = 7;
    this.sun.shadow.intensity = 1;
    this.sun.shadow.autoUpdate = false;
    this.fireLights.forEach(light => { light.shadow.autoUpdate = false; });
    this.scene.add(this.sun, this.sun.target, landscape.group);
    this.camera.position.copy(landscape.cameraPosition);
    this.lookAt.copy(landscape.cameraTarget);
    this.camera.lookAt(this.lookAt);
    this.canopy.applyTo(this.scene);
    this.post = new LandscapePostProcessing(this.renderer, this.scene, this.camera, this.sun,
      this.fireLights, this.canopy.texture, this.canopy.matrix, quality);
    landscape.setSceneDepth?.(this.post.depthField);
    this.setQuality(quality);
    this.rebuildEnvironment();
  }

  async prepare(): Promise<void> {
    this.post.prepare();
    await this.renderer.compileAsync(this.scene, this.camera);
  }

  rebuildEnvironment(): void {
    const oldEnvironment = this.environment;
    const liveSun = this.sun.intensity, liveSunColor = this.sun.color.clone();
    const liveHemisphere = this.hemisphere.intensity;
    const liveEnvironment = this.scene.environmentIntensity;
    const fog = this.scene.fog as FogExp2;
    const liveFogColor = fog.color.clone(), liveFogDensity = fog.density;
    const liveBackground = (this.scene.background as Color).clone();
    // A weather change modulates this fixed local probe. Rebuilding after
    // context loss must not bake the currently selected storm/snow a second time.
    this.sun.intensity = .80; this.sun.color.copy(this.sunCool);
    this.hemisphere.intensity = .10;
    this.scene.environmentIntensity = 1.55;
    fog.color.copy(this.rainHaze); fog.density = .003;
    (this.scene.background as Color).copy(this.rainHaze);
    // Static radiance must not depend on the wind's time when context loss
    // happened. Capture the same rest pose and initial sky every time.
    this.landscape.setEnvironmentCapture?.(true);
    this.sky.setEnvironmentCapture(true);
    try {
      this.contacts.bake(this.renderer, this.scene, this.landscape.groundHeightAt);
      this.canopy.bake(this.renderer, this.scene);
      this.canopy.setEnvironmentCapture(true);
      // The probe already sees canopy geometry: do not bake the extra spatial
      // sky estimate into it and then apply that estimate for a second time.
      this.environment = this.captureEnvironment();
    } finally {
      this.sky.setEnvironmentCapture(false);
      this.canopy.setEnvironmentCapture(false);
      this.landscape.setEnvironmentCapture?.(false);
      this.sun.intensity = liveSun; this.sun.color.copy(liveSunColor);
      this.hemisphere.intensity = liveHemisphere;
      this.scene.environmentIntensity = liveEnvironment;
      fog.color.copy(liveFogColor); fog.density = liveFogDensity;
      (this.scene.background as Color).copy(liveBackground);
    }
    this.scene.environment = this.environment.texture;
    oldEnvironment?.dispose();
    this.scene.add(this.sky.mesh);
    this.landscape.invalidateRenderCaches?.();
    this.post.invalidate();
    this.lastCanopyShadow = this.lastFireShadow = -Infinity;
    this.sun.shadow.needsUpdate = true;
    this.fireLights.forEach(light => { light.shadow.needsUpdate = true; });
    this.renderer.shadowMap.needsUpdate = true;
  }

  private captureEnvironment(): WebGLCubeRenderTarget {
    // A quality switch does not recapture static IBL. Its eventual restoration
    // must therefore use the same shadowed probe, even if live shadows are off.
    const shadow = this.sun.shadow;
    const previous = {
      map: shadow.map, size: shadow.mapSize.clone(), cast: this.sun.castShadow,
      enabled: this.renderer.shadowMap.enabled, needsUpdate: shadow.needsUpdate,
      globalNeedsUpdate: this.renderer.shadowMap.needsUpdate,
    };
    shadow.map = null;
    shadow.mapSize.set(1024, 1024);
    this.sun.castShadow = this.renderer.shadowMap.enabled = true;
    shadow.needsUpdate = this.renderer.shadowMap.needsUpdate = true;
    try {
      return captureForestEnvironment(this.renderer, this.scene,
        this.sky.mesh, new Vector3(-.3, 1.7, -2.3));
    } finally {
      // Three allocates this lazily inside the capture's render call.
      const temporary = shadow.map as typeof previous.map;
      shadow.map = previous.map;
      shadow.mapSize.copy(previous.size);
      this.sun.castShadow = previous.cast;
      this.renderer.shadowMap.enabled = previous.enabled;
      shadow.needsUpdate = previous.needsUpdate;
      this.renderer.shadowMap.needsUpdate = previous.globalNeedsUpdate;
      if (temporary && temporary !== previous.map) temporary.dispose();
    }
  }

  resize(width: number, height: number, dpr = window.devicePixelRatio): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const size = drawingSize(this.width, this.height, dpr, this.quality);
    this.renderer.setSize(size.width, size.height, false);
    this.post.setSize(size.width, size.height);
    this.camera.aspect = this.width / this.height;
    // Narrow screens can use an individual scene's authored portrait composition.
    this.camera.fov = this.camera.aspect < 0.8 ? 53 : 47;
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
    this.sun.shadow.needsUpdate = true;
    this.fireLights.forEach(light => { light.shadow.needsUpdate = true; });
    this.lastCanopyShadow = this.lastFireShadow = -Infinity;
    this.renderer.shadowMap.needsUpdate = true;
    this.landscape.setQuality(quality);
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
    this.camera.position.copy(portrait ? this.landscape.portraitCameraPosition ?? this.landscape.cameraPosition : this.landscape.cameraPosition);
    this.camera.position.x += this.offset.x * 0.18;
    this.camera.position.y += this.offset.y * 0.08;
    this.lookAt.copy(portrait ? this.landscape.portraitCameraTarget ?? this.landscape.cameraTarget : this.landscape.cameraTarget);
    this.lookAt.x += this.offset.x * 5;
    this.lookAt.y += this.offset.y * 2.4;
    this.camera.lookAt(this.lookAt);
    const light = weatherLighting(frame.weather, frame.lightning?.flash ?? 0);
    this.sun.intensity = light.sun;
    this.sun.color.copy(this.sunCool).lerp(this.sunWarm, light.clearing)
      .lerp(this.flashColor, frame.lightning?.flash ?? 0);
    this.hemisphere.intensity = light.hemisphere;
    this.scene.environmentIntensity = light.environment;
    const fog = this.scene.fog as FogExp2;
    fog.density = light.fog;
    fog.color.copy(this.rainHaze).lerp(this.clearHaze, light.clearing)
      .lerp(this.snowHaze, frame.weather.snow * .65).lerp(this.stormHaze, frame.weather.storm);
    (this.scene.background as Color).copy(fog.color);
    this.sky.update(frame);
    this.landscape.update(frame);
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
    // Broad tree shadows move slowly; the near fire needs a faster cadence.
    // Each light owns its invalidation, including the two fire-light samples.
    if (QUALITY[this.quality].shadows) {
      if (frame.weather.revision !== this.weatherRevision || frame.fire.revision !== this.fireRevision
        || frame.elapsed < this.lastCanopyShadow || this.lastCanopyShadow === -Infinity
        || (frame.delta === 0 && frame.elapsed !== this.lastCanopyShadow)
        || (this.landscape.movingCanopy && frame.elapsed - this.lastCanopyShadow >= 1 / 6)) {
        this.sun.shadow.needsUpdate = true;
        this.lastCanopyShadow = frame.elapsed;
        this.canopyShadowUpdates += 1;
        this.renderer.shadowMap.needsUpdate = true;
      }
      if (this.fireLights.length && (frame.fire.revision !== this.fireRevision
        || frame.elapsed < this.lastFireShadow
        || frame.elapsed - this.lastFireShadow >= 1 / 10
        || (frame.delta === 0 && frame.elapsed !== this.lastFireShadow))) {
        this.fireLights.forEach(light => { light.shadow.needsUpdate = true; });
        this.lastFireShadow = frame.elapsed;
        this.fireShadowUpdates += 1;
        this.renderer.shadowMap.needsUpdate = true;
      }
    }
    this.post.render(frame);
    this.weatherRevision = frame.weather.revision;
    this.fireRevision = frame.fire.revision;
    this.renderedElapsed = frame.elapsed;
    this.frameFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return true;
  }

  diagnostics() {
    return { quality: this.quality, viewX: this.goal.x, viewY: this.goal.y, calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries, textures: this.renderer.info.memory.textures,
      contactBakes: this.contacts.bakes, contactResolution: this.contacts.resolution,
      canopyBakes: this.canopy.bakes,
      weatherSunIntensity: this.sun.intensity, weatherEnvironmentIntensity: this.scene.environmentIntensity,
      renderedWeatherRevision: this.weatherRevision, renderedFireRevision: this.fireRevision,
      canopyShadowUpdates: this.canopyShadowUpdates, fireShadowUpdates: this.fireShadowUpdates,
      lastCanopyShadow: this.lastCanopyShadow, lastFireShadow: this.lastFireShadow,
      deferredFrames: this.deferredFrames, renderedElapsed: this.renderedElapsed,
      drawingWidth: this.canvas.width, drawingHeight: this.canvas.height,
      ...this.post.diagnostics(), ...this.landscape.diagnostics?.() };
  }

  dispose(): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (this.frameFence && !gl.isContextLost()) gl.deleteSync(this.frameFence);
    this.frameFence = null;
    this.landscape.dispose();
    this.sky.dispose();
    this.environment?.dispose();
    this.contacts.dispose();
    this.canopy.dispose();
    this.post.dispose();
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.scene.clear();
    this.renderer.dispose();
  }
}
