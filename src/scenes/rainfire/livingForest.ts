import {
  BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Group, Mesh,
  MeshStandardMaterial, Vector3,
} from 'three';
import { createRandom, randomBetween } from '../../core/random';
import { BARK_WIDTH_METRES, BARK_HEIGHT_METRES, createBarkSurface } from './barkSurface';

const UP = new Vector3(0, 1, 0);
const VIEWPOINT = new Vector3(1, 1.25, 4.5);
const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
type Curve = (t: number) => Vector3;
type Height = (x: number, z: number) => number;

/** Forest batches are authored directly in world metres; no foliage billboards. */
class Surface {
  positions: number[] = [];
  uv: number[] = [];
  colors: number[] = [];
  identity: number[] = [];
  rootHeights: number[] = [];
  indices: number[] = [];
  rootHeight = 0;
  groundAt?: Height;
  vertex(p: Vector3, u: number, v: number, color: Color, identity: number): number {
    const at = this.positions.length / 3;
    this.positions.push(p.x, p.y, p.z);
    this.uv.push(u, v);
    this.colors.push(color.r, color.g, color.b);
    this.identity.push(identity);
    this.rootHeights.push(this.rootHeight);
    return at;
  }
  triangle(a: number, b: number, c: number): void { this.indices.push(a, b, c); }
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    g.setAttribute('aForestIdentity', new Float32BufferAttribute(this.identity, 1));
    g.setAttribute('aForestRootHeight', new Float32BufferAttribute(this.rootHeights, 1));
    g.setIndex(this.indices);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

function cubic(a: Vector3, b: Vector3, c: Vector3, d: Vector3): Curve {
  return (t) => {
    const u = 1 - t;
    return a.clone().multiplyScalar(u * u * u).addScaledVector(b, 3 * u * u * t)
      .addScaledVector(c, 3 * u * t * t).addScaledVector(d, t * t * t);
  };
}

function growthNoise(x:number,y:number):number {
  const ix=Math.floor(x),iy=Math.floor(y),tx=x-ix,ty=y-iy;
  const u=tx*tx*(3-2*tx),v=ty*ty*(3-2*ty);
  const hash=(a:number,b:number)=>{
    let h=Math.imul(a,374761393)+Math.imul(b,668265263);
    h=Math.imul(h^(h>>>13),1274126177);return ((h^(h>>>16))>>>0)/4294967296;
  };
  return (hash(ix,iy)*(1-u)+hash(ix+1,iy)*u)*(1-v)
    +(hash(ix,iy+1)*(1-u)+hash(ix+1,iy+1)*u)*v;
}

function tube(surface: Surface, curve: Curve, radius: number, terminal: number,
  segments: number, sides: number, identity: number, color: Color, buttressed = false, collar = 0): void {
  const first = surface.positions.length / 3;
  const length = curve(0).distanceTo(curve(1));
  let transportedSide:Vector3|undefined;
  for (let ring = 0; ring <= segments; ring++) {
    // Extra rings are concentrated around the changing root flare instead
    // of spending identical geometry on each half-metre of a straight pole.
    const t = buttressed ? Math.pow(ring / segments,1.45) : ring / segments;
    const p = curve(t);
    const tangent = curve(Math.min(1, t + .002)).sub(curve(Math.max(0, t - .002))).normalize();
    let side = transportedSide
      ? transportedSide.clone().addScaledVector(tangent,-transportedSide.dot(tangent))
      : tangent.clone().cross(UP);
    if (side.lengthSq() < .0001) side = tangent.clone().cross(new Vector3(0, 0, 1));
    side.normalize();
    transportedSide=side.clone();
    const top = side.clone().cross(tangent).normalize();
    const axial=t*length;
    const baseProfile=buttressed ? .73+.27*Math.exp(-axial*.72) : 1;
    const taper = terminal + (radius - terminal)*Math.pow(1-t,buttressed?.78:.9)*baseProfile;
    const swell=1+(growthNoise(axial*2.5,identity*7.17)-.5)*(buttressed?.11:.18);
    for (let sector = 0; sector <= sides; sector++) {
      const angle = sector / sides * TAU;
      const fluting = 1 + .105*Math.sin(angle*2+identity*.87+axial*.05)
        + .058*Math.sin(angle*3-identity*1.33+axial*.13)
        + .025*Math.sin(angle*7+identity+axial*.47);
      const lobe=Math.max(0,.32+.47*Math.sin(angle*3+identity*.73)
        +.20*Math.sin(angle*5-identity*1.9));
      const foot=buttressed?radius*.70*Math.exp(-axial*1.55)*lobe*lobe:0;
      const nodule=(growthNoise(Math.cos(angle)*1.7+identity*3.1,Math.sin(angle)*1.7+axial*1.35)-.5)
        *Math.min(.026,radius*.18)*Math.sin(Math.PI*t);
      const shoulder=1+collar*Math.exp(-t*15);
      const r=taper*fluting*swell*shoulder+foot+nodule;
      const q = p.clone().addScaledVector(side, Math.cos(angle) * r)
        .addScaledVector(top, Math.sin(angle) * r);
      if(buttressed&&surface.groundAt) {
        const contact=surface.groundAt(q.x,q.z)+p.y-surface.rootHeight;
        q.y+=(contact-q.y)*Math.exp(-axial*5);
      }
      // Circumferential and axial metres keep bark grain the same physical size
      // on a large trunk and on a thin branch, with no world-axis stretching.
      surface.vertex(q, sector / sides * TAU * radius, t * length, color, identity);
    }
  }
  const stride = sides + 1;
  for (let ring = 0; ring < segments; ring++) for (let side = 0; side < sides; side++) {
    const a = first + ring * stride + side, b = a + stride;
    surface.triangle(a, b, a + 1);
    surface.triangle(a + 1, b, b + 1);
  }
  const end = surface.vertex(curve(1), 0, length, color, identity);
  const last = first + segments * stride;
  for (let side = 0; side < sides; side++) surface.triangle(end, last + side + 1, last + side);
}

function barkMaterial(seed:string): MeshStandardMaterial {
  const surface=createBarkSurface(seed);
  const material = new MeshStandardMaterial({ color: 0xffffff, vertexColors: true,
    roughness: .97, normalMap:surface.normal, roughnessMap:surface.roughness,
    metalness: 0, dithering: true });
  material.normalScale.set(1.12,1.12);
  material.name = 'living-forest-wet-bark';
  material.addEventListener('dispose',surface.dispose);
  material.onBeforeCompile = shader => {
    shader.uniforms.uBarkSurface={value:surface.albedo};
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aForestIdentity;
        attribute float aForestRootHeight;
        varying vec2 vBarkUv;
        varying vec3 vForestPosition;
        varying float vBarkRootHeight;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vec2 barkOffset=vec2(aForestIdentity*.4173,aForestIdentity*.6197);
        vNormalMapUv+=barkOffset;
        vRoughnessMapUv+=barkOffset;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vBarkUv=uv*vec2(${1/BARK_WIDTH_METRES},${1/BARK_HEIGHT_METRES})+barkOffset;
        vForestPosition=(modelMatrix*vec4(position,1.0)).xyz;
        vBarkRootHeight=aForestRootHeight;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uBarkSurface;
        varying vec2 vBarkUv;
        varying vec3 vForestPosition;
        varying float vBarkRootHeight;
        float growthHash(vec2 p) {
          vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);
          return fract((q.x+q.y)*q.z);
        }
        float growthPatch(vec2 p) {
          vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
          return mix(mix(growthHash(i),growthHash(i+vec2(1,0)),f.x),
            mix(growthHash(i+vec2(0,1)),growthHash(i+vec2(1,1)),f.x),f.y);
        }`)
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        vec4 barkSample=texture2D(uBarkSurface,vBarkUv);
        diffuseColor.rgb*=barkSample.rgb*1.43;
        float rootDistance=max(0.0,vForestPosition.y-vBarkRootHeight);
        vec2 weatherPoint=vec2(vForestPosition.x*.74+vForestPosition.z*.61,vForestPosition.y*.59);
        float damp=smoothstep(.34,.74,growthPatch(weatherPoint)*.72+growthPatch(weatherPoint*2.7)*.28);
        diffuseColor.rgb*=mix(vec3(1),vec3(.73,.78,.77),damp*.62);
        float rootPatch=growthPatch(vForestPosition.xz*1.7+vec2(.17,.83));
        float moss=barkSample.a*(1.0-smoothstep(.22,1.8,rootDistance))
          *smoothstep(.28,.67,rootPatch);
        vec3 colony=vec3(.037,.060,.023)*(0.80+barkSample.g*.57);
        diffuseColor.rgb=mix(diffuseColor.rgb,colony,moss*.75);
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor=clamp(roughnessFactor-damp*.08+moss*.06,.58,.98);`);
  };
  material.customProgramCacheKey = () => 'living-forest-grown-bark-v5';
  return material;
}

function foliageMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color: 0xffffff, vertexColors: true,
    side: DoubleSide, roughness: .69, metalness: 0, dithering: true });
  material.name = 'living-forest-individual-leaves';
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aForestIdentity;
        varying vec2 vLeafUv;
        varying float vLeafIdentity;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLeafUv=uv;vLeafIdentity=aForestIdentity;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vLeafUv;
        varying float vLeafIdentity;`)
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        float span=abs(vLeafUv.x-.5);
        float aa=max(.002,fwidth(vLeafUv.x));
        float midrib=1.0-smoothstep(.008,.008+aa,span);
        float ribs=abs(fract(vLeafUv.y*9.0-span*4.7+vLeafIdentity*.7)-.5);
        float veins=(1.0-smoothstep(.018,.018+aa*2.0,ribs))*(1.0-span*1.5);
        diffuseColor.rgb*=.82+vLeafUv.y*.20+midrib*.17+veins*.055;
      `)
      .replace('#include <lights_fragment_end>', /* glsl */ `
        #include <lights_fragment_end>
        #if NUM_DIR_LIGHTS > 0
          float transmitted=pow(max(0.0,dot(-normal,directionalLights[0].direction)),2.0);
          reflectedLight.directDiffuse+=diffuseColor.rgb*directionalLights[0].color*transmitted*.11;
        #endif
      `);
  };
  material.customProgramCacheKey = () => 'living-forest-leaf-v1';
  return material;
}

