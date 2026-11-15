import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';

export const CLOUD_LIGHT_DIRECTION = new Vector3(-28, 34, -22).normalize();

/** An overcast late-evening sky; every density sample is evaluated in the shader. */
export function createRainAtmosphere() {
  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uTime: { value: 0 },
      uZenith: { value: new Color('#263e48') },
      uCloudLight: { value: new Color('#71838a') },
      uHaze: { value: new Color('#31484e') },
      uGround: { value: new Color('#101b1d') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDirection;
      void main() {
        vDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uZenith, uCloudLight, uHaze, uGround;
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
        float density = smoothstep(0.24, 0.77, broad * 0.76 + wisps * 0.24);
        vec3 radiance = mix(uZenith, uCloudLight, exp(-elevation * 3.5));
        radiance *= 0.34 + 0.60 * (1.0 - density);
        float breakInCloud = pow(max(dot(d, normalize(vec3(-0.7,0.3,-0.5))), 0.0), 8.0);
        radiance += vec3(0.015, 0.021, 0.024) * breakInCloud * (1.0 - density);
        radiance = mix(radiance, uHaze, exp(-elevation * 35.0) * 0.8);
        if (d.y < 0.0) radiance = mix(uGround, uHaze, smoothstep(-0.22, 0.0, d.y));
        gl_FragColor = vec4(radiance, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new Mesh(new SphereGeometry(350, 40, 20), material);
  mesh.name = 'generated-rain-atmosphere';
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  let currentTime = 0;
  return {
    mesh,
    update(elapsed: number): void {
      currentTime = elapsed;
      material.uniforms.uTime!.value = elapsed;
    },
    // The cached environment always represents the same cloud field. Context
    // restoration must not suddenly relight an otherwise frozen scene.
    setEnvironmentCapture(capturing: boolean): void {
      material.uniforms.uTime!.value = capturing ? 0 : currentTime;
    },
    dispose(): void { mesh.geometry.dispose(); material.dispose(); },
  };
}
