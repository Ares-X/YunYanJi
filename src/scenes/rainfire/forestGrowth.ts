import { createRandom, randomBetween } from '../../core/random';

export interface GrowthPoint { x:number;y:number;z:number; }
export interface GrowthNode {
  point:GrowthPoint; direction:GrowthPoint; parent:number; children:number[];
  born:number; flow:number; radius:number; remaining:number; dead:boolean;
}
export interface GrowthTree {
  nodes:GrowthNode[]; chains:number[][]; tips:number; iterations:number; consumed:number;
}
export interface GrowthOptions {
  height:number; radius:number; crownBase:number; spread:number;
  coarsePoints:number; finePoints:number; maxNodes:number; lightX:number; lightZ:number;
}
const unit=(p:GrowthPoint):GrowthPoint=>{const m=Math.hypot(p.x,p.y,p.z)||1;return{x:p.x/m,y:p.y/m,z:p.z/m};};
const sub=(a:GrowthPoint,b:GrowthPoint):GrowthPoint=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const distance2=(a:GrowthPoint,b:GrowthPoint)=>{const x=a.x-b.x,y=a.y-b.y,z=a.z-b.z;return x*x+y*y+z*z;};

/**
 * Space-colonization growth, following Runions, Lane & Prusinkiewicz (2007),
 * "Modeling Trees with a Space Colonization Algorithm". See docs/architecture.md.
 * This implementation uses a spatial hash, two growth seasons, tropism and
 * competing buds. The geometry renderer consumes the resulting plain graph.
 */