function leaf(surface: Surface, root: Vector3, direction: Vector3, length: number,
  width: number, roll: number, color: Color, identity: number, detailed: boolean): void {
  const axis=direction.clone().normalize();
  let cross=axis.clone().cross(UP);
  if(cross.lengthSq()<.0001)cross=axis.clone().cross(new Vector3(0,0,1));
  cross.normalize();
  const top=cross.clone().cross(axis).normalize();
  cross.multiplyScalar(Math.cos(roll)).addScaledVector(top,Math.sin(roll)).normalize();
  const up=cross.clone().cross(axis).normalize();
  const point=(t:number,w:number):Vector3 => root.clone().addScaledVector(axis,t*length)
    .addScaledVector(cross,w*width)
    .addScaledVector(up,-Math.abs(w)*length*.11+Math.sin(t*Math.PI)*length*.07)
    .addScaledVector(UP,-t*t*length*.16);
  const first=surface.positions.length/3;
  if(detailed) {
    for(const [t,w] of [[0,0],[.34,-.48],[.34,0],[.34,.48],[.69,-.40],[.69,0],[.69,.40],[1,0]]) {
      surface.vertex(point(t!,w!),w!+.5,t!,color,identity);
    }
    for(const [a,b,c] of [[0,1,2],[0,2,3],[1,4,2],[2,4,5],[2,5,3],[3,5,6],[4,7,5],[5,7,6]]) {
      surface.triangle(first+a!,first+b!,first+c!);
    }
  } else {
    surface.vertex(point(0,0),.5,0,color,identity);
    surface.vertex(point(.46,-.5),0,.46,color,identity);
    surface.vertex(point(1,0),.5,1,color,identity);
    surface.vertex(point(.46,.5),1,.46,color,identity);
    surface.triangle(first,first+1,first+2);
    surface.triangle(first,first+2,first+3);
  }
}

interface TreeSpec { x:number;z:number;height:number;radius:number;young?:boolean; }

