import {
  Color, DoubleSide, Line, Matrix4, Mesh, MeshStandardMaterial, NormalBlending,
  OrthographicCamera, PlaneGeometry, Points, Scene, ShaderMaterial, Sprite,
  Vector2, Vector4, WebGLRenderTarget,
} from 'three';
import type { Material, Object3D, Texture, WebGLRenderer } from 'three';

const captureVertex = /* glsl */ `
  varying float vCanopyHeight;
  #include <batching_pars_vertex>
  void main() {
    #include <batching_vertex>
    vec4 p=vec4(position,1.0);
    #ifdef USE_BATCHING
      p=batchingMatrix*p;
    #endif
    #ifdef USE_INSTANCING
      p=instanceMatrix*p;
    #endif
    vec4 world=modelMatrix*p;
    vCanopyHeight=world.y;
    gl_Position=projectionMatrix*viewMatrix*world;
  }
`;

const blurFragment = /* glsl */ `
  uniform sampler2D source;
  uniform vec2 direction;
  varying vec2 vUv;
  void main() {
    float coverage=texture2D(source,vUv).r*.227027;
    coverage+=texture2D(source,vUv+direction*1.384615).r*.316216;
    coverage+=texture2D(source,vUv-direction*1.384615).r*.316216;
    coverage+=texture2D(source,vUv+direction*3.230769).r*.070270;
    coverage+=texture2D(source,vUv-direction*3.230769).r*.070270;
    gl_FragColor=vec4(vec3(coverage),1.0);
  }
`;

/** Per-surface opacity accumulates as 1-product(1-opacity), without a depth test. */
function canopyOpacity(mesh: Mesh): number {
  const explicit = mesh.userData.canopyCoverage as unknown;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return Math.max(0, Math.min(1, explicit));
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  let opacity = 0;
  for (const material of materials) {
    if (material.transparent || material.opacity < 1) continue;
    if (material.name === 'living-forest-individual-leaves') opacity = Math.max(opacity, .045);
    else if (material.name === 'living-forest-wet-bark') opacity = Math.max(opacity, .32);
    else if (material.name === 'generated-weathered-canvas') opacity = Math.max(opacity, .92);
    else if (material.name === 'generated-canvas-seams-and-cord') opacity = Math.max(opacity, .42);
  }
  return opacity;
}

/**
 * A cached, soft estimate of how much overhead structure hides the sky. This is
 * macro canopy occlusion, not another direct-light shadow or a per-frame effect.
 * R is coverage: zero is open sky; one is covered. The projection also serves
 * the atmosphere pass, so surface light and air can share the same clearings.
 */
export class CanopyLightField {
  readonly texture: Texture;
  readonly matrix = new Matrix4();
  private readonly resolution = 512;
  private readonly field = new WebGLRenderTarget(this.resolution, this.resolution, { depthBuffer: false });
  private readonly temporary = new WebGLRenderTarget(this.resolution, this.resolution, { depthBuffer: false });
  private readonly camera = new OrthographicCamera(-48, 48, 60, -60, .1, 100);
  private readonly capture = new ShaderMaterial({
    name: 'canopy-coverage-capture',
    uniforms: { uOpacity: { value: .045 } },
    transparent: true, blending: NormalBlending, side: DoubleSide,
    depthTest: false, depthWrite: false, toneMapped: false,
    vertexShader: captureVertex,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying float vCanopyHeight;
      void main() {
        float coverage=uOpacity*smoothstep(2.3,3.1,vCanopyHeight);
        if(coverage<.0001)discard;
        gl_FragColor=vec4(1.0,1.0,1.0,coverage);
      }
    `,
  });
  private readonly blur = new ShaderMaterial({
    name: 'canopy-coverage-blur',
    uniforms: { source: { value: this.field.texture }, direction: { value: new Vector2() } },
    depthTest: false, depthWrite: false, toneMapped: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}
    `,
    fragmentShader: blurFragment,
  });
  private readonly quad = new Mesh(new PlaneGeometry(2, 2), this.blur);
  private readonly blurScene = new Scene();
  private readonly blurCamera = new OrthographicCamera(-1, 1, 1, -1, .1, 2);
  private readonly installed = new WeakSet<Material>();
  private readonly enabled = { value: 0 };
  private bakeCount = 0;
  private disposed = false;

