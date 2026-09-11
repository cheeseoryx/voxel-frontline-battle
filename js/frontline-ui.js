/** Shared UI adapters. Gameplay eligibility stays in each runtime. */
(function(global){
'use strict';
const VF=global.VF,UI=VF.UI,small=document.body.dataset.gameRuntime==='small';
document.body.classList.add(small?'frontline-small':'frontline-large');
const el=id=>document.getElementById(id),put=(id,text)=>{if(el(id))el(id).textContent=text;};
const className=c=>c?(c.nameZh||(c.label||'').split('|').pop().trim()||c.nameEn||c.id):'';
const selectedInfo=()=>VF.Soldier.CLASSES.find(c=>c.id===UI.selectedClassId)||VF.Soldier.CLASSES[0];
const modeName=()=>small?VFEntry.modeNames[VF.GameModes.currentId()]:'大型战争 · 征服';
function metadata(){
 const g=VF.game,pvp=g.mode==='pvp';
 put('class-deploy-player-count','装备整备');
 put('class-deploy-player-state',pvp?'房间 '+(VF.Pvp.roomCode||'')+' · AI 自动补位':'单人对局 · AI 对战');
 if(small){put('class-deploy-map-name',g.world._mapName||'作战区域');put('class-deploy-mode-name',modeName());}
 put('class-deploy-faction-name',small&&VF.GameModes.isTeamless()?'独立作战':(g.world._playerTeam||(g.pvp&&g.pvp.team))==='enemy'?'赤焰军团 · 红方':'和平军团 · 蓝方');
}
function bindSquadElements(){
 const map={squadIntroOverlay:'squad-intro-overlay',squadIntroMapName:'squad-intro-map-name',squadIntroModeName:'squad-intro-mode-name',squadIntroFactionName:'squad-intro-faction-name',squadIntroCanvas:'squad-intro-canvas',squadIntroCards:'squad-intro-cards',squadIntroCurrentClass:'squad-intro-current-class',squadIntroCountdown:'squad-intro-countdown',squadIntroSkip:'squad-intro-skip',squadIntroBack:'squad-intro-back',squadIntroCustomize:'squad-intro-customize'};
 Object.keys(map).forEach(k=>UI.els[k]=el(map[k]));
}
function gear(){
 if(!small)return;
 const c=selectedInfo(),E=VF.Economy,defs=VF.WEAPONS,g=VF.game;
 put('class-deploy-blurb',(c.blurb||c.role||'').split('主动')[0].replace(/[。；;\s]+$/,'')+'。');
 [['active',c.activeSkill],['passive',c.passiveSkill]].forEach(([key,s])=>{put('class-skill-'+key+'-name',s?s.name:'');put('class-skill-'+key+'-desc',s?s.desc:'');});
 const locked=VF.GameModes.isGg();
 const primary=E.weaponForSlot(1),secondary=E.weaponForSlot(2);
 const thrown=(VF.THROWABLE_CATALOG||{})[E.throwableForSlot()];
 const wname=id=>defs[id]?(defs[id].nameZh||defs[id].name||id):id;
 const items=[['主武器',locked?'击杀晋级':wname(primary),1],['副武器',locked?'模式锁定':wname(secondary),2],['近战','战术匕首',0],['投掷物',locked?'模式禁用':(thrown?thrown.nameZh:'破片手雷'),4],['技能',c.activeSkill?c.activeSkill.name:'兵种技能',0],['特性',c.passiveSkill?c.passiveSkill.name:'兵种特性',0]];
 for(const id of ['class-deploy-loadout','squad-intro-loadout']){
  const host=el(id);if(!host)continue;host.replaceChildren();
  items.forEach(([label,name,slot],i)=>{
   const b=document.createElement('button');b.type='button';b.className='deploy-gear-slot'+(!i?' primary':'');b.title=label+' · '+name;b.disabled=!slot||locked;
   const s=document.createElement('small');s.textContent=label;const strong=document.createElement('strong');strong.textContent=name;
   const icon=document.createElement('span');icon.className='frontline-gear-icon';icon.innerHTML=UI._deployGearSvg(['rifle','shotgun','knife','frag','ammo','optic'][i]);
   b.append(s,icon,strong);
   if(slot&&!locked)b.addEventListener('click',()=>{
    // Opening the arsenal during the showcase freezes its personal timer.
    const remaining=UI.squadIntroOpen?Math.max(.2,(UI._squadIntroEndsAt-performance.now())/1000):null;
    if(remaining!==null)clearInterval(UI._squadIntroTimer);
    VF.Arsenal.show({slot,onClose:()=>{gear();if(remaining!==null&&UI.squadIntroOpen)UI._startSquadIntroCountdown(remaining);}});
   });
   host.append(b);
  });
 }
}
if(small){
 UI._playerTeam=()=>VF.game.world._playerTeam||'ally';
 UI.closeArsenal=()=>{if(VF.Arsenal)VF.Arsenal.hide();};
 UI._syncDeployClassDetails=gear;
 const update=UI._updateClassStageUI;
 UI._updateClassStageUI=function(){update.apply(this,arguments);gear();put('class-stage-name',className(selectedInfo()));};
 const init=UI.init;UI.init=function(){init.apply(this,arguments);bindSquadElements();};
 const build=UI._buildClassGrid;UI._buildClassGrid=function(){build.apply(this,arguments);this.els.classGrid.querySelectorAll('.class-card').forEach(b=>{const c=VF.Soldier.CLASSES.find(c=>c.id===b.dataset.classId);b.querySelector('.class-card-name').textContent=className(c);b.setAttribute('aria-pressed',b.dataset.classId===this.selectedClassId?'true':'false');});};
 const open=UI.openClassSelect;
 UI.openClassSelect=function(confirm,cancel,preferred){
  open.call(this,confirm,cancel,preferred||VF.game.playerClass||'vanguard');
  metadata();gear();
 };
 global.addEventListener('keydown',e=>{
  if(VF.Arsenal.isOpen&&e.code==='Escape'){e.preventDefault();e.stopImmediatePropagation();VF.Arsenal.hide();return;}
  if(e.repeat||!UI.classSelectOpen||VF.Arsenal.isOpen)return;
  if(e.code==='KeyC'&&!VF.GameModes.isGg()){e.preventDefault();VF.Arsenal.show({onClose:gear});}
  if(e.code==='Escape'){e.preventDefault();if(UI._classOnCancel)UI._classOnCancel();}
 },true);
}else{
 const open=UI.openClassSelect;
 UI.openClassSelect=function(){const result=open.apply(this,arguments);metadata();return result;};
 document.addEventListener('click',e=>{
  const b=e.target.closest('[data-quick-mode],[data-server-runtime]');
  if(!b||b.disabled)return;
  e.preventDefault();e.stopImmediatePropagation();
  if(b.dataset.serverRuntime==='small')VFEntry.openSmallBattle(b.dataset.serverModeId,b.dataset.serverCode);
  else if(b.dataset.quickMode)VFEntry.openSmallBattle(b.dataset.quickMode);
 },true);
}
put('class-confirm-btn','部署进入战场');
const canvas=el('class-stage-canvas');
if(canvas){let start=null;canvas.addEventListener('pointerdown',e=>{start={x:e.clientX,yaw:UI._menuRotation||.12};canvas.setPointerCapture(e.pointerId);});canvas.addEventListener('pointermove',e=>{if(start)UI._menuRotation=start.yaw+(e.clientX-start.x)*.009;});for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,()=>{start=null;});}
const syncSquadEquipment=UI._syncDeployClassDetails;
UI._syncDeployClassDetails=function(){const result=syncSquadEquipment.apply(this,arguments);if(!small){const kit=VF.Arsenal&&VF.Arsenal.getStripItems?VF.Arsenal.getStripItems(arguments[0]||selectedInfo()):[];const labels={primary:'主武器',secondary:'副武器',gadget1:'轻型装备',gadget2:'重型装备',grenade:'投掷物',melee:'近战'};document.querySelectorAll('#squad-intro-loadout .deploy-gear-slot').forEach((button,index)=>{const icon=button.querySelector('svg');if(icon&&kit[index])icon.outerHTML=UI._squadGearIcon(kit[index].kind);const label=button.querySelector('small');if(label)label.textContent=labels[button.dataset.arsenalSlot]||label.textContent;button.setAttribute('aria-label',button.title);});}return result;};
const squad=UI.openSquadIntro;
UI.openSquadIntro=function(roster,done,opts){
 roster=roster.slice().sort((a,b)=>Number(b.isPlayer)-Number(a.isPlayer));
 squad.call(this,roster,done,Object.assign({durationSec:3},opts));
 const teamless=small&&VF.GameModes.isTeamless();
 put('squad-intro-title',teamless?'个人部署':'小队部署');
 const factionSub=document.querySelector('.squad-intro-faction small');
 if(factionSub)factionSub.textContent=teamless?'各自为战':(this._playerTeam()==='enemy'?'红方':'蓝方');
 put('squad-intro-summary',teamless?'个人竞技 · 独立部署':'支援编组预览 · '+roster.filter(m=>m.isPlayer).length+' 名玩家 · '+roster.filter(m=>!m.isPlayer).length+' 名 AI');
 put('squad-deploy-note',teamless?'个人竞技 · 各自为战':VF.game.mode==='pvp'?'真人加入后替换 AI 席位':'单人对局 · AI 支援');
 el('squad-intro-cards').style.gridTemplateColumns='repeat('+roster.length+',minmax(0,1fr))';
 if(teamless){put('squad-intro-faction-name','独立作战');el('squad-intro-cards').style.maxWidth='380px';el('squad-intro-cards').style.margin='auto';}
 else{el('squad-intro-cards').style.maxWidth='none';}
};
VF.FrontlineUI={metadata,gear,requestPointerLock:function(canvas){
 if(!canvas||!canvas.isConnected||document.visibilityState==='hidden')return;
 try{const pending=canvas.requestPointerLock();if(pending&&pending.catch)pending.catch(()=>{});}catch(_){}
}};
})(window);
