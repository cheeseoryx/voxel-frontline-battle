import type {Vec3} from './voxel-map.ts';
import type {Team} from './objective-rules.ts';
export type CoreSpawnPoint={id:string;position:Vec3;owner:Team;capture:number;contested:boolean;fixed:boolean};
/** Home bases are fixed; forward spawn crystals change team after 20 uncontested seconds. */
export class CoreSpawnRules {
 readonly points:CoreSpawnPoint[];
 constructor(source:any[]){this.points=source.map(p=>({id:p.id,position:[p.x,p.y,p.z],owner:p.team,capture:0,contested:false,fixed:!!p.fixed}));}
 update(dt:number,actors:{team:Team;position:Vec3;alive:boolean}[]){for(const point of this.points){if(point.fixed)continue;const near=actors.filter(a=>a.alive&&Math.hypot(a.position[0]-point.position[0],a.position[2]-point.position[2])<12&&Math.abs(a.position[1]-point.position[1])<4),ally=near.some(a=>a.team==='ally'),enemy=near.some(a=>a.team==='enemy');point.contested=ally&&enemy;if(point.contested||!ally&&!enemy||near[0]?.team===point.owner){point.capture=0;continue;}point.capture+=dt;if(point.capture>=20){point.owner=ally?'ally':'enemy';point.capture=0;}}}
}
