import { Vector3 } from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/** Direction is shared by the visible sun, its environment light and shadows. */
export const WINTER_SUN_DIRECTION = new Vector3(-36, 32, 18).normalize();

/**
 * Atmospheric scattering and slowly evolving thin cloud, evaluated entirely by
 * the official Three sky shader. The lower hemisphere represents light bounced
 * by the surrounding snow, rather than a second blue sky under the landscape.
 * No bitmap, cube-map file or HDRI is used.
 */
export function createWinterAtmosphere() {
  const mesh = new Sky();
  mesh.name = 'generated-winter-atmosphere';
  mesh.scale.setScalar(380);
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  const material = mesh.material;
  const uniforms = material.uniforms;
  uniforms.sunPosition!.value.copy(WINTER_SUN_DIRECTION).multiplyScalar(1000);
  // High turbidity washes the whole visible, low winter sky into the tone
  // mapper's shoulder. Keep air clear enough to retain cool sky/bright cloud
  // separation; distance haze belongs to the landscape fog, not this dome.
  uniforms.turbidity!.value = 4.0;
  uniforms.rayleigh!.value = 1.35;
  uniforms.mieCoefficient!.value = 0.0035;
  uniforms.mieDirectionalG!.value = 0.82;
  uniforms.cloudScale!.value = 0.0009;
  uniforms.cloudSpeed!.value = 0.0000018;
  uniforms.cloudCoverage!.value = 0.60;
  uniforms.cloudDensity!.value = 0.36;
  uniforms.cloudElevation!.value = 0.32;
  uniforms.time!.value = 0;
  uniforms.winterRadiance = { value: 0.27 };

  material.fragmentShader = material.fragmentShader
    .replace('uniform float time;', 'uniform float time;\n uniform float winterRadiance;')
    .replace('i < 4;', 'i < 5;')
    .replace('float cloudNoise = clamp( fbm( cloudUV * 1000.0, evolve ) * 0.7 + 0.5, 0.0, 1.0 );', /* glsl */ `
      // Thin winter cloud has structure across several scales. Stretch the
      // large field into layers and let fine irregular density break its edges;
      // avoid the isolated, smooth cotton blobs of a single coverage octave.
      vec2 layerPosition = cloudUV * 1000.0;
      float broadLayer = fbm(layerPosition * vec2(0.70, 0.38) + vec2(17.1, 7.3), evolve * 0.35);
      float fineLayer = fbm(layerPosition * vec2(3.8, 2.5) + vec2(11.4, 29.2), evolve);
      float cloudNoise = clamp(0.47 + broadLayer * 0.36 + fineLayer * 0.13, 0.0, 1.0);
    `)
    .replace('float region = noise( cloudUV * 300.0 ) * 0.37 + 0.5;',
      'float region = noise( cloudUV * 300.0 ) * 0.16 + 0.5;')
    .replace('cloudColor += sunColor * silver * edge * 0.6;',
      'cloudColor += sunColor * silver * edge * 0.18;')
    .replace('gl_FragColor = vec4( texColor, 1.0 );', /* glsl */ `
      texColor *= winterRadiance;
      float luminance = dot(texColor, vec3(0.2126, 0.7152, 0.0722));
      texColor = mix(texColor, vec3(luminance), 0.16);
      // Snow on the ground returns a broad, neutral-cool fill to bark and rocks.
      // This is part of the generated environment radiance, not an extra lamp.
      vec3 groundBounce = vec3(0.22, 0.26, 0.29);
      texColor = mix(groundBounce, texColor, smoothstep(-0.16, 0.015, direction.y));
      gl_FragColor = vec4(texColor, 1.0);
    `);

  return {
    mesh,
    update(elapsed: number): void { uniforms.time!.value = elapsed; },
    /** Avoid a sub-texel solar disc producing hot pixels in the PMREM. */
    setEnvironmentCapture(capturing: boolean): void {
      uniforms.showSunDisc!.value = capturing ? 0 : 1;
    },
    dispose(): void {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
