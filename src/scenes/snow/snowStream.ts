import {
  BufferGeometry, Color, Float32BufferAttribute, LinearFilter, LinearSRGBColorSpace,
  Matrix4, UniformsLib, UniformsUtils, Vector2, Vector4,
} from 'three';
import type { Camera, ShaderMaterial } from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { createRandom } from '../../core/random';
import type { EnvironmentSnapshot, QualityLevel } from '../../core/types';
import { STREAM_LEVEL, streamShoreline } from './snowLandscape';

const RESOLUTION: Readonly<Record<QualityLevel, number>> = { low: 256, medium: 384, high: 512 };

function streamGeometry(): BufferGeometry {
  const rows = 360, columns = 8;
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (let row = 0; row <= rows; row += 1) {
    const z = 38 - row / rows * 182;
    const left = streamShoreline(z, -1) - 0.2;
    const right = streamShoreline(z, 1) + 0.2;
    const centre = (left + right) * 0.5;
    const halfWidth = (right - left) * 0.5;
    for (let column = 0; column <= columns; column += 1) {
      const u = column / columns * 2 - 1;
      // Reflector's local XY plane is turned horizontal at the water level.
      positions.push(centre + u * halfWidth, -z, 0);
      normals.push(0, 0, 1);
      uvs.push(u, halfWidth);
      if (row < rows && column < columns) {
        const a = row * (columns + 1) + column;
        const b = a + 1, c = a + columns + 1, d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

const vertexShader = /* glsl */ `
  uniform mat4 textureMatrix;
  varying vec4 vReflection;
  varying vec3 vWorldPosition;
  varying vec2 vStreamPosition;
  varying vec2 vBank;
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vBank = uv;
    vStreamPosition = vec2(position.x, -position.y);
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
  uniform vec4 uObstacles[12];
  varying vec4 vReflection;
  varying vec3 vWorldPosition;
  varying vec2 vStreamPosition;
  varying vec2 vBank;
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  #include <dithering_pars_fragment>

  float streamHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float streamNoise(vec2 p) {
    vec2 cell = floor(p), t = fract(p);
    t = t * t * (3.0 - 2.0 * t);
    return mix(mix(streamHash(cell), streamHash(cell + vec2(1.0, 0.0)), t.x),
      mix(streamHash(cell + vec2(0.0, 1.0)), streamHash(cell + 1.0), t.x), t.y);
  }
  // Value and exact first derivatives of cubic value noise. Irregular slopes
  // break reflection contours without repeating horizontal sine-wave bands.
  vec3 streamNoiseGradient(vec2 p) {
    vec2 cell = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    vec2 derivative = 6.0 * f * (1.0 - f);
    float a = streamHash(cell), b = streamHash(cell + vec2(1.0, 0.0));
    float c = streamHash(cell + vec2(0.0, 1.0)), d = streamHash(cell + 1.0);
    float value = mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    return vec3(value, derivative.x * mix(b - a, d - c, u.y),
      derivative.y * mix(c - a, d - b, u.x));
  }
  vec3 reflectionAt(vec2 uv) {
    return texture2D(tDiffuse, clamp(uv, uTexel * 0.5, vec2(1.0) - uTexel * 0.5)).rgb;
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = vStreamPosition;
    float shoreDistance = max(0.0, (1.0 - abs(vBank.x)) * vBank.y - 0.20);
    float edgeNoise = streamNoise(p * vec2(8.4, 5.2) + uSeed);
    float iceWidth = 0.10 + streamNoise(p * 2.1 + uSeed * 0.6) * 0.35;
    float ice = 1.0 - smoothstep(iceWidth * 0.3, iceWidth, shoreDistance);
    float frost = 1.0 - smoothstep(0.018, 0.07 + edgeNoise * 0.11, shoreDistance);
    float frozenPocket = smoothstep(0.32, 0.63, streamNoise(p * vec2(0.7, 0.32) + uSeed));
    ice *= frozenPocket;
    frost *= frozenPocket;

    // Foam is generated downstream of actual emergent stones. It is sparse,
    // fragmented by the current, and absent from the quiet open stretches.
    float wake = 0.0;
    float foam = 0.0;
    for (int i = 0; i < 12; i++) {
      vec4 obstruction = uObstacles[i];
      if (obstruction.w < 0.5) continue;
      vec2 q = p - obstruction.xy;
      float radius = obstruction.z;
      float distanceToRock = length(q);
      float downstream = smoothstep(-radius * 0.5, radius, q.y);
      float rim = smoothstep(radius * 0.85, radius + 0.025, distanceToRock)
        * (1.0 - smoothstep(radius + 0.025, radius + 0.23, distanceToRock));
      float trail = exp(-q.x * q.x / max(0.025, 0.06 + max(q.y, 0.0) * 0.055))
        * smoothstep(radius * 0.6, radius + 0.3, q.y)
        * (1.0 - smoothstep(1.0 + radius, 2.7 + radius, q.y));
      foam = max(foam, (rim * 0.75 + trail * 0.22) * downstream);
      wake = max(wake, exp(-dot(q, q) / 3.5) * downstream);
    }

    // Flowing irregular capillary waves. Footprint filtering removes fine
    // detail in the distance before it aliases into horizontal shimmer.
    vec2 flow = p + vec2(0.0, -uTime * 0.16);
    float pixelFootprint = max(length(dFdx(p)), length(dFdy(p)));
    float detailFade = 1.0 - smoothstep(0.018, 0.15, pixelFootprint);
    float turbulence = 0.45 + streamNoise(flow * 0.47 + uSeed) * 0.9 + wake * 0.75;
    vec2 broadFrequency = vec2(1.7, 1.3);
    vec2 middleFrequency = vec2(6.2, 3.4);
    vec2 fineFrequency = vec2(15.1, 8.7);
    mat2 turn = mat2(0.9239, -0.3827, 0.3827, 0.9239);
    vec3 broad = streamNoiseGradient(turn * flow * broadFrequency + uSeed);
    vec3 middle = streamNoiseGradient(transpose(turn) * flow * middleFrequency + uSeed * 2.3 + broad.x * 0.8);
    vec3 fine = streamNoiseGradient(flow * fineFrequency + uSeed * 0.7 + middle.x);
    vec2 slope = transpose(turn) * (broad.yz * broadFrequency) * 0.0105
      + turn * (middle.yz * middleFrequency) * 0.0030 * turbulence
      + fine.yz * fineFrequency * 0.00065 * detailFade;
    slope *= (1.0 + uWind * 0.5) * (1.0 - ice * 0.92);
    vec3 waterNormal = normalize(vec3(-slope.x, 1.0, -slope.y));
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    float grazing = 1.0 - clamp(dot(waterNormal, viewDirection), 0.0, 1.0);
    float fresnel = 0.02 + 0.98 * pow(grazing, 5.0);
    vec2 reflectionUv = vReflection.xy / max(vReflection.w, 0.0001);
    reflectionUv += vec2(slope.x, -slope.y) * 0.24;
    vec2 blur = uTexel * (0.6 + ice * 1.5 + wake * 0.4);
    vec3 reflected = reflectionAt(reflectionUv) * 0.5
      + reflectionAt(reflectionUv + blur) * 0.125
      + reflectionAt(reflectionUv - blur) * 0.125
      + reflectionAt(reflectionUv + vec2(blur.x, -blur.y)) * 0.125
      + reflectionAt(reflectionUv + vec2(-blur.x, blur.y)) * 0.125;
    reflected *= vec3(0.88, 0.94, 0.96);
    float reflectionAmount = (0.17 + fresnel * 0.70) * (1.0 - ice * 0.42);
    float sediment = streamNoise(p * 1.5 + uSeed) * 0.45 + streamNoise(p * 6.8) * 0.15;
    vec3 deepWater = color * (0.75 + sediment);
    vec3 surface = mix(deepWater, reflected, reflectionAmount);
    surface = mix(surface, uIceColor, ice * 0.52);
    surface = mix(surface, uFrostColor, frost * 0.78);
    float foamBreakup = smoothstep(0.42, 0.74, streamNoise(flow * vec2(18.0, 11.0) + uSeed)
      * 0.7 + streamNoise(flow * 4.5 - uSeed) * 0.3);
    float foamAmount = foam * foamBreakup * (1.0 - ice) * 0.75;
    surface = mix(surface, uFrostColor * 0.82, foamAmount);
    gl_FragColor = vec4(surface, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
      #endif
      float reflectedContribution = reflectionAmount * (1.0 - ice * 0.52) * (1.0 - frost * 0.78) * (1.0 - foamAmount);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor * (1.0 - reflectedContribution));
    #endif
    #include <dithering_fragment>
  }
`;

export interface SnowStream {
  readonly mesh: Reflector;
  update(frame: EnvironmentSnapshot): void;
  setQuality(quality: QualityLevel): void;
  invalidate(): void;
  disposeTargets(): void;
}

export interface StreamObstacle { x: number; z: number; radius: number }

/** Procedural running water with a cached, real planar reflection. */
export function createSnowStream(seed: string, quality: QualityLevel, obstacles: readonly StreamObstacle[] = []): SnowStream {
  const random = createRandom(`${seed}/running-winter-water`);
  const size = RESOLUTION[quality];
  const mesh = new Reflector(streamGeometry(), {
    color: 0x202d26,
    clipBias: 0.003,
    textureWidth: size,
    textureHeight: size,
    multisample: 0,
    shader: {
      name: 'ProceduralSnowStream',
      uniforms: UniformsUtils.merge([UniformsLib.fog, {
        tDiffuse: { value: null }, color: { value: new Color() }, textureMatrix: { value: new Matrix4() },
        uIceColor: { value: new Color(0x899e9e) }, uFrostColor: { value: new Color(0xd3dedc) },
        uSeed: { value: new Vector2(random() * 71, random() * 71) },
        uTexel: { value: new Vector2(1 / size, 1 / size) }, uTime: { value: 0 }, uWind: { value: 0 },
        uObstacles: { value: Array.from({ length: 12 }, (_, i) => {
          const obstacle = obstacles[i];
          return obstacle ? new Vector4(obstacle.x, obstacle.z, obstacle.radius, 1) : new Vector4();
        }) },
      }]),
      vertexShader,
      fragmentShader,
    },
  });
  mesh.name = 'running-winter-stream';
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = STREAM_LEVEL;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.reflectionUpdates = 0;
  mesh.userData.reflectionSize = size;
  const material = mesh.material as ShaderMaterial;
  material.fog = true;
  material.dithering = true;
  material.toneMapped = true;
  const target = mesh.getRenderTarget();
  target.texture.name = 'generated-stream-reflection';
  target.texture.colorSpace = LinearSRGBColorSpace;
  target.texture.minFilter = LinearFilter;
  target.texture.magFilter = LinearFilter;
  target.texture.generateMipmaps = false;

  const cameraWorld = new Matrix4(), projection = new Matrix4(), waterWorld = new Matrix4();
  let capturedCamera: Camera | undefined;
  let elapsed = 0, lastCapture = -Infinity, lastSnow = NaN;
  let dirty = true, disposed = false;
  const drawReflection = mesh.onBeforeRender;
  mesh.onBeforeRender = (renderer, scene, camera, geometry, drawMaterial, group) => {
    if (disposed) return;
    const moved = capturedCamera !== camera || !camera.matrixWorld.equals(cameraWorld)
      || !camera.projectionMatrix.equals(projection) || !mesh.matrixWorld.equals(waterWorld);
    if (!dirty && !mesh.forceUpdate && !moved && elapsed - lastCapture < 1 / 8) return;
    drawReflection.call(mesh, renderer, scene, camera, geometry, drawMaterial, group);
    capturedCamera = camera;
    cameraWorld.copy(camera.matrixWorld);
    projection.copy(camera.projectionMatrix);
    waterWorld.copy(mesh.matrixWorld);
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
      if (frame.elapsed < elapsed || frame.precipitation !== lastSnow) invalidate();
      elapsed = frame.elapsed;
      lastSnow = frame.precipitation;
      material.uniforms.uTime!.value = elapsed;
      material.uniforms.uWind!.value = Math.max(0, Math.min(1, frame.wind.strength));
    },
    setQuality(next): void {
      if (disposed) return;
      const resolution = RESOLUTION[next];
      if (target.width === resolution) return;
      target.setSize(resolution, resolution);
      (material.uniforms.uTexel!.value as Vector2).set(1 / resolution, 1 / resolution);
      mesh.userData.reflectionSize = resolution;
      invalidate();
    },
    invalidate,
    disposeTargets(): void {
      if (disposed) return;
      disposed = true;
      target.dispose();
    },
  };
}
