import {
  BufferGeometry, CatmullRomCurve3, CylinderGeometry, DoubleSide, Float32BufferAttribute,
  Group, IcosahedronGeometry, Mesh, MeshStandardMaterial, TubeGeometry, Vector3, Vector4,
} from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRandom, randomBetween } from '../../core/random';
import { mergeStaticMeshes } from '../snow/mergeStaticMeshes';
import { createRainMaterial } from './rainMaterials';
import { createEarthMaterial } from './earthMaterials';

/** Roof outline in world X/Z, shared with rain and ripple generation. */
export const SHELTER = new Vector4(-3.65, -3.15, 2.85, 6.6);
export const PUDDLE_LEVEL = -0.018;
export const FIRE_X = -.8, FIRE_Z = -1.6;

const smooth = (from:number,to:number,value:number) => {
  const t=Math.max(0,Math.min(1,(value-from)/(to-from))); return t*t*(3-2*t);
};
function hash(x:number,z:number):number {
  let h=Math.imul(x,374761393)+Math.imul(z,668265263);
  h=Math.imul(h^(h>>>13),1274126177);
  return ((h^(h>>>16))>>>0)/4294967296;
}
export function landNoise(x:number,z:number):number {
  const ix=Math.floor(x),iz=Math.floor(z),tx=smooth(0,1,x-ix),tz=smooth(0,1,z-iz);
  return (hash(ix,iz)*(1-tx)+hash(ix+1,iz)*tx)*(1-tz)
    +(hash(ix,iz+1)*(1-tx)+hash(ix+1,iz+1)*tx)*tz;
}

export interface RainLandscape {
  group:Group;
  height(x:number,z:number):number;
  firePosition:Vector3;
}

/** One continuous height field also places every stone, trunk and the hearth. */
export function createRainHeight(seed:string):(x:number,z:number)=>number {
  const random=createRandom(`${seed}/rain-ground`);
  const ox=random()*180,oz=random()*180;
  return (x,z) => {
    const broad=landNoise(x*.115+ox,z*.11+oz);
    const detail=landNoise(x*1.4+ox,z*1.7+oz);
    // Even the lowest dry soil stays above the water plane; only the authored
    // basin can expose water, so none of the plane's rectangular edge appears.
    const near=.095+(broad-.5)*.095+(landNoise(x*.76+ox,z*.83+oz)-.5)*.075+(detail-.5)*.018;
    const edgeVariation=(landNoise(x*1.45+ox,z*1.28+oz)-.5)*.54
      +(landNoise(x*4.8+ox,z*4.9+oz)-.5)*.12;
    const radial=1-((x-.46-.26*Math.sin(z*2.1))/1.05)**2-((z-.05)/1.75)**2+edgeVariation;
    const basin=smooth(-.34,.78,radial);
    // Rain collects in a shallow depression. Blend towards a waterlogged soil
    // floor instead of cutting a steep 23 cm bowl out of the campsite.
    const catchment=.060*Math.exp(-((x-.46)**2/3.4+(z-.05)**2/5.2));
    const wetFloor=PUDDLE_LEVEL-.031+.010*(landNoise(x*3.8+ox,z*4.3+oz)-.5);
    const clearing=(near-catchment)*(1-basin)+wetFloor*basin;
    const hearth=.10*Math.exp(-((x-FIRE_X)**2+(z-FIRE_Z)**2)/1.65);
    const hummocks=.24*Math.exp(-((x+4.3)**2/4+(z+3.2)**2/8))
      +.38*Math.exp(-((x-4.8)**2/3+(z+5.4)**2/6));
    // The clearing is cut into an uneven forest floor. Two offset banks break
    // the view into overlapping root/fern layers instead of a flat display of
    // tree trunks, while a narrow bend remains visible to the right of the fire.
    const forestBanks=(.88*Math.exp(-((x+4.15)**2/5.6+(z+7.0)**2/12.5))
      +.67*Math.exp(-((x+6.25)**2/6.5+(z+11.7)**2/9.0))
      +.58*Math.exp(-((x-4.8)**2/6.0+(z+10.4)**2/11.0))
      +.37*Math.exp(-((x-3.6)**2/3.6+(z+15.4)**2/7.0)))
      *(.80+.38*landNoise(x*.80+ox,z*.72+oz))
      *smooth(2.1,3.8,Math.hypot(x-FIRE_X,z-FIRE_Z));
    // Exposed mud ribs interrupt the reflection instead of making a display pond.
    const mudRib=.045*Math.exp(-((x-1.75)**2/.50+(z-.7)**2/.24))
      +.024*Math.exp(-((x-.24)**2/.16+(z-1.5)**2/.28));
    const edgeHills=smooth(8,34,Math.abs(x))*(1.4+4.4*landNoise(x*.063+ox,z*.059+oz));
    const deepForest=smooth(15,95,-z)*(1.7+2.0*landNoise(x*.048+ox,z*.04+oz));
    const ridge=smooth(65,155,-z)*(3+7*landNoise(x*.023+ox,z*.028+oz));
    return clearing+hearth+hummocks+forestBanks+mudRib+edgeHills+deepForest+ridge;
  };
}

