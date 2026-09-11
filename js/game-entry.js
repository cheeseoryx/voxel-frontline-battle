/** Whitelisted navigation shared by both game runtimes. */
(function(global){
'use strict';
const root=new URL('../',document.currentScript.src);
const ids=['tdm','demo','ffa','gungame','core'];
const names={tdm:'团队死斗',demo:'爆破模式',ffa:'自由混战',gungame:'枪械模式',core:'核心攻防'};
const params=new URLSearchParams(global.location.search);
const selection={mode:ids.includes(params.get('mode'))?params.get('mode'):null,screen:params.get('screen')==='modes'?'modes':null,room:/^[A-Z0-9]{4,8}$/.test(params.get('room')||'')?params.get('room'):null};
let navigationPending=false,coverClick=null;
function showTransition(message){
 if(!document.body)return;
 let panel=document.getElementById('game-entry-transition');
 if(!panel){panel=document.createElement('div');panel.id='game-entry-transition';panel.setAttribute('role','status');panel.style.cssText='position:fixed;inset:0;z-index:3000;display:grid;place-items:center;background:#15232ff2;color:#dcebf3;font:18px Microsoft YaHei, sans-serif;letter-spacing:2px';document.body.append(panel);}
 panel.textContent=message;
}
function hideTransition(){const panel=document.getElementById('game-entry-transition');if(panel)panel.remove();}
function navigate(relative){
 if(navigationPending)return;
 navigationPending=true;
 showTransition(relative.startsWith('modes/')?'正在载入作战模式…':relative==='index.html'?'正在返回首页…':'正在返回模式大厅…');
 global.dispatchEvent(new Event('vf:navigate'));
 const destination=new URL(relative,root);
 if(global.parent!==global && /[?&]kubee=1(?:&|$)/.test(global.location.search))destination.searchParams.set('kubee','1');
 global.location.assign(destination.href);
}
function listSmallServers(){
 const out=[],now=Date.now();
 try{for(let i=0;i<localStorage.length;i++){
  const key=localStorage.key(i);if(!/^vf_small_pvp_bus_[A-Z0-9]{4,8}$/.test(key))continue;
  let s;try{s=JSON.parse(localStorage.getItem(key));}catch(_){continue;}
  if(!s||!s.host||now-s.host.ts>=10000||!s.start||!s.start.quick||!ids.includes(s.start.matchMode))continue;
  const guest=!!(s.guest&&now-s.guest.ts<10000);
  out.push({code:s.code,name:names[s.start.matchMode]+' · '+s.code,map:'模式战场',mode:s.start.matchMode,modeLabel:names[s.start.matchMode],size:2,sizeLabel:'2 真人席位 + AI',players:1+(guest?1:0),capacity:2,ping:null,official:false,password:false,phase:s.winner||s.tdmEnd||s.host.ended?'closed':s.host.phase,runtime:'small',createdAt:s.start.createdAt||0});
 }}catch(_){}
 return out;
}
global.VFEntry={
 selection,modeNames:names,listSmallServers,showTransition,hideTransition,
 get navigating(){return navigationPending;},
 openSmallBattle:function(mode,room){
  let dest='modes/small-battle/index.html';
  if(ids.includes(mode)){dest+='?mode='+mode;if(/^[A-Z0-9]{4,8}$/.test(room||''))dest+='&room='+room;}
  navigate(dest);
 },
 goHome:()=>navigate('index.html'),
 goLobby:()=>navigate('index.html?screen=modes')
};
document.addEventListener('click',function(event){
 const cover=event.target.closest('#enter-hub-btn');
 if(cover&&!cover.disabled){
  event.preventDefault();event.stopImmediatePropagation();
  coverClick={x:event.clientX,y:event.clientY,at:performance.now()};
  if(document.body.dataset.gameRuntime==='small')global.VFEntry.goLobby();
  else if(global.VF&&global.VF.openFrontlineHub)global.VF.openFrontlineHub();
  else if(global.VF&&global.VF.UI&&global.VF.UI.openModeSelect)global.VF.UI.openModeSelect();
  return;
 }
 if(coverClick&&performance.now()-coverClick.at<500&&event.detail>0&&Math.hypot(event.clientX-coverClick.x,event.clientY-coverClick.y)<12&&event.target.closest('[data-mode-action],[data-quick-mode]')){event.preventDefault();event.stopImmediatePropagation();return;}
 const button=event.target.closest('[data-game-entry]');if(!button||button.disabled)return;
 const target=button.getAttribute('data-game-entry');if(!['home','small-battle','lobby'].includes(target))return;
 event.preventDefault();event.stopPropagation();
 if(target==='small-battle')global.VFEntry.openSmallBattle();else if(target==='lobby')global.VFEntry.goLobby();else global.VFEntry.goHome();
},true);
if(typeof document.addEventListener==='function')document.addEventListener('DOMContentLoaded',()=>{
 if(document.body.dataset.gameRuntime==='small'&&selection.mode)showTransition('正在载入'+names[selection.mode]+'…');
 else if(selection.screen==='modes')showTransition('正在载入模式大厅…');
});
global.addEventListener('pageshow',event=>{
 if(!event.persisted)return;
 navigationPending=false;hideTransition();
 if(document.body.dataset.gameRuntime==='small'){global.VFEntry.goLobby();return;}
 if(global.VF&&global.VF.game)global.VF.game._leaving=false;
});
})(window);
