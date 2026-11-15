import {
  Color, Data3DTexture, HalfFloatType, LinearFilter, Matrix4, RedFormat, RepeatWrapping,
  ShaderMaterial, Vector2, Vector3, WebGLRenderTarget,
} from 'three';
import type { DirectionalLight, PerspectiveCamera, PointLight, Texture, WebGLRenderer } from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import type { EnvironmentSnapshot, QualityLevel } from '../core/types';
import type { SceneDepthField } from './SurfaceOcclusion';
import { weatherLighting } from './weatherLighting';

const STEPS = { low: 10, medium: 18, high: 28 } as const;
function createMistNoise():Data3DTexture {
  const data=new Uint8Array(32*32*32);
  let state=0x72ab391f;
  for(let i=0;i<data.length;i++) {
    state=Math.imul(state^state>>>16,0x45d9f3b);
    data[i]=(state^state>>>16)>>>24;
  }
  const texture=new Data3DTexture(data,32,32,32);
  texture.name='generated-mist-density';texture.format=RedFormat;
  texture.minFilter=texture.magFilter=LinearFilter;
  texture.wrapS=texture.wrapT=texture.wrapR=RepeatWrapping;
  texture.unpackAlignment=1;texture.needsUpdate=true;
  return texture;
}
const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }
`;

/** Single scattering through a shallow, wind-carried forest mist, in linear HDR. */
const volumeFragment = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tDepth, tCanopy;
  uniform highp sampler3D tNoise;
  uniform mat4 uInverseProjection, uCameraWorld, uCanopyMatrix, uSunMatrix;
  uniform vec3 uCamera, uSunDirection, uSunColor, uFirePosition, uFireColor, uHaze;
  uniform vec2 uWind;
  uniform float uTime, uRain, uDensity, uFlash, uSteps, uNear, uFar, uFireIntensity;
  #ifdef MIST_SHADOWS
    uniform highp sampler2DShadow tSunShadow;
    uniform highp samplerCubeShadow tFireShadow;
    uniform mat4 uFireShadowMatrix;
    uniform vec2 uFireRange;
  #endif
  float noise(vec3 p) {
    vec3 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
    return texture(tNoise,(i+f+.5)/32.0).r;
  }
  float linearDepth(float d) { return uNear*uFar/(uFar-d*(uFar-uNear)); }
  float canopy(vec3 p) {
    vec2 uv=(uCanopyMatrix*vec4(p.x,0.0,p.z,1.0)).xy;
    float inside=step(0.0,uv.x)*step(0.0,uv.y)*step(uv.x,1.0)*step(uv.y,1.0);
    float cover=texture2D(tCanopy,clamp(uv,0.0,1.0)).r*inside;
    return mix(exp(-cover*2.2),1.0,smoothstep(4.0,24.0,p.y));
  }
  float sunlight(vec3 p) {
    #ifdef MIST_SHADOWS
      vec4 s=uSunMatrix*vec4(p,1.0); vec3 q=s.xyz/s.w;
      if(min(min(q.x,q.y),q.z)<0.0||max(max(q.x,q.y),q.z)>1.0) return 1.0;
      return texture(tSunShadow,vec3(q.xy,q.z-.0007));
    #else
      return 1.0;
    #endif
  }
  float fireVisibility(vec3 p) {
    #ifdef MIST_SHADOWS
      vec3 d=(uFireShadowMatrix*vec4(p,1.0)).xyz;
      float z=max(max(abs(d.x),abs(d.y)),abs(d.z));
      if(z<uFireRange.x||z>uFireRange.y)return 1.0;
      float depth=uFireRange.y*(z-uFireRange.x)/(z*(uFireRange.y-uFireRange.x));
      return texture(tFireShadow,vec4(d,depth-.001));
    #else
      return 1.0;
    #endif
  }
  void main() {
    float depth=texture2D(tDepth,vUv).r;
    vec4 view=uInverseProjection*vec4(vUv*2.0-1.0,1.0,1.0);
    vec3 viewRay=normalize(view.xyz/view.w);
    vec3 ray=normalize(mat3(uCameraWorld)*viewRay);
    float distance=min(linearDepth(depth)/max(.05,-viewRay.z),140.0);
    // Quadratic spacing spends samples on nearby fire-lit haze and ground mist.
    // The sampling pattern is fixed in screen space: a paused image never shimmers.
    // A decorrelated hash avoids the visible diagonal lattice produced by an
    // interleaved gradient sequence when integrating sparse leaf shadows.
    vec3 random=fract(vec3(gl_FragCoord.xyx)*vec3(.1031,.1030,.0973));
    random+=dot(random,random.yzx+33.33);
    float jitter=fract((random.x+random.y)*random.z);
    vec3 scatter=vec3(0); float transmission=1.0;
    float facing=max(0.0,dot(ray,uSunDirection));
    float phase=.65+1.4*pow(facing,5.0);
    for(int i=0;i<28;i++) {
      if(float(i)>=uSteps)break;
      float a=float(i)/uSteps,b=(float(i)+1.0)/uSteps;
      float t=mix(a*a,b*b,jitter)*distance;
      float ds=(b*b-a*a)*distance;
      vec3 p=uCamera+ray*t;
      // Prevailing drift is time-addressed; a gust adds a bounded displacement.
      // Multiplying current gust velocity by total uptime would jump the field.
      vec3 drift=vec3(.016,0.0,.004)*uTime+vec3(uWind.x,0.0,uWind.y)*.17;
      float broad=noise(p*vec3(.10,.17,.10)-drift);
      float filaments=noise(p*vec3(.36,.44,.36)-drift*1.6);
      float groundLayer=exp(-max(p.y-.25,0.0)*.24);
      float pockets=smoothstep(.22,.75,broad*.74+filaments*.26);
      float nearClear=smoothstep(1.5,8.0,t);
      float density=(.0065+groundLayer*(.009+.024*pockets))
        *uDensity*mix(.40,1.0,nearClear);
      float sky=canopy(p);
      float sun=sunlight(p);
      vec3 incident=uHaze*(.40+.24*sky) + vec3(.38,.48,.67)*uFlash
        +uSunColor*(.04+.20*sky)*sun*phase;
      vec3 toFire=uFirePosition-p;
      float radius2=dot(toFire,toFire);
      if(radius2<100.0) {
        float firePhase=.65+.70*pow(max(0.0,dot(ray,normalize(toFire))),3.0);
        incident+=uFireColor*uFireIntensity/(radius2+.45)*.20*firePhase*fireVisibility(p);
      }
      float stepTransmission=exp(-density*ds);
      scatter+=transmission*(1.0-stepTransmission)*incident;
      transmission*=stepTransmission;
    }
    gl_FragColor=vec4(scatter,transmission);
  }
`;

