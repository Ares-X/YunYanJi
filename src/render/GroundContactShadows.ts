import {
  Color, DoubleSide, Float32BufferAttribute, Mesh, OrthographicCamera, PlaneGeometry, Scene,
  ShaderMaterial, Vector2, Vector4, WebGLRenderTarget,
} from 'three';
import type { Material, Object3D, WebGLRenderer } from 'three';
import { setContactShadowField } from './materials/proceduralMaterials';

const captureVertex = /* glsl */ `
  varying float vHeight;
  #include <batching_pars_vertex>
  void main() {
    #include <batching_vertex>
    vec4 p = vec4(position, 1.0);
    #ifdef USE_BATCHING
      p = batchingMatrix * p;
    #endif
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
    #endif
    vec4 world = modelMatrix * p;
    vHeight = world.y;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const blurFragment = /* glsl */ `
  uniform sampler2D source;
  uniform vec2 direction;
  varying vec2 vUv;
  void main() {
    vec4 color = texture2D(source, vUv) * 0.227027;
    color += texture2D(source, vUv + direction * 1.384615) * 0.316216;
    color += texture2D(source, vUv - direction * 1.384615) * 0.316216;
    color += texture2D(source, vUv + direction * 3.230769) * 0.070270;
    color += texture2D(source, vUv - direction * 3.230769) * 0.070270;
    gl_FragColor = color;
  }
`;

/**
 * A cached approximation of short-range ground occlusion. The field comes from
 * this scene's generated geometry, never from an authored image. An upward
 * camera captures the nearest underside, so a tall wall still contacts the snow.
 * Moving foliage keeps its real-time directional shadow; this broad contact
 * layer is regenerated only at creation or WebGL context restoration.
 */
export class GroundContactShadows {
  readonly resolution = 1024;
  readonly bounds = new Vector4(-16, -18, 32, 32);
  private readonly field = new WebGLRenderTarget(this.resolution, this.resolution);
  private readonly temporary = new WebGLRenderTarget(this.resolution, this.resolution, { depthBuffer: false });
  private readonly camera = new OrthographicCamera(-16, 16, 16, -16, 0.01, 7);
  private readonly captureMaterial = new ShaderMaterial({
    side: DoubleSide,
    toneMapped: false,
    vertexShader: captureVertex,
    fragmentShader: /* glsl */ `
      varying float vHeight;
      void main() {
        float occlusion = exp(-max(0.0, vHeight) * 2.4);
        gl_FragColor = vec4(vec3(occlusion), 1.0);
      }
    `,
  });
  private readonly blurMaterial = new ShaderMaterial({
    uniforms: { source: { value: this.field.texture }, direction: { value: new Vector2() } },
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: blurFragment,
  });
  private readonly quad = new Mesh(new PlaneGeometry(2, 2), this.blurMaterial);
  private readonly blurScene = new Scene();
  private readonly blurCamera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 2);
  private bakeCount = 0;

  constructor() {
    this.field.texture.name = 'generated-ground-contact';
    this.temporary.texture.name = 'ground-contact-blur';
    this.camera.position.set(0, -0.45, -2);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(0, 1, -2);
    this.blurCamera.position.z = 1;
    this.quad.frustumCulled = false;
    this.blurScene.add(this.quad);
  }

  bake(renderer: WebGLRenderer, scene: Scene): void {
    const hidden: Object3D[] = [];
    const materials = new Set<Material>();
    scene.traverse((object) => {
      let cutout = false;
      if (object instanceof Mesh) {
        const entries = Array.isArray(object.material) ? object.material : [object.material];
        if (!object.castShadow && object.receiveShadow) entries.forEach((material) => materials.add(material));
        // This inexpensive override pass has no UV/alpha sampling. Foliage
        // retains its correctly clipped directional shadow and screen-space AO.
        cutout = entries.some((material) => material.alphaTest > 0
          && (('map' in material && Boolean(material.map))
            || ('alphaMap' in material && Boolean(material.alphaMap))));
        // This is a field projected onto the ground, not general-purpose AO.
        // Letting a caster sample its own underside darkens a step's snow cap.
        // Static batches already preserve cast/receive flags, so one constant
        // vertex weight is sufficient and survives material sharing correctly.
        const weight = Number(!object.castShadow && object.receiveShadow);
        const count = object.geometry.getAttribute('position')?.count ?? 0;
        const current = object.geometry.getAttribute('aYyjContactReceiver');
        if (!current || current.count !== count || current.itemSize !== 1) {
          object.geometry.setAttribute('aYyjContactReceiver',
            new Float32BufferAttribute(new Float32Array(count).fill(weight), 1));
        } else if (count > 0 && current.getX(0) !== weight) {
          for (let i = 0; i < count; i += 1) current.setX(i, weight);
          current.needsUpdate = true;
        }
      }
      // The ground cannot occlude itself; particles and the sky are not casters.
      if (object.visible && ('isPoints' in object || (object instanceof Mesh && (!object.castShadow || cutout)))) {
        hidden.push(object);
        object.visible = false;
      }
    });
    const previous = {
      target: renderer.getRenderTarget(),
      color: renderer.getClearColor(new Color()).clone(),
      alpha: renderer.getClearAlpha(),
      autoClear: renderer.autoClear,
      shadows: renderer.shadowMap.enabled,
      background: scene.background,
      override: scene.overrideMaterial,
    };
    try {
      renderer.autoClear = true;
      renderer.shadowMap.enabled = false;
      renderer.setClearColor(0x000000, 0);
      scene.background = null;
      scene.overrideMaterial = this.captureMaterial;
      renderer.setRenderTarget(this.field);
      renderer.render(scene, this.camera);

      scene.overrideMaterial = previous.override;
      const uniforms = this.blurMaterial.uniforms;
      uniforms.source!.value = this.field.texture;
      (uniforms.direction!.value as Vector2).set(2.2 / this.resolution, 0);
      renderer.setRenderTarget(this.temporary);
      renderer.render(this.blurScene, this.blurCamera);
      uniforms.source!.value = this.temporary.texture;
      (uniforms.direction!.value as Vector2).set(0, 2.2 / this.resolution);
      renderer.setRenderTarget(this.field);
      renderer.render(this.blurScene, this.blurCamera);
      materials.forEach((material) => setContactShadowField(material, this.field.texture, this.bounds));
      this.bakeCount += 1;
    } finally {
      scene.overrideMaterial = previous.override;
      scene.background = previous.background;
      hidden.forEach((object) => { object.visible = true; });
      renderer.autoClear = previous.autoClear;
      renderer.shadowMap.enabled = previous.shadows;
      renderer.setClearColor(previous.color, previous.alpha);
      renderer.setRenderTarget(previous.target);
    }
  }

  get bakes(): number { return this.bakeCount; }

  dispose(): void {
    this.field.dispose();
    this.temporary.dispose();
    this.captureMaterial.dispose();
    this.blurMaterial.dispose();
    this.quad.geometry.dispose();
    this.blurScene.clear();
  }
}