export function growSpaceTree(seed:string,options:GrowthOptions):GrowthTree {
  const random=createRandom(`${seed}/space-colonization`);
  const {height,radius,crownBase,spread}=options;
  const phase=random()*Math.PI*2, leanX=randomBetween(random,-.34,.34)*spread,
    leanZ=randomBetween(random,-.26,.26)*spread;
  const axis=(y:number):GrowthPoint=>({
    x:leanX*y/height+(Math.sin(y*.57+phase)-Math.sin(phase))*radius*.5,
    y,z:leanZ*y/height+(Math.sin(y*.43-phase)+Math.sin(phase))*radius*.45,
  });
  const nodes:GrowthNode[]=[];
  const add=(point:GrowthPoint,direction:GrowthPoint,parent:number,born:number)=>{
    const at=nodes.length;
    nodes.push({point,direction,parent,children:[],born,flow:0,radius:0,remaining:0,dead:false});
    if(parent>=0)nodes[parent]!.children.push(at);
    return at;
  };
  let parent=-1;
  const initialSteps=Math.max(5,Math.ceil(crownBase/.20));
  for(let i=0;i<=initialSteps;i++){
    const p=axis(crownBase*.94*i/initialSteps);
    const direction=parent<0?{x:0,y:1,z:0}:unit(sub(p,nodes[parent]!.point));
    parent=add(p,direction,parent,-1);
  }
  const heightRange=height-crownBase;
  const centerY=crownBase+heightRange*.48;
  const emptyPockets=Array.from({length:3},()=>({
    x:randomBetween(random,-.65,.65)*spread,
    y:crownBase+heightRange*randomBetween(random,.21,.84),
    z:randomBetween(random,-.65,.65)*spread,
    r:randomBetween(random,.11,.22)*spread,
  }));
  const attractors=(count:number):GrowthPoint[]=>{
    const points:GrowthPoint[]=[];
    for(let attempt=0;points.length<count&&attempt<count*25;attempt++){
      const y=randomBetween(random,crownBase,height),ny=(y-centerY)/(heightRange*.54);
      const angle=random()*Math.PI*2;
      const rim=Math.sqrt(Math.max(0,1-ny*ny))
        *(1+.14*Math.sin(angle*3+phase)+.10*Math.sin(angle*5-y*.7+phase));
      const r=Math.sqrt(random())*rim*spread;
      const center=axis(y);
      const point={x:center.x+Math.cos(angle)*r,y,
        z:center.z+Math.sin(angle)*r*randomBetween(random,.78,1.12)};
      if(emptyPockets.some(hole=>distance2(point,hole)<hole.r*hole.r))continue;
      if(random()>.48+.48*r/Math.max(.1,spread))continue;
      points.push(point);
    }
    return points;
  };
  let iterations=0,consumed=0;
  const grow=(points:GrowthPoint[],step:number,influence:number,kill:number,season:number,maxIterations:number)=>{
    const cells=new Map<string,number[]>();
    const cell=(p:GrowthPoint)=>[Math.floor(p.x/influence),Math.floor(p.y/influence),Math.floor(p.z/influence)];
    const key=(x:number,y:number,z:number)=>`${x}/${y}/${z}`;
    const insert=(i:number)=>{const c=cell(nodes[i]!.point),k=key(c[0]!,c[1]!,c[2]!);const list=cells.get(k);if(list)list.push(i);else cells.set(k,[i]);};
    nodes.forEach((_,i)=>insert(i));
    let active=points;
    for(let iteration=0;iteration<maxIterations&&active.length&&nodes.length<options.maxNodes;iteration++){
      iterations++;
      const sums=new Map<number,{x:number;y:number;z:number;n:number}>();
      const alive:GrowthPoint[]=[];
      for(const point of active){
        const c=cell(point);let closest=-1,nearest=influence*influence,wasReached=false;
        for(let dz=-1;dz<=1;dz++)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
          const list=cells.get(key(c[0]!+dx,c[1]!+dy,c[2]!+dz));if(!list)continue;
          for(const index of list){
            const node=nodes[index]!,d=distance2(point,node.point);
            if(d<kill*kill){wasReached=true;break;}
            if(d>=nearest||node.children.length>=3)continue;
            const v=unit(sub(point,node.point));
            if(node.children.some(child=>{const q=nodes[child]!.direction;return q.x*v.x+q.y*v.y+q.z*v.z>.94;}))continue;
            nearest=d;closest=index;
          }
          if(wasReached)break;
        }
        if(wasReached){consumed++;continue;}
        alive.push(point);
        if(closest<0)continue;
        const d=unit(sub(point,nodes[closest]!.point));
        const sum=sums.get(closest)||{x:0,y:0,z:0,n:0};
        sum.x+=d.x;sum.y+=d.y;sum.z+=d.z;sum.n++;sums.set(closest,sum);
      }
      active=alive;
      let created=0;
      for(const [index,sum]of sums){
        if(nodes.length>=options.maxNodes)break;
        const node=nodes[index]!,aim=unit(sum);
        const age=node.point.y/height;
        const direction=unit({x:aim.x+node.direction.x*.19+options.lightX*.055+randomBetween(random,-.035,.035),
          y:aim.y+node.direction.y*.19+(season===0?.10:.025)-Math.max(0,age-.57)*.10,
          z:aim.z+node.direction.z*.19+options.lightZ*.055+randomBetween(random,-.035,.035)});
        if(node.children.some(child=>{const q=nodes[child]!.direction;return q.x*direction.x+q.y*direction.y+q.z*direction.z>.965;}))continue;
        const length=step*randomBetween(random,.83,1.18);
        const point={x:node.point.x+direction.x*length,y:node.point.y+direction.y*length,z:node.point.z+direction.z*length};
        if(point.y<crownBase*.75||point.y>height*1.05)continue;
        const child=add(point,direction,index,season*100+iteration);insert(child);created++;
      }
      if(!created)break;
    }
  };
  const coarseStep=Math.max(.17,height*.021);
  grow(attractors(options.coarsePoints),coarseStep,Math.max(1.0,spread*.72),coarseStep*1.75,0,56);
  const fineStep=Math.max(.085,height*.009);
  grow(attractors(options.finePoints),fineStep,Math.max(.55,spread*.32),fineStep*1.55,1,65);
  // Relocate degree-two nodes only. Forks keep their unequal growth history;
  // chain interpolation in the renderer preserves the remaining small bends.
  for(let pass=0;pass<2;pass++)for(let i=initialSteps+1;i<nodes.length;i++){
    const node=nodes[i]!;
    if(node.children.length!==1||node.parent<0)continue;
    const a=nodes[node.parent]!.point,b=nodes[node.children[0]!]!.point;
    node.point={x:node.point.x*.68+(a.x+b.x)*.16,y:node.point.y*.68+(a.y+b.y)*.16,z:node.point.z*.68+(a.z+b.z)*.16};
  }
  for(let i=nodes.length-1;i>=0;i--){
    const node=nodes[i]!;
    node.flow=node.children.length?node.children.reduce((sum,id)=>sum+nodes[id]!.flow,0):1;
    node.remaining=node.children.reduce((longest,id)=>Math.max(longest,Math.sqrt(distance2(node.point,nodes[id]!.point))+nodes[id]!.remaining),0);
    node.dead=!node.children.length&&node.born<100&&node.point.y<height*.78&&random()<.37;
  }
  const rootPipe=Math.sqrt(nodes[0]!.flow)*.00165,heartwood=Math.max(0,radius-rootPipe);
  const extent=1-Math.exp(-nodes[0]!.remaining/(height*.32));
  for(const node of nodes){
    const age=(1-Math.exp(-node.remaining/(height*.32)))/Math.max(.01,extent);
    const supportedFraction=Math.pow(node.flow/nodes[0]!.flow,.36);
    node.radius=Math.sqrt(node.flow)*.00165+heartwood*Math.pow(age,1.8)*supportedFraction;
  }
  const chains:number[][]=[];
  const walk=(start:number)=>{
    for(const child of nodes[start]!.children){
      const path=[start,child];let at=child;
      while(nodes[at]!.children.length===1){at=nodes[at]!.children[0]!;path.push(at);}
      chains.push(path);if(nodes[at]!.children.length)walk(at);
    }
  };
  walk(0);
  return{nodes,chains,tips:nodes.filter(n=>!n.children.length).length,iterations,consumed};
}
