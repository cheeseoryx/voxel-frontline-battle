import {createEquipmentHud} from './equipment-hud.ts';
import {createTacticalMap} from './tactical-map.ts';
import type {} from '@forgeax/engine/app';
import type {Plugin} from '@forgeax/engine/plugin';
import {AssetGuid} from '@forgeax/engine/pack/guid';
import {mountUi,type UiAsset} from '@forgeax/engine/ui';
import {Update,Time} from '@forgeax/engine/ecs';
import {addOnEnter,getState,setNextState} from '@forgeax/engine/state';
import {BATTLE_RUNTIME,BATTLE,type BattleState,type BattleRuntime} from '../gameplay/battle.plugin.ts';
import {IDS} from '../identity.ts';
import {Screen,SESSION,type Session,type ScreenId} from '../gameplay/state.ts';
import {original,MODE_NAMES,SLOT_IDS,SLOT_NAMES,className,classesFor,createEconomies,equipItem,initialLoadout,itemsFor,ownsItem,runtimeFor,teamless,paramsFor,type ModeId,type Slot} from '../gameplay/catalog.ts';
import {createPresentation} from '../gameplay/presentation.ts';
import {gearIcons,classIcons} from '../original/icons.ts';
const plugin:Plugin={name:'voxel-frontline/ui',inject:['world','gameHost'],async apply(ctx){
 const host=ctx.gameHost;if(!host)throw Error('App GameHost is required');
 const parsed=AssetGuid.parse(IDS.ui);if(!parsed.ok)throw parsed.error;const id=parsed.value;
 const loaded=await host.assets.loadByGuid<UiAsset>(id);if(!loaded.ok)throw loaded.error;
 const mounted=mountUi(loaded.value,{root:host.uiRoot??document.body,layer:50});if(!mounted.ok)throw mounted.error;const ui=mounted.value;
 const root=ui.host.shadowRoot!;if(!root)throw Error('Native UI did not mount');
 const economies=createEconomies(localStorage),presentation=await createPresentation(ctx.world,host);
 const state:Session={mode:'conquest',solo:false,classId:'assault',loadouts:{large:initialLoadout('large',economies.large),small:initialLoadout('small',economies.small)},countdown:3,modal:null,slot:'primary',selectedItem:'',revision:0,message:''};ctx.world.insertResource(SESSION,state);
 let disposed=false,coverActivatedAt=-Infinity,archive=false,entering=false;
 const find=(id:string)=>root.getElementById(id) as HTMLElement|null;
 const show=(id:string,visible:boolean)=>find(id)?.classList.toggle('hidden',!visible);
 const put=(id:string,text:string)=>{const el=find(id);if(el)el.textContent=text;};
 const button=(text:string,cls:string,data:Record<string,string>)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.className=cls;Object.assign(b.dataset,data);return b;};
 const icon=(kind:string,cls='')=>{const s=document.createElement('span');s.className=cls;s.innerHTML=gearIcons[kind]||gearIcons.rifle;return s;};
 const screen=()=>getState(ctx.world,Screen).unwrap() as ScreenId;
 const go=(next:ScreenId)=>{if(disposed)return;const current=screen();state.revision++;if(current==='deployment'&&next!=='battle'||(current==='battle'||current==='pause')&&next!=='battle'&&next!=='pause')ctx.world.getResource<BattleRuntime>(BATTLE_RUNTIME)?.stop();state.modal=null;setNextState(ctx.world,Screen,next).unwrap();};
 const currentClass=()=>classesFor(state.mode).find(c=>c.id===state.classId)!;
 const kit=()=>state.loadouts[runtimeFor(state.mode)];
 const economy=()=>economies[runtimeFor(state.mode)];
 const message=(text:string)=>{state.message=text;put('class-deploy-player-state',text);put('squad-intro-summary',text);};
 function refreshGear(){
  for(const id of ['class-deploy-loadout','squad-intro-loadout']){
   const list=find(id)!;list.replaceChildren();
   for(const slot of SLOT_IDS){
    const item=itemsFor(state.mode,slot).find(i=>i.id===kit()[slot]);
    const label=item?.name||(slot==='gadget1'?currentClass().activeSkill?.name:slot==='gadget2'?currentClass().passiveSkill?.name:kit()[slot])||SLOT_NAMES[slot];
    const b=button('', 'deploy-gear-slot'+(slot==='primary'?' primary':''),{nativeSlot:slot});
    b.title=SLOT_NAMES[slot]+' · '+label;b.setAttribute('aria-label',b.title);b.disabled=state.mode==='gungame'||!itemsFor(state.mode,slot).length;
    const small=document.createElement('small');small.textContent=SLOT_NAMES[slot];const strong=document.createElement('strong');strong.textContent=state.mode==='gungame'&&(slot==='primary'||slot==='secondary')?'击杀晋级':label;
    b.append(small,icon(item?.kind||slot,'frontline-gear-icon'),strong);list.append(b);
   }
  }
 }
 function refreshClasses(){
  const cls=currentClass(),grid=find('class-grid')!;grid.replaceChildren();
  for(const c of classesFor(state.mode)){
   const b=button('','class-card'+(c.id===state.classId?' selected':''),{nativeClass:c.id});b.setAttribute('aria-pressed',String(c.id===state.classId));b.setAttribute('aria-label',className(c));
   const emblem=document.createElement('span');emblem.className='native-class-emblem';emblem.innerHTML=classIcons[c.id]||classIcons.assault;
   const name=document.createElement('span');name.className='class-card-name';name.textContent=className(c);b.append(emblem,name);grid.append(b);
  }
  put('class-stage-name',className(cls));put('class-stage-role-text',cls.role);put('class-deploy-blurb',cls.blurb);
  for(const key of ['active','passive'] as const){const skill=key==='active'?cls.activeSkill:cls.passiveSkill;put('class-skill-'+key+'-name',skill?.name||'');put('class-skill-'+key+'-desc',skill?.desc||'');}
  show('class-stage-skills',true);show('class-stage-placeholder',false);put('squad-intro-current-class',className(cls));refreshGear();
 }
 function refreshSquad(){
  const cards=find('squad-intro-cards')!;cards.replaceChildren();const classes=classesFor(state.mode),count=teamless(state.mode)?1:4;
  cards.style.gridTemplateColumns=`repeat(${count},minmax(0,1fr))`;cards.style.maxWidth=count===1?'380px':'none';cards.style.margin=count===1?'auto':'0';
  for(let i=0;i<count;i++){
   const c=i===0?currentClass():classes[i%classes.length],card=document.createElement('div');card.className='squad-intro-card'+(!i?' is-player':'');
   const heading=document.createElement('div');heading.className='squad-member-heading';const name=document.createElement('strong');name.className='squad-member-name';name.textContent=i?'阿尔法-0'+(i+1):'你';heading.append(name);
   const desc=document.createElement('small');desc.className='squad-member-class';desc.textContent=className(c)+' · '+(itemsFor(state.mode,'primary').find(w=>w.id===kit().primary)?.name||kit().primary);
   const gear=document.createElement('div');gear.className='squad-card-gear';gear.append(icon('rifle'),icon('pistol'),icon('frag'));card.append(heading,desc,gear);cards.append(card);
  }
  put('squad-intro-title',teamless(state.mode)?'个人部署':'小队部署');put('squad-deploy-note',teamless(state.mode)?'个人竞技 · 各自为战':state.solo?'单人对局 · AI 支援':'本地对局 · AI 支援');
 }
 function refreshArsenal(){
  const slot=state.slot,items=itemsFor(state.mode,slot),item=items.find(i=>i.id===state.selectedItem)||items[0];if(!item)return;
  state.selectedItem=item.id;put('arsenal-title','选择'+SLOT_NAMES[slot]);put('arsenal-name',item.name);put('arsenal-desc',item.desc);put('arsenal-tags',item.category||SLOT_NAMES[slot]);put('arsenal-flavor','');
  const slots=find('arsenal-slots')!;slots.replaceChildren();for(const id of SLOT_IDS)if(itemsFor(state.mode,id).length)slots.append(button(SLOT_NAMES[id],'arsenal-slot'+(id===slot?' active':''),{nativeSlot:id}));
  const list=find('arsenal-list')!;list.replaceChildren();for(const row of items){const owned=ownsItem(state.mode,slot,row,economy()),equipped=kit()[slot]===row.id;const b=button('','arsenal-card'+(row.id===item.id?' selected':'')+(equipped?' equipped':'')+(owned?'':' locked'),{nativeItem:row.id});b.setAttribute('role','option');b.setAttribute('aria-selected',String(row.id===item.id));b.setAttribute('aria-label',row.name);const copy=document.createElement('span');copy.className='arsenal-card-copy';const name=document.createElement('strong');name.textContent=row.name;const status=document.createElement('small');status.textContent=owned?(equipped?'已装备':String(row.def?.caliber||'已拥有')):'未解锁';copy.append(name,status);b.append(icon(row.kind,'arsenal-card-icon'),copy);if(equipped||!owned){const mark=document.createElement('span');mark.className=equipped?'arsenal-check':'arsenal-lock';mark.setAttribute('aria-hidden','true');b.append(mark);}list.append(b);}
  const owned=ownsItem(state.mode,slot,item,economy());(find('arsenal-equip') as HTMLButtonElement).disabled=!owned||state.mode==='gungame';put('arsenal-equip-label',owned?(kit()[slot]===item.id?'已装备':'装备'):'尚未解锁');
  const stats=find('arsenal-detail')!;stats.replaceChildren();for(const [key,label] of [['damage','伤害'],['fireRate','射速'],['magSize','弹匣'],['range','射程'],['reloadTime','换弹时间']]){if(item.def?.[key]===undefined)continue;const row=document.createElement('div');row.className='arsenal-kv';const title=document.createElement('span');title.textContent=key==='fireRate'?'射速 (发/分)':label;const value=document.createElement('b');const n=Number(item.def[key]);value.textContent=String(key==='fireRate'&&n>0&&n<=5?Math.round(60/n):n);const track=document.createElement('span');track.dataset.originalTag='i';const fill=document.createElement('em');const limit=key==='fireRate'?1000:key==='range'?200:key==='reloadTime'?5:100;const amount=key==='fireRate'&&n>0&&n<=5?60/n:n;fill.style.width=String(Math.max(0,Math.min(100,amount/limit*100)))+'%';track.append(fill);row.append(title,track,value);stats.append(row);}
  // The 3D gun inspection is owned by the native presentation renderer.
  put('arsenal-headline',item.def?`${item.def.damage} 伤害 · ${item.def.magSize} 发 / 弹匣`:'');
 }
 function refreshInspection(){
  if(state.modal!=='arsenal')return;const fallback=find('arsenal-stage-fallback')!;
  if(Object.prototype.hasOwnProperty.call(runtimeFor(state.mode)==='small'?original.small.weapons:original.large.weaponCatalog,state.selectedItem)){
   fallback.hidden=true;void presentation.inspect(find('arsenal-canvas')!,state.selectedItem,state.mode).catch(error=>{if(!disposed){fallback.hidden=false;fallback.textContent='装备模型载入失败';message(String(error));}});
  }else{fallback.hidden=false;fallback.replaceChildren(icon(itemsFor(state.mode,state.slot).find(i=>i.id===state.selectedItem)?.kind||'rifle'));}
 }
 function render(){
  const next=screen(),lobby=next==='modes'||next==='servers';
  show('start-overlay',next==='home');show('mode-overlay',lobby);show('server-browser',next==='servers');show('mode-scroll',next==='modes'&&!archive);show('soldier-browser',next==='modes'&&archive);
  const sub=root.querySelector<HTMLElement>('.frontline-subnav');if(sub)sub.classList.toggle('hidden',next!=='modes'||archive);
  show('class-overlay',next==='equipment');show('squad-intro-overlay',next==='deployment');show('arsenal-overlay',state.modal==='arsenal');
  show('hud',next==='battle');show('pause-overlay',next==='pause');if(next!=='battle')show('victory-overlay',false);
  ui.host.classList.toggle('native-battle',next==='battle'||next==='pause');host?.setPointerLockAllowed?.(next==='battle');
  document.documentElement.dataset.frontlineScreen=next;ui.host.dataset.gameRuntime=runtimeFor(state.mode);ui.host.classList.toggle('frontline-small',runtimeFor(state.mode)==='small');
  const faction=teamless(state.mode)?'独立作战':'和平军团 · 蓝方',map=state.mode==='conquest'?'荒盆':state.mode==='demo'?'Dust 2':'作战区域';
  for(const prefix of ['class-deploy','squad-intro']){put(prefix+'-mode-name',MODE_NAMES[state.mode]);put(prefix+'-map-name',map);put(prefix+'-faction-name',faction);}
  put('class-deploy-player-count','装备整备');put('class-deploy-player-state',state.message||(state.solo?'单人对局 · AI 对战':'本地对局 · AI 自动补位'));
  if(next==='equipment'||next==='deployment'){refreshClasses();if(next==='deployment')refreshSquad();}
  if(state.modal==='arsenal')refreshArsenal();
  const target=state.modal==='arsenal'?null:next==='equipment'?find('class-stage-canvas'):next==='deployment'?find('squad-intro-canvas'):null;
  if(next==='battle'){const currentBattle=ctx.world.getResource<BattleState>(BATTLE);if(currentBattle)updateBattleHud(currentBattle);}
  if(next==='battle'||next==='pause')presentation.battle();else presentation.place(target,state.mode,state.classId,next==='deployment');
  refreshInspection();
 }
 function chooseMode(mode:ModeId,solo=false){archive=false;state.mode=mode;state.solo=solo;state.classId=classesFor(mode)[0].id;state.countdown=3;state.message='';go('equipment');}
 function openArsenal(slot:Slot){if(state.mode==='gungame'||!itemsFor(state.mode,slot).length)return;state.slot=slot;state.selectedItem=kit()[slot];state.modal='arsenal';render();}
 async function enterBattle(){
  if(entering)return;
  // No redirect or old-renderer fallback is permitted at the native boundary.
  const runtime=ctx.world.getResource<{start:(session:Session)=>Promise<void>}>('voxel-frontline/battle-runtime');
  if(!runtime){state.countdown=0;message('原生战斗运行模块尚未接通');return;}
  state.countdown=0;entering=true;const request=state.revision;message('正在载入战场…');try{await runtime.start(state);state.message='';if(!disposed&&request===state.revision&&screen()==='deployment')go('battle');}catch(e){if(!disposed&&request===state.revision)message('战场载入失败：'+(e instanceof Error?e.message:String(e)));}finally{entering=false;}
 }
 const enter=find('enter-hub-btn') as HTMLButtonElement;enter.disabled=false;enter.querySelector('span:last-child')!.textContent='进入大厅';(find('class-confirm-btn') as HTMLButtonElement).disabled=false;put('class-confirm-btn','部署进入战场');
 const click=(event:Event)=>{const target=event.target as Element;const combatSlot=target.closest<HTMLElement>('[data-combat-slot]');if(combatSlot&&screen()==='battle'){const battle=ctx.world.getResource<BattleState>(BATTLE);if(battle?.mode==='core'&&combatSlot.id!=='native-melee-slot'&&combatSlot.closest('#gadget-hud')){battle.gear?.cancel();battle.building?.select(combatSlot.dataset.slot==='4'?'cover':'tower');}else if(combatSlot.dataset.equipmentSlot)battle?.gear?.select(combatSlot.dataset.equipmentSlot as Slot);return;}const b=target.closest<HTMLElement>('button,[data-mode-action]');if(!b||(b as HTMLButtonElement).disabled)return;
  if(b.id==='enter-hub-btn'){event.preventDefault();coverActivatedAt=performance.now();archive=false;go('modes');return;}
  if((event as MouseEvent).detail>0&&performance.now()-coverActivatedAt<500&&(b.dataset.modeAction||b.dataset.quickMode)){event.preventDefault();return;}
  if(b.dataset.nativeClass){state.classId=b.dataset.nativeClass;state.revision++;render();return;}
  if(b.dataset.nativeSlot){openArsenal(b.dataset.nativeSlot as Slot);return;}
  if(b.dataset.nativeItem){state.selectedItem=b.dataset.nativeItem;refreshArsenal();refreshInspection();return;}
  if(b.dataset.quickMode){chooseMode(b.dataset.quickMode as ModeId);return;}
  switch(b.dataset.modeAction){
   case 'close':go('home');return;case 'mode-home':case 'server-back':archive=false;go('modes');return;case 'servers':go('servers');return;
   case 'solo':chooseMode('conquest',true);return;case 'conquest32':chooseMode('conquest');return;
  }
  switch(b.id){
   case 'class-cancel-btn':go('modes');break;
   case 'class-confirm-btn':state.countdown=3;go('deployment');break;
   case 'squad-intro-back':case 'squad-intro-customize':go('equipment');break;
   case 'squad-intro-skip':void enterBattle();break;
   case 'arsenal-back':state.modal=null;render();break;
   case 'arsenal-equip':if(equipItem(state.mode,state.slot,state.selectedItem,kit(),economy())){state.revision++;refreshGear();refreshArsenal();}break;
   case 'tutorial-btn':show('tutorial-overlay',true);break;case 'tutorial-back-btn':show('tutorial-overlay',false);break;
   case 'victory-btn':ctx.world.getResource<BattleRuntime>(BATTLE_RUNTIME)?.stop();go('modes');break;
   case 'pause-resume':go('battle');ctx.world.getResource<BattleRuntime>(BATTLE_RUNTIME)?.lock();break;case 'pause-leave':ctx.world.getResource<BattleRuntime>(BATTLE_RUNTIME)?.stop();go('modes');break;
  }
 };
 const key=(event:KeyboardEvent)=>{if(event.repeat||(event.target as Element)?.matches('input,textarea'))return;if(event.code==='Escape'){if(state.modal){state.modal=null;render();}else if(screen()==='equipment')go('modes');else if(screen()==='deployment')go('equipment');else if(screen()==='battle')go('pause');}else if(event.code==='KeyC'&&screen()==='equipment'){event.preventDefault();openArsenal('primary');}else if(event.code==='KeyX'&&screen()==='deployment'){event.preventDefault();go('equipment');}};
 const tacticalMap=createTacticalMap(find('minimap')!);
 const battleMessage=document.createElement('div');battleMessage.id='native-battle-message';battleMessage.setAttribute('aria-live','polite');find('hud')!.append(battleMessage);
 const updateEquipmentHud=createEquipmentHud(root,ui.host);
 function updateBattleHud(b:BattleState){
  tacticalMap.update(b);
  put('ammo-mag',String(b.mag));put('ammo-reserve',String(b.reserve));put('weapon-hud-name',b.weapon.nameZh||b.weapon.name);show('ammo-reload',b.reload>0);put('hp-num',String(Math.ceil(b.health)));put('armor-num',String(Math.ceil(b.armor)));put('hp-blocks','█'.repeat(Math.max(0,Math.min(16,Math.ceil(b.health/100*16)))));put('armor-blocks','█'.repeat(Math.max(0,Math.min(16,Math.ceil(b.armor/100*16)))));
  updateEquipmentHud(b);
   put('core-count',String(b.buildCores));put('block-count',String(b.buildBlocks));const resources=find('resources');if(resources)resources.style.display=b.mode==='core'?'block':'none';const arena=b.arena,match=arena?.match;find('hud')!.classList.toggle('native-arena',!!arena);show('home-seg-bar',!arena);show('mission-seg-bar',!arena);show('ticket-ally',!!arena);show('ticket-enemy',!!arena);
  if(match){const ranking=match.ranking(),row=match.playerStats?match.playerStats():match.stats.player;put('ticket-ally',String(match.score?.ally??row?.level??row?.kills??0));put('ticket-enemy',String(match.score?.enemy??ranking[0]?.level??ranking[0]?.kills??0));const seconds=Math.ceil(match.phase==='prep'||match.phase==='buy'?match.phaseLeft:match.timeLeft);put('timer',!Number.isFinite(seconds)?'核心攻防':match.phase==='prep'?'准备 '+seconds:String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0'));put('kill-feed',match.feed.map((entry:any)=>(entry.killer||'环境')+' → '+entry.victim).join('\n'));put('squad-count',String(arena.squadCounts[0]));put('hostile-count',String(arena.squadCounts[1]));
   const meleeFlash=b.gear?.melee.flash,crosshair=find('crosshair');if(crosshair){crosshair.classList.toggle('fire',meleeFlash==='fire');crosshair.classList.toggle('hit',meleeFlash==='hit'||meleeFlash==='kill');crosshair.classList.toggle('hit-kill',meleeFlash==='kill');crosshair.style.visibility=b.inspect?.active?'hidden':'';}
   show('victory-overlay',b.inspect?.resultsReady??!!match.ended);if(match.ended){put('victory-title',match.winner===(teamless(b.mode)?'player':'ally')?'胜利':match.winner?'本局结束':'平局');put('victory-sub',match.endReason);put('victory-flavor',ranking.slice(0,5).map((r:any)=>r.name+'  '+(r.kills??0)+' 击杀').join(' · '));}
   battleMessage.textContent=b.inspect?.active?'检查武器':b.downed?'倒地 · '+Math.ceil(arena.downed.find(d=>d.target.isPlayer)?.left??0)+' 秒可救援 · 按住空格 1.2 秒放弃':b.dead?(b.mode==='demo'?'本回合阵亡 · 等待下一回合':'阵亡 · '+Math.ceil(arena.spawn.respawnLeft())+' 秒后重新部署'):b.noticeLeft>0?b.notice:[b.building?.hint(),b.vehicles?.hint(),b.gear?.hint(),arena.hint(),b.skills?.hint()].filter(Boolean).join(' · ');
   Object.assign(ui.host.dataset,{inspect:JSON.stringify(b.inspect?.snapshot()),combatants:String(arena.ai.aliveCount('ally')+arena.ai.aliveCount('enemy')+(b.dead?0:1)),teamScore:JSON.stringify(match.score||{}),matchPhase:match.phase,health:String(b.health),audio:JSON.stringify(b.audio?.getState()),skill:JSON.stringify(b.skills?.snapshot()),armor:String(b.armor),downed:JSON.stringify(arena.downed.map(d=>({id:d.target.id,team:d.target.team,left:d.left,position:arena.position(d.target)}))),grenades:String(b.grenades),shots:String(b.shots),buildBlocks:String(b.buildBlocks),buildCores:String(b.buildCores),yaw:String(b.yaw),pitch:String(b.pitch),physicsBodies:String(b.physics.backend.getBodyCount()),renderChunks:String(b.chunks.size),cameraPosition:JSON.stringify(b.physics.position(b.camera)),groundHeight:String(b.map.walkHeight(...[b.physics.position(b.playerBody)[0],b.physics.position(b.playerBody)[2]] as [number,number])),vehicle:JSON.stringify(b.vehicles?.seated?{id:b.vehicles.seated.id,hp:b.vehicles.seated.hp}:null),vehicles:JSON.stringify(b.vehicles?.vehicles.map(v=>({id:v.id,hp:v.hp,ammo:v.ammo,shots:v.armament.shots,reserve:v.armament.reserve,heat:v.armament.heat,reloads:v.armament.reloads,position:b.physics.position(v.entity)}))||[]),playerPosition:JSON.stringify(b.physics.position(b.playerBody)),objectives:JSON.stringify(arena.objectives),controlPoints:JSON.stringify(arena.coreSpawns.points),traversing:String(arena.traversingPlayer),bomb:JSON.stringify(arena.bomb?.snapshot()),aiPositions:JSON.stringify(arena.units.map(u=>({id:u.id,team:u.team,hp:u.hp,position:arena.position(u),path:u.path.length,mission:u.mission}))),aiMissions:JSON.stringify(arena.units.filter(u=>u.alive).slice(0,8).map(u=>u.mission))});
  }else{battleMessage.textContent=b.noticeLeft>0?b.notice:'';}
 }
 const unsub=Screen.variants.map(value=>addOnEnter(Screen,value,()=>render()));
 const systemName='voxel-frontline/deployment';ctx.world.addSystem(Update,{name:systemName,queries:[],fn:world=>{if(screen()==='battle'){const b=world.getResource<BattleState>(BATTLE);if(b){updateBattleHud(b);}return;}if(screen()!=='deployment'||state.modal||state.countdown<=0)return;state.countdown=Math.max(0,state.countdown-world.getResource(Time).delta);put('squad-intro-countdown',String(Math.ceil(state.countdown)));if(state.countdown===0)void enterBattle();}}).unwrap();
 root.addEventListener('click',click);document.addEventListener('keydown',key);const resize=()=>render();window.addEventListener('resize',resize);render();
 ui.host.dataset.migrationStage='native-gameplay';
 ctx.effect(()=>()=>{disposed=true;unsub.forEach(stop=>stop());ctx.world.removeSystem(Update,systemName).unwrap();root.removeEventListener('click',click);document.removeEventListener('keydown',key);window.removeEventListener('resize',resize);ctx.world.removeResource(SESSION);tacticalMap.dispose();presentation.dispose();ui.dispose();},'voxel-frontline/ui');
}};
export default plugin;
