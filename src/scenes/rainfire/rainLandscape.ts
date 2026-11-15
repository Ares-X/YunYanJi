import {
  BoxGeometry, BufferGeometry, CylinderGeometry, DoubleSide, Float32BufferAttribute,
  Group, IcosahedronGeometry, Mesh, MeshStandardMaterial, Vector3, Vector4,
} from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRandom, randomBetween } from '../../core/random';
import { mergeStaticMeshes } from '../snow/mergeStaticMeshes';
import { createRainMaterial } from './rainMaterials';

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
    const near=.055+(broad-.5)*.095+(detail-.5)*.029;
    const edgeVariation=(landNoise(x*1.45+ox,z*1.28+oz)-.5)*.22
      +(landNoise(x*4.8+ox,z*4.9+oz)-.5)*.045;
    const radial=1-((x-.9)/2.4)**2-((z-.3)/2.4)**2+edgeVariation;
    const basin=smooth(-.10,.46,radial);
    const irregular=.018*(landNoise(x*3.8+ox,z*4.3+oz)-.5)*smooth(0,.7,basin);
    const hearth=.15*Math.exp(-((x-FIRE_X)**2+(z-FIRE_Z)**2)/1.65);
    const edgeHills=smooth(8,34,Math.abs(x))*(1.4+4.4*landNoise(x*.063+ox,z*.059+oz));
    const deepForest=smooth(15,95,-z)*(1.7+2.0*landNoise(x*.048+ox,z*.04+oz));
    const ridge=smooth(65,155,-z)*(3+7*landNoise(x*.023+ox,z*.028+oz));
    return near-basin*.13+irregular+hearth+edgeHills+deepForest+ridge;
  };
}

function groundGeometry(height:(x:number,z:number)=>number):BufferGeometry {
  const cols=220,rows=230,position:number[]=[],index:number[]=[];
  for(let row=0;row<=rows;row++) {
    const v=row/rows,z=12-Math.pow(v,1.75)*194;
    for(let col=0;col<=cols;col++) {
      const u=col/cols*2-1,x=Math.sign(u)*Math.pow(Math.abs(u),1.6)*85;
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
    const erosion=(landNoise(x*4.2+phase,y*3.8+z*2.9)-.5)*.18
      +(landNoise(x*8.2-y*2.2,z*9.1+phase)-.5)*.055;
    const slope=1+.10*x-.06*z+erosion;
    positions.setXYZ(i,x*scale.x*slope,y*scale.y*(.93+erosion*.8)+scale.y*.07*x,z*scale.z*slope);
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

/** The high roof is deliberately only an edge in the seated view. */
function shelter(seed:string,height:(x:number,z:number)=>number,wood:MeshStandardMaterial):Group {
  const group=new Group();group.name='rough-timber-rain-shelter';
  const random=createRandom(`${seed}/shelter`);
  const roofY=(z:number)=>4.63-(z-SHELTER.y)*.137;
  const left=SHELTER.x+.15,right=SHELTER.z-.10,front=SHELTER.y+.16,back=SHELTER.w-.1;
  group.add(timberBetween(new Vector3(left,height(left,front)-.18,front),new Vector3(left+.10,roofY(front)+.15,front),.15,wood,1.2));
  group.add(timberBetween(new Vector3(left,roofY(front),front),new Vector3(right,roofY(front)-.04,front),.115,wood,2.9));
  group.add(timberBetween(new Vector3(left,roofY(back),back),new Vector3(left,roofY(front),front),.10,wood,1.7));
  group.add(timberBetween(new Vector3(right,roofY(back),back),new Vector3(right,roofY(front),front),.10,wood,3.1));
  for(let z=front+.8;z<back;z+=2.0) {
    group.add(timberBetween(new Vector3(left,roofY(z)-.07,z),new Vector3(right,roofY(z)-.07,z),.055,wood,z));
  }
  // Narrow irregular boards have real thickness and small joints between them.
  const boardCount=35;
  for(let i=0;i<boardCount;i++) {
    const x=SHELTER.x+(i+.5)/boardCount*(SHELTER.z-SHELTER.x);
    const z=(front+back)*.5+randomBetween(random,-.06,.06);
    const board=new Mesh(new BoxGeometry((SHELTER.z-SHELTER.x)/boardCount-.009,.042,back-front+.3,1,1,12),wood);
    const positions=board.geometry.getAttribute('position');
    for(let j=0;j<positions.count;j++) {
      const zz=positions.getZ(j);
      positions.setY(j,positions.getY(j)-zz*.137+Math.sin(zz*.9+i*1.3)*.009);
    }
    board.geometry.computeVertexNormals();
    board.position.set(x,roofY(z)+.12+randomBetween(random,-.012,.012),z);
    board.castShadow=board.receiveShadow=true;group.add(board);
  }
  return group;
}

function grass(seed:string,height:(x:number,z:number)=>number):Mesh {
  const random=createRandom(`${seed}/wet-grass`),position:number[]=[],index:number[]=[];
  const spots=[[-4.4,-1.0],[4.3,-2.4],[4.9,-6.8],[-5.7,-6.2],[-3.4,-11.4],[6.3,1.7],[-5.2,4.1],[8.8,-15.8]];
  for(const spot of spots)for(let blade=0;blade<22;blade++) {
    const x=spot[0]!+randomBetween(random,-.43,.43),z=spot[1]!+randomBetween(random,-.38,.38);
    const y=height(x,z)-.02,angle=random()*Math.PI*2,length=randomBetween(random,.19,.57),width=randomBetween(random,.004,.014);
    const first=position.length/3;
    for(let row=0;row<=4;row++) {
      const t=row/4,lean=t*t*length*.55;
      for(const sign of [-1,1])position.push(x+Math.cos(angle)*lean-Math.sin(angle)*width*sign*(1-t),y+Math.sin(t*1.6)*length,z+Math.sin(angle)*lean+Math.cos(angle)*width*sign*(1-t));
      if(row<4){const a=first+row*2;index.push(a,a+1,a+2,a+1,a+3,a+2);}
    }
  }
  const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute(position,3));geometry.setIndex(index);geometry.computeVertexNormals();
  const mesh=new Mesh(geometry,new MeshStandardMaterial({color:0x33432e,roughness:.61,side:DoubleSide}));
  mesh.name='wet-grass-at-clearing-edge';mesh.receiveShadow=true;mesh.castShadow=false;return mesh;
}

export function buildRainLandscape(seed:string):RainLandscape {
  const group=new Group();group.name='wet-forest-clearing';
  const height=createRainHeight(seed);
  const earth=createRainMaterial('earth',seed),stone=createRainMaterial('stone',seed),wood=createRainMaterial('timber',seed);
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
  group.add(grass(seed,height));
  return {group,height,firePosition:new Vector3(FIRE_X,height(FIRE_X,FIRE_Z)+.006,FIRE_Z)};
}
