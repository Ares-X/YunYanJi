import { DoubleSide, MeshDepthMaterial, MeshDistanceMaterial, RGBADepthPacking, Vector3 } from 'three';
import type { Material, Mesh } from 'three';
import type { EnvironmentSnapshot } from '../../core/types';

/** All forest passes use these same world-space roots and leaf attachment points. */
const deformation = /* glsl */ `
  uniform float uForestTime;
  uniform vec3 uForestWind;
  attribute vec4 aForestWindRoot;
  attribute vec4 aForestWindAnchor;
  vec3 forestRotate(vec3 p, vec3 axis, float angle) {
    float c=cos(angle),s=sin(angle);
    return p*c+cross(axis,p)*s+axis*dot(axis,p)*(1.0-c);
  }
  float forestPhase() {
    return dot(aForestWindRoot.xz,vec2(.217,.139));
  }
  vec2 forestDirection() {
    return normalize(uForestWind.xz+vec2(.0001,.0002));
  }
  float forestBend() {
    float phase=forestPhase();
    float wave=.58+.27*sin(uForestTime*.71+phase)
      +.15*sin(uForestTime*1.13+phase*1.73);
    return uForestWind.y*wave*(.38+aForestWindRoot.w*.019);
  }
  float forestFlutter() {
    float phase=dot(aForestWindAnchor.xyz,vec3(1.83,2.17,.91));
    return step(.01,aForestWindAnchor.w)*uForestWind.y*
      (.24*sin(uForestTime*2.17+phase)+.10*sin(uForestTime*3.91+phase*1.71));
  }
  vec3 forestAxis() {
    vec2 direction=forestDirection();
    return normalize(vec3(-direction.y,.24,direction.x));
  }
  vec3 forestDeform(vec3 p) {
    // A leaf turns around its own petiole; it cannot detach from its branch.
    p=aForestWindAnchor.xyz+forestRotate(p-aForestWindAnchor.xyz,forestAxis(),forestFlutter());
    float h=clamp((p.y-aForestWindRoot.y)/max(1.0,aForestWindRoot.w),0.0,1.0);
    p.xz+=forestDirection()*forestBend()*h*h;
    return p;
  }
  vec3 forestDeformNormal(vec3 n,vec3 p) {
    n=forestRotate(n,forestAxis(),forestFlutter());
    float height=max(1.0,aForestWindRoot.w);
    float h=clamp((p.y-aForestWindRoot.y)/height,0.0,1.0);
    // Inverse transpose of the trunk's height-dependent shear.
    n.y-=dot(n.xz,forestDirection())*forestBend()*2.0*h/height;
    return normalize(n);
  }
`;

export function createForestWind() {
  const uniforms = {
    uForestTime: { value: 0 },
    uForestWind: { value: new Vector3(.45, .23, .12) },
  };
  const installed = new WeakSet<Material>();
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, side: DoubleSide });
  const distance = new MeshDistanceMaterial({ side: DoubleSide });
  const capturedWind = new Vector3();
  let capturedTime = 0;
  let capturing = false;
  let disposed = false;
  function install(material: Material): void {
    if (installed.has(material)) return;
    installed.add(material);
    const previous = material.onBeforeCompile.bind(material);
    const key = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
      previous(shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${deformation}`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          objectNormal=forestDeformNormal(objectNormal,position);`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          transformed=forestDeform(transformed);`);
    };
    material.customProgramCacheKey = () => `${key}/rooted-forest-wind-v1`;
  }
  install(depth);
  install(distance);
  return {
    uniforms,
    install,
    attach(mesh: Mesh): void {
      mesh.customDepthMaterial = depth;
      mesh.customDistanceMaterial = distance;
      // Wind is bounded by 1.2 m, with another 10 cm for a fluttering leaf.
      mesh.geometry.boundingSphere!.radius += 1.3;
      mesh.geometry.boundingBox!.expandByScalar(1.3);
    },
    update(frame: EnvironmentSnapshot): void {
      if (disposed || capturing) return;
      // Absolute simulation time, never wall time or accumulated frame delta.
      uniforms.uForestTime.value = frame.elapsed;
      uniforms.uForestWind.value.set(
        Math.max(-3, Math.min(3, frame.wind.x)),
        frame.reducedMotion ? 0 : Math.max(0, Math.min(1, frame.wind.strength)),
        Math.max(-3, Math.min(3, frame.wind.z)),
      );
    },
    setEnvironmentCapture(enabled: boolean): void {
      if (disposed || capturing === enabled) return;
      capturing = enabled;
      if (enabled) {
        capturedTime = uniforms.uForestTime.value;
        capturedWind.copy(uniforms.uForestWind.value);
        // Static probes always see the same rest pose, including after a
        // context restore at a different point in the simulation timeline.
        uniforms.uForestTime.value = 0;
        uniforms.uForestWind.value.set(0, 0, 0);
      } else {
        uniforms.uForestTime.value = capturedTime;
        uniforms.uForestWind.value.copy(capturedWind);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      depth.dispose();
      distance.dispose();
    },
  };
}
