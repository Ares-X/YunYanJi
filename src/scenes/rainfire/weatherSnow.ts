import { BufferGeometry, Float32BufferAttribute, Points, ShaderMaterial, UniformsLib, UniformsUtils, Vector2 } from 'three';
import type { Vector3 } from 'three';
import { createRandom, randomBetween } from '../../core/random';
import type { EnvironmentSnapshot, QualityLevel } from '../../core/types';
import { SHELTER } from './rainLandscape';

const COUNTS = { low: 2200, medium: 4400, high: 7200 } as const;

/** Millimetre-scale wind-carried crystals; their soft sixfold coverage is analytic. */
export function createWeatherSnow(seed: string, quality: QualityLevel, firePosition: Vector3) {
  const random = createRandom(`${seed}/weather-snow`);
  const positions: number[] = [], motion: number[] = [], fields: number[] = [];
  for (let i = 0; i < COUNTS.high; i++) {
    // Interleave a populated clearing with the distant grove, so every quality
    // retains small visible flakes rather than diluting them over empty forest.
    const nearby = i % 10 < 7;
    const width = nearby ? 22 : 70, depth = nearby ? 34 : 100;
    const height = nearby ? 16 : 35, back = nearby ? -28 : -90;
    positions.push(randomBetween(random, -width * .5, width * .5), randomBetween(random, 0, height),
      randomBetween(random, back, back + depth));
    fields.push(width, depth, height, back);
    motion.push(randomBetween(random, .38, 1.05), random() * Math.PI * 2,
      randomBetween(random, .007, .021), randomBetween(random, .6, 1.5));
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aMotion', new Float32BufferAttribute(motion, 4));
  geometry.setAttribute('aField', new Float32BufferAttribute(fields, 4));
  const advection = new Vector2(), wind = new Vector2();
  const material = new ShaderMaterial({
    name: 'generated-wind-carried-snow', transparent: true, depthWrite: false, depthTest: true, fog: true,
    uniforms: UniformsUtils.merge([UniformsLib.fog, {
      uTime: { value: 0 }, uAmount: { value: 0 }, uViewportHeight: { value: 1 },
      uAdvection: { value: advection }, uWind: { value: wind }, uShelter: { value: SHELTER },
      uFirePosition: { value: firePosition.clone() }, uFire: { value: 1 }, uSky: { value: .4 }, uFlash: { value: 0 },
    }]),
    vertexShader: /* glsl */ `
      uniform float uTime, uAmount, uViewportHeight;
      uniform vec2 uAdvection, uWind;
      attribute vec4 aMotion, aField;
      varying float vAlpha, vDepth, vSpin;
      varying vec3 vWorld;
      void main() {
        vec3 p = position;
        p.x = mod(p.x + uAdvection.x + aField.x * .5, aField.x) - aField.x * .5;
        p.z = mod(p.z + uAdvection.y - aField.w, aField.y) + aField.w;
        p.y = mod(p.y - uTime * aMotion.x + aField.z, aField.z);
        p.x += sin(uTime * aMotion.w + aMotion.y) * .19 + sin(uTime * .37 + aMotion.y * 2.3) * .14;
        p.z += cos(uTime * aMotion.w * .61 + aMotion.y) * .15;
        p.xz += uWind * sin(uTime * .8 + aMotion.y) * .05;
        vec4 viewPoint = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * viewPoint;
        float projected = aMotion.z * .5 * uViewportHeight * projectionMatrix[1][1] / max(.1, -viewPoint.z);
        gl_PointSize = clamp(projected, .85, 5.5);
        vAlpha = min(1.0, projected / .85) * smoothstep(.3, 1.3, -viewPoint.z)
          * (.55 + .45 * abs(sin(uTime * aMotion.w + aMotion.y))) * sqrt(uAmount);
        vDepth = max(0.0, -viewPoint.z);
        vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
        vSpin = uTime * aMotion.w + aMotion.y;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec4 uShelter;
      uniform vec3 uFirePosition;
      uniform float uFire, uSky, uFlash;
      varying float vAlpha, vDepth, vSpin;
      varying vec3 vWorld;
      #include <fog_pars_fragment>
      void main() {
        vec2 roofUv = (vWorld.xz - uShelter.xy) / (uShelter.zw - uShelter.xy);
        float roofHeight = 4.15 - (vWorld.z - uShelter.y) * .137
          - sin(roofUv.x * 3.14159265) * (.16 + .24 * sin(roofUv.y * 3.14159265));
        bool underRoof = vWorld.x > uShelter.x && vWorld.x < uShelter.z
          && vWorld.z > uShelter.y && vWorld.z < uShelter.w;
        if ((underRoof && vWorld.y < roofHeight) || vWorld.y < .12) discard;
        vec2 q = gl_PointCoord - .5;
        float radius = length(q), angle = atan(q.y, q.x) + vSpin;
        float edge = .31 + .07 * cos(angle * 6.0);
        float alpha = (1.0 - smoothstep(edge - .15, edge + .10, radius)) * vAlpha * .82;
        #ifdef USE_FOG
          #ifdef FOG_EXP2
            alpha *= exp(-fogDensity * fogDensity * vDepth * vDepth);
          #else
            alpha *= 1.0 - smoothstep(fogNear, fogFar, vDepth);
          #endif
        #endif
        if (alpha < .003) discard;
        float nearFire = exp(-length(vWorld - uFirePosition) * .52) * uFire;
        vec3 light = vec3(.45,.54,.64) * (.75 + uSky * .60)
          + vec3(1.4,.46,.1) * nearFire + vec3(.55,.65,.84) * uFlash;
        gl_FragColor = vec4(light, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  // UniformsUtils clones vectors; retain the shared values explicitly.
  material.uniforms.uAdvection!.value = advection;
  material.uniforms.uWind!.value = wind;
  const points = new Points(geometry, material);
  points.name = 'falling-snow-crystals'; points.frustumCulled = false; points.renderOrder = 4;
  points.visible = false;
  const drawingSize = new Vector2();
  points.onBeforeRender = renderer => {
    renderer.getDrawingBufferSize(drawingSize);
    material.uniforms.uViewportHeight!.value = renderer.getRenderTarget()?.height ?? drawingSize.y;
  };
  let currentQuality = quality, lastElapsed = 0;
  return {
    points,
    update(frame: EnvironmentSnapshot): void {
      if (frame.elapsed < lastElapsed) advection.set(0, 0);
      lastElapsed = frame.elapsed;
      advection.x += frame.wind.x * frame.delta * .70;
      advection.y += frame.wind.z * frame.delta * .70;
      wind.set(frame.wind.x, frame.wind.z);
      const amount = Math.max(0, Math.min(1, frame.weather.snow));
      points.visible = amount > .001;
      geometry.setDrawRange(0, Math.round(COUNTS[currentQuality] * amount));
      material.uniforms.uTime!.value = frame.elapsed;
      material.uniforms.uAmount!.value = amount;
      material.uniforms.uSky!.value = frame.weather.daylight;
      material.uniforms.uFlash!.value = frame.lightning?.flash ?? 0;
      material.uniforms.uFire!.value = frame.fire.flame * 1.45 + frame.fire.embers * .06;
    },
    setQuality(next: QualityLevel): void { currentQuality = next; },
  };
}