function groundGeometry(height:(x:number,z:number)=>number):BufferGeometry {
  const cols=200,rows=220,position:number[]=[],index:number[]=[];
  for(let row=0;row<=rows;row++) {
    const z=row<=180?12-row/180*30:-18-Math.pow((row-180)/40,1.55)*164;
    for(let col=0;col<=cols;col++) {
      const u=(col-cols/2)/(cols/2);
      const x=Math.sign(u)*(Math.abs(u)<=.8?Math.abs(u)/.8*10:10+Math.pow((Math.abs(u)-.8)/.2,1.6)*75);
      position.push(x,height(x,z),z);
      if(row<rows&&col<cols) {
        const a=row*(cols+1)+col,b=a+1,c=a+cols+1,d=c+1;
        index.push(a,b,c,b,d,c);
      }
    }
  }
  const geometry=new BufferGeometry();
  geometry.setAttribute('position',new Float32BufferAttribute(position,3));
  geometry.setIndex(index);geometry.computeVertexNormals();geometry.computeBoundingSphere();
  return geometry;
}

function rockGeometry(seed:string,scale:Vector3,detail:number):BufferGeometry {
  const random=createRandom(seed),phase=random()*13;
  const primitive=new IcosahedronGeometry(1,detail);
  primitive.deleteAttribute('normal');primitive.deleteAttribute('uv');
  const geometry=mergeVertices(primitive,1e-5);primitive.dispose();
  const positions=geometry.getAttribute('position');
  for(let i=0;i<positions.count;i++) {
    const x=positions.getX(i),y=positions.getY(i),z=positions.getZ(i);
    const erosion=(landNoise(x*3.2+phase,y*3.1+z*2.9)-.5)*.31
      +(landNoise(x*8.2-y*2.2,z*9.1+phase)-.5)*.07;
    const fracture=Math.min(1, .77/Math.max(.01,Math.abs(x*.62+y*.68+z*.33)),
      .82/Math.max(.01,Math.abs(x*-.74+y*.21+z*.64)));
    const slope=(1+.10*x-.06*z+erosion)*fracture;
    positions.setXYZ(i,x*scale.x*slope,y*scale.y*(.93+erosion*.8)*fracture+scale.y*.07*x,z*scale.z*slope);
  }
  geometry.computeVertexNormals();geometry.computeBoundingSphere();
  return geometry;
}

function timberBetween(a:Vector3,b:Vector3,radius:number,material:MeshStandardMaterial,phase:number):Mesh {
  const length=a.distanceTo(b),geometry=new CylinderGeometry(radius*.82,radius,length,14,8);
  const positions=geometry.getAttribute('position');
  for(let i=0;i<positions.count;i++) {
    const x=positions.getX(i),y=positions.getY(i),z=positions.getZ(i);
    const angle=Math.atan2(z,x);
    const uneven=1+.055*Math.sin(angle*7+y*2.1+phase)+.035*Math.sin(angle*13-y*3.1);
    positions.setXYZ(i,x*uneven,y,z*uneven);
  }
  geometry.computeVertexNormals();
  const mesh=new Mesh(geometry,material);
  mesh.position.copy(a).add(b).multiplyScalar(.5);
  mesh.quaternion.setFromUnitVectors(new Vector3(0,1,0),b.clone().sub(a).normalize());
  mesh.castShadow=mesh.receiveShadow=true;return mesh;
}

