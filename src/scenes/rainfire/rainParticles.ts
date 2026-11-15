import {
  BufferGeometry, DoubleSide, Float32BufferAttribute, Group, InstancedBufferAttribute, InstancedBufferGeometry,
  Mesh, Points, ShaderMaterial, UniformsLib, UniformsUtils, Vector2,
} from 'three';
import type { Vector3 } from 'three';
import { createRandom, randomBetween } from '../../core/random';
import type { EnvironmentSnapshot, QualityLevel } from '../../core/types';
import { createRainHeight, PUDDLE_LEVEL, SHELTER } from './rainLandscape';
import { createWeatherSnow } from './weatherSnow';

const COUNTS: Record<QualityLevel, number> = { low: 5500, medium: 11000, high: 18000 };
const SPLASH_COUNTS: Record<QualityLevel, number> = { low: 96, medium: 180, high: 300 };

/** Sparse centimetre-scale droplets briefly rebound from exposed wet ground. */
function createGroundSplashes(seed: string, quality: QualityLevel, firePosition: Vector3) {
  const random = createRandom(`${seed}/ground-rain-impacts`), height = createRainHeight(seed);
  const positions: number[] = [], velocity: number[] = [], phase: number[] = [], period: number[] = [], sizes: number[] = [];
  for (let impact = 0; impact < SPLASH_COUNTS.high / 3; impact++) {
    const besideShelter = impact % 3 !== 0;
    const x = besideShelter ? randomBetween(random, SHELTER.z + 0.20, SHELTER.z + 5.15)
      : randomBetween(random, -5.5, 5.5);
    const z = besideShelter ? randomBetween(random, -8, 3.7)
      : randomBetween(random, -16, SHELTER.y - 0.25);
    const y = Math.max(PUDDLE_LEVEL, height(x, z)) + 0.009;
    const delay = random(), repeat = randomBetween(random, 1.1, 2.4);
    for (let drop = 0; drop < 3; drop++) {
      const angle = random() * Math.PI * 2, spread = randomBetween(random, 0.17, 0.55);
      positions.push(x, y, z);
      velocity.push(Math.cos(angle) * spread, randomBetween(random, 0.65, 1.12), Math.sin(angle) * spread);
      phase.push(delay); period.push(repeat); sizes.push(randomBetween(random, 0.0025, 0.005));
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aVelocity', new Float32BufferAttribute(velocity, 3));
  geometry.setAttribute('aPhase', new Float32BufferAttribute(phase, 1));
  geometry.setAttribute('aPeriod', new Float32BufferAttribute(period, 1));
  geometry.setAttribute('aSize', new Float32BufferAttribute(sizes, 1));
  geometry.setDrawRange(0, SPLASH_COUNTS[quality]);
  const material = new ShaderMaterial({
    name: 'generated-ground-rain-splashes', transparent: true, depthWrite: false, fog: true,
    uniforms: UniformsUtils.merge([UniformsLib.fog, {
      uTime: { value: 0 }, uRain: { value: 0.72 }, uViewportHeight: { value: 1 },
      uFirePosition: { value: firePosition.clone() }, uWind: { value: new Vector2() },
      uFire: { value: 1 }, uSky: { value: .25 }, uFlash: { value: 0 },
    }]),
    vertexShader: /* glsl */ `
      uniform float uTime, uRain, uViewportHeight;
      uniform vec2 uWind;
      attribute vec3 aVelocity;
      attribute float aPhase, aPeriod, aSize;
      varying float vSplashAlpha, vSplashDepth;
      varying vec3 vSplashWorld;
      void main() {
        float age = mod(uTime + aPhase * aPeriod, aPeriod);
        float lifetime = aVelocity.y * 2.0 / 9.81;
        vec3 p = position + aVelocity * age;
        p.y -= 4.905 * age * age;
        p.xz += uWind * age * age * 0.30;
        vec4 viewPoint = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * viewPoint;
        float projected = aSize * 0.5 * uViewportHeight * projectionMatrix[1][1] / max(0.1, -viewPoint.z);
        gl_PointSize = clamp(projected, 0.8, 2.0);
        vSplashAlpha = step(age, lifetime) * smoothstep(0.0, 0.025, age)
          * (1.0 - smoothstep(lifetime * 0.65, lifetime, age))
          * min(1.0, projected / 0.8) * uRain;
        vSplashDepth = max(0.0, -viewPoint.z);
        vSplashWorld = (modelMatrix * vec4(p, 1.0)).xyz;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uFirePosition;
      uniform float uFire, uSky, uFlash;
      varying float vSplashAlpha, vSplashDepth;
      varying vec3 vSplashWorld;
      #include <fog_pars_fragment>
      void main() {
        float radius = length(gl_PointCoord - 0.5);
        float alpha = (1.0 - smoothstep(0.10, 0.50, radius)) * vSplashAlpha * 0.64;
        #ifdef USE_FOG
          #ifdef FOG_EXP2
            alpha *= exp(-fogDensity * fogDensity * vSplashDepth * vSplashDepth);
          #else
            alpha *= 1.0 - smoothstep(fogNear, fogFar, vSplashDepth);
          #endif
        #endif
        if (alpha < 0.003) discard;
        float warmth = exp(-length(vSplashWorld - uFirePosition) * 0.43);
        vec3 light = vec3(0.50, 0.61, 0.67) * (.7 + uSky) + vec3(1.9, 0.67, 0.15) * warmth * uFire
          + vec3(.5,.6,.8) * uFlash;
        gl_FragColor = vec4(light, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const points = new Points(geometry, material);
  points.name = 'sparse-rain-impact-droplets'; points.frustumCulled = false; points.renderOrder = 5;
  const drawingSize = new Vector2();
  points.onBeforeRender = renderer => {
    renderer.getDrawingBufferSize(drawingSize);
    material.uniforms.uViewportHeight!.value = renderer.getRenderTarget()?.height ?? drawingSize.y;
  };
  return {
    points,
    update(frame: EnvironmentSnapshot): void {
      material.uniforms.uTime!.value = frame.elapsed;
      material.uniforms.uRain!.value = Math.max(0, Math.min(1, frame.weather.rain));
      material.uniforms.uFire!.value = frame.fire.flame * 1.45 + frame.fire.embers * .06;
      material.uniforms.uSky!.value = frame.weather.daylight;
      material.uniforms.uFlash!.value = frame.lightning?.flash ?? 0;
      points.visible = frame.weather.rain > .001;
      (material.uniforms.uWind!.value as Vector2).set(frame.wind.x, frame.wind.z);
    },
    setQuality(next: QualityLevel): void { geometry.setDrawRange(0, SPLASH_COUNTS[next]); },
  };
}

const vertexShader = /* glsl */ `
  uniform float uTime, uViewportHeight, uFall, uStreak;
  uniform vec2 uAdvection, uWind;
  attribute vec3 aOrigin;
  attribute vec4 aField;
  attribute float aSpeed, aLength, aWidth;
  varying vec2 vRainUv;
  varying vec3 vRainWorld;
  varying float vRainCoverage, vRainDepth;
  void main() {
    vec3 centre = aOrigin;
    centre.x = mod(centre.x + uAdvection.x + aField.x * 0.5, aField.x) - aField.x * 0.5;
    centre.z = mod(centre.z + uAdvection.y - aField.w, aField.y) + aField.w;
    centre.y = mod(centre.y - uFall * aSpeed * 10.5 + aField.z, aField.z);
    vec3 direction = normalize(vec3(uWind.x * 0.19, -1.0, uWind.y * 0.19));
    vec3 end = centre + direction * aLength * uStreak;
    vec4 viewStart = modelViewMatrix * vec4(centre, 1.0);
    vec4 viewEnd = modelViewMatrix * vec4(end, 1.0);
    vec4 viewPoint = mix(viewStart, viewEnd, uv.y);
    vec2 segment = viewEnd.xy - viewStart.xy;
    vec2 across = normalize(vec2(-segment.y, segment.x) + vec2(0.000001, 0.0));
    float metresPerPixel = max(0.0001, -viewPoint.z * 2.0 / max(1.0, uViewportHeight * projectionMatrix[1][1]));
    float width = max(aWidth, metresPerPixel * 0.75);
    viewPoint.xy += across * position.x * width;
    gl_Position = projectionMatrix * viewPoint;
    vRainWorld = (modelMatrix * vec4(mix(centre, end, uv.y), 1.0)).xyz;
    vRainDepth = max(0.0, -viewPoint.z);
    vRainCoverage = min(1.0, aWidth / metresPerPixel)
      * smoothstep(0.35, 1.0, vRainDepth) * (0.77 + aSpeed * 0.18);
    vRainUv = uv;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime, uIntensity, uFire, uSky, uFlash;
  uniform vec4 uShelter;
  uniform vec3 uFirePosition;
  varying vec2 vRainUv;
  varying vec3 vRainWorld;
  varying float vRainCoverage, vRainDepth;
  #include <common>
  #include <fog_pars_fragment>
  void main() {
    bool underRoof = vRainWorld.x > uShelter.x && vRainWorld.x < uShelter.z
      && vRainWorld.z > uShelter.y && vRainWorld.z < uShelter.w;
    vec2 roofUv=(vRainWorld.xz-uShelter.xy)/(uShelter.zw-uShelter.xy);
    float roofHeight = 4.15 - (vRainWorld.z - uShelter.y) * 0.137
      -sin(roofUv.x*3.14159265)*(.16+.24*sin(roofUv.y*3.14159265));
    if (underRoof && vRainWorld.y < roofHeight) discard;
    float sides = 1.0 - smoothstep(0.12, 0.50, abs(vRainUv.x - 0.5));
    float ends = smoothstep(0.0, 0.12, vRainUv.y)
      * (1.0 - smoothstep(0.68, 1.0, vRainUv.y));
    float illumination = exp(-length(vRainWorld - uFirePosition) * 0.57)
      * uFire;
    vec3 rainColor = vec3(0.42, 0.52, 0.56) * (.72 + uSky)
      + vec3(1.45, 0.48, 0.10) * illumination + vec3(.5,.6,.8) * uFlash;
    float alpha = sides * ends * vRainCoverage * uIntensity * (0.24 + illumination * 0.12);
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        alpha *= exp(-fogDensity * fogDensity * vRainDepth * vRainDepth);
      #else
        alpha *= 1.0 - smoothstep(fogNear, fogFar, vRainDepth);
      #endif
    #endif
    if (alpha < 0.001) discard;
    gl_FragColor = vec4(rainColor, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface RainParticles {
  readonly group: Group;
  update(frame: EnvironmentSnapshot): void;
  setQuality(quality: QualityLevel): void;
}

/**
 * World-space falling streaks. Narrow drops keep fractional pixel coverage,
 * rather than making distant rain as bright and wide as foreground rain.
 * A shared roof footprint excludes rain from the viewer's and fire's shelter.
 */
export function createRainParticles(seed: string, quality: QualityLevel, firePosition: Vector3): RainParticles {
  const group = new Group();
  group.name = 'rain-outside-the-shelter';
  const splashes = createGroundSplashes(seed, quality, firePosition);
  const snow = createWeatherSnow(seed, quality, firePosition);
  group.add(splashes.points, snow.points);
  const random = createRandom(`${seed}/rain-streaks`);
  const origin = new Float32Array(COUNTS.high * 3);
  const field = new Float32Array(COUNTS.high * 4);
  const speed = new Float32Array(COUNTS.high), length = new Float32Array(COUNTS.high), width = new Float32Array(COUNTS.high);
  for (let i = 0; i < COUNTS.high; i++) {
    // Keep enough falling water in the visible clearing at every quality.
    // The independent periodic domains remain populated even in strong wind.
    const nearby = i % 10 < 7;
    const fieldWidth = nearby ? 32 : 70, fieldDepth = nearby ? 48 : 102;
    const fieldHeight = nearby ? 16 : 34, fieldBack = nearby ? -40 : -88;
    origin[i * 3] = randomBetween(random, -fieldWidth * 0.5, fieldWidth * 0.5);
    origin[i * 3 + 1] = random() * fieldHeight;
    origin[i * 3 + 2] = randomBetween(random, fieldBack, fieldBack + fieldDepth);
    field.set([fieldWidth, fieldDepth, fieldHeight, fieldBack], i * 4);
    speed[i] = randomBetween(random, 0.85, 1.30);
    length[i] = randomBetween(random, 0.16, 0.37);
    width[i] = randomBetween(random, 0.004, 0.009);
  }
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([
    -0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0,
  ], 3));
  geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  geometry.setAttribute('aOrigin', new InstancedBufferAttribute(origin, 3));
  geometry.setAttribute('aField', new InstancedBufferAttribute(field, 4));
  geometry.setAttribute('aSpeed', new InstancedBufferAttribute(speed, 1));
  geometry.setAttribute('aLength', new InstancedBufferAttribute(length, 1));
  geometry.setAttribute('aWidth', new InstancedBufferAttribute(width, 1));
  geometry.instanceCount = COUNTS[quality];
  const advection = new Vector2(), wind = new Vector2(0.45, 0.12);
  const material = new ShaderMaterial({
    name: 'generated-world-rain-streaks', transparent: true, depthWrite: false, depthTest: true, fog: true, side: DoubleSide,
    uniforms: UniformsUtils.merge([UniformsLib.fog, {
      uTime: { value: 0 }, uViewportHeight: { value: 1 }, uIntensity: { value: 0.72 },
      uFall: { value: 0 }, uStreak: { value: 1 },
      uFire: { value: 1 }, uSky: { value: .25 }, uFlash: { value: 0 },
      uAdvection: { value: advection }, uWind: { value: wind },
      uShelter: { value: SHELTER }, uFirePosition: { value: firePosition.clone() },
    }]),
    vertexShader, fragmentShader,
  });
  material.uniforms.uAdvection!.value = advection;
  material.uniforms.uWind!.value = wind;
  // Illuminate droplets around the flame, above the ground-level scene anchor.
  (material.uniforms.uFirePosition!.value as Vector3).y += 0.67;
  const mesh = new Mesh(geometry, material);
  mesh.name = 'falling-rain'; mesh.frustumCulled = false; mesh.renderOrder = 4;
  group.add(mesh);
  const drawingSize = new Vector2();
  mesh.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(drawingSize);
    material.uniforms.uViewportHeight!.value = renderer.getRenderTarget()?.height ?? drawingSize.y;
  };
  let lastElapsed = 0, fall = 0, currentQuality = quality;
  return {
    group,
    update(frame): void {
      if (frame.elapsed < lastElapsed) { advection.set(0, 0); fall = 0; }
      lastElapsed = frame.elapsed;
      advection.x += frame.wind.x * frame.delta * 2.5;
      advection.y += frame.wind.z * frame.delta * 2.5;
      wind.set(frame.wind.x, frame.wind.z);
      material.uniforms.uTime!.value = frame.elapsed;
      const rain = Math.max(0, Math.min(1, frame.weather.rain));
      geometry.instanceCount = Math.round(COUNTS[currentQuality] * rain ** 1.10);
      mesh.visible = rain > .001;
      material.uniforms.uIntensity!.value = Math.sqrt(rain);
      fall += frame.delta * (.72 + Math.sqrt(rain) * .38 + frame.weather.storm * .15);
      material.uniforms.uFall!.value = fall;
      material.uniforms.uStreak!.value = .65 + rain * .55;
      material.uniforms.uFire!.value = frame.fire.flame * 1.45 + frame.fire.embers * .06;
      material.uniforms.uSky!.value = frame.weather.daylight;
      material.uniforms.uFlash!.value = frame.lightning?.flash ?? 0;
      splashes.update(frame);
      snow.update(frame);
    },
    setQuality(next): void {
      currentQuality = next;
      geometry.instanceCount = COUNTS[next];
      splashes.setQuality(next);
      snow.setQuality(next);
    },
  };
}