/** A broadleaf sapling divides into leaders, not a stack of radial arms. */
function saplingCrown(spec:TreeSpec,identity:number,wood:Surface,leaves:Surface,
  random:()=>number,trunk:Curve,ground:number,woodColor:Color,near:boolean,far:boolean):void {
  const height=spec.height;
  const forkCount=2+Math.floor(random()*3);
  const randomBearing=random()*TAU;
  const bearing=spec.z< -34&&spec.x> -3&&spec.x<5
    ? Math.atan2(.22,-1)-TAU/forkCount : randomBearing;
  const tangent=(curve:Curve,t:number)=>curve(Math.min(1,t+.015)).sub(curve(Math.max(0,t-.015))).normalize();
  const makeLimb=(start:Vector3,direction:Vector3,end:Vector3,radius:number,terminal:number,level:number):Curve=>{
    const length=start.distanceTo(end);
    const axis=end.clone().sub(start).normalize();
    let side=axis.clone().cross(UP);if(side.lengthSq()<.001)side.set(1,0,0);else side.normalize();
    const cross=side.clone().cross(axis).normalize();
    const bendA=randomBetween(random,-.030,.030)*length;
    const bendB=randomBetween(random,-.023,.023)*length;
    const phase=random()*TAU;
    const base=cubic(start,start.clone().addScaledVector(direction,length*.34),
      end.clone().addScaledVector(UP,-length*.17),end);
    const curve:Curve=t=>base(t)
      .addScaledVector(side,Math.sin(Math.PI*t)*Math.sin(t*5.4+phase)*bendA)
      .addScaledVector(cross,Math.sin(Math.PI*t)*Math.sin(t*7.2-phase)*bendB);
    const shoulder=level===0?(radius/spec.radius>.60?0:.30):.50;
    if(level<2||near)tube(wood,curve,radius,terminal,level===0?13:level===1?6:3,
      level===0?8:level===1?5:3,identity,woodColor,false,shoulder);
    return curve;
  };
  const putLeaf=(attach:Vector3,direction:Vector3)=>{
    const size=randomBetween(random,.12,.205)*(far?1.09:1);
    const color=new Color().setRGB(.071,.118,.041).multiplyScalar(randomBetween(random,.65,1.28));
    if(random()<.045)color.setRGB(.12,.112,.052).multiplyScalar(randomBetween(random,.75,1.1));
    leaf(leaves,attach,direction,size,size*randomBetween(random,.55,.78),
      randomBetween(random,-.90,.90),color,random()*37,attach.distanceToSquared(VIEWPOINT)<225);
  };
  const terminalSpray=(root:Vector3,direction:Vector3,size:number)=>{
    let side=direction.clone().cross(UP);
    if(side.lengthSq()<.001)side.set(1,0,0);else side.normalize();
    const around=side.clone().cross(direction).normalize();
    const twist=random()*TAU;
    for(let shoot=0;shoot<3;shoot++) {
      // Individual shoots diverge through a volume. No shared horizontal
      // leaf deck runs from the trunk to the edge of the crown.
      const angle=twist+shoot*2.09+randomBetween(random,-.50,.50);
      const growth=direction.clone().multiplyScalar(.57)
        .addScaledVector(side,Math.cos(angle)*.72)
        .addScaledVector(around,Math.sin(angle)*.62)
        .addScaledVector(UP,randomBetween(random,-.30,.15)).normalize();
      const length=size*randomBetween(random,.71,1.15);
      const end=root.clone().addScaledVector(growth,length).addScaledVector(UP,-length*.25);
      const curve=cubic(root,root.clone().addScaledVector(growth,length*.34),
        end.clone().addScaledVector(growth,-length*.26).addScaledVector(UP,length*.10),end);
      if(near&&root.y<7.5)tube(wood,curve,.0025,.0004,3,3,identity,woodColor);
      const count=far?14:18;
      for(let k=0;k<count;k++) {
        const at=(k+randomBetween(random,.12,.92))/count;
        const attach=curve(at);
        const axis=tangent(curve,at);
        let lateral=axis.clone().cross(UP);
        if(lateral.lengthSq()<.001)lateral.set(1,0,0);else lateral.normalize();
        const upper=lateral.clone().cross(axis).normalize();
        const leafAngle=k*2.399+twist+randomBetween(random,-.50,.50);
        const out=axis.clone().multiplyScalar(randomBetween(random,.18,.48))
          .addScaledVector(lateral,Math.cos(leafAngle)*.88)
          .addScaledVector(upper,Math.sin(leafAngle)*.64)
          .addScaledVector(UP,-.22).normalize();
        putLeaf(attach,out);
      }
    }
  };
  for(let fork=0;fork<forkCount;fork++) {
    const low=fork===1;
    const at=fork===0?.46:low?randomBetween(random,.21,.30):randomBetween(random,.31,.43);
    const angle=bearing+fork*(TAU/forkCount)+randomBetween(random,-.65,.65);
    const outward=new Vector3(Math.cos(angle),0,Math.sin(angle));
    const sideways=outward.clone().cross(UP);
    const root=trunk(at);
    const spread=height*randomBetween(random,low?.28:.19,low?.37:.31);
    const end=root.clone().addScaledVector(outward,spread);
    end.y=ground+height*(fork===0?randomBetween(random,.80,.94):low?randomBetween(random,.44,.58):randomBetween(random,.64,.79));
    const opening=tangent(trunk,at).multiplyScalar(.81).addScaledVector(outward,.25).normalize();
    const primaryRadius=spec.radius*(fork===0?.64:.52);
    const primary=makeLimb(root,opening,end,primaryRadius,primaryRadius*.35,0);
    const children=far?3:4;
    for(let child=0;child<children;child++) {
      const t=randomBetween(random,.48,.96);
      const start=primary(t);
      const sign=child%2?1:-1;
      const push=outward.clone().multiplyScalar(.48).addScaledVector(sideways,sign*randomBetween(random,.45,.92))
        .addScaledVector(UP,randomBetween(random,low?-.05:.06,.57)).normalize();
      const extension=height*randomBetween(random,.14,.24);
      const tip=start.clone().addScaledVector(push,extension);
      const secondary=makeLimb(start,tangent(primary,t),tip,primaryRadius*.33,.007,1);
      for(let split=0;split<3;split++) {
        const s=randomBetween(random,.43,.98);
        const branchRoot=secondary(s);
        const axis=tangent(secondary,s);
        const across=axis.clone().cross(UP).normalize();
        const spreadSign=split%2?1:-1;
        const growth=axis.clone().multiplyScalar(.58).addScaledVector(across,spreadSign*randomBetween(random,.43,.83))
          .addScaledVector(UP,randomBetween(random,-.24,.36)).normalize();
        const twigLength=height*randomBetween(random,.065,.13);
        const twigEnd=branchRoot.clone().addScaledVector(growth,twigLength);
        const tertiary=makeLimb(branchRoot,axis,twigEnd,.006,.0015,2);
        for(let bud=0;bud<4;bud++) {
          const u=randomBetween(random,.47,1);
          const budRoot=tertiary(u);
          const budDirection=tangent(tertiary,u).addScaledVector(UP,randomBetween(random,-.20,.22)).normalize();
          terminalSpray(budRoot,budDirection,Math.min(.62,height*randomBetween(random,.045,.075)));
        }
      }
    }
  }
}

