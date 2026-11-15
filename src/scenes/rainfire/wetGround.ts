import {
  BufferGeometry, Color, Float32BufferAttribute, LinearFilter, LinearSRGBColorSpace,
  Matrix4, UniformsLib, UniformsUtils, Vector2,
} from 'three';
import type { Camera, ShaderMaterial } from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { createRandom } from '../../core/random';
import type { EnvironmentSnapshot, QualityLevel } from '../../core/types';
import { PUDDLE_LEVEL, SHELTER } from './rainLandscape';

const RESOLUTION: Readonly<Record<QualityLevel, number>> = { low: 256, medium: 384, high: 512 };

function puddleGeometry(height: (x: number, z: number) => number): BufferGeometry {
  // Most of this plane is below the continuous terrain. The terrain itself
  // defines the irregular bank and the raised, dry island beneath the fire.
  const count=80,positions:number[]=[],depths:number[]=[],indices:number[]=[];
  for(let row=0;row<=count;row++)for(let column=0;column<=count;column++) {
    const x=-3.6+column/count*8.2,z=4.4-row/count*8.2;
    positions.push(x,-z,0);
    depths.push(Math.max(0,PUDDLE_LEVEL-height(x,z)));
    if(row<count&&column<count) {
      const a=row*(count+1)+column,b=a+1,c=a+count+1,d=c+1;
      indices.push(a,b,c,b,d,c);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position',new Float32BufferAttribute(positions,3));
  geometry.setAttribute('aDepth',new Float32BufferAttribute(depths,1));
  geometry.setIndex(indices);geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

const vertexShader = /* glsl */ `
  uniform mat4 textureMatrix;
  attribute float aDepth;
  varying float vWaterDepth;
  varying vec4 vReflection;
  varying vec3 vWorldPosition;
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vWaterDepth=aDepth;
    vReflection = textureMatrix * vec4(position, 1.0);
    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
    #include <logdepthbuf_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec3 color;
  uniform vec2 uSeed;
  uniform vec2 uTexel;
  uniform vec4 uShelter;
  uniform float uTime;
  uniform float uWind;
  uniform float uRain;
  varying float vWaterDepth;
  varying vec4 vReflection;
  varying vec3 vWorldPosition;
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  #include <dithering_pars_fragment>
  float wetHash(vec2 p) {
    vec3 a = fract(vec3(p.xyx) * .1031);
    a += dot(a, a.yzx + 33.33);
    return fract((a.x + a.y) * a.z);
  }
  vec3 wetGradient(vec2 p) {
    vec2 cell = floor(p), f = fract(p);
    vec2 u = f*f*(3.0-2.0*f), derivative = 6.0*f*(1.0-f);
    float a=wetHash(cell), b=wetHash(cell+vec2(1,0));
    float c=wetHash(cell+vec2(0,1)), d=wetHash(cell+vec2(1,1));
    return vec3(mix(mix(a,b,u.x),mix(c,d,u.x),u.y),
      derivative.x*mix(b-a,d-c,u.y), derivative.y*mix(c-a,d-b,u.x));
  }
  float exposed(vec2 p) {
    return 1.0-step(uShelter.x,p.x)*step(uShelter.y,p.y)
      *step(p.x,uShelter.z)*step(p.y,uShelter.w);
  }
  vec2 rainRings(vec2 p) {
    const float frequency = 2.3;
    vec2 cell = floor(p*frequency), gradient = vec2(0);
    for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++) {
      vec2 id=cell+vec2(float(x),float(y));
      float phase=wetHash(id+uSeed);
      float life=fract(uTime*(1.03+phase*.44)+phase*19.7);
      vec2 centre=(id+vec2(wetHash(id+7.1),wetHash(id+41.3))*.72+.14)/frequency;
      vec2 q=p-centre;
      float radius=length(q), wave=radius-life*.32;
      float envelope=exp(-wave*wave*950.0)*(1.0-life)*(1.0-life);
      float front=sin(wave*94.0)*envelope;
      float impact=step(phase, .20+uRain*.68)*exposed(centre)*uRain;
      gradient += q/max(radius,.001)*front*.027*impact;
    }
    return gradient;
  }
  vec3 reflectedAt(vec2 uv) {
    return texture2D(tDiffuse,clamp(uv,uTexel*.5,vec2(1)-uTexel*.5)).rgb;
  }
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p=vWorldPosition.xz;
    float footprint=max(length(dFdx(p)),length(dFdy(p)));
    float detail=1.0-smoothstep(.018,.10,footprint);
    vec2 flow=p+vec2(-uTime*.038,uTime*.018);
    vec3 broad=wetGradient(flow*vec2(2.3,1.7)+uSeed);
    vec3 middle=wetGradient(flow*vec2(7.1,4.8)+uSeed*2.1+broad.x*.45);
    vec3 fine=wetGradient(flow*vec2(15.1,11.7)+uSeed*1.7+middle.x*.45);
    // A puddle has shallow capillary motion, not the travelling ocean waves
    // used by generic water demonstrations. Rain circles respect the roof.
    vec2 slope=broad.yz*vec2(2.3,1.7)*.0023
      +middle.yz*vec2(7.1,4.8)*.0012
      +fine.yz*vec2(15.1,11.7)*.00065*detail;
    slope*=.65+uWind*.75;
    slope+=rainRings(p)*detail;
    vec3 waterNormal=normalize(vec3(-slope.x,1.0,-slope.y));
    vec3 viewDirection=normalize(cameraPosition-vWorldPosition);
    float grazing=1.0-clamp(dot(waterNormal,viewDirection),0.0,1.0);
    float fresnel=.02+.98*pow(grazing,5.0);
    vec2 uv=vReflection.xy/max(vReflection.w,.0001)+vec2(slope.x,-slope.y)*.18;
    vec2 blur=uTexel*.6;
    vec3 reflection=reflectedAt(uv)*.60
      +reflectedAt(uv+blur)*.10+reflectedAt(uv-blur)*.10
      +reflectedAt(uv+vec2(blur.x,-blur.y))*.10
      +reflectedAt(uv+vec2(-blur.x,blur.y))*.10;
    float amount=(.10+fresnel*.65)*(.72+broad.x*.28);
    float sediment=.73+wetGradient(p*3.6+uSeed).x*.32;
    vec3 surface=mix(color*sediment,reflection*vec3(.96,.98,.98),amount);
    float bank=smoothstep(.001,.032,vWaterDepth);
    gl_FragColor=vec4(surface,bank);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor=1.0-exp(-fogDensity*fogDensity*vFogDepth*vFogDepth);
      #else
        float fogFactor=smoothstep(fogNear,fogFar,vFogDepth);
      #endif
      gl_FragColor.rgb=mix(gl_FragColor.rgb,fogColor,fogFactor*(1.0-amount));
    #endif
    #include <dithering_fragment>
  }
`;

export interface WetGround {
  readonly mesh: Reflector;
  update(frame: EnvironmentSnapshot): void;
  setQuality(quality: QualityLevel): void;
  invalidate(): void;
  disposeTargets(): void;
}

/** A real, cached reflection: the reflected flame is the flame in the scene. */
export function createWetGround(seed: string, quality: QualityLevel, height: (x: number, z: number) => number): WetGround {
  const random=createRandom(`${seed}/rain-puddle`),size=RESOLUTION[quality];
  const mesh=new Reflector(puddleGeometry(height),{
    color:0x242b25,clipBias:.002,textureWidth:size,textureHeight:size,multisample:0,
    shader:{
      name:'ProceduralRainPuddle',
      uniforms:UniformsUtils.merge([UniformsLib.fog,{
        tDiffuse:{value:null},color:{value:new Color()},textureMatrix:{value:new Matrix4()},
        uSeed:{value:new Vector2(random()*73,random()*73)},uShelter:{value:SHELTER.clone()},
        uTexel:{value:new Vector2(1/size,1/size)},uTime:{value:0},uWind:{value:0},uRain:{value:.7},
      }]),vertexShader,fragmentShader,
    },
  });
  mesh.name='shallow-rain-puddle';mesh.rotation.x=-Math.PI/2;mesh.position.y=PUDDLE_LEVEL;
  mesh.castShadow=mesh.receiveShadow=false;
  mesh.userData.reflectionUpdates=0;mesh.userData.reflectionSize=size;
  const material=mesh.material as ShaderMaterial;
  material.fog=true;material.dithering=true;material.toneMapped=true;
  material.transparent=true;material.depthWrite=false;
  const target=mesh.getRenderTarget();
  target.texture.name='generated-fire-reflection';target.texture.colorSpace=LinearSRGBColorSpace;
  target.texture.minFilter=target.texture.magFilter=LinearFilter;target.texture.generateMipmaps=false;
  const cameraWorld=new Matrix4(),projection=new Matrix4(),waterWorld=new Matrix4();
  let capturedCamera:Camera|undefined;
  let elapsed=0,lastCapture=-Infinity,lastRain=NaN,dirty=true,disposed=false;
  const drawReflection=mesh.onBeforeRender;
  mesh.onBeforeRender=(renderer,scene,camera,geometry,drawMaterial,group)=>{
    if(disposed)return;
    const moved=capturedCamera!==camera||!camera.matrixWorld.equals(cameraWorld)
      ||!camera.projectionMatrix.equals(projection)||!mesh.matrixWorld.equals(waterWorld);
    if(!dirty&&!mesh.forceUpdate&&!moved&&elapsed-lastCapture<1/8)return;
    drawReflection.call(mesh,renderer,scene,camera,geometry,drawMaterial,group);
    capturedCamera=camera;cameraWorld.copy(camera.matrixWorld);projection.copy(camera.projectionMatrix);
    waterWorld.copy(mesh.matrixWorld);lastCapture=elapsed;dirty=false;
    mesh.userData.reflectionUpdates+=1;
  };
  const invalidate=():void=>{if(!disposed){dirty=true;mesh.forceUpdate=true;}};
  invalidate();
  return {
    mesh,
    update(frame):void {
      if(disposed)return;
      if(frame.elapsed<elapsed||frame.precipitation!==lastRain)invalidate();
      elapsed=frame.elapsed;lastRain=frame.precipitation;
      material.uniforms.uTime!.value=elapsed;
      material.uniforms.uWind!.value=Math.max(0,Math.min(1,frame.wind.strength));
      material.uniforms.uRain!.value=frame.precipitation;
    },
    setQuality(next):void {
      if(disposed)return;
      const resolution=RESOLUTION[next];if(target.width===resolution)return;
      target.setSize(resolution,resolution);
      (material.uniforms.uTexel!.value as Vector2).set(1/resolution,1/resolution);
      mesh.userData.reflectionSize=resolution;invalidate();
    },
    invalidate,
    disposeTargets():void {if(!disposed){disposed=true;target.dispose();}},
  };
}
