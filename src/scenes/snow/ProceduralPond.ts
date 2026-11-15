import {
  BufferGeometry, Color, Float32BufferAttribute, LinearFilter, LinearSRGBColorSpace,
  Matrix4, UniformsLib, UniformsUtils, Vector2,
} from 'three';
import type { Camera, ShaderMaterial } from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { createRandom } from '../../core/random';
import type { EnvironmentSnapshot, QualityLevel } from '../../core/types';

export const POND = { x: -1.25, y: 0.015, z: 0.9, rx: 2.43, rz: 1.62 } as const;

/** Local XY angle: after the -PI/2 rotation, world Z uses minus sin(theta). */
export function pondRadius(theta: number): number {
  return 1 + 0.045 * Math.sin(theta * 3 + 0.7) + 0.025 * Math.sin(theta * 7 - 0.5);
}

const RESOLUTION: Readonly<Record<QualityLevel, number>> = { low: 256, medium: 384, high: 512 };

function createPondGeometry(): BufferGeometry {
  const segments = 160;
  const positions: number[] = [0, 0, 0];
  const normals: number[] = [0, 0, 1];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const theta = i / segments * Math.PI * 2;
    const radius = pondRadius(theta);
    positions.push(Math.cos(theta) * POND.rx * radius, Math.sin(theta) * POND.rz * radius, 0);
    normals.push(0, 0, 1);
    if (i < segments) indices.push(0, i + 1, i + 2);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

const vertexShader = /* glsl */ `
  uniform mat4 textureMatrix;
  varying vec4 vReflection;
  varying vec3 vWorldPosition;
  varying vec2 vPondPosition;
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vPondPosition = position.xy;
    vReflection = textureMatrix * vec4(position, 1.0);
    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
    #include <logdepthbuf_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec3 color;
  uniform vec3 uIceColor;
  uniform vec3 uFrostColor;
  uniform vec2 uSeed;
  uniform vec2 uTexel;
  uniform float uTime;
  uniform float uWind;
  varying vec4 vReflection;
  varying vec3 vWorldPosition;
  varying vec2 vPondPosition;
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  #include <dithering_pars_fragment>

  float pondHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float pondNoise(vec2 p) {
    vec2 cell = floor(p), t = fract(p);
    t = t * t * (3.0 - 2.0 * t);
    return mix(mix(pondHash(cell), pondHash(cell + vec2(1.0, 0.0)), t.x),
      mix(pondHash(cell + vec2(0.0, 1.0)), pondHash(cell + 1.0), t.x), t.y);
  }
  vec3 readReflection(vec2 uv) {
    return texture2D(tDiffuse, clamp(uv, uTexel * 0.5, vec2(1.0) - uTexel * 0.5)).rgb;
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = vPondPosition;
    vec2 ellipse = p / vec2(${POND.rx.toFixed(2)}, ${POND.rz.toFixed(2)});
    float theta = atan(ellipse.y, ellipse.x);
    float boundary = 1.0 + 0.045 * sin(theta * 3.0 + 0.7) + 0.025 * sin(theta * 7.0 - 0.5);
    float shoreDistance = max(0.0, boundary - length(ellipse)) * ${POND.rz.toFixed(2)};
    float breakup = pondNoise(p * vec2(6.4, 5.1) + uSeed);
    float broadIce = pondNoise(p * 1.4 + uSeed * 0.6);
    float frostWidth = 0.045 + breakup * 0.13 + 0.025 * sin(theta * 9.0 + uSeed.x);
    float iceWidth = 0.14 + broadIce * 0.22;
    float frost = 1.0 - smoothstep(frostWidth * 0.35, frostWidth, shoreDistance);
    frost *= 0.72 + breakup * 0.28;
    float ice = 1.0 - smoothstep(iceWidth * 0.5, iceWidth, shoreDistance);

    // Analytic height derivatives in metres: sub-millimetre winter ripples,
    // with a quiet frozen fringe. No normal map or animated texture is needed.
    vec2 waveA = vec2(12.0, 4.0);
    vec2 waveB = vec2(-7.0, 19.0);
    float phaseA = dot(p, waveA) + uTime * 0.78 + uSeed.x;
    float phaseB = dot(p, waveB) - uTime * 0.62 + uSeed.y;
    float amplitude = (0.00045 + uWind * 0.00065) * (1.0 - ice * 0.92);
    vec2 slope = amplitude * (waveA * cos(phaseA) + waveB * cos(phaseB) * 0.42);
    // The pond is horizontal; local +Y points toward world -Z.
    vec3 waterNormal = normalize(vec3(-slope.x, 1.0, slope.y));
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    float grazing = 1.0 - clamp(dot(waterNormal, viewDirection), 0.0, 1.0);
    float fresnel = 0.02 + 0.98 * pow(grazing, 5.0);

    vec2 reflectionUv = vReflection.xy / max(vReflection.w, 0.0001);
    reflectionUv += vec2(slope.x, -slope.y) * 0.035;
    vec2 softness = uTexel * (0.72 + ice * 1.2 + uWind * 0.18);
    vec3 reflected = readReflection(reflectionUv) * 0.4;
    reflected += readReflection(reflectionUv + vec2(softness.x, 0.0)) * 0.15;
    reflected += readReflection(reflectionUv - vec2(softness.x, 0.0)) * 0.15;
    reflected += readReflection(reflectionUv + vec2(0.0, softness.y)) * 0.15;
    reflected += readReflection(reflectionUv - vec2(0.0, softness.y)) * 0.15;
    reflected *= mix(vec3(0.68, 0.82, 0.83), vec3(0.83, 0.90, 0.92), fresnel);

    float reflectionAmount = (0.18 + fresnel * 0.64) * (1.0 - ice * 0.28);
    vec3 deepWater = color * (1.0 + ice * 0.22);
    vec3 surface = mix(deepWater, reflected, reflectionAmount);
    surface = mix(surface, uIceColor, ice * 0.38);
    surface = mix(surface, uFrostColor, frost * 0.82);
    gl_FragColor = vec4(surface, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>

    // Reflected geometry already includes fog along its reflected sightline.
    // Add aerial perspective to the remaining water/ice contribution only.
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
      #endif
      float reflectedContribution = reflectionAmount * (1.0 - ice * 0.38) * (1.0 - frost * 0.82);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor * (1.0 - reflectedContribution));
    #endif
    #include <dithering_fragment>
  }
`;

export interface ProceduralPond {
  readonly mesh: Reflector;
  update(frame: EnvironmentSnapshot): void;
  setQuality(quality: QualityLevel): void;
  invalidate(): void;
  /** Geometry and material belong to the scene's normal traversal disposal. */
  disposeTargets(): void;
}

/** A real planar scene reflection with a seeded, analytical winter-water finish. */
export function createProceduralPond(seed: string, quality: QualityLevel): ProceduralPond {
  const random = createRandom(`${seed}/pond-surface`);
  const size = RESOLUTION[quality];
  const mesh = new Reflector(createPondGeometry(), {
    color: 0x233b40,
    clipBias: 0.003,
    textureWidth: size,
    textureHeight: size,
    multisample: 0,
    shader: {
      name: 'ProceduralWinterPond',
      uniforms: UniformsUtils.merge([UniformsLib.fog, {
        tDiffuse: { value: null }, color: { value: new Color() }, textureMatrix: { value: new Matrix4() },
        uIceColor: { value: new Color(0x94a9a7) }, uFrostColor: { value: new Color(0xd1dfd9) },
        uSeed: { value: new Vector2(random() * 71, random() * 71) },
        uTexel: { value: new Vector2(1 / size, 1 / size) }, uTime: { value: 0 }, uWind: { value: 0 },
      }]),
      vertexShader,
      fragmentShader,
    },
  });
  mesh.name = 'procedural-winter-pond';
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(POND.x, POND.y, POND.z);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.reflectionUpdates = 0;
  mesh.userData.reflectionSize = size;
  const material = mesh.material as ShaderMaterial;
  material.fog = true;
  material.dithering = true;
  material.toneMapped = true;
  const renderTarget = mesh.getRenderTarget();
  renderTarget.texture.name = 'generated-pond-reflection';
  // Reflector creates a HalfFloat target. Its scene render stays in linear HDR;
  // tone mapping and display colour conversion happen once in the pond shader.
  renderTarget.texture.colorSpace = LinearSRGBColorSpace;
  renderTarget.texture.minFilter = LinearFilter;
  renderTarget.texture.magFilter = LinearFilter;
  renderTarget.texture.generateMipmaps = false;

  const capturedCameraWorld = new Matrix4();
  const capturedProjection = new Matrix4();
  const capturedPondWorld = new Matrix4();
  let capturedCamera: Camera | undefined;
  let elapsed = 0;
  let lastCapture = -Infinity;
  let lastSnow = NaN;
  let dirty = true;
  let disposed = false;
  const drawReflection = mesh.onBeforeRender;
  mesh.onBeforeRender = (renderer, scene, camera, geometry, drawMaterial, group) => {
    if (disposed) return;
    const moved = capturedCamera !== camera
      || !camera.matrixWorld.equals(capturedCameraWorld)
      || !camera.projectionMatrix.equals(capturedProjection)
      || !mesh.matrixWorld.equals(capturedPondWorld);
    if (!dirty && !mesh.forceUpdate && !moved && elapsed - lastCapture < 1 / 8) return;
    drawReflection.call(mesh, renderer, scene, camera, geometry, drawMaterial, group);
    capturedCamera = camera;
    capturedCameraWorld.copy(camera.matrixWorld);
    capturedProjection.copy(camera.projectionMatrix);
    capturedPondWorld.copy(mesh.matrixWorld);
    lastCapture = elapsed;
    dirty = false;
    mesh.userData.reflectionUpdates += 1;
  };

  const invalidate = (): void => {
    if (disposed) return;
    dirty = true;
    mesh.forceUpdate = true;
  };
  invalidate();
  return {
    mesh,
    update(frame): void {
      if (disposed) return;
      // A replay or settings change can alter the scene without advancing time.
      if (frame.elapsed < elapsed || frame.snowIntensity !== lastSnow) invalidate();
      elapsed = frame.elapsed;
      lastSnow = frame.snowIntensity;
      material.uniforms.uTime!.value = elapsed;
      material.uniforms.uWind!.value = Math.max(0, Math.min(1, frame.wind.strength));
    },
    setQuality(next): void {
      if (disposed) return;
      const resolution = RESOLUTION[next];
      if (renderTarget.width === resolution) return;
      renderTarget.setSize(resolution, resolution);
      (material.uniforms.uTexel!.value as Vector2).set(1 / resolution, 1 / resolution);
      mesh.userData.reflectionSize = resolution;
      invalidate();
    },
    invalidate,
    disposeTargets(): void {
      if (disposed) return;
      disposed = true;
      // Reflector.dispose() also disposes its material, which the scene owns.
      renderTarget.dispose();
    },
  };
}
