import type {BattleState} from '../gameplay/battle.plugin.ts';
import {gearIcons} from '../original/icons.ts';
import {itemsFor,weaponsFor,type Slot} from '../gameplay/catalog.ts';
/** UI projects the authoritative carried inventory; it never grants items. */
export function createEquipmentHud(root:ShadowRoot,host:HTMLElement){
 const find=(id:string)=>root.getElementById(id) as HTMLElement;
 const put=(id:string,value:string)=>{const el=find(id);if(el)el.textContent=value;};
 const show=(id:string,visible:boolean)=>find(id)?.classList.toggle('hidden',!visible);
 const throwButton=find('throw-hud').querySelector<HTMLElement>('[data-throw-id]')!;
 for(const e of [...find('throw-hud').querySelectorAll('[data-throw-id]')].slice(1))e.remove();
 const melee=find('gadget-hud').querySelector<HTMLElement>('[data-slot]')!.cloneNode(true) as HTMLElement;
 melee.id='native-melee-slot';find('gadget-hud').append(melee);
 const slots=[...find('gadget-hud').querySelectorAll<HTMLElement>('[data-combat-slot]')];
 const overlay=document.createElement('div');overlay.id='native-equipment-effect';overlay.setAttribute('aria-hidden','true');find('hud').append(overlay);
 const status=document.createElement('div');status.id='native-throwable-status';status.className='hidden';status.setAttribute('role','status');find('hud').append(status);
 const drawIcon=(el:HTMLElement,kind:string)=>{if(el.dataset.equipmentIcon===kind)return;el.dataset.equipmentIcon=kind;el.classList.add('native-equipment-icon');el.innerHTML=gearIcons[kind]||gearIcons.rifle;};
 const classIcon=document.createElement('div');classIcon.className='skill-icon native-large-class-icon hidden';find('skill-active').querySelector('.skill-icon-wrap')!.append(classIcon);
 const optic=document.createElement('div');optic.id='native-binocular-optic';optic.className='hidden';optic.setAttribute('aria-hidden','true');find('hud').append(optic);
 return (b:BattleState)=>{
  const g=b.gear;if(!g)return;const inv=g.inventory,large=b.mode==='conquest',knife=large||b.mode!=='core'&&b.mode!=='gungame';
  const name=(slot:Slot)=>itemsFor(b.mode,slot).find(i=>i.id===inv.loadout[slot])?.name||inv.loadout[slot];
  slots.forEach((el,i)=>{
   const slot:Slot=i===2?'melee':i===0?'gadget1':'gadget2',key=i===2?(large?'6':'3'):String(i+(large?3:4));
   el.classList.toggle('hidden',i===2?!knife:!large&&b.mode!=='core');
   el.dataset.equipmentSlot=slot;el.dataset.slot=key;
   const label=large||i===2?name(slot):i===0?'掩体':'防御塔';
   el.querySelector('.slot-key')!.textContent=key;el.querySelector('.slot-name')!.textContent=label;
   el.querySelector('.gadget-slot-role')!.textContent=i===2?'近战':large?'配件 '+(i+1):'建造';
   const id=inv.loadout[slot];el.querySelector('.slot-icon')!.className='slot-icon '+(i===2?'weapon-knife':id==='rpg'?'weapon-rpg':'gadget-'+id);
   drawIcon(el.querySelector<HTMLElement>('.slot-icon')!,i===2?'knife':id);
   el.title=label+' ('+key+')';el.classList.toggle('selected',inv.slot===slot&&!b.building?.active);
  });
  const id=inv.loadout.grenade;throwButton.dataset.throwId=id;throwButton.dataset.equipmentSlot='grenade';throwButton.title=name('grenade');
  throwButton.querySelector('.skill-keybind')!.textContent=large?'G':'Q';throwButton.querySelector('.throw-icon')!.className='skill-icon throw-icon throw-icon-'+(id==='semtex'?'frag':id==='stun'?'flash':id==='molotov'?'smoke':id);
  drawIcon(throwButton.querySelector<HTMLElement>('.throw-icon')!,id==='semtex'?'charge':id==='stun'?'flash':id==='molotov'?'grenade':id);
  throwButton.classList.toggle('selected',inv.slot==='grenade');throwButton.setAttribute('aria-label',name('grenade')+'，剩余 '+inv.grenades);
  show('throw-hud',b.mode!=='gungame');put('throwable-count',String(inv.grenades));
  show('gadget-ammo',inv.id==='charge');put('gadget-ammo','C4 '+g.availableCharges+' · 已投出 '+g.projectile.charges.length);
  show('skill-active',true);show('skill-passive',true);find('skill-active').querySelector('.skill-keybind')!.textContent=large?(b.classId==='recon'?'Q':'X'):'G';find('skill-active').title=b.skills?.hint()||'';
  classIcon.classList.toggle('hidden',!large);classIcon.textContent=b.classId==='engineer'?'⚒':b.classId==='recon'?'⌖':'✚';
  const alias=large?({assault:'vanguard',support:'medic',recon:'ghost',engineer:'engineer'} as Record<string,string>)[b.classId]:b.classId;
  const passive:Record<string,string>={vanguard:'切换武器 / 换弹速度 ×1.15',medic:'每次部署初始护甲 100',ghost:'从背面射击伤害 ×1.3',juggernaut:'受到攻击伤害 ×0.94',raider:'掉落弹药 ×1.3 / 增加资源回收',engineer:'初始 20 建材 / 建造结构承受 2 次打击'};find('skill-passive').title=passive[alias]||'';
  const skill=b.skills?.snapshot(),dash=find('dash-hud');dash.hidden=false;show('dash-hud',true);show('dash-cd-overlay',(skill?.dashCooldown??0)>0);put('dash-cd-num',String(Math.ceil(skill?.dashCooldown??0)));
  show('skill-passive-time',!!skill?.ambush||b.speedBoostUntil>b.elapsed);put('skill-passive-time-num',skill?.ambush?'+40':String(Math.ceil(b.speedBoostUntil-b.elapsed)));
  for(const e of root.querySelectorAll<HTMLElement>('[data-skill-icon]'))e.classList.toggle('hidden',e.dataset.skillIcon!==alias||large&&!!e.closest('#skill-active'));
  show('skill-cd-overlay',b.skillCooldown>0);put('skill-cd-num',String(Math.ceil(b.skillCooldown)));
  put('weapon-hud-name',inv.gun?(b.weapon.nameZh||b.weapon.name):inv.skill?'C4 遥控炸药':name(inv.slot));
  const item=itemsFor(b.mode,inv.slot).find(i=>i.id===inv.id);drawIcon(find('weapon-silhouette'),inv.gun?(b.weapon.category==='pistol'?'pistol':b.weaponId==='rpg'?'rpg':'rifle'):item?.kind||inv.id);
  put('weapon-slot-key',inv.skill?'G':inv.slot==='primary'?'1':inv.slot==='secondary'?'2':inv.slot==='gadget1'?'3':inv.slot==='gadget2'?'4':inv.slot==='grenade'?(large?'5':'Q'):large?'6':'3');show('weapon-fire-mode',inv.gun);put('weapon-fire-mode-label',b.weapon.automatic?'全自动':'单发');
  const stowed=inv.slot==='secondary'?inv.loadout.primary:inv.loadout.secondary,def=weaponsFor(b.mode)[stowed],ammo=b.ammoState[stowed];put('stowed-weapon-key',inv.slot==='secondary'?'1':'2');put('stowed-weapon-name',def?.nameZh||def?.name||stowed);put('stowed-weapon-ammo',ammo?ammo.mag+' / '+ammo.reserve:'');drawIcon(find('stowed-weapon-silhouette'),def?.category==='pistol'?'pistol':'rifle');
  if(!inv.gun){put('ammo-mag',inv.id==='charge'?String(g.availableCharges):inv.slot==='grenade'?String(inv.grenades):'—');put('ammo-reserve','');}
  show('native-binocular-optic',inv.id==='binoculars'&&b.ads&&!b.dead&&!b.vehicles?.seated);
  overlay.style.background=g.flash?'rgba(255,255,245,'+g.flash+')':g.smokeOpacity?'rgba(125,134,137,'+g.smokeOpacity+')':'transparent';
  const snapshot=g.snapshot();status.textContent=snapshot.flash>0?'闪光致盲 · '+snapshot.flash.toFixed(1)+' 秒':snapshot.stun>0?'震撼 · 移动 / 转向减缓 '+snapshot.stun.toFixed(1)+' 秒':g.smokeOpacity>.1?'烟雾遮挡视线':'';status.classList.toggle('hidden',!status.textContent);
  host.dataset.equipment=JSON.stringify(snapshot);
 };
}
