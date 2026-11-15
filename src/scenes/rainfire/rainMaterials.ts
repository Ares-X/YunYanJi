import { MeshStandardMaterial, Vector3 } from 'three';
import { createRandom } from '../../core/random';

export type RainSurface = 'earth' | 'stone' | 'bark' | 'timber';

const noise = /* glsl */ `
  varying vec3 vRainSurface;
  uniform vec3 uRainSeed;
  float rainHash(vec3 p) {
    p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float rainNoise(vec3 p) {
    vec3 c = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(mix(rainHash(c),rainHash(c+vec3(1,0,0)),f.x),
      mix(rainHash(c+vec3(0,1,0)),rainHash(c+vec3(1,1,0)),f.x),f.y),
      mix(mix(rainHash(c+vec3(0,0,1)),rainHash(c+vec3(1,0,1)),f.x),
      mix(rainHash(c+vec3(0,1,1)),rainHash(c+vec3(1,1,1)),f.x),f.y),f.z);
  }
  float rainFbm(vec3 p) {
    return rainNoise(p)*.57 + rainNoise(p*2.03+vec3(7.4,13.8,3.1))*.29
      + rainNoise(p*4.09+vec3(17.3,2.4,11.8))*.14;
  }
`;

const surfaces: Record<RainSurface, string> = {
  earth: /* glsl */ `
    float broad = rainFbm(p*1.9);
    float grit = mix(.5,rainNoise(p*38.0),detail);
    float litter = rainNoise(p*vec3(11.0,2.0,19.0)+broad*2.0);
    float wet = smoothstep(.20,.67,rainNoise(p*.68));
    diffuseColor.rgb *= .62 + broad*.68 + (grit-.5)*.16;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb*vec3(1.16,.96,.72), smoothstep(.53,.72,litter)*.5);
    vec2 litterCell=floor(p.xz*6.25), litterLocal=(fract(p.xz*6.25)-.5)*.16;
    float litterIdentity=rainHash(vec3(litterCell,9.7));
    float litterAngle=litterIdentity*29.3;
    vec2 litterPoint=mat2(cos(litterAngle),-sin(litterAngle),sin(litterAngle),cos(litterAngle))*litterLocal;
    float litterAA=max(.0005,fwidth(litterPoint.x));
    float needle=(1.0-smoothstep(.0007,.0007+litterAA,abs(litterPoint.x)))
      *(1.0-smoothstep(.018,.027+litterIdentity*.016,abs(litterPoint.y)))
      *step(.63,litterIdentity)*detail;
    diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*vec3(1.32,1.09,.75),needle*.65);
    relief = ((broad-.5)*.011+(grit-.5)*.0014+(litter-.5)*.0025*detail)*(1.0-wet*.48)+needle*.0006;
    roughnessChange = .03 - wet*.32 + (grit-.5)*.10;
  `,
  stone: /* glsl */ `
    float mottle = rainFbm(p*3.1);
    float vein = rainNoise(p*vec3(4.8,12.0,6.2)+mottle*1.8);
    float fine = mix(.5,rainNoise(p*63.0),detail);
    float quartz = smoothstep(.70,.83,rainNoise(p*18.0));
    float moss = smoothstep(.56,.73,rainFbm(p*1.4));
    diffuseColor.rgb *= .65+mottle*.62+(fine-.5)*.17+quartz*.12;
    diffuseColor.rgb = mix(diffuseColor.rgb,diffuseColor.rgb*vec3(.76,.96,.68),moss*.65);
    relief = (mottle-.5)*.024+(vein-.5)*.009+(fine-.5)*.0018;
    roughnessChange = -.12+moss*.15+(fine-.5)*.18;
  `,
  bark: /* glsl */ `
    float weather = rainFbm(p*vec3(2.4,.48,2.4));
    float plates = rainNoise(p*vec3(13.0,2.7,13.0)+weather*1.5);
    float crack = (1.0-smoothstep(.035,.105,abs(plates-.46)))*detail;
    float grain = mix(.5,rainNoise(p*vec3(76.0,8.0,76.0)),detail);
    diffuseColor.rgb *= .70+weather*.52-crack*.35+(grain-.5)*.11;
    relief = (weather-.5)*.012+(plates-.5)*.011-crack*.007+(grain-.5)*.0014;
    roughnessChange = -.10+(weather-.5)*.16;
  `,
  timber: /* glsl */ `
    float age = rainFbm(p*vec3(1.7,.38,1.7));
    float grain = mix(.5,rainNoise(p*vec3(17.0,.65,18.0)+age*1.2),detail);
    float split = (1.0-smoothstep(.025,.09,abs(grain-.41)))*detail;
    diffuseColor.rgb *= .69+age*.53+grain*.11-split*.19;
    relief = (age-.5)*.006+(grain-.5)*.003-split*.0035;
    roughnessChange = (age-.5)*.16;
  `,
};

/** Wetness, grain and normals are sampled in metres; no material image is used. */
export function createRainMaterial(kind: RainSurface, seed: string): MeshStandardMaterial {
  const palettes = {
    earth: { color: 0x3c4034, roughness: .82 },
    stone: { color: 0x535957, roughness: .52 },
    bark: { color: 0x51483a, roughness: .84 },
    timber: { color: 0x463c2d, roughness: .78 },
  };
  const material = new MeshStandardMaterial({ ...palettes[kind], metalness: 0, dithering: true });
  material.name = `rain-${kind}`;
  const random = createRandom(`${seed}/surface/${kind}`);
  const offset = new Vector3(random()*89,random()*89,random()*89);
  material.onBeforeCompile = shader => {
    shader.uniforms.uRainSeed = { value: offset };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>','#include <common>\nvarying vec3 vRainSurface;')
      .replace('#include <worldpos_vertex>', /* glsl */ `
        #include <worldpos_vertex>
        vec4 rainWorld = vec4(transformed,1.0);
        #ifdef USE_BATCHING
          rainWorld = batchingMatrix * rainWorld;
        #endif
        #ifdef USE_INSTANCING
          rainWorld = instanceMatrix * rainWorld;
        #endif
        vRainSurface = (modelMatrix * rainWorld).xyz;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',`#include <common>\n${noise}`)
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        vec3 p = vRainSurface + uRainSeed;
        float footprint = max(length(dFdx(p)),length(dFdy(p)));
        float detail = 1.0-smoothstep(.014,.085,footprint);
        float relief = 0.0, roughnessChange = 0.0;
        ${surfaces[kind]}
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor+roughnessChange,.27,.96);
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */ `
        #include <normal_fragment_maps>
        vec3 sx=dFdx(-vViewPosition),sy=dFdy(-vViewPosition);
        vec3 cx=cross(sy,normal),cy=cross(normal,sx);
        float determinant=dot(sx,cx);
        if(abs(determinant)>1e-8) {
          normal=normalize(abs(determinant)*normal-sign(determinant)*(dFdx(relief)*cx+dFdy(relief)*cy));
        }
      `);
  };
  material.customProgramCacheKey=()=>`rain-surface-v1/${kind}`;
  return material;
}
