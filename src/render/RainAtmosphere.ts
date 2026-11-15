import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';
import type { EnvironmentSnapshot } from '../core/types';

export const CLOUD_LIGHT_DIRECTION = new Vector3(-9, 22, -24).normalize();

/** Analytical changing cloud cover; no sky image, authored map or star sprite. */
export function createRainAtmosphere() {
  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uTime: { value: 0 },
      uCloudCover: { value: .9 }, uDaylight: { value: .25 },
      uStorm: { value: 0 }, uSnow: { value: 0 }, uFlash: { value: 0 },
      uZenith: { value: new Color('#43576c') },
      uCloudLight: { value: new Color('#9cb1bb') },
      uHaze: { value: new Color('#4d6874') },
      uGround: { value: new Color('#202a26') },
      uCloudDirection: { value: CLOUD_LIGHT_DIRECTION },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDirection;
      void main() {
        vDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uCloudCover, uDaylight, uStorm, uSnow, uFlash;
      uniform vec3 uZenith, uCloudLight, uHaze, uGround, uCloudDirection;
      varying vec3 vDirection;
      float hash(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.yzx + 33.33);
        return fract((p.x + p.y) * p.z);
      }
      float noise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1.,0.,0.)), f.x),
          mix(hash(i + vec3(0.,1.,0.)), hash(i + vec3(1.,1.,0.)), f.x), f.y),
          mix(mix(hash(i + vec3(0.,0.,1.)), hash(i + vec3(1.,0.,1.)), f.x),
          mix(hash(i + vec3(0.,1.,1.)), hash(i + vec3(1.,1.,1.)), f.x), f.y), f.z);
      }
      float fbm(vec3 p) {
        float f = 0.0, amplitude = 0.54;
        for (int i = 0; i < 4; i++) {
          f += noise(p) * amplitude;
          p = p * 2.03 + vec3(13.2, 5.1, 9.7);
          amplitude *= 0.48;
        }
        return f;
      }
      void main() {
        vec3 d = normalize(vDirection);
        float elevation = max(d.y, 0.0);
        vec2 projected = d.xz / (0.32 + elevation * 0.75);
        vec3 cloudPosition = vec3(projected * vec2(1.15, 0.72)
          + vec2(uTime * 0.002, -uTime * 0.0007), 1.6);
        float broad = fbm(cloudPosition);
        float wisps = fbm(cloudPosition * vec3(3.7, 2.1, 1.0) + broad * 1.2);
        float field = broad * 0.76 + wisps * 0.24;
        float threshold = mix(.69, .20, uCloudCover);
        float density = smoothstep(threshold, threshold + .24, field);
        vec3 clearZenith = mix(uZenith, vec3(.13,.32,.57), uDaylight);
        vec3 clearHorizon = mix(uCloudLight, vec3(.68,.77,.79), uDaylight);
        vec3 radiance = mix(clearZenith, clearHorizon, exp(-elevation * 3.5));
        vec3 cloudColor = mix(vec3(.37,.46,.52), vec3(.75,.79,.80), uDaylight);
        cloudColor *= (1.0 - uStorm * .61) * (.74 + .26 * (1.0 - wisps));
        cloudColor = mix(cloudColor, vec3(.56,.63,.68), uSnow * .25);
        radiance = mix(radiance, cloudColor, density);
        float facing = max(dot(d, uCloudDirection), 0.0);
        float sunDisk = smoothstep(.99988,.99996,facing);
        float openSky = pow(facing,4.0);
        float direct = uDaylight * (1.0 - uCloudCover) * (1.0 - density);
        radiance += vec3(1.0,.87,.66) * (sunDisk * 18.0 + pow(facing,40.0) * .36) * direct;
        radiance += vec3(.09,.11,.12) * openSky * smoothstep(0.0,.25,d.y) * (1.0 - uStorm * .7);
        radiance *= .76 + uDaylight * .38 - uStorm * .24;
        // A cloud sheet is illuminated by the same strike that lights the trees.
        radiance += vec3(.64,.76,1.0) * uFlash * (1.0 + density * .9);
        // Match terrain fog all the way through the low sky; an abrupt colour
        // mismatch would expose the far height field as a clean horizon wall.
        radiance = mix(radiance, uHaze, 1.0-smoothstep(.06,.42,elevation));
        if (d.y < 0.0) radiance = mix(uGround, uHaze, smoothstep(-0.22, 0.0, d.y));
        gl_FragColor = vec4(radiance, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new Mesh(new SphereGeometry(350, 40, 20), material);
  mesh.name = 'generated-weather-atmosphere';
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  let currentFrame: EnvironmentSnapshot | undefined;
  const rainHaze = new Color('#4d6874'), clearHaze = new Color('#abc7d7');
  const snowHaze = new Color('#8d9da8'), stormHaze = new Color('#2b3945');
  const apply = (frame?: EnvironmentSnapshot): void => {
    const weather = frame?.weather;
    material.uniforms.uTime!.value = frame?.elapsed ?? 0;
    material.uniforms.uCloudCover!.value = weather?.cloudCover ?? .9;
    material.uniforms.uDaylight!.value = weather?.daylight ?? .25;
    material.uniforms.uStorm!.value = weather?.storm ?? 0;
    material.uniforms.uSnow!.value = weather?.snow ?? 0;
    material.uniforms.uFlash!.value = frame?.lightning?.flash ?? 0;
    (material.uniforms.uHaze!.value as Color).copy(rainHaze)
      .lerp(clearHaze, (weather?.daylight ?? .25) * (1 - (weather?.cloudCover ?? .9)))
      .lerp(snowHaze, (weather?.snow ?? 0) * .65)
      .lerp(stormHaze, weather?.storm ?? 0);
  };
  return {
    mesh,
    update(frame: EnvironmentSnapshot): void { currentFrame = frame; apply(frame); },
    // Local IBL remains a deterministic overcast reference. Live sky and
    // direct/ambient energy change without rebaking an expensive probe per frame.
    setEnvironmentCapture(capturing: boolean): void { apply(capturing ? undefined : currentFrame); },
    dispose(): void { mesh.geometry.dispose(); material.dispose(); },
  };
}
