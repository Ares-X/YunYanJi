import {
  DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping,
  RGBAFormat, UnsignedByteType,
} from 'three';
import { createRandom, randomBetween } from '../../core/random';

const WIDTH=512,HEIGHT=1024;
export const BARK_WIDTH_METRES=1.20;
export const BARK_HEIGHT_METRES=2.40;
interface BarkPixels { albedo:Uint8Array;normal:Uint8Array;roughness:Uint8Array; }
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
    heights[i]=.0007+granules*.00045+fine*.00055;
    tone[i]=.59+granules*.025+fine*.025+broad*.030;
    lichen[i]=smooth(.48,.76,noise(u,v,5,7)*.67+noise(u,v,14,23)*.33)
      *smooth(.38,.79,granules*.77+fine*.23);
  }
  // Broad longitudinal growth plates have unrelated widths and lifetimes.
  // Some split after a few centimetres, others continue for thirty; there is
  // no equally spaced column/row lattice to become a pattern of short dashes.
  let boundary=-48;
  while(boundary<WIDTH+48) {
    const columnWidth=randomBetween(random,12,42);
    const columnCenter=boundary+columnWidth*.5;
    let y=randomBetween(random,-180,-25);
    const phase=random()*Math.PI*2;
    while(y<HEIGHT+180) {
      const tall=random()<.24?randomBetween(random,18,43):randomBetween(random,52,155);
      const wide=columnWidth*randomBetween(random,.70,1.45);
      const cx=columnCenter+Math.sin(y*.007+phase)*8.4+Math.sin(y*.023-phase)*2.1
        +randomBetween(random,-3,3);
      const cy=y+tall*.5,slant=randomBetween(random,-.16,.16);
      const crest=randomBetween(random,.0018,.0068);
      const colour=randomBetween(random,.84,1.05);
      const edgePhase=random()*19,peel=random()<.17;
      const bevel=randomBetween(random,1.6,4.2);
      for(let py=Math.floor(cy-tall*.62-4);py<=Math.ceil(cy+tall*.62+4);py++) {
        const vertical=(py-cy)/(tall*.5);
        const endTaper=1-.18*Math.pow(Math.abs(vertical),1.7);
        for(let px=Math.floor(cx-wide*.75-9);px<=Math.ceil(cx+wide*.75+9);px++) {
          const warpedX=px-cx-slant*(py-cy);
          const edgeWave=Math.sin(py*.29+edgePhase)*1.0+Math.sin(py*.69+edgePhase*2.1)*.45;
          const sideDistance=wide*.5*endTaper+edgeWave-Math.abs(warpedX);
          const endDistance=tall*.5+Math.sin(px*.43+edgePhase)*1.6-Math.abs(py-cy);
          const edge=Math.min(sideDistance,endDistance);
          if(edge<0)continue;
          const i=wrap(py,HEIGHT)*WIDTH+wrap(px,WIDTH);
          const granule=(hash(wrap(px,WIDTH),wrap(py,HEIGHT))-.5)*.00034;
          const edgeWeight=smooth(0,bevel,edge);
          const cup=.0008*(1-vertical*vertical)-.0005*Math.abs(warpedX)/(wide*.5);
          const curl=peel?.0026*smooth(.12,.8,vertical)*smooth(0,.5,1-Math.abs(warpedX)/(wide*.5)):0;
          const h=.001+(crest+cup+curl+granule-.001)*edgeWeight;
          if(h>heights[i]!) {
            const chipped=noise(wrap(px,WIDTH)/WIDTH,wrap(py,HEIGHT)/HEIGHT,83,109);
            heights[i]=h+(chipped-.5)*.00050;
            tone[i]=tone[i]!*(1-edgeWeight)+(colour+(chipped-.5)*.085)*edgeWeight;
          }
        }
      }
      y+=tall*randomBetween(random,.70,.96);
    }
    boundary+=columnWidth;
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
  return{albedo,normal:normals,roughness};
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