  constructor() {
    this.texture = this.field.texture;
    this.texture.name = 'generated-canopy-coverage';
    this.temporary.texture.name = 'generated-canopy-coverage-blur';
    this.camera.position.set(0, 70, -36);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(0, 0, -36);
    this.camera.layers.enableAll();
    this.camera.updateMatrixWorld(true);
    this.matrix.set(.5,0,0,.5, 0,.5,0,.5, 0,0,.5,.5, 0,0,0,1)
      .multiply(this.camera.projectionMatrix).multiply(this.camera.matrixWorldInverse);
    this.blurCamera.position.z = 1;
    this.quad.frustumCulled = false;
    this.blurScene.add(this.quad);
  }

  get bakes(): number { return this.bakeCount; }

  applyTo(scene: Scene): void {
    if (this.disposed) return;
    scene.traverse(object => {
      if (!(object instanceof Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!(material instanceof MeshStandardMaterial) || this.installed.has(material)) continue;
        this.installed.add(material);
        const previous = material.onBeforeCompile.bind(material);
        const key = material.customProgramCacheKey();
        // Leaves already carry a local estimate of crown interior occlusion.
        // Keep the broad field weaker there rather than blackening it twice.
        const strength = material.name === 'living-forest-individual-leaves' ? .22 : .43;
        material.onBeforeCompile = (shader, renderer) => {
          previous(shader, renderer);
          shader.uniforms.uYyjCanopyMap = { value: this.texture };
          shader.uniforms.uYyjCanopyMatrix = { value: this.matrix };
          shader.uniforms.uYyjCanopyEnabled = this.enabled;
          shader.uniforms.uYyjCanopyStrength = { value: strength };
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>\nvarying vec3 vYyjCanopyPosition;`)
            .replace('#include <worldpos_vertex>', /* glsl */ `
              #include <worldpos_vertex>
              vec4 yyjCanopyWorld=vec4(transformed,1.0);
              #ifdef USE_BATCHING
                yyjCanopyWorld=batchingMatrix*yyjCanopyWorld;
              #endif
              #ifdef USE_INSTANCING
                yyjCanopyWorld=instanceMatrix*yyjCanopyWorld;
              #endif
              vYyjCanopyPosition=(modelMatrix*yyjCanopyWorld).xyz;
            `);
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', /* glsl */ `
              #include <common>
              varying vec3 vYyjCanopyPosition;
              uniform sampler2D uYyjCanopyMap;
              uniform mat4 uYyjCanopyMatrix;
              uniform float uYyjCanopyEnabled,uYyjCanopyStrength;
            `)
            .replace('#include <aomap_fragment>', /* glsl */ `
              #include <aomap_fragment>
              vec4 yyjCanopyProjected=uYyjCanopyMatrix*vec4(vYyjCanopyPosition,1.0);
              vec2 yyjCanopyUv=yyjCanopyProjected.xy/yyjCanopyProjected.w;
              float yyjCanopyInside=step(0.0,yyjCanopyUv.x)*step(yyjCanopyUv.x,1.0)
                *step(0.0,yyjCanopyUv.y)*step(yyjCanopyUv.y,1.0);
              float yyjOverhead=texture2D(uYyjCanopyMap,clamp(yyjCanopyUv,0.0,1.0)).r
                *yyjCanopyInside*uYyjCanopyEnabled;
              float yyjBelowCrown=1.0-smoothstep(4.0,24.0,vYyjCanopyPosition.y);
              float yyjSkyTransmission=1.0-yyjOverhead*yyjBelowCrown*uYyjCanopyStrength;
              reflectedLight.indirectDiffuse*=yyjSkyTransmission;
              reflectedLight.indirectSpecular*=mix(1.0,yyjSkyTransmission,.70);
            `);
        };
        material.customProgramCacheKey = () => `${key}/canopy-light-field-v1`;
        material.needsUpdate = true;
      }
    });
  }

  bake(renderer: WebGLRenderer, scene: Scene): void {
    if (this.disposed) return;
    const hidden: Object3D[] = [];
    const hooks = new Map<Mesh, Mesh['onBeforeRender']>();
    const previous = {
      target: renderer.getRenderTarget(),
      color: renderer.getClearColor(new Color()).clone(),
      alpha: renderer.getClearAlpha(), autoClear: renderer.autoClear,
      viewport: renderer.getViewport(new Vector4()),
      scissor: renderer.getScissor(new Vector4()), scissorTest: renderer.getScissorTest(),
      shadows: renderer.shadowMap.enabled,
      shadowAutoUpdate: renderer.shadowMap.autoUpdate,
      shadowNeedsUpdate: renderer.shadowMap.needsUpdate,
      override: scene.overrideMaterial, fog: scene.fog, background: scene.background,
    };
    try {
      scene.traverse(object => {
        const coverage = object instanceof Mesh ? canopyOpacity(object) : 0;
        if (object instanceof Mesh && coverage > 0) {
          hooks.set(object, object.onBeforeRender);
          object.onBeforeRender = () => {
            this.capture.uniforms.uOpacity!.value = coverage;
            this.capture.uniformsNeedUpdate = true;
          };
        } else if (object.visible && (object instanceof Mesh || object instanceof Points
          || object instanceof Line || object instanceof Sprite)) {
          hidden.push(object);object.visible = false;
        }
      });
      renderer.autoClear = true;
      renderer.shadowMap.enabled = false;
      renderer.setScissorTest(false);
      renderer.setClearColor(0x000000, 0);
      scene.overrideMaterial = this.capture;
      scene.background = null;scene.fog = null;
      renderer.setRenderTarget(this.field);
      renderer.render(scene, this.camera);
      // 96 by 120 world metres: use the same blur footprint along both axes.
      this.blur.uniforms.source!.value = this.field.texture;
      (this.blur.uniforms.direction!.value as Vector2).set(2.5 / this.resolution, 0);
      renderer.setRenderTarget(this.temporary);
      renderer.render(this.blurScene, this.blurCamera);
      this.blur.uniforms.source!.value = this.temporary.texture;
      (this.blur.uniforms.direction!.value as Vector2).set(0, 2 / this.resolution);
      renderer.setRenderTarget(this.field);
      renderer.render(this.blurScene, this.blurCamera);
      this.enabled.value = 1;
      this.bakeCount++;
    } finally {
      hooks.forEach((hook, mesh) => { mesh.onBeforeRender = hook; });
      hidden.forEach(object => { object.visible = true; });
      scene.overrideMaterial = previous.override;
      scene.fog = previous.fog;scene.background = previous.background;
      renderer.autoClear = previous.autoClear;
      renderer.shadowMap.enabled = previous.shadows;
      renderer.shadowMap.autoUpdate = previous.shadowAutoUpdate;
      renderer.shadowMap.needsUpdate = previous.shadowNeedsUpdate;
      renderer.setClearColor(previous.color, previous.alpha);
      renderer.setRenderTarget(previous.target);
      renderer.setViewport(previous.viewport);
      renderer.setScissor(previous.scissor);
      renderer.setScissorTest(previous.scissorTest);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;this.enabled.value = 0;
    this.field.dispose();this.temporary.dispose();
    this.capture.dispose();this.blur.dispose();this.quad.geometry.dispose();
    this.blurScene.clear();
  }
}
