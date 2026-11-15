import {
  DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping,
  RGBAFormat, UnsignedByteType,
} from 'three';
import { createRandom, randomBetween } from '../../core/random';

const WIDTH=512,HEIGHT=1024;
const TAU=Math.PI*2;
export const BARK_WIDTH_METRES=1.20;
export const BARK_HEIGHT_METRES=2.40;
interface BarkPixels { albedo:Uint8Array;normal:Uint8Array;roughness:Uint8Array;heights:Float32Array; }
let cached:{seed:string;pixels:BarkPixels}|undefined;
const saturate=(x:number)=>Math.max(0,Math.min(1,x));
const smooth=(a:number,b:number,x:number)=>{const t=saturate((x-a)/(b-a));return t*t*(3-2*t);};
const wrap=(x:number,size:number)=>(x%size+size)%size;

/** A tileable growth surface, expressed in metres and generated once per seed. */
function growBark(seed:string):BarkPixels {
  const random=createRandom(`${seed}/bark-growth`);
  const salt=Math.floor(random()*0x7fffffff);
  const hash=(x:number,y:number)=>{
    let h=Math.imul(x,374761393)+Math.imul(y,668265263)+salt;
    h=Math.imul(h^(h>>>13),1274126177);
    return ((h^(h>>>16))>>>0)/4294967296;
  };
  const noise=(u:number,v:number,nx:number,ny:number)=>{
    const x=u*nx,y=v*ny,ix=Math.floor(x),iy=Math.floor(y);
    const fx=smooth(0,1,x-ix),fy=smooth(0,1,y-iy);
    const sample=(dx:number,dy:number)=>hash(wrap(ix+dx,nx),wrap(iy+dy,ny));
    return (sample(0,0)*(1-fx)+sample(1,0)*fx)*(1-fy)
      +(sample(0,1)*(1-fx)+sample(1,1)*fx)*fy;
  };
  const heights=new Float32Array(WIDTH*HEIGHT);
  const tone=new Float32Array(WIDTH*HEIGHT);
  const lichen=new Float32Array(WIDTH*HEIGHT);
  for(let y=0;y<HEIGHT;y++)for(let x=0;x<WIDTH;x++) {
    const u=x/WIDTH,v=y/HEIGHT,i=y*WIDTH+x;
    const granules=noise(u,v,192,384),fine=noise(u,v,71,139),broad=noise(u,v,9,12);
    const grownU=u+(noise(u,v,5,9)-.5)*.047;
    const longitudinal=noise(grownU,v,29,11)*.73+noise(grownU,v,57,23)*.27;
    const ridge=smooth(.23,.77,longitudinal);
    heights[i]=.0015+ridge*.0036+granules*.00040+fine*.00045;
    tone[i]=.73+ridge*.12+granules*.035+fine*.025+broad*.045;
    lichen[i]=smooth(.48,.76,noise(u,v,5,7)*.67+noise(u,v,14,23)*.33)
      *smooth(.38,.79,granules*.77+fine*.23);
  }
  // Local broken plates interrupt the older longitudinal growth surface.
  // They occupy only part of it, avoiding an all-over fish-scale cover.
  for(let scale=0;scale<610;scale++) {
    const cx=random()*WIDTH,cy=random()*HEIGHT;
    const wide=randomBetween(random,11,36),tall=randomBetween(random,24,87);
    const rotation=randomBetween(random,-.30,.30),co=Math.cos(rotation),si=Math.sin(rotation);
    const vertices=7;
    const outline=Array.from({length:vertices},(_,i)=>{
      const angle=i/vertices*Math.PI*2;
      const growth=randomBetween(random,.80,1.12);
      return{x:Math.cos(angle)*wide*.5*growth,y:Math.sin(angle)*tall*.5*growth};
    });
    const crest=randomBetween(random,.0036,.0080),colour=randomBetween(random,.82,1.015);
    const bevel=randomBetween(random,1.0,2.7),curl=random()<.14?randomBetween(random,.001,.0028):0;
    const extent=Math.ceil(Math.hypot(wide,tall)*.60+3);
    for(let py=Math.floor(cy-extent);py<=cy+extent;py++)for(let px=Math.floor(cx-extent);px<=cx+extent;px++) {
      const xx=(px-cx)*co+(py-cy)*si,yy=-(px-cx)*si+(py-cy)*co;
      let edge=Infinity;
      for(let i=0;i<vertices;i++) {
        const a=outline[i]!,b=outline[(i+1)%vertices]!;
        const ex=b.x-a.x,ey=b.y-a.y;
        edge=Math.min(edge,(ex*(yy-a.y)-ey*(xx-a.x))/Math.hypot(ex,ey));
      }
      if(edge<=0)continue;
      const x=wrap(px,WIDTH),y=wrap(py,HEIGHT),i=y*WIDTH+x;
      const granules=noise(x/WIDTH,y/HEIGHT,193,317);
      const chipped=noise(x/WIDTH,y/HEIGHT,77,101);
      const edgeWeight=smooth(0,bevel,edge);
      const lip=curl*smooth(.08,.80,yy/(tall*.5))*(1-Math.min(1,Math.abs(xx)/(wide*.6)));
      const h=.0012+(crest+lip+(chipped-.5)*.0012+(granules-.5)*.00040-.0012)*edgeWeight;
      if(h>heights[i]!) {
        heights[i]=h;
        tone[i]=tone[i]!*(1-edgeWeight)+(colour+(chipped-.5)*.10+(granules-.5)*.04)*edgeWeight;
      }
    }
  }
  // Unequal, winding longitudinal fissures occasionally divide. Their width,
  // depth and direction change with growth, and their ends feather into the
  // surface. Nothing partitions the tile into long rectangular boards.
  const crease=(cx:number,cy:number,length:number,slope:number,width:number,depth:number,phase:number)=>{
    const wander=randomBetween(random,3.5,10.5);
    const centerAt=(row:number)=>cx+slope*row+(Math.sin(row/length*4.8+phase)-Math.sin(phase))*wander
      +(Math.sin(row/length*15.1-phase)+Math.sin(phase))*wander*.21;
    for(let row=0;row<=Math.ceil(length);row++) {
      const t=row/length;
      const center=centerAt(row);
      const fade=Math.pow(Math.max(0,Math.sin(Math.PI*t)),.38);
      const w=width*(.55+noise(t,phase*.037,19,7)*1.05);
      const y=wrap(Math.round(cy+row),HEIGHT);
      for(let px=Math.floor(center-w*2.4-1);px<=center+w*2.4+1;px++) {
        const x=wrap(px,WIDTH),i=y*WIDTH+x;
        const d=(px-center)/Math.max(.6,w),cut=Math.exp(-d*d*1.9)*fade;
        heights[i]=Math.max(.00035,heights[i]!-depth*cut);
        const humid=.59+noise(x/WIDTH,y/HEIGHT,29,53)*.075;
        tone[i]=tone[i]!*(1-cut*.78)+humid*cut*.78;
      }
    }
    return centerAt;
  };
  for(let i=0;i<34;i++) {
    const x=random()*WIDTH,y=random()*HEIGHT,length=randomBetween(random,130,410);
    const slope=randomBetween(random,-.055,.055),phase=random()*TAU;
    const width=randomBetween(random,1.1,3.2),depth=randomBetween(random,.0013,.0032);
    const path=crease(x,y,length,slope,width,depth,phase);
    if(random()<.72) {
      const at=randomBetween(random,.25,.74)*length;
      const start=path(at);
      crease(start,y+at,randomBetween(random,48,145),randomBetween(random,-.30,.30),
        width*.55,depth*.68,phase+.7);
    }
  }
  const albedo=new Uint8Array(WIDTH*HEIGHT*4);
  const normals=new Uint8Array(WIDTH*HEIGHT*4);
  const roughness=new Uint8Array(WIDTH*HEIGHT*4);
  // The same granular colonies change colour, roughness and surface height.
  for(let i=0;i<heights.length;i++)heights[i]=heights[i]!+lichen[i]!*.0012;
  const texelX=BARK_WIDTH_METRES/WIDTH,texelY=BARK_HEIGHT_METRES/HEIGHT;
  const occlusionOffsets=[[-5,0],[5,0],[0,-7],[0,7],[-8,-9],[8,-9],[-8,9],[8,9]];
  for(let y=0;y<HEIGHT;y++)for(let x=0;x<WIDTH;x++) {
    const i=y*WIDTH+x,o=i*4;
    const dx=(heights[y*WIDTH+wrap(x+1,WIDTH)]!-heights[y*WIDTH+wrap(x-1,WIDTH)]!)/(2*texelX);
    const dy=(heights[wrap(y+1,HEIGHT)*WIDTH+x]!-heights[wrap(y-1,HEIGHT)*WIDTH+x]!)/(2*texelY);
    const inv=1/Math.sqrt(dx*dx+dy*dy+1),moss=lichen[i]!;
    normals[o]=Math.round((-dx*inv*.5+.5)*255);
    normals[o+1]=Math.round((-dy*inv*.5+.5)*255);
    normals[o+2]=Math.round((inv*.5+.5)*255);normals[o+3]=255;
    const warm=noise(x/WIDTH,y/HEIGHT,11,17);
    // Hemispherical skylight does not expose a tiny normal-map ridge by
    // itself. Crevice visibility is correlated with the actual heightfield:
    // lower pieces receive less indirect light beneath neighbouring scales.
    // The floor remains medium grey-brown, never an ink-black edge stroke.
    let surrounding=0;
    for(const [ox,oy] of occlusionOffsets) {
      surrounding+=heights[wrap(y+oy!,HEIGHT)*WIDTH+wrap(x+ox!,WIDTH)]!;
    }
    const visibility=Math.max(.80,1-Math.max(0,surrounding/8-heights[i]!)*160);
    const shadedTone=tone[i]!*visibility;
    // Packed albedo is a relative multiplier, not sRGB colour; decoding is
    // explicit in the wood shader so vertex tone remains physically modest.
    albedo[o]=Math.round(saturate(shadedTone*(.70+warm*.025))*255);
    albedo[o+1]=Math.round(saturate(shadedTone*(.685+warm*.014))*255);
    albedo[o+2]=Math.round(saturate(shadedTone*(.65+warm*.012))*255);
    albedo[o+3]=Math.round(saturate(moss*2.4)*255);
    const wet=noise(x/WIDTH,y/HEIGHT,7,11);
    const rough=.69+tone[i]!*.09+wet*.085+moss*.20;
    roughness[o]=255;roughness[o+1]=Math.round(saturate(rough)*255);
    roughness[o+2]=255;roughness[o+3]=255;
  }
  return{albedo,normal:normals,roughness,heights};
}

