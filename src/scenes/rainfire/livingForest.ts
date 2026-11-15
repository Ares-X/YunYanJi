import {
  BufferGeometry, CatmullRomCurve3, Color, DoubleSide, Float32BufferAttribute, Group, Mesh,
  MeshStandardMaterial, Vector3,
} from 'three';
import { createRandom, randomBetween } from '../../core/random';
import { BARK_WIDTH_METRES, BARK_HEIGHT_METRES, createBarkReliefSampler, createBarkSurface } from './barkSurface';
import { growSpaceTree } from './forestGrowth';
import { createForestWind } from './forestWind';
import { forestFireShadowBounds, limitForestFireShadows } from './forestFireShadows';
import { FIRE_X, FIRE_Z } from './rainLandscape';
import type { EnvironmentSnapshot } from '../../core/types';

const UP = new Vector3(0, 1, 0);
const VIEWPOINT = new Vector3(1, 1.25, 4.5);
const TAU = Math.PI * 2;
type Curve = (t: number) => Vector3;
type Height = (x: number, z: number) => number;

/** Forest batches are authored directly in world metres; no foliage billboards. */
class Surface {
  positions: number[] = [];
  uv: number[] = [];
  colors: number[] = [];
  identity: number[] = [];
  rootHeights: number[] = [];
  windRoots: number[] = [];
  windAnchors: number[] = [];
  indices: number[] = [];
  rootHeight = 0;
  rootX = 0;
  rootZ = 0;
  treeHeight = 1;
  leafAnchor = new Vector3();
  leafOpenness = 0;
  groundAt?: Height;
  barkRelief?: (u:number,v:number,identity:number)=>number;
  vertex(p: Vector3, u: number, v: number, color: Color, identity: number): number {
    const at = this.positions.length / 3;
    this.positions.push(p.x, p.y, p.z);
    this.uv.push(u, v);
    this.colors.push(color.r, color.g, color.b);
    this.identity.push(identity);
    this.rootHeights.push(this.rootHeight);
    this.windRoots.push(this.rootX, this.rootHeight, this.rootZ, this.treeHeight);
    this.windAnchors.push(this.leafAnchor.x, this.leafAnchor.y, this.leafAnchor.z, this.leafOpenness);
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
    g.setAttribute('aForestWindRoot', new Float32BufferAttribute(this.windRoots, 4));
    g.setAttribute('aForestWindAnchor', new Float32BufferAttribute(this.windAnchors, 4));
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
  segments: number, sides: number, identity: number, color: Color, buttressed = false, collar = 0, radiusAt?: (t:number)=>number, cap = true): void {
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
    const taper = radiusAt ? radiusAt(t) : terminal + (radius - terminal)*Math.pow(1-t,buttressed?.78:.9)*baseProfile;
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
      const relief=buttressed&&segments>200&&surface.barkRelief
        ? surface.barkRelief(sector/sides*TAU*radius,t*length,identity) : 0;
      const r=taper*fluting*swell*shoulder+foot+nodule+relief;
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
  if(cap) {
    const end = surface.vertex(curve(1), 0, length, color, identity);
    const last = first + segments * stride;
    for (let side = 0; side < sides; side++) surface.triangle(end, last + side + 1, last + side);
  }
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
        vForestPosition=(modelMatrix*vec4(transformed,1.0)).xyz;
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
        diffuseColor.rgb*=mix(vec3(1),vec3(.65,.64,.61),damp*.67);
        float rootPatch=growthPatch(vForestPosition.xz*1.7+vec2(.17,.83));
        float moss=barkSample.a*(1.0-smoothstep(.22,1.8,rootDistance))
          *smoothstep(.28,.67,rootPatch);
        vec3 colony=vec3(.037,.060,.023)*(0.80+barkSample.g*.57);
        diffuseColor.rgb=mix(diffuseColor.rgb,colony,moss*.75);
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor=clamp(roughnessFactor-damp*.08+moss*.06,.58,.98);`);
  };
  material.customProgramCacheKey = () => 'living-forest-grown-bark-v7';
  return material;
}

function foliageMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color: 0xffffff, vertexColors: true,
    side: DoubleSide, roughness: .57, metalness: 0, dithering: true });
  material.name = 'living-forest-individual-leaves';
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aForestIdentity;
        varying vec2 vLeafUv;
        varying float vLeafIdentity;
        varying float vLeafOpenness;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLeafUv=uv;vLeafIdentity=aForestIdentity;
        vLeafOpenness=aForestWindAnchor.w;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vLeafUv;
        varying float vLeafIdentity;
        varying float vLeafOpenness;`)
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        float span=abs(vLeafUv.x-.5);
        float aa=max(.002,fwidth(vLeafUv.x));
        float midrib=1.0-smoothstep(.008,.008+aa,span);
        float ribs=abs(fract(vLeafUv.y*9.0-span*4.7+vLeafIdentity*.7)-.5);
        float veins=(1.0-smoothstep(.018,.018+aa*2.0,ribs))*(1.0-span*1.5);
        diffuseColor.rgb*=.80+vLeafUv.y*.18+midrib*.11+veins*.045;
      `)
      .replace('#include <lights_fragment_end>', /* glsl */ `
        #include <lights_fragment_end>
        // A leaf inside a crown sees less sky than one on its outside. This
        // controls only indirect light; real shadows still control direct light.
        float skyVisibility=mix(.28,1.0,vLeafOpenness);
        reflectedLight.indirectDiffuse*=skyVisibility;
        reflectedLight.indirectSpecular*=mix(.45,1.0,vLeafOpenness);
        #if NUM_DIR_LIGHTS > 0
          float leafShadow=1.0;
          #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
            DirectionalLightShadow leafSun=directionalLightShadows[0];
            leafShadow=receiveShadow?getShadow(directionalShadowMap[0],leafSun.shadowMapSize,
              leafSun.shadowIntensity,leafSun.shadowBias,leafSun.shadowRadius,vDirectionalShadowCoord[0]):1.0;
          #endif
          float transmitted=pow(max(0.0,dot(-geometryNormal,directionalLights[0].direction)),1.5);
          float forwardScatter=pow(max(0.0,dot(-geometryViewDir,directionalLights[0].direction)),3.0);
          vec3 thinLeaf=diffuseColor.rgb*vec3(.86,1.16,.68);
          reflectedLight.directDiffuse+=thinLeaf*directionalLights[0].color*leafShadow
            *transmitted*(.19+forwardScatter*.12)*mix(.55,1.0,vLeafOpenness);
        #endif
      `);
  };
  material.customProgramCacheKey = () => 'living-forest-leaf-v2';
  return material;
}

function leaf(surface: Surface, root: Vector3, direction: Vector3, length: number,
  width: number, roll: number, color: Color, identity: number, detailed: boolean): void {
  surface.leafAnchor.copy(root);
  const heightFraction=Math.max(0,(root.y-surface.rootHeight)/surface.treeHeight);
  const radial=Math.hypot(root.x-surface.rootX,root.z-surface.rootZ)/Math.max(1.2,surface.treeHeight*.29);
  surface.leafOpenness=Math.max(.18,Math.min(1,.18+radial*.78+heightFraction*.38));
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

/** A complete space-colonized tree, including crown regions outside the starting view. */
function tree(spec:TreeSpec,identity:number,wood:Surface,leaves:Surface,seed:string,heightAt:Height):void {
  const random=createRandom(`${seed}/grown-tree/${identity}`);
  const distance=Math.hypot(spec.x-1,spec.z-4.5),near=distance<20,far=distance>48;
  const hero=Boolean(spec.young)&&(identity===5||identity===6||identity===9);
  const ground=heightAt(spec.x,spec.z)-.055;
  for(const surface of [wood,leaves]) {
    surface.rootHeight=ground+.055;
    surface.rootX=spec.x;surface.rootZ=spec.z;surface.treeHeight=spec.height;
  }
  wood.groundAt=heightAt;
  const growth=growSpaceTree(`${seed}/tree-${identity}`,{
    height:spec.height,radius:spec.radius,
    crownBase:spec.height*(spec.young?randomBetween(random,.19,.28):randomBetween(random,.34,.45)),
    spread:spec.height*(spec.young?randomBetween(random,.34,.43):randomBetween(random,.21,.29)),
    coarsePoints:hero?320:far?130:220,finePoints:hero?1600:far?320:850,
    maxNodes:hero?2400:far?650:1200,
    lightX:-spec.x/Math.max(8,Math.abs(spec.x))*.75,lightZ:.25,
  });
  const world=(i:number)=>{
    const p=growth.nodes[i]!.point;
    return new Vector3(spec.x+p.x,ground+p.y,spec.z+p.z);
  };
  const radius=(i:number)=>{
    const node=growth.nodes[i]!;
    return node.radius*(.79+.21*Math.exp(-node.point.y*.60));
  };
  const woodColor=new Color(spec.young?0x716d5a:0x625749).multiplyScalar(randomBetween(random,.84,1.04));
  for(const chain of growth.chains){
    const root=chain[0]!,tip=chain[chain.length-1]!;
    const points=chain.map(world);
    const curve=new CatmullRomCurve3(points,false,'centripetal');
    const firstRadius=root===0?radius(root):Math.min(radius(root),radius(chain[1]!)*1.32);
    const radii=chain.map((id,i)=>i===0?firstRadius:radius(id));
    const radiusAt=(t:number)=>{
      const n=t*(radii.length-1),at=Math.min(radii.length-2,Math.floor(n)),fraction=n-at;
      return radii[at]!*(1-fraction)+radii[at+1]!*fraction;
    };
    const primary=root===0;
    const maxRadius=Math.max(...radii);
    // Millimetre twigs at tens of metres are smaller than a pixel in every
    // permitted view. Keep their graph and leaves, omit only their tube mesh.
    if(distance>25&&maxRadius<.0045)continue;
    const sides=primary&&near&&!spec.young?120:maxRadius>.09?(near?16:10):maxRadius>.018?(near?9:6):far?4:5;
    const segments=primary&&near&&!spec.young?224:Math.max(1,Math.ceil((chain.length-1)*(maxRadius>.025&&near?1.45:1)));
    const shade=growth.nodes[tip]!.dead?.81:1;
    tube(wood,t=>curve.getPoint(t),firstRadius,radii[radii.length-1]!,segments,sides,
      identity+root*.00001,woodColor.clone().multiplyScalar(shade),primary,0,radiusAt,!growth.nodes[tip]!.children.length);
  }
  // Surface roots follow the terrain. Their shoulders grow continuously from
  // the basal bole; distal ends descend below soil rather than resting on it.
  if(near&&!spec.young)for(let i=0;i<5;i++){
    const angle=random()*TAU,length=spec.radius*randomBetween(random,1.65,3.0);
    const direction=new Vector3(Math.cos(angle),0,Math.sin(angle)),side=direction.clone().cross(UP);
    const start=world(0).addScaledVector(UP,.11).addScaledVector(direction,spec.radius*.18);
    const end=new Vector3(spec.x+direction.x*length,0,spec.z+direction.z*length);
    end.y=heightAt(end.x,end.z)-.13;
    const a=start.clone().addScaledVector(direction,length*.36).addScaledVector(side,randomBetween(random,-.22,.22));
    a.y=heightAt(a.x,a.z)+randomBetween(random,.055,.15);
    const b=end.clone().addScaledVector(direction,-length*.26);b.y=heightAt(b.x,b.z)-.025;
    tube(wood,cubic(start,a,b,end),spec.radius*randomBetween(random,.22,.31),.003,14,12,identity,woodColor);
  }
  // Leaf initiation is tied to thin current-season internodes, continuously
  // along each twig. There are no arbitrary balls or cards placed at tips.
  for(let i=1;i<growth.nodes.length;i++){
    const node=growth.nodes[i]!;
    if(node.dead||node.flow>(far?3:7)||node.born<100&&node.remaining>.16)continue;
    const a=world(node.parent),b=world(i),axis=b.clone().sub(a),length=axis.length();
    if(length<.012)continue;axis.normalize();
    let side=axis.clone().cross(UP);if(side.lengthSq()<.001)side.set(1,0,0);else side.normalize();
    const upper=side.clone().cross(axis).normalize();
    const steps=Math.max(1,Math.ceil(length/(far?.068:hero?.038:.048)));
    const twist=i*2.399+identity*.73;
    for(let k=0;k<steps;k++)for(let pair=0;pair<2;pair++){
      const t=(k+randomBetween(random,.12,.90))/steps;
      const attach=a.clone().lerp(b,t);
      const phi=twist+k*2.399+pair*Math.PI+randomBetween(random,-.24,.24);
      const out=axis.clone().multiplyScalar(randomBetween(random,.14,.42))
        .addScaledVector(side,Math.cos(phi)*.93).addScaledVector(upper,Math.sin(phi)*.62)
        .addScaledVector(UP,-.10).normalize();
      const size=randomBetween(random,.095,.17)*(spec.young?1.04:1);
      const color=new Color().setRGB(.065,.107,.037).multiplyScalar(randomBetween(random,.67,1.24));
      if(random()<.035)color.setRGB(.11,.106,.044);
      const detailed=attach.distanceToSquared(VIEWPOINT)<400;
      leaf(leaves,attach,out,size,size*randomBetween(random,.53,.76),randomBetween(random,-.62,.62),
        color,random()*37,detailed);
    }
  }
}

/**
 * Mature mixed woodland, built as six opaque geometry batches. Individual
 * folded leaves have centimetre-scale silhouettes; no repeated alpha cards
 * determine the near forest outline. All materials and geometry are owned by
 * the returned group and may be released by the scene's normal traversal.
 */
export function buildLivingForest(seed:string,heightAt:Height):{
  group:Group;treeCount:number;update:(frame:EnvironmentSnapshot)=>void;
  setEnvironmentCapture:(enabled:boolean)=>void;dispose:()=>void;
} {
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
  const nearWood=new Surface(),middleWood=new Surface(),farWood=new Surface();
  const nearLeaves=new Surface(),middleLeaves=new Surface(),farLeaves=new Surface();
  nearWood.barkRelief=createBarkReliefSampler(seed);
  specs.forEach((spec,i)=>{
    const distance=Math.hypot(spec.x+.8,spec.z+1.6);
    const wood=distance<14?nearWood:distance<36?middleWood:farWood;
    const leaves=distance<14?nearLeaves:distance<36?middleLeaves:farLeaves;
    tree(spec,i+1,wood,leaves,seed,heightAt);
  });
  const bark=barkMaterial(seed),foliar=foliageMaterial(),wind=createForestWind();
  wind.install(bark);wind.install(foliar);
  foliar.addEventListener('dispose',wind.dispose);
  const batches=[
    {surface:nearWood,material:bark,name:'near-trunks-roots-branches',shadows:true,fire:true},
    {surface:middleWood,material:bark,name:'middle-trunks-branches',shadows:true,fire:false},
    {surface:farWood,material:bark,name:'distant-trunks-branches',shadows:false,fire:false},
    {surface:nearLeaves,material:foliar,name:'near-folded-leaves',shadows:true,fire:true},
    {surface:middleLeaves,material:foliar,name:'middle-folded-leaves',shadows:true,fire:false},
    {surface:farLeaves,material:foliar,name:'distant-leaves',shadows:false,fire:false},
  ];
  const fireBounds=forestFireShadowBounds(new Vector3(FIRE_X,heightAt(FIRE_X,FIRE_Z)+.006,FIRE_Z));
  let fireShadowTriangles=0;
  for(const batch of batches) {
    const mesh=new Mesh(batch.surface.geometry(),batch.material);
    mesh.name=`living-forest-${batch.name}`;
    mesh.castShadow=batch.shadows;mesh.receiveShadow=true;
    mesh.userData.fireShadow=batch.fire;
    wind.attach(mesh);
    if(batch.fire)fireShadowTriangles+=limitForestFireShadows(mesh,fireBounds);
    group.add(mesh);
  }
  group.userData.forest={trees:specs.length,
    triangles:batches.reduce((sum,batch)=>sum+batch.surface.indices.length/3,0),
    shadowTriangles:batches.reduce((sum,batch)=>sum+(batch.shadows?batch.surface.indices.length/3:0),0),
    fireShadowTriangles,
    fireShadowSourceTriangles:(nearWood.indices.length+nearLeaves.indices.length)/3,
    leafVertices:(nearLeaves.positions.length+middleLeaves.positions.length+farLeaves.positions.length)/3,
    drawCalls:6,generatedTextures:3};
  return {group,treeCount:specs.length,update:wind.update,
    setEnvironmentCapture:wind.setEnvironmentCapture,dispose:wind.dispose};
}