/** A tensioned, weathered canvas edge, held at four corners outside the view. */
function shelter(seed:string,height:(x:number,z:number)=>number,wood:MeshStandardMaterial):Group {
  const group=new Group();group.name='tensioned-rain-canvas';
  const random=createRandom(`${seed}/shelter`);
  const roofY=(x:number,z:number)=> {
    const u=(x-SHELTER.x)/(SHELTER.z-SHELTER.x),v=(z-SHELTER.y)/(SHELTER.w-SHELTER.y);
    const span=Math.sin(Math.PI*u),longitudinal=Math.sin(Math.PI*v);
    const tension=span*(.16+.24*longitudinal);
    // Wrinkles converge towards the tie-outs; they do not ripple like water.
    const corner=Math.pow(Math.max(0,1-Math.min(u,1-u)*5),3)
      *Math.sin(v*37+u*11)*.006*longitudinal;
    return 4.15-(z-SHELTER.y)*.137-tension+corner;
  };
  const cloth=new MeshStandardMaterial({color:'#45473c',roughness:.88,side:DoubleSide,dithering:true});
  cloth.name='generated-weathered-canvas';
  cloth.onBeforeCompile=shader=>{
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 vCanvasMetres;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nvCanvasMetres=position.xz;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec2 vCanvasMetres;')
      .replace('#include <color_fragment>',`#include <color_fragment>
        float canvasFootprint=max(length(dFdx(vCanvasMetres)),length(dFdy(vCanvasMetres)));
        float canvasDetail=1.0-smoothstep(.002,.009,canvasFootprint);
        vec2 weave=sin(vCanvasMetres*3600.0);
        float fibres=weave.x*weave.y*canvasDetail;
        float stain=.5+.25*sin(vCanvasMetres.x*1.3+sin(vCanvasMetres.y*2.4))
          +.25*sin(vCanvasMetres.y*.8+sin(vCanvasMetres.x*3.1));
        float seam=pow(max(0.0,cos(vCanvasMetres.x*6.3)),160.0);
        diffuseColor.rgb*=.81+stain*.21+fibres*.045-seam*.06;`);
  };
  cloth.customProgramCacheKey=()=> 'tensioned-canvas-v1';
  const positions:number[]=[],indices:number[]=[],cols=44,rows=50;
  for(let row=0;row<=rows;row++)for(let col=0;col<=cols;col++){
    const x=SHELTER.x+col/cols*(SHELTER.z-SHELTER.x),z=SHELTER.y+row/rows*(SHELTER.w-SHELTER.y);
    positions.push(x,roofY(x,z),z);
    if(row<rows&&col<cols){const a=row*(cols+1)+col;indices.push(a,a+1,a+cols+1,a+1,a+cols+2,a+cols+1);}
  }
  const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute(positions,3));
  geometry.setIndex(indices);geometry.computeVertexNormals();
  const canvas=new Mesh(geometry,cloth);canvas.name='sagging-canvas-roof';canvas.castShadow=canvas.receiveShadow=true;group.add(canvas);
  const cord=new MeshStandardMaterial({color:'#59574a',roughness:.93});cord.name='generated-canvas-seams-and-cord';
  const corners=[new Vector3(SHELTER.x,roofY(SHELTER.x,SHELTER.y),SHELTER.y),
    new Vector3(SHELTER.z,roofY(SHELTER.z,SHELTER.y),SHELTER.y),
    new Vector3(SHELTER.z,roofY(SHELTER.z,SHELTER.w),SHELTER.w),
    new Vector3(SHELTER.x,roofY(SHELTER.x,SHELTER.w),SHELTER.w)];
  for(let edge=0;edge<4;edge++){
    const a=corners[edge]!,b=corners[(edge+1)%4]!,path:Vector3[]=[];
    for(let i=0;i<=20;i++){const q=a.clone().lerp(b,i/20);q.y=roofY(q.x,q.z)-.004;path.push(q);}
    const seam=new Mesh(new TubeGeometry(new CatmullRomCurve3(path),40,.009,5,false),cord);
    seam.castShadow=seam.receiveShadow=true;group.add(seam);
    const out=a.clone().add(new Vector3(edge===0||edge===3?-3.5:3.5,-2.6,edge<2?-3:3));
    out.y=height(out.x,out.z)+.06;
    const tie=new Mesh(new TubeGeometry(new CatmullRomCurve3([a,a.clone().lerp(out,.5).add(new Vector3(0,-.035,0)),out]),12,.004,5,false),cord);
    tie.receiveShadow=true;group.add(tie);
  }
  // The supporting sticks sit just outside the main frame; the visible joint
  // tapers and leans instead of forming a rectangular doorway.
  for(const corner of [corners[0]!,corners[2]!]) {
    const base=corner.clone().add(new Vector3(-.35,0,.22));base.y=height(base.x,base.z)-.05;
    const top=corner.clone().add(new Vector3(0,.04,0));
    group.add(timberBetween(base,top,.047,wood,random()*12));
  }
  return group;
}

