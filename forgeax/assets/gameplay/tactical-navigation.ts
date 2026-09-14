import type {VoxelMap,Vec3} from './voxel-map.ts';
export type Waypoint=Vec3&{transit?:boolean;jump?:boolean};
export type TraversalLink={from:Vec3;to:Vec3;route:Waypoint[]};
/** Walkable voxel A*, with authored off-mesh links for the two ends of each zipline. */
export class TacticalNavigation {
 allowJumps=false;readonly links:TraversalLink[]=[];obstacles:{min:Vec3;max:Vec3}[]=[];
 constructor(readonly map:VoxelMap){}
 stand(x:number,z:number,near:number,climb=1.1,drop=4):Vec3|null {x=Math.floor(x)+.5;z=Math.floor(z)+.5;if(x<1||z<1||x>this.map.width-2||z>this.map.width-2)return null;const bottom=Math.max(1,Math.floor(near)-drop),top=Math.min(this.map.height-2,Math.floor(near+climb));let best:Vec3|null=null;for(let y=bottom;y<=top;y++)if(this.map.get(Math.floor(x),y+1,Math.floor(z))!==8&&this.map.solid(Math.floor(x),y-1,Math.floor(z))&&!this.map.overlaps([x,y+.04,z],.3,1.75)&&!this.obstacles.some(b=>x+.34>b.min[0]&&x-.34<b.max[0]&&z+.34>b.min[2]&&z-.34<b.max[2]&&y+1.8>b.min[1]&&y<b.max[1]))if(!best||Math.abs(y-near)<Math.abs(best[1]-near))best=[x,y+.04,z];return best;}
 safe(origin:Vec3,radius=10):Vec3 {for(let r=0;r<=radius;r++)for(let i=0;i<Math.max(1,r*8);i++){const a=i/Math.max(1,r*8)*Math.PI*2,x=origin[0]+Math.cos(a)*r,z=origin[2]+Math.sin(a)*r;const near=Number.isFinite(origin[1])?origin[1]:(this.map.ground[Math.floor(z)*this.map.width+Math.floor(x)]||0)+1;const p=this.stand(x,z,near,3);if(p)return p;}return [origin[0],this.map.walkHeight(origin[0],origin[2])+.05,origin[2]];}

 addZiplines(lines:any[]){for(const z of lines){
  if(!z.landLow||!z.landHigh||!z.start||!z.end)continue;
  const v=(p:any):Vec3=>[p.x,p.y,p.z],low=this.safe(v(z.landLow),4),high=this.safe(v(z.landHigh),4),top=Math.max(high[1]+1.1,z.rideEnd?.y||0);
  let pivot:Vec3|null=null;
  for(let r=0;r<=18&&!pivot;r++)for(let i=0;i<Math.max(1,r*8);i++){const angle=i/Math.max(1,r*8)*Math.PI*2,p=this.stand(low[0]+Math.cos(angle)*r,low[2]+Math.sin(angle)*r,low[1],2);if(!p)continue;let clear=true;for(let y=p[1];y<=top;y+=.5)if(this.map.overlaps([p[0],y,p[2]],.34,1.8)){clear=false;break;}if(clear){const distance=Math.hypot(p[0]-high[0],p[2]-high[2]);for(let d=0;d<=distance;d+=.5)if(this.map.overlaps([p[0]+(high[0]-p[0])*d/distance,top,p[2]+(high[2]-p[2])*d/distance],.34,1.8)){clear=false;break;}}if(clear){pivot=p;break;}}
  if(!pivot)continue;const ground=this.path(low,pivot,3000);if(Math.hypot(...(ground.at(-1)||low).map((v,i)=>v-pivot![i]))>2.1)continue;
  const points:Waypoint[]=[low,...ground,pivot,[pivot[0],top,pivot[2]],[high[0],top,high[2]],high].map(p=>Object.assign([...p],{transit:true})) as Waypoint[];
  this.links.push({from:low,to:high,route:points.slice(1)},{from:high,to:low,route:points.slice(0,-1).reverse()});
 }}

 path(from:Vec3,to:Vec3,budget=this.links.length?6000:1500):Waypoint[]{
  type Node={p:Vec3;g:number;h:number;f:number;parent?:Node;edge:Waypoint[]};const heuristic=(p:Vec3)=>Math.hypot(p[0]-to[0],p[2]-to[2])+Math.abs(p[1]-to[1])*.3;
  const stride=Math.hypot(from[0]-to[0],from[2]-to[2])>65?4:1,open:Node[]=[],seen=new Map<string,number>();
  const push=(n:Node)=>{let i=open.length;open.push(n);while(i){const parent=(i-1)>>1;if(open[parent].f<=n.f)break;open[i]=open[parent];i=parent;}open[i]=n;};
  const pop=()=>{const n=open[0],tail=open.pop()!;if(open.length){let i=0;while(i*2+1<open.length){let child=i*2+1;if(child+1<open.length&&open[child+1].f<open[child].f)child++;if(open[child].f>=tail.f)break;open[i]=open[child];i=child;}open[i]=tail;}return n;};
  const first:Node={p:from,g:0,h:heuristic(from),f:heuristic(from),edge:[]};push(first);let best=first;
  while(open.length&&budget-->0){const n=pop();if(n.h<best.h)best=n;if(n.h<2){best=n;break;}
   const add=(p:Vec3,edge:Waypoint[],cost:number)=>{const key=p.join(','),g=n.g+cost;if((seen.get(key)??Infinity)<=g)return;seen.set(key,g);const h=heuristic(p);push({p,g,h,f:g+h*1.15,parent:n,edge});};
   for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){let p:Vec3|null=n.p;const edge:Waypoint[]=[];for(let step=0;step<stride&&p;step++){p=this.stand(p[0]+dx,p[2]+dz,p[1]);if(p)edge.push(p);}if(p)add(p,edge,stride+Math.abs(p[1]-n.p[1])*.4);
    else if(this.allowJumps){for(let d=2;d<=5;d++){const landing=this.stand(n.p[0]+dx*d,n.p[2]+dz*d,n.p[1],1.1,14);if(!landing||this.map.waterSurface(landing[0],landing[2])>landing[1]+.5)continue;const time=d/4.5;if(n.p[1]+7*time-9*time*time<landing[1])continue;let clear=true;for(let step=.2;step<=d;step+=.2){const t=step/4.5,y=n.p[1]+7*t-9*t*t;if(this.map.overlaps([n.p[0]+dx*step,y,n.p[2]+dz*step],.34,1.8)){clear=false;break;}}if(clear)add(landing,[Object.assign(landing,{jump:true})],d+3);}}
}
   for(const link of this.links)if(Math.hypot(link.from[0]-n.p[0],link.from[2]-n.p[2])<4.5&&Math.abs(link.from[1]-n.p[1])<1.2)add(link.to,[link.from,...link.route],Math.hypot(...link.to.map((v,i)=>v-link.from[i]))*.6+3);
  }
  const segments:Waypoint[][]=[];while(best.parent){segments.push(best.edge);best=best.parent;}return segments.reverse().flat();
 }
}