const denoiseFragment = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tMist,tDepth;
  uniform vec2 uDirection;
  uniform float uNear,uFar;
  float linearDepth(float d) { return uNear*uFar/(uFar-d*(uFar-uNear)); }
  void main() {
    float centre=linearDepth(texture2D(tDepth,vUv).r);
    vec4 sum=texture2D(tMist,vUv)*.227027;
    float weights=.227027;
    // Blur the low-resolution scattering, never the scene's colour. Reject
    // distant samples at nearby silhouettes so mist cannot wash over a trunk.
    for(int side=-1;side<=1;side+=2)for(int tap=0;tap<2;tap++) {
      float offset=tap==0?1.384615:3.230769;
      float kernel=tap==0?.316216:.070270;
      vec2 uv=clamp(vUv+uDirection*offset*float(side),vec2(0),vec2(1));
      float depth=linearDepth(texture2D(tDepth,uv).r);
      float weight=kernel/(1.0+abs(depth-centre)*3.0);
      sum+=texture2D(tMist,uv)*weight;weights+=weight;
    }
    gl_FragColor=sum/weights;
  }
`;

const compositeFragment = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tDiffuse,tDepth,tMist;
  uniform vec2 uMistSize;
  uniform float uNear,uFar;
  float linearDepth(float d) { return uNear*uFar/(uFar-d*(uFar-uNear)); }
  void main() {
    float centre=linearDepth(texture2D(tDepth,vUv).r);
    vec2 grid=vUv*uMistSize-.5,base=floor(grid),fraction=fract(grid);
    vec4 atmosphere=vec4(0);float weights=0.0;
    // Depth-aware reconstruction keeps the pale distant mist off nearby trunks.
    for(int y=0;y<2;y++)for(int x=0;x<2;x++) {
      vec2 offset=vec2(float(x),float(y));
      vec2 sampleUv=clamp((base+offset+.5)/uMistSize,.5/uMistSize,1.0-.5/uMistSize);
      float sampleDepth=linearDepth(texture2D(tDepth,sampleUv).r);
      vec2 bilinear=mix(1.0-fraction,fraction,offset);
      float weight=(bilinear.x*bilinear.y+.001)/(1.0+abs(sampleDepth-centre)*4.0);
      atmosphere+=texture2D(tMist,sampleUv)*weight; weights+=weight;
    }
    atmosphere/=weights;
    vec4 surface=texture2D(tDiffuse,vUv);
    gl_FragColor=vec4(surface.rgb*atmosphere.a+atmosphere.rgb,surface.a);
  }
`;