function tree(spec:TreeSpec,identity:number,wood:Surface,leaves:Surface,seed:string,heightAt:Height):void {
  const random=createRandom(`${seed}/living-tree/${identity}`);
  const {x,z,height,radius}=spec;
  const ground=heightAt(x,z)-.065;
  wood.rootHeight=ground+.065;
  wood.groundAt=heightAt;
  const distance=Math.hypot(x-1,z-4.5);
  const near=distance<18;
  const far=distance>48;
  const young=Boolean(spec.young);
  const phase=random()*TAU;
  const lean=new Vector3(randomBetween(random,-1.9,1.9),0,randomBetween(random,-1.3,1.3));
  const woodColor=new Color(young?0x6d705c:0x777468).multiplyScalar(randomBetween(random,.80,1.05));
  const bendX=Math.sin(phase*1.37+.8)*radius*.95;
  const bendZ=Math.cos(phase*.91-.5)*radius*.77;
  const trunk:Curve=t=>new Vector3(
    x+lean.x*(t*.64+Math.pow(t,1.7)*.36)+bendX*(1-Math.exp(-t*height*.62))
      +(Math.sin(t*height*.48+phase)-Math.sin(phase))*radius*.21,
    ground+t*height,
    z+lean.z*(t*.64+Math.pow(t,1.7)*.36)+bendZ*(1-Math.exp(-t*height*.56))
      +(Math.sin(t*height*.39-phase)+Math.sin(phase))*radius*.19);
  if(young)tube(wood,t=>trunk(t*.46),radius,radius*.62,near?22:14,near?10:7,identity,woodColor,true);
  else tube(wood,trunk,radius,.006,near?88:far?15:24,near?28:far?6:9,identity,woodColor,true);
  if(near&&!young) {
    // Roots enter the soil quickly, follow its surface and vary in direction;
    // most of the spreading root plate is buried rather than a ring of cones.
    const roots=4;
    for(let i=0;i<roots;i++) {
      const angle=phase+i*GOLDEN+randomBetween(random,-.55,.55);
      const length=radius*randomBetween(random,1.65,3.5);
      const direction=new Vector3(Math.cos(angle),0,Math.sin(angle));
      const lateral=new Vector3(-direction.z,0,direction.x);
      const start=trunk(.002).addScaledVector(direction,radius*.34);
      const end=new Vector3(x+direction.x*length,0,z+direction.z*length);
      end.y=heightAt(end.x,end.z)-.17;
      const bend=randomBetween(random,-.45,.45);
      const control=start.clone().addScaledVector(direction,length*.40)
        .addScaledVector(lateral,bend);
      control.y=heightAt(control.x,control.z)+randomBetween(random,.045,.16);
      const second=end.clone().addScaledVector(direction,-length*.28).addScaledVector(lateral,-bend*.35);
      second.y=heightAt(second.x,second.z)+randomBetween(random,-.07,.015);
      const curve=cubic(start,control,second,end);
      tube(wood,curve,radius*randomBetween(random,.19,.34),.002,11,9,identity+i*.001,woodColor);
    }
  }
  if(!young)for(let i=0;i<(near?4:1);i++) {
    const at=randomBetween(random,.06,.22),a=trunk(at),angle=random()*TAU;
    const d=new Vector3(Math.cos(angle),randomBetween(random,-.12,.24),Math.sin(angle));
    const length=randomBetween(random,.13,.41)*(1-at);
    const end=a.clone().addScaledVector(d,length);
    tube(wood,cubic(a,a.clone().addScaledVector(d,length*.3),end,end),
      radius*randomBetween(random,.06,.12),.004,4,near?6:4,identity+i*.01,woodColor);
  }

  if(young) {
    saplingCrown(spec,identity,wood,leaves,random,trunk,ground,woodColor,near,far);
    return;
  }

  // Broad overlapping crowns occupy the visible forest. Main limbs fork at
  // unequal heights; the crown's outline comes from many small leaf surfaces.
  const primaryCount=far?7:10;
  const occupiedJunctions:number[]=[];
  for(let primary=0;primary<primaryCount;primary++) {
    let t=randomBetween(random,.32,.73);
    if(near) {
      for(let attempt=0;attempt<8&&occupiedJunctions.some(old=>Math.abs(old-t)*height<.68);attempt++) {
        t=randomBetween(random,.32,.73);
      }
      occupiedJunctions.push(t);
    }
    const angle=phase+primary*GOLDEN+randomBetween(random,-.95,.95);
    const start=trunk(t);
    const outward=new Vector3(Math.cos(angle),0,Math.sin(angle));
    const sideways=outward.clone().cross(UP);
    const crownWidth=(height*.245)
      *Math.pow(Math.sin(t*Math.PI)*.73+.27,.65);
    const length=crownWidth*randomBetween(random,.64,1.20);
    const rise=length*randomBetween(random,.16,.69);
    const end=start.clone().addScaledVector(outward,length).addScaledVector(UP,rise);
    const curve=cubic(start,start.clone().addScaledVector(outward,length*.22).addScaledVector(UP,rise*.10),
      end.clone().addScaledVector(outward,-length*.25).addScaledVector(UP,-rise*.49),end);
    const branchRadius=radius*(1-t)*randomBetween(random,.29,.46);
    tube(wood,curve,branchRadius,Math.min(.004,branchRadius*.18),near?9:far?3:4,
      near?7:4,identity+primary*.01,woodColor);
    if(near&&start.y<9.2) {
      // A thick, tapering branch collar grows out of the bole and continues
      // into the limb. This hides the cylinder intersection inside a smooth
      // healed shoulder, with no detached cap or bead at the visible joint.
      const collarEnd=Math.min(.32,.95/length);
      const parentRadius=.006+(radius-.006)*Math.pow(1-t,.68);
      const tipRadius=.004+(branchRadius-.004)*Math.pow(1-collarEnd,.9);
      tube(wood,u=>curve(u*collarEnd),Math.max(branchRadius*1.20,parentRadius*.69),
        tipRadius*1.015,9,14,identity+primary*.01,woodColor);
    }
    const secondaryCount=far?4:5;
    for(let second=0;second<secondaryCount;second++) {
      const at=.24+(second+randomBetween(random,.1,.9))/secondaryCount*.74;
      const root=curve(at),sign=second%2?1:-1;
      const direction=outward.clone().multiplyScalar(.44).addScaledVector(sideways,sign*.88)
        .addScaledVector(UP,randomBetween(random,-.09,.45)).normalize();
      const extension=length*randomBetween(random,.38,.61)*(1-at*.25);
      const tip=root.clone().addScaledVector(direction,extension);
      const secondary=cubic(root,root.clone().addScaledVector(direction,extension*.31).addScaledVector(UP,.05),
        tip.clone().addScaledVector(direction,-extension*.20).addScaledVector(UP,-extension*.10),tip);
      // Fine secondary wood in distant crowns is smaller than a pixel. Spend
      // that budget on the leaf area that actually closes the canopy.
      if(!far)tube(wood,secondary,Math.max(.003,branchRadius*(1-at)*.45),.001,
        near?4:2,near?4:3,identity+second*.002,woodColor);
      const tertiaryCount=far?4:5;
      for(let third=0;third<tertiaryCount;third++) {
        const u=.14+(third+randomBetween(random,.1,.9))/tertiaryCount*.85;
        const node=secondary(u);
        const tangent=secondary(Math.min(1,u+.025)).sub(secondary(Math.max(0,u-.025))).normalize();
        const lateral=tangent.clone().cross(UP).normalize();
        const tw=third%2?1:-1;
        const growth=tangent.clone().multiplyScalar(.60).addScaledVector(lateral,tw*.72)
          .addScaledVector(UP,randomBetween(random,-.27,.22)).normalize();
        const twigLength=Math.max(.24,extension*randomBetween(random,.35,.62)*(1-u*.24));
        const twigTip=node.clone().addScaledVector(growth,twigLength).addScaledVector(UP,-twigLength*.17);
        const twig=cubic(node,node.clone().addScaledVector(growth,twigLength*.30),
          twigTip.clone().addScaledVector(growth,-twigLength*.22),twigTip);
        if(near&&node.y<5.5)tube(wood,twig,.0027,.0005,3,3,identity,woodColor);
        const count=far?15:22;
        for(let k=0;k<count;k++) {
          const f=(k+randomBetween(random,.1,.9))/count;
          const attach=twig(f);
          // The whole permitted look-up range is retained, including the
          // portrait field of view; only crowns above a 44-degree ray are
          // beyond the interactive camera's possible view. Saplings keep
          // their complete crowns, regardless of the initial composition.
          if(attach.y>2.0+Math.hypot(attach.x-1,attach.z-4.5)*.966)continue;
          const side=k%2?1:-1;
          const leafDirection=growth.clone().multiplyScalar(randomBetween(random,.21,.54))
            .addScaledVector(lateral,side*randomBetween(random,.57,1))
            .addScaledVector(UP,randomBetween(random,-.52,.16)).normalize();
          const leafLength=randomBetween(random,.12,.205)*(far?1.15:1);
          const leafColor=new Color().setRGB(.071,.118,.041).multiplyScalar(randomBetween(random,.64,1.27));
          if(random()<.045)leafColor.setRGB(.12,.112,.052).multiplyScalar(randomBetween(random,.75,1.1));
          const detailed=attach.distanceToSquared(VIEWPOINT)<57;
          leaf(leaves,attach,leafDirection,leafLength,leafLength*randomBetween(random,.47,.75),
            randomBetween(random,-.75,.75),leafColor,random()*37,detailed);
        }
      }
    }
  }
}

