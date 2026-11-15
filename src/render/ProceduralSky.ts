import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry } from 'three';

export function createProceduralSky() {
  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    uniforms: {
      time: { value: 0 },
      zenith: { value: new Color('#8da6b6') },
      horizon: { value: new Color('#dde5e5') },
      floorColor: { value: new Color('#617c8a') },
    },
    vertexShader: `varying vec3 direction;
      void main() { direction = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float time;
      uniform vec3 zenith, horizon, floorColor;
      varying vec3 direction;
      float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.0),f.x),f.y);
      }
      void main() {
        vec3 d = normalize(direction);
        float h = max(d.y,0.0);
        vec3 col = mix(horizon,zenith,pow(h,0.65));
        col = mix(col,floorColor,1.0-smoothstep(-0.6,0.0,d.y));
        vec2 uv = d.xz / (0.55 + abs(d.y)) * 4.0 + vec2(time * 0.006,0.0);
        float clouds = noise(uv)*0.65 + noise(uv*2.1)*0.25 + noise(uv*4.3)*0.1;
        float broad = noise(uv * 0.43 + vec2(12.0, 7.0));
        float veil = smoothstep(0.3, 0.72, clouds * 0.72 + broad * 0.28);
        col += (veil - 0.45) * 0.085 * smoothstep(-0.05, 0.3, d.y);
        float glow = pow(max(0.0, dot(d, normalize(vec3(-0.46, 0.71, 0.53)))), 12.0);
        col += vec3(0.085, 0.065, 0.035) * glow * (0.6 + broad * 0.4);
        gl_FragColor = vec4(col,1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new Mesh(new SphereGeometry(190, 32, 20), material);
  mesh.name = 'procedural-sky';
  mesh.frustumCulled = false;
  return { mesh, update: (time: number) => { material.uniforms.time!.value = time; }, dispose: () => { mesh.geometry.dispose(); material.dispose(); } };
}