/** Reuses scene depth and the native r187 PCF shadow textures; no geometry pass. */
export class ForestAtmospherePass extends Pass {
  private readonly noise=createMistNoise();
  private readonly target = new WebGLRenderTarget(1,1,{
    type:HalfFloatType,depthBuffer:false,minFilter:LinearFilter,magFilter:LinearFilter,
  });
  private readonly temporary = new WebGLRenderTarget(1,1,{
    type:HalfFloatType,depthBuffer:false,minFilter:LinearFilter,magFilter:LinearFilter,
  });
  private readonly volume: ShaderMaterial;
  private readonly denoise: ShaderMaterial;
  private readonly composite: ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private quality: QualityLevel;
  private readonly fireWorld=new Vector3();
  private readonly lightWorld=new Vector3();
  private readonly sunWorld=new Vector3();
  private readonly sunTarget=new Vector3();
  private readonly fire:PointLight|undefined;
  private hasShadows=false;
  private readonly rainHaze=new Color('#425b66');
  private readonly clearHaze=new Color('#afc4c5');
  private readonly snowHaze=new Color('#a0b2bf');
  private readonly stormHaze=new Color('#3c4b5d');

  constructor(camera:PerspectiveCamera,private readonly sun:DirectionalLight,
    private readonly fireLights:readonly PointLight[],canopyTexture:Texture,canopyMatrix:Matrix4,
    private readonly depthField:SceneDepthField,quality:QualityLevel) {
    super(); this.quality=quality;
    const fire=this.fire=fireLights[0];
    this.target.texture.name='generated-forest-mist';
    this.volume=new ShaderMaterial({
      depthTest:false,depthWrite:false,toneMapped:false,vertexShader:vertex,fragmentShader:volumeFragment,
      uniforms:{
        tDepth:{value:null},tCanopy:{value:canopyTexture},tNoise:{value:this.noise},uCanopyMatrix:{value:canopyMatrix},
        tSunShadow:{value:null},tFireShadow:{value:null},uSunMatrix:{value:sun.shadow.matrix},
        uFireShadowMatrix:{value:fire?.shadow.matrix??new Matrix4()},
        uFireRange:{value:new Vector2(.08,12)},
        uInverseProjection:{value:camera.projectionMatrixInverse},uCameraWorld:{value:camera.matrixWorld},
        uCamera:{value:camera.position},uSunDirection:{value:new Vector3()},
        uSunColor:{value:new Color()},uHaze:{value:new Color('#425b66')},
        uFirePosition:{value:this.fireWorld},uFireColor:{value:new Color()},uFireIntensity:{value:0},
        uWind:{value:new Vector2()},uTime:{value:0},uRain:{value:.72},uDensity:{value:1},uFlash:{value:0},uSteps:{value:STEPS[quality]},
        uNear:{value:camera.near},uFar:{value:camera.far},
      },
    });
    this.temporary.texture.name='forest-mist-denoise';
    this.denoise=new ShaderMaterial({
      depthTest:false,depthWrite:false,toneMapped:false,vertexShader:vertex,fragmentShader:denoiseFragment,
      uniforms:{tMist:{value:this.target.texture},tDepth:{value:this.depthField.texture},
        uDirection:{value:new Vector2()},uNear:{value:camera.near},uFar:{value:camera.far}},
    });
    this.composite=new ShaderMaterial({
      depthTest:false,depthWrite:false,toneMapped:false,vertexShader:vertex,fragmentShader:compositeFragment,
      uniforms:{tDiffuse:{value:null},tDepth:{value:null},tMist:{value:this.target.texture},
        uMistSize:{value:new Vector2(1,1)},uNear:{value:camera.near},uFar:{value:camera.far}},
    });
    this.quad=new FullScreenQuad(this.volume);
  }

