import {
  BufferGeometry, Float32BufferAttribute, Points, ShaderMaterial, UniformsLib,
  UniformsUtils, Vector2,
} from 'three';
import { createRandom, randomBetween } from '../../core/random';
import type { EnvironmentSnapshot, QualityLevel } from '../../core/types';

const COUNTS: Record<QualityLevel, number> = { low: 1600, medium: 3800, high: 6800 };

const VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform vec2 uAdvection;
  uniform float uLift;
  uniform float uViewportHeight;
  uniform float uPixelRatio;
  attribute float aPhase;
  attribute float aSize;
  attribute float aSpeed;
  varying float vOpacity;
  varying float vPhase;
  varying float vNear;
  #include <fog_pars_vertex>
  void main() {
    vec3 p = position;
    float t = uTime;
    p.x = mod(p.x + uAdvection.x * (0.75 + aSpeed * 0.22) + sin(t * 0.42 + aPhase) * 0.38 + 19.0, 38.0) - 19.0;
    p.z = mod(p.z + uAdvection.y * (0.78 + aSpeed * 0.18) + cos(t * 0.31 + aPhase) * 0.34 + 18.0, 36.0) - 18.0;
    p.y = mod(p.y - t * aSpeed * 0.64 + sin(t * 0.68 + aPhase) * 0.13 + uLift * (0.7 + 0.2 * sin(aPhase)) + 14.0, 14.0);
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    float projectedSize = aSize * 0.5 * uViewportHeight * projectionMatrix[1][1] / max(0.2, -mvPosition.z);
    gl_PointSize = clamp(projectedSize, uPixelRatio, 18.0 * uPixelRatio);
    vOpacity = smoothstep(0.02, 0.42, p.y) * smoothstep(0.35, 1.25, -mvPosition.z)
      * min(1.0, projectedSize / max(1.0, uPixelRatio));
    vPhase = aPhase;
    vNear = 1.0 - smoothstep(0.8, 4.2, -mvPosition.z);
    #include <fog_vertex>
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform float uIntensity;
  varying float vOpacity;
  varying float vPhase;
  varying float vNear;
  #include <fog_pars_fragment>
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float c = cos(vPhase), s = sin(vPhase);
    p = mat2(c, -s, s, c) * p;
    p.x *= 0.83 + 0.14 * sin(vPhase);
    float radius = length(p);
    float angle = atan(p.y, p.x);
    float uneven = 1.0 + sin(angle * 5.0 + vPhase) * 0.06;
    float edge = 1.0 - smoothstep(mix(0.13, 0.02, vNear), 0.49, radius * uneven);
    if (edge < 0.015) discard;
    gl_FragColor = vec4(vec3(0.89, 0.93, 0.96), edge * vOpacity * mix(0.72, 0.48, vNear) * uIntensity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export class SnowParticles {
  readonly points: Points<BufferGeometry, ShaderMaterial>;
  private readonly advection = new Vector2();
  private readonly drawingBufferSize = new Vector2();
  private lift = 0;
  private lastElapsed = 0;

  constructor(seed: string, quality: QualityLevel) {
    const random = createRandom(`${seed}/snow-particles`);
    const count = COUNTS.high;
    const positions = new Float32Array(count * 3);
    const phase = new Float32Array(count);
    const size = new Float32Array(count);
    const speed = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = randomBetween(random, -19, 19);
      positions[i * 3 + 1] = randomBetween(random, 0, 14);
      positions[i * 3 + 2] = randomBetween(random, -18, 18);
      phase[i] = random() * Math.PI * 2;
      size[i] = random() < 0.055 ? randomBetween(random, 0.038, 0.065) : randomBetween(random, 0.009, 0.028);
      speed[i] = randomBetween(random, 0.55, 1.22);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aPhase', new Float32BufferAttribute(phase, 1));
    geometry.setAttribute('aSize', new Float32BufferAttribute(size, 1));
    geometry.setAttribute('aSpeed', new Float32BufferAttribute(speed, 1));
    const material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([UniformsLib.fog, {
        uTime: { value: 0 }, uAdvection: { value: this.advection }, uLift: { value: 0 }, uIntensity: { value: 1 },
        uViewportHeight: { value: 1 }, uPixelRatio: { value: 1 },
      }]),
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.points = new Points(geometry, material);
    this.points.name = 'analytical-snow';
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.onBeforeRender = (renderer) => {
      renderer.getDrawingBufferSize(this.drawingBufferSize);
      const height = Math.max(1, renderer.getRenderTarget()?.height ?? this.drawingBufferSize.y);
      const cssHeight = Math.max(1, renderer.domElement.clientHeight || height);
      // Point sizes are drawing-buffer pixels; keep their world/CSS size stable
      // when DPR, quality, the canvas dimensions or camera FOV changes.
      material.uniforms.uViewportHeight!.value = height;
      material.uniforms.uPixelRatio!.value = height / cssHeight;
    };
    this.setQuality(quality);
  }

  update(frame: EnvironmentSnapshot): void {
    if (frame.elapsed < this.lastElapsed) {
      this.advection.set(0, 0);
      this.lift = 0;
    }
    this.lastElapsed = frame.elapsed;
    // Wind is accumulated in seconds: a new gust never teleports every flake.
    this.advection.x += frame.wind.x * frame.delta * 0.68;
    this.advection.y += frame.wind.z * frame.delta * 0.68;
    const alpha = 1 - Math.exp(-frame.delta * 1.4);
    this.lift += (frame.gust * 1.35 - this.lift) * alpha;
    const uniforms = this.points.material.uniforms;
    uniforms.uTime!.value = frame.elapsed;
    (uniforms.uAdvection!.value as Vector2).copy(this.advection);
    uniforms.uLift!.value = this.lift;
    uniforms.uIntensity!.value = Math.max(0, Math.min(1, frame.snowIntensity));
  }

  setQuality(quality: QualityLevel): void {
    this.points.geometry.setDrawRange(0, COUNTS[quality]);
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.points.removeFromParent();
  }
}
