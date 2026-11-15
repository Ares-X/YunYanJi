import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry } from 'three';

export function createProceduralSky() {
  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    uniforms: {
      time: { value: 0 },
      zenith: { value: new Color('#6f8798') },
      horizon: { value: new Color('#d9dedb') },
      floorColor: { value: new Color('#627783') },
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
        col += (clouds-0.5)*0.055*smoothstep(-0.1,0.2,d.y);
        gl_FragColor = vec4(col,1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new Mesh(new SphereGeometry(85, 24, 12), material);
  mesh.name = 'procedural-sky';
  mesh.frustumCulled = false;
  return { mesh, update: (time: number) => { material.uniforms.time!.value = time; }, dispose: () => { mesh.geometry.dispose(); material.dispose(); } };
}