  update(frame:EnvironmentSnapshot):void {
    this.volume.uniforms.uTime!.value=frame.elapsed;
    this.volume.uniforms.uRain!.value=frame.weather.rain;
    const light=weatherLighting(frame.weather,frame.lightning?.flash??0);
    this.volume.uniforms.uDensity!.value=light.mist;
    this.volume.uniforms.uFlash!.value=frame.lightning?.flash??0;
    (this.volume.uniforms.uHaze!.value as Color).copy(this.rainHaze)
      .lerp(this.clearHaze,light.clearing).lerp(this.snowHaze,frame.weather.snow*.65)
      .lerp(this.stormHaze,frame.weather.storm);
    (this.volume.uniforms.uWind!.value as Vector2).set(frame.wind.x,frame.wind.z);
  }

  setQuality(quality:QualityLevel):void {
    this.quality=quality; this.volume.uniforms.uSteps!.value=STEPS[quality];
  }

  override setSize(width:number,height:number):void {
    const scale=this.quality==='low'?.35:.5;
    this.target.setSize(Math.max(1,Math.ceil(width*scale)),Math.max(1,Math.ceil(height*scale)));
    this.temporary.setSize(this.target.width,this.target.height);
    (this.composite.uniforms.uMistSize!.value as Vector2).set(this.target.width,this.target.height);
  }

  override render(renderer:WebGLRenderer,write:WebGLRenderTarget,read:WebGLRenderTarget):void {
    const uniforms=this.volume.uniforms;
    // Independent opaque depth cannot be lost when composer swaps colour targets.
    uniforms.tDepth!.value=this.depthField.texture;
    this.sun.getWorldPosition(this.sunWorld);
    this.sun.target.getWorldPosition(this.sunTarget);
    (uniforms.uSunDirection!.value as Vector3).copy(this.sunWorld).sub(this.sunTarget).normalize();
    (uniforms.uSunColor!.value as Color).copy(this.sun.color).multiplyScalar(this.sun.intensity);
    const shadows=this.quality!=='low'&&!!this.sun.shadow.map?.depthTexture&&!!this.fire?.shadow.map?.depthTexture;
    if(shadows!==this.hasShadows) {
      this.hasShadows=shadows;this.volume.defines=shadows?{MIST_SHADOWS:1}:{};this.volume.needsUpdate=true;
    }
    if(shadows) {
      uniforms.tSunShadow!.value=this.sun.shadow.map!.depthTexture;
      uniforms.tFireShadow!.value=this.fire!.shadow.map!.depthTexture;
      (uniforms.uFireRange!.value as Vector2).set(this.fire!.shadow.camera.near,this.fire!.shadow.camera.far);
    }
    if(this.fire) {
      this.fireWorld.set(0,0,0);
      let energy=0,red=0,green=0,blue=0;
      for(const light of this.fireLights) {
        light.getWorldPosition(this.lightWorld);
        this.fireWorld.addScaledVector(this.lightWorld,light.intensity);
        energy+=light.intensity;
        red+=light.color.r*light.intensity;green+=light.color.g*light.intensity;blue+=light.color.b*light.intensity;
      }
      this.fireWorld.multiplyScalar(1/Math.max(.001,energy));
      uniforms.uFireIntensity!.value=energy;
      (uniforms.uFireColor!.value as Color).setRGB(red/Math.max(.001,energy),
        green/Math.max(.001,energy),blue/Math.max(.001,energy));
    }
    this.quad.material=this.volume;
    renderer.setRenderTarget(this.target);this.quad.render(renderer);
    const direction=this.denoise.uniforms.uDirection!.value as Vector2;
    this.quad.material=this.denoise;
    this.denoise.uniforms.tMist!.value=this.target.texture;
    direction.set(1/this.target.width,0);
    renderer.setRenderTarget(this.temporary);this.quad.render(renderer);
    this.denoise.uniforms.tMist!.value=this.temporary.texture;
    direction.set(0,1/this.target.height);
    renderer.setRenderTarget(this.target);this.quad.render(renderer);
    this.composite.uniforms.tDiffuse!.value=read.texture;
    this.composite.uniforms.tDepth!.value=this.depthField.texture;
    this.quad.material=this.composite;
    renderer.setRenderTarget(this.renderToScreen?null:write);this.quad.render(renderer);
  }

  invalidate():void {this.target.dispose();this.temporary.dispose();this.noise.needsUpdate=true;}
  diagnostics():Record<string,number> {
    return {mistDensity:Number(this.volume.uniforms.uDensity!.value),mistSteps:STEPS[this.quality],mistWidth:this.target.width,mistHeight:this.target.height};
  }
  override dispose():void {
    this.target.dispose();this.temporary.dispose();this.noise.dispose();
    this.volume.dispose();this.denoise.dispose();this.composite.dispose();this.quad.dispose();
  }
}
