import {isRemoteExplosive,REMOTE_RULES,vanguardDamage} from './remote-explosives.ts';
import {createThrowableEffects} from './throwable-effects.ts';
import {createThrowableVisuals} from './native-throwable-visuals.ts';
import {THROWABLE_RULES} from './throwable-rules.ts';
import originalPoses from '../original/gadget-poses.ts';
import type {World,EntityHandle} from '@forgeax/engine/ecs';
import type {Handle} from '@forgeax/engine/types';
import {Transform,ChildOf,Name} from '@forgeax/engine/scene';
import {MeshFilter,MeshRenderer,Visibility,VisibilityStateValue} from '@forgeax/engine/render';
import type {BattleState} from './battle.plugin.ts';
import {equipmentSlot,EquipmentInventory,EQUIPMENT_RULES as R} from './equipment-rules.ts';
import {createEquipmentProjectiles,type EquipmentProjectileKind} from './equipment-projectiles.ts';
import {itemsFor,weaponsFor,teamless,type Slot} from './catalog.ts';
import type {Vec3} from './voxel-map.ts';

type Crate={id:string;kind:'medkit'|'ammo';entity:EntityHandle;team:'ally';hp:number;alive:boolean;life:number;isEquipment:true};
type Marker={id:string;position:Vec3;life:number};
export type EquipmentAssets=Map<string,Handle<'MeshAsset','shared'>>;
const dist=(a:Vec3,b:Vec3)=>Math.hypot(...a.map((n,i)=>n-b[i]));
export function createEquipment(world:World,b:BattleState,assets:EquipmentAssets,setWeapon:(id:string,refill:boolean)=>void){
 const inventory=new EquipmentInventory(b.mode,b.equipment),crates:Crate[]=[],markers:Marker[]=[],owned=new Set<EntityHandle>();
 let view:EntityHandle|undefined,closed=false,serial=0,pending:{kind:'medkit'|'ammo';position:Vec3;at:number}|null=null,lockUntil=0;
 let aim:{kind:EquipmentProjectileKind;source:'mouse'|'quick';at:number}|null=null,release:{kind:EquipmentProjectileKind;power:number;at:number}|null=null,swing:{at:number;until:number;hit:boolean}|null=null,previousHealth=b.health;
 let nearMed=false,nearAmmo=false;
 const visuals=createThrowableVisuals(world,b),effects=createThrowableEffects(b,visuals);
 const projectile=createEquipmentProjectiles(world,b,assets,effect);
 const availableCharges=()=>b.mode==='conquest'?inventory.charges:b.classId!=='vanguard'||b.mode==='gungame'||b.skillCooldown>0?0:1;
 const feet=():Vec3=>{const p=b.physics.position(b.playerBody);return [p[0],p[1]-.9,p[2]];};
 const forward=():Vec3=>[-Math.sin(b.yaw)*Math.cos(b.pitch),Math.sin(b.pitch),-Math.cos(b.yaw)*Math.cos(b.pitch)];
 const notice=(text:string)=>{b.notice=text;b.noticeLeft=3;};
 const playable=()=>!closed&&!b.dead&&!b.vehicles?.seated&&(!b.arena||b.arena.match.scoringLive());
 function viewPose(){const id=aim?.kind||release?.kind||inventory.id,key=(b.mode==='conquest'?'':'small/')+'gadget/'+b.classId+'/'+(b.mode==='conquest'&&id==='charge'&&inventory.charges===0?'remote':id),poses=(originalPoses as Record<string,any>)[key],pose=b.ads&&id==='binoculars'?poses?.ads:poses?.hip;if(!pose)return {pos:[0,0,0] as Vec3,quat:[0,0,0,1] as [number,number,number,number]};const x=(pose.rx||0)/2,y=(pose.ry||0)/2,z=(pose.rz||0)/2,sx=Math.sin(x),sy=Math.sin(y),sz=Math.sin(z),cx=Math.cos(x),cy=Math.cos(y),cz=Math.cos(z);return {pos:[pose.x,pose.y,pose.z] as Vec3,quat:[sx*cy*cz+cx*sy*sz,cx*sy*cz-sx*cy*sz,cx*cy*sz+sx*sy*cz,cx*cy*cz-sx*sy*sz] as [number,number,number,number]};}
 const named=(slot=inventory.slot)=>itemsFor(b.mode,slot).find(i=>i.id===inventory.loadout[slot])?.name||inventory.loadout[slot];
 function syncAmmo(){b.grenades=inventory.grenades;}
 function removeCrate(crate:Crate){const i=crates.indexOf(crate);if(i<0)return;crates.splice(i,1);crate.alive=false;world.despawn(crate.entity).unwrap();owned.delete(crate.entity);const n=b.deployables.indexOf(crate);if(n>=0)b.deployables.splice(n,1);}
 function cancel(){const throwing=!!aim||!!release;aim=null;release=null;pending=null;swing=null;b.firing=false;b.ads=false;if(throwing)syncView();}
 function syncView(){
  if(view!==undefined){world.despawn(view).unwrap();owned.delete(view);view=undefined;}
  const selected=aim?.kind||release?.kind||inventory.id;const id=b.mode==='conquest'&&selected==='charge'&&inventory.charges===0?'remote':selected;
  const mesh=assets.get('gadget/'+id);if(!mesh||!aim&&!release&&inventory.gun)return;
  view=world.spawn({component:ChildOf,data:{parent:b.camera}},{component:Transform,data:viewPose()},{component:MeshFilter,data:{assetHandle:mesh}},{component:MeshRenderer,data:{materials:[]}},{component:Visibility,data:{state:VisibilityStateValue.visible}}).unwrap();owned.add(view);
 }
 function select(slot:Slot){
  if(!playable()||b.mode==='gungame'||!inventory.loadout[slot]||b.mode!=='conquest'&&(slot==='gadget1'||slot==='gadget2'||slot==='melee'&&b.mode==='core'))return false;
  const id=inventory.loadout[slot];
  cancel();b.building?.cancel();inventory.skill=null;inventory.slot=slot;b.reload=0;
  if(inventory.gun||slot==='melee')setWeapon(id,false);
  lockUntil=b.elapsed+.16;syncView();return true;
 }
 function selectSkillCharge(){if(!playable()||b.mode==='conquest'||b.mode==='gungame'||b.classId!=='vanguard')return false;cancel();b.building?.cancel();inventory.skill='charge';inventory.slot='gadget1';b.reload=0;lockUntil=b.elapsed+.16;syncView();return true;}
 function secondary(){if(b.building?.active||!isRemoteExplosive(inventory.id))return false;if(!playable())return true;b.ads=false;b.firing=false;const count=projectile.detonateCharges();notice(count?'已引爆全部 '+count+' 枚遥控炸药':'没有已投出的遥控炸药');return true;}
 function key(code:string){const slot=equipmentSlot(b.mode,code);if(slot)return select(slot);if(code===(b.mode==='conquest'?'KeyG':'KeyQ')){if(inventory.loadout.grenade==='semtex')select('grenade');else beginThrow('quick');return true;}return false;}
 function beginThrow(source:'mouse'|'quick'){
  if(!playable()||aim||release||b.elapsed<lockUntil||b.mode==='gungame')return;
  const kind=source==='quick'?inventory.loadout.grenade:inventory.id;
  if(kind==='charge'&&availableCharges()===0){notice(b.mode==='conquest'?'C4 已用完 · 右键引爆已投出炸药':'C4 冷却 '+Math.ceil(b.skillCooldown)+' 秒 · 右键仍可引爆');return;}
  if(kind!=='charge'&&inventory.grenades<=0){notice('没有投掷物');return;}
  if(projectile.parts.length>=REMOTE_RULES.maxActive){notice('已达到投出上限 · 右键引爆已投出的炸药');return;}
  if(!['frag','flash','smoke','stun','semtex','molotov','charge'].includes(kind))return;
  b.audio?.play('throwable.'+(kind==='charge'?'frag':kind)+'.pin');b.firing=false;b.ads=false;b.reload=0;b.building?.cancel();pending=null;aim={kind:kind as EquipmentProjectileKind,source,at:b.elapsed};syncView();
 }
 function releaseThrow(source:'mouse'|'quick'){
  if(!aim||aim.source!==source)return;
  release={kind:aim.kind,power:source==='mouse'&&isRemoteExplosive(aim.kind)?1:Math.min(1,b.elapsed-aim.at),at:b.elapsed+(isRemoteExplosive(aim.kind)?0:b.mode==='conquest'?.15:.34)};
  aim=null;lockUntil=b.elapsed+(isRemoteExplosive(release.kind)?REMOTE_RULES.throwLock:b.mode==='conquest'?.6:.74);
 }
 function placeCrate(kind:'medkit'|'ammo'){
  const p=feet(),q:Vec3=[p[0]-Math.sin(b.yaw)*3.2,0,p[2]-Math.cos(b.yaw)*3.2];q[1]=b.map.walkHeight(q[0],q[2]);
  const from:Vec3=[p[0],p[1]+1.2,p[2]],target:Vec3=[q[0],q[1]+.4,q[2]],d=target.map((n,i)=>n-from[i]) as Vec3;
  if(q[0]<1||q[2]<1||q[0]>=b.map.width-1||q[2]>=b.map.width-1||Math.abs(q[1]-p[1])>1.6||b.map.raycast(from,d,dist(from,target)-.4)||b.map.overlaps([q[0],q[1]+.05,q[2]],.65,.65)){notice('此处无法部署，请选择前方空地');return;}
  pending={kind,position:q,at:b.elapsed+.18};lockUntil=b.elapsed+.42;
 }
 function deploy(kind:'medkit'|'ammo',p:Vec3){
  const mesh=assets.get('deployed/'+kind);if(!mesh)throw Error('缺少原版部署装备 '+kind);
  for(const c of [...crates])if(c.kind===kind)removeCrate(c);
  const entity=world.spawn({component:Transform,data:{pos:p}},{component:Name,data:{value:kind==='medkit'?'急救箱':'弹药箱'}},{component:MeshFilter,data:{assetHandle:mesh}},{component:MeshRenderer,data:{materials:[]}}).unwrap();owned.add(entity);
  const crate:Crate={id:'equipment-'+(++serial),kind,entity,team:'ally',hp:R.crateHealth,alive:true,life:R.crateLife,isEquipment:true};crates.push(crate);b.deployables.push(crate);notice((kind==='medkit'?'急救箱':'弹药箱')+'已部署 · 靠近 1 米生效');
 }
 function spot(){
  const origin=b.physics.position(b.camera),d=forward();let nearest=160,target:Marker|undefined;
  for(const u of b.arena?.units||[]){if(!u.alive||u.team==='ally')continue;const p=b.arena!.position(u),v=p.map((n,i)=>n+(i===1?1:0)-origin[i]),len=Math.hypot(...v),dot=v.reduce((sum,n,i)=>sum+n*d[i],0)/(len||1);
   if(len<nearest&&dot>.92&&!blocksLine(origin,p)){nearest=len;target={id:u.id,position:p,life:8};}
  }
  if(!target)for(const v of b.vehicles?.vehicles||[]){if(v.hp<=0||v.team==='ally')continue;const p=b.physics.position(v.entity),delta=p.map((n,i)=>n-origin[i]),len=Math.hypot(...delta),dot=delta.reduce((sum,n,i)=>sum+n*d[i],0)/(len||1);if(len<nearest&&dot>.985&&!blocksLine(origin,p)){nearest=len;target={id:v.id,position:p,life:9};}}
  if(target){const old=markers.findIndex(m=>m.id===target!.id);if(old>=0)markers.splice(old,1);markers.push(target);notice('已标记敌人 · '+Math.round(nearest)+' 米');}else notice('未发现可标记的目标');
 }
 function press(){
  if(!playable())return true;
  if(b.elapsed<lockUntil||aim||release)return true;
  if(inventory.slot==='melee'){swing={at:b.elapsed+.05,until:b.elapsed+.2,hit:false};lockUntil=b.elapsed+.45;return true;}
  if(inventory.gun){if(inventory.id!=='rpg')return false;
   if(b.reload>0||b.cooldown>0)return true;if(b.mag<=0){notice('R 装填 RPG');return true;}
   if(projectile.launch('rpg')){b.mag--;b.shots++;b.cooldown=3.2;b.spawnProtection=0;b.audio?.gun('rpg');}return true;
  }
  if(inventory.id==='medkit'||inventory.id==='ammo')placeCrate(inventory.id);
  else if(inventory.id==='binoculars')spot();
  else {beginThrow('mouse');if(aim&&isRemoteExplosive(inventory.id))releaseThrow('mouse');}
  return true;
 }
 function visible(a:Vec3,p:Vec3){const delta=p.map((n,i)=>n-a[i]) as Vec3;return !b.map.raycast(a,delta,Math.max(0,dist(a,p)-.2));}
 function damagePlayer(amount:number,id:string){if(amount>0)b.arena?.damage(b.arena.player,amount,b.arena.player,id);}
 function effect(kind:EquipmentProjectileKind,p:Vec3){
  if(kind!=='charge'&&kind!=='rpg'){effects.detonate(kind,p);return;}
  if(kind==='charge')visuals.spawn('semtex',p);
  b.audio?.play('throwable.frag.detonate',p);
  b.ordnance?.burst(p,12);
  const radius=kind==='charge'?7.5:4.5,inner=2.5,damage=kind==='rpg'?150:130;
  for(const u of b.arena?.units||[]){if(!u.alive||u.team==='ally'&&!teamless(b.mode))continue;const q=b.arena!.position(u),d=kind==='charge'?(b.mode==='conquest'?Math.hypot(q[0]-p[0],q[2]-p[2]):dist([q[0],q[1]+1,q[2]],p)):dist(q,p);if(d>radius||kind!=='charge'&&!visible(p,[q[0],q[1]+1,q[2]]))continue;const amount=kind==='charge'?(b.mode==='conquest'?Math.max(12,damage*(1-d/(radius+.1))):vanguardDamage(d)):damage-(damage-20)*Math.max(0,(d-inner)/(radius-inner));b.arena!.damage(u,amount,b.arena!.player,kind);}
  const d=kind==='charge'?Math.hypot(feet()[0]-p[0],feet()[2]-p[2]):dist(feet(),p);
  if(kind==='charge'&&b.mode==='conquest'&&d<=2.4)damagePlayer(Math.max(8,130*(1-d/3)*.2),'charge');
  else if(kind!=='charge'&&d<=radius&&visible(p,b.physics.position(b.camera)))damagePlayer(damage-(damage-20)*Math.max(0,(d-inner)/(radius-inner)),kind);
  b.vehicles?.damageArea(p,kind==='charge'?9:radius,kind==='charge'?160:damage,'ally');
  damageArea(p,kind==='charge'?6:radius,kind==='charge'?120:damage);
  if(kind==='charge'){const r=b.mode==='conquest'?4.5:5.5;for(let x=Math.floor(p[0]-r);x<=p[0]+r;x++)for(let y=Math.max(1,Math.floor(p[1]-r));y<=p[1]+r;y++)for(let z=Math.floor(p[2]-r);z<=p[2]+r;z++)if(dist([x+.5,y+.5,z+.5],p)<r&&b.map.breakBlock(x,y,z))b.broken++;if(b.mode!=='conquest'&&b.classId==='vanguard')b.speedBoostUntil=b.elapsed+3;}
  if(kind!=='charge')for(let x=Math.floor(p[0]-2);x<=p[0]+2;x++)for(let y=Math.floor(p[1]-2);y<=p[1]+2;y++)for(let z=Math.floor(p[2]-2);z<=p[2]+2;z++)if(dist([x,y,z],p)<2&&b.map.breakBlock(x,y,z,true))b.broken++;

 }
 function damageArea(p:Vec3,radius:number,amount:number){projectile.damageArea(p,radius,amount);for(const c of [...crates]){const q=b.physics.position(c.entity),d=dist(p,q);if(d<=radius&&visible(p,q)){c.hp-=amount*Math.max(.1,1-d/radius);if(c.hp<=0)removeCrate(c);}}}
 const blocksLine=effects.blocksLine;
 function reset(){
  cancel();inventory.reset();syncAmmo();projectile.clearCharges();effects.clearPlayerStatus();lockUntil=0;b.lastHurt=-Infinity;
  for(const id of inventory.carriedWeapons){const def=weaponsFor(b.mode)[id];if(def)b.ammoState[id]={mag:def.magSize,reserve:def.reserve};}
  if(b.mode!=='gungame')setWeapon(inventory.loadout.primary,false);syncView();previousHealth=b.health;
 }
 function update(dt:number){
  if(closed)return;
  if(b.health<previousHealth)b.lastHurt=b.elapsed;previousHealth=b.health;
  if(b.dead||b.vehicles?.seated){cancel();if(b.dead)projectile.clearCharges();}
  if(view!==undefined){world.set(view,Visibility,{state:b.dead||b.vehicles?.seated||b.building?.active||inventory.id==='binoculars'&&b.ads?VisibilityStateValue.hidden:VisibilityStateValue.visible}).unwrap();const pose=viewPose();if(aim){const draw=Math.min(1,(b.elapsed-aim.at)/.22);pose.pos[1]-=.06*draw;pose.pos[2]+=.10*draw;}else if(release){const duration=b.mode==='conquest'?.15:.34,progress=1-Math.max(0,(release.at-b.elapsed)/duration);pose.pos[1]+=.18*progress;pose.pos[2]-=.35*progress;}world.set(view,Transform,pose).unwrap();}
  if(!b.arena?.match.scoringLive())return;
  if(pending&&b.elapsed>=pending.at){const next=pending;pending=null;if(playable())deploy(next.kind,next.position);}
  if(release&&b.elapsed>=release.at){const next=release;release=null;if(playable()&&projectile.launch(next.kind,next.power)){if(next.kind==='charge'){if(b.mode==='conquest')inventory.charges--;else b.skillCooldown=REMOTE_RULES.skillCooldown;}else inventory.grenades--;if(next.kind==='semtex'){inventory.skill=null;inventory.slot='grenade';}lockUntil=Math.max(lockUntil,b.elapsed+REMOTE_RULES.throwLock);syncAmmo();syncView();b.spawnProtection=0;b.audio?.play('throwable.'+(next.kind==='charge'?'frag':next.kind)+'.throw');}}
  projectile.update(dt);
  for(const c of [...crates]){c.life-=dt;if(c.life<=0||c.hp<=0)removeCrate(c);}
  nearMed=false;nearAmmo=false;
  if(!b.dead)for(const c of crates){if(dist(feet(),b.physics.position(c.entity))>R.crateRadius)continue;if(c.kind==='medkit')nearMed=true;else nearAmmo=true;}
  if(nearMed&&(b.lastHurt===undefined||b.elapsed-b.lastHurt>=R.healDelay))b.health=Math.min(100,b.health+R.healRate*dt);
  if(nearAmmo){inventory.refill(dt,b.ammoState);syncAmmo();}
  for(const u of b.arena?.units||[]){if(!u.alive||u.team!=='ally'||u.hp>=100||b.elapsed-(u.lastHurt??-Infinity)<1)continue;if(crates.some(c=>c.kind==='medkit'&&dist(b.arena!.position(u),b.physics.position(c.entity))<=1))u.hp=Math.min(100,u.hp+30*dt);}
  effects.update(dt);
  for(let i=markers.length-1;i>=0;i--){markers[i].life-=dt;if(markers[i].life<=0)markers.splice(i,1);}
  if(swing&&b.elapsed>=swing.at&&!swing.hit&&b.elapsed<=swing.until){
   const p=feet(),d=forward();for(const u of b.arena?.units||[]){if(!u.alive||u.team==='ally'&&!teamless(b.mode))continue;const q=b.arena!.position(u),delta=q.map((n,i)=>n-p[i]),len=Math.hypot(...delta);if(len>2||delta.reduce((s,n,i)=>s+n*d[i],0)/(len||1)<Math.cos(Math.PI/6)||!visible([p[0],p[1]+1,p[2]],[q[0],q[1]+1.2,q[2]]))continue;const yaw=u.yaw||0,back=(-Math.sin(yaw)*(p[0]-q[0])-Math.cos(yaw)*(p[2]-q[2]))/(len||1)<-.5;b.arena!.damage(u,back?999:90,b.arena!.player,'knife');swing.hit=true;break;}
  }
  if(swing&&b.elapsed>swing.until)swing=null;
 }
 function hint(){
  if(isRemoteExplosive(inventory.id))return (inventory.id==='charge'?'C4 '+availableCharges():'黏性炸药 '+inventory.grenades)+' · 左键投出 / 右键引爆全部 · 已投出 '+projectile.charges.length+(inventory.skill&&b.skillCooldown>0?' · 冷却 '+Math.ceil(b.skillCooldown)+' 秒':'');
  if(nearMed)return '急救箱 · 1 秒未受伤后持续恢复';if(nearAmmo)return '弹药箱 · 补充携行弹药 / 投掷物 / C4';
  if(inventory.id==='binoculars')return '望远镜 · 右键瞄准 / 左键标记';
  if(!inventory.gun&&inventory.slot!=='melee')return named()+' · '+(inventory.slot==='grenade'?'按住左键蓄力，松开投掷':'左键部署');
  return b.mode==='conquest'?'3 / 4 装备 · 5 投掷物 · 6 战斗刀 · G 投掷':'Q '+named('grenade')+' · G 兵种技能'+(b.mode==='core'?' · 4 / 5 建造':b.mode==='gungame'?'':' · 3 战术匕首');
 }
 function snapshot(){return {ready:playable()&&b.elapsed>=lockUntil&&!aim&&!release,loadout:{...inventory.loadout},slot:inventory.slot,id:inventory.id,grenades:inventory.grenades,charges:availableCharges(),remoteCount:projectile.charges.length,skill:inventory.skill,grenadeProgress:inventory.grenadeProgress,chargeProgress:inventory.chargeProgress,ammo:Object.fromEntries(inventory.carriedWeapons.map(id=>[id,{...b.ammoState[id]}])),crates:crates.map(c=>({kind:c.kind,hp:c.hp,life:c.life,position:b.physics.position(c.entity)})),projectiles:projectile.parts.map(p=>({kind:p.kind,landed:p.landed,life:Number.isFinite(p.life)?p.life:null,hp:p.hp,attachment:p.attachment?.actor.entity??null,position:b.physics.position(p.entity)})),zones:effects.zones.map(z=>({kind:z.kind,position:z.position,life:z.life,age:z.age})),markers:markers.map(m=>({...m})),aim:aim?.kind||release?.kind||null,flash:effects.flashLeft,stun:effects.stunLeft,smokeOpacity:effects.smokeOpacity(b.physics.position(b.camera))};}
 reset();
 return {inventory,crates,markers,projectile,get zones(){return effects.zones;},select,selectSkillCharge,secondary,key,press,damageArea,release:()=>releaseThrow('mouse'),releaseQuick:()=>releaseThrow('quick'),cancel,reset,update,hint,snapshot,blocksLine,
  damage:(item:Crate,amount:number)=>{item.hp-=Math.max(0,amount);if(item.hp<=0)removeCrate(item);},
  get availableCharges(){return availableCharges();},get gunVisible(){return !aim&&!release&&inventory.gun;},get busy(){return !!aim||!!release;},get canFireGun(){return inventory.gun&&inventory.id!=='rpg'&&!aim&&!release&&b.elapsed>=lockUntil;},
  get adsFov(){return inventory.id==='binoculars'?16:inventory.gun?Number(b.weapon.adsFov)||48:70;},get canAds(){return inventory.gun||inventory.id==='binoculars';},
  get movementScale(){return (effects.stunLeft>0?THROWABLE_RULES.stun.move:1)*(inventory.slot==='melee'?1.12:1);},get turnScale(){return effects.stunLeft>0?THROWABLE_RULES.stun.turn:1;},
  get flash(){return effects.flash;},get smokeOpacity(){return effects.smokeOpacity(b.physics.position(b.camera));},get inSmoke(){return effects.smokeOpacity(b.physics.position(b.camera))>0;},get cameraShake(){return effects.cameraShake;},
  dispose(){if(closed)return;closed=true;cancel();projectile.dispose();effects.dispose();for(const c of [...crates])removeCrate(c);for(const e of owned)world.despawn(e).unwrap();owned.clear();markers.length=0;}
 };
}
