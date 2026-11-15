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
    const granules=noise(u,v,149,271),fine=noise(u,v,41,89),broad=noise(u,v,5,9);
    // Fine pores sit on larger growth tissue. Keeping their height below the
    // plate relief prevents a uniformly gritty normal map from drowning it out.
    heights[i]=.0007+granules*.00014+fine*.00032+broad*.0006;
    tone[i]=.67+granules*.012+fine*.025+broad*.075;
    lichen[i]=smooth(.48,.76,noise(u,v,5,7)*.67+noise(u,v,14,23)*.33)
      *smooth(.38,.79,granules*.77+fine*.23);
  }
  // Broad longitudinal growth plates have unrelated widths and lifetimes.
  // Some split after a few centimetres, others continue for thirty; there is
  // no equally spaced column/row lattice to become a pattern of short dashes.
  let boundary=-48;
  while(boundary<WIDTH+48) {
    const columnWidth=randomBetween(random,18,51);
    const columnCenter=boundary+columnWidth*.5;
    let y=randomBetween(random,-180,-25);
    const phase=random()*Math.PI*2;
    while(y<HEIGHT+180) {
      const tall=random()<.32?randomBetween(random,20,56):randomBetween(random,48,132);
      const wide=columnWidth*randomBetween(random,.70,1.45);
      const cx=columnCenter+Math.sin(y*.010+phase)*columnWidth*.34+Math.sin(y*.029-phase)*3.8
        +randomBetween(random,-wide*.14,wide*.14);
      const cy=y+tall*.5,slant=randomBetween(random,-.22,.22);
      const crest=randomBetween(random,.0030,.0100);
      const colour=randomBetween(random,.81,1.02);
      const edgePhase=random()*19,peel=random()<.28;
      const bevel=randomBetween(random,2.4,5.7);
      for(let py=Math.floor(cy-tall*.62-4);py<=Math.ceil(cy+tall*.62+4);py++) {
        const vertical=(py-cy)/(tall*.5);
        const endTaper=1-.29*Math.pow(Math.abs(vertical),1.5);
        for(let px=Math.floor(cx-wide*.75-9);px<=Math.ceil(cx+wide*.75+9);px++) {
          const warpedX=px-cx-slant*(py-cy)-Math.sin(vertical*2.7+edgePhase)*wide*.065;
          const edgeWave=Math.sin(py*.061+edgePhase)*2.8+Math.sin(py*.19+edgePhase*2.1)*.85;
          const sideDistance=wide*.5*endTaper+edgeWave-Math.abs(warpedX);
          const endDistance=tall*.5+Math.sin(px*.13+edgePhase)*3.4
            +Math.sin(px*.37-edgePhase)*1.1-Math.abs(py-cy+warpedX*.16);
          const edge=Math.min(sideDistance,endDistance);
          if(edge<0)continue;
          const i=wrap(py,HEIGHT)*WIDTH+wrap(px,WIDTH);
          const granule=(hash(wrap(px,WIDTH),wrap(py,HEIGHT))-.5)*.00010;
          const edgeWeight=smooth(0,bevel,edge);
          const cup=.0012*(1-vertical*vertical)-.0008*Math.abs(warpedX)/(wide*.5);
          const curl=peel?.0040*smooth(.10,.80,vertical)*smooth(0,.5,1-Math.abs(warpedX)/(wide*.5)):0;
          const h=.001+(crest+cup+curl+granule-.001)*edgeWeight;
          if(h>heights[i]!) {
            const chipped=noise(wrap(px,WIDTH)/WIDTH,wrap(py,HEIGHT)/HEIGHT,29,63);
            const tissue=noise(wrap(px,WIDTH)/WIDTH,wrap(py,HEIGHT)/HEIGHT,79,133);
            // Broad flakes peel as one surface. A few missing islands expose
            // lower tissue in both pigment and relief, breaking up long stripes.
            const worn=smooth(.61,.80,chipped)*smooth(.18,.50,edgeWeight);
            heights[i]=h-worn*crest*.48+(tissue-.5)*.00028;
            tone[i]=tone[i]!*(1-edgeWeight)
              +(colour+(chipped-.5)*.095+(tissue-.5)*.025-worn*.10)*edgeWeight;
          }
        }
      }
      y+=tall*randomBetween(random,.76,1.10);
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
    // A two-texel derivative preserves centimetre flakes while suppressing
    // single-pixel grit that would glitter when lit from the side.
    const dx=(heights[y*WIDTH+wrap(x+1,WIDTH)]!+heights[y*WIDTH+wrap(x+2,WIDTH)]!
      -heights[y*WIDTH+wrap(x-1,WIDTH)]!-heights[y*WIDTH+wrap(x-2,WIDTH)]!)/(6*texelX);
    const dy=(heights[wrap(y+1,HEIGHT)*WIDTH+x]!+heights[wrap(y+2,HEIGHT)*WIDTH+x]!
      -heights[wrap(y-1,HEIGHT)*WIDTH+x]!-heights[wrap(y-2,HEIGHT)*WIDTH+x]!)/(6*texelY);
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
    const hollow=Math.max(0,surrounding/8-heights[i]!);
    const visibility=Math.max(.73,1-hollow*110);
    const runoff=noise(x/WIDTH,y/HEIGHT,7,4)*.66+noise(x/WIDTH,y/HEIGHT,21,11)*.34;
    const wet=saturate(smooth(.27,.69,runoff)*.83+hollow*45);
    const shadedTone=tone[i]!*visibility*(1-wet*.08);
    // Packed albedo is a relative multiplier, not sRGB colour; decoding is
    // explicit in the wood shader so vertex tone remains physically modest.
    albedo[o]=Math.round(saturate(shadedTone*(.69+warm*.034))*255);
    albedo[o+1]=Math.round(saturate(shadedTone*(.658+warm*.020))*255);
    albedo[o+2]=Math.round(saturate(shadedTone*(.603+warm*.018))*255);
    albedo[o+3]=Math.round(saturate(moss*2.4)*255);
    // Wet runnels are darker but smoother; raised fibrous plates and lichen
    // keep a broad, rough response. All three maps describe the same surface.
    const rough=.80+tone[i]!*.035-wet*.37+moss*.15;
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