export function buildRainLandscape(seed:string):RainLandscape {
  const group=new Group();group.name='wet-forest-clearing';
  const height=createRainHeight(seed);
  const earth=createEarthMaterial(seed,PUDDLE_LEVEL),stone=createRainMaterial('stone',seed),wood=createRainMaterial('timber',seed);
  const ground=new Mesh(groundGeometry(height),earth);ground.name='continuous-rain-terrain';ground.receiveShadow=true;group.add(ground);
  const props=new Group();group.add(props);
  const random=createRandom(`${seed}/clearing-stones`);
  const placements:[number,number,number,number,number][]=[
    [-4.2,1.6,1.3,.65,.85],[3.9,4.8,.83,.36,.61],[5.9,-3.8,1.4,.79,.95],
    [-4.5,-7.5,1.0,.55,.81],[3.2,-6.3,.64,.36,.42],[-2.5,2.8,.45,.23,.32],
  ];
  for(let i=0;i<44;i++) {
    const z=randomBetween(random,-28,7),x=randomBetween(random,-11,11);
    if(Math.hypot(x-FIRE_X,z-FIRE_Z)<1.6||Math.hypot(x-.8,z-4.8)<1.1)continue;
    const size=randomBetween(random,.06,.33)*(i%9===0?1.8:1);
    placements.push([x,z,size, size*randomBetween(random,.35,.72),size*randomBetween(random,.66,1.35)]);
  }
  for(let i=0;i<placements.length;i++) {
    const [x,z,rx,ry,rz]=placements[i]!;
    const mesh=new Mesh(rockGeometry(`${seed}/rock/${i}`,new Vector3(rx,ry,rz),i<6?5:2),stone);
    mesh.position.set(x,height(x,z)-ry*.27,z);mesh.rotation.y=random()*Math.PI*2;
    mesh.name='rain-worn-stone';mesh.castShadow=mesh.receiveShadow=true;props.add(mesh);
  }
  // A few fallen branches supply scale without filling the clearing with props.
  for(const [x,z,length,angle] of [[-3.5,-4.8,2.2,.7],[4.6,-9.3,3.1,2.2],[-5.3,3.5,1.3,1.5]]) {
    const a=new Vector3(x!,height(x!,z!)+.04,z!),b=new Vector3(x!+Math.cos(angle!)*length!,0,z!+Math.sin(angle!)*length!);
    b.y=height(b.x,b.z)+.03;props.add(timberBetween(a,b,.055,wood,angle!));
  }
  props.add(shelter(seed,height,wood));
  mergeStaticMeshes(props,new Set());
  return {group,height,firePosition:new Vector3(FIRE_X,height(FIRE_X,FIRE_Z)+.006,FIRE_Z)};
}