/**
 * Mature mixed woodland, built as four opaque geometry batches. Individual
 * folded leaves have centimetre-scale silhouettes; no repeated alpha cards
 * determine the near forest outline. All materials and geometry are owned by
 * the returned group and may be released by the scene's normal traversal.
 */
export function buildLivingForest(seed:string,heightAt:Height):{group:Group;treeCount:number} {
  const group=new Group();group.name='living-wet-woodland';
  const random=createRandom(`${seed}/living-forest-layout`);
  const specs:TreeSpec[]=[
    {x:-5.15,z:-2.5,height:25.4,radius:.61},
    {x:5.85,z:-6.65,height:27.2,radius:.61},
    {x:-7.2,z:-14.0,height:28.1,radius:.56},
    {x:8.9,z:-16.4,height:26.4,radius:.55},
    {x:-4.7,z:-8.9,height:6.7,radius:.10,young:true},
    {x:5.3,z:-10.6,height:8.0,radius:.13,young:true},
    {x:-8.2,z:-11.8,height:7.9,radius:.12,young:true},
    {x:9.1,z:-15.8,height:8.3,radius:.14,young:true},
    {x:-3.8,z:-20.1,height:10.9,radius:.19,young:true},
    {x:5.8,z:-24.5,height:12.5,radius:.21,young:true},
    {x:-11.5,z:-25.8,height:9.8,radius:.17,young:true},
    {x:13.1,z:-31.3,height:12.4,radius:.23,young:true},
    {x:-3.8,z:-33.8,height:11.4,radius:.22,young:true},
    {x:12.2,z:-21.1,height:10.5,radius:.18,young:true},
    {x:3.0,z:-39.3,height:7.7,radius:.11,young:true},
    {x:-1.9,z:-46.5,height:9.2,radius:.14,young:true},
  ];
  // Rejection sampling gives uneven groups and clearings, with no grid rows.
  for(let i=0;i<1200&&specs.length<36;i++) {
    const near=specs.length<23;
    const x=randomBetween(random,near?-19:-38,near?19:38);
    const z=randomBetween(random,near?-43:-112,near?-13:-36);
    if(z>-26&&Math.abs(x)<2.3)continue;
    if(specs.some(s=>Math.hypot(s.x-x,s.z-z)<(near?4.1:5.2)))continue;
    const height=randomBetween(random,16.0,28.0);
    specs.push({x,z,height,radius:height*randomBetween(random,.014,.022)});
  }
  const nearWood=new Surface(),farWood=new Surface(),nearLeaves=new Surface(),farLeaves=new Surface();
  specs.forEach((spec,i)=>{
    const shadows=Math.hypot(spec.x+.8,spec.z+1.6)<14;
    tree(spec,i+1,shadows?nearWood:farWood,shadows?nearLeaves:farLeaves,seed,heightAt);
  });
  const bark=barkMaterial(seed),foliar=foliageMaterial();
  const batches=[
    {surface:nearWood,material:bark,name:'near-trunks-roots-branches',shadows:true},
    {surface:farWood,material:bark,name:'distant-trunks-branches',shadows:false},
    {surface:nearLeaves,material:foliar,name:'near-folded-leaves',shadows:true},
    {surface:farLeaves,material:foliar,name:'distant-leaves',shadows:false},
  ];
  for(const batch of batches) {
    const mesh=new Mesh(batch.surface.geometry(),batch.material);
    mesh.name=`living-forest-${batch.name}`;
    mesh.castShadow=batch.shadows;mesh.receiveShadow=true;
    group.add(mesh);
  }
  group.userData.forest={trees:specs.length,
    triangles:batches.reduce((sum,batch)=>sum+batch.surface.indices.length/3,0),
    shadowTriangles:(nearWood.indices.length+nearLeaves.indices.length)/3,
    leafVertices:(nearLeaves.positions.length+farLeaves.positions.length)/3,drawCalls:4,generatedTextures:3};
  return {group,treeCount:specs.length};
}