/** Geometry samples the same growth relief used to derive the normal map. */
export function createBarkReliefSampler(seed:string):(u:number,v:number,identity:number)=>number {
  if(cached?.seed!==seed)cached={seed,pixels:growBark(seed)};
  const heights=cached.pixels.heights;
  const sample=(u:number,v:number)=>{
    const x=wrap(u*WIDTH,WIDTH),y=wrap(v*HEIGHT,HEIGHT),ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;
    const a=heights[iy*WIDTH+ix]!,b=heights[iy*WIDTH+wrap(ix+1,WIDTH)]!;
    const c=heights[wrap(iy+1,HEIGHT)*WIDTH+ix]!,d=heights[wrap(iy+1,HEIGHT)*WIDTH+wrap(ix+1,WIDTH)]!;
    return(a*(1-fx)+b*fx)*(1-fy)+(c*(1-fx)+d*fx)*fy;
  };
  return(u,v,identity)=>{
    const x=u/BARK_WIDTH_METRES+identity*.4173,y=v/BARK_HEIGHT_METRES+identity*.6197;
    const du=.014/BARK_WIDTH_METRES,dv=.014/BARK_HEIGHT_METRES;
    return(sample(x,y)*2+sample(x-du,y)+sample(x+du,y)+sample(x,y-dv)+sample(x,y+dv))/6-.0033;
  };
}

export function createBarkSurface(seed:string):{albedo:DataTexture;normal:DataTexture;roughness:DataTexture;dispose:()=>void} {
  if(cached?.seed!==seed)cached={seed,pixels:growBark(seed)};
  const texture=(bytes:Uint8Array,name:string)=>{
    const result=new DataTexture(bytes,WIDTH,HEIGHT,RGBAFormat,UnsignedByteType);
    result.name=name;result.wrapS=result.wrapT=RepeatWrapping;
    result.minFilter=LinearMipmapLinearFilter;result.magFilter=LinearFilter;
    result.generateMipmaps=true;result.anisotropy=4;
    result.repeat.set(1/BARK_WIDTH_METRES,1/BARK_HEIGHT_METRES);
    result.needsUpdate=true;return result;
  };
  const albedo=texture(cached.pixels.albedo,'generated-bark-colour-and-moss');
  const normal=texture(cached.pixels.normal,'generated-bark-millimetre-relief');
  const roughness=texture(cached.pixels.roughness,'generated-bark-wet-roughness');
  return{albedo,normal,roughness,dispose:()=>{albedo.dispose();normal.dispose();roughness.dispose();}};
}
