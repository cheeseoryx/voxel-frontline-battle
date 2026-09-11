/** Quick-entry adapter for the existing two-human small-battle transport. */
(function(global){
'use strict';
const VF=global.VF,P=VF.Pvp,UI=VF.UI;
let timeout=0;
function status(message,actions){
 let box=document.getElementById('frontline-match-status');
 if(!box){box=document.createElement('div');box.id='frontline-match-status';box.className='frontline-match-status';box.setAttribute('role','status');document.body.append(box);}
 box.replaceChildren();const text=document.createElement('div');text.textContent=message;box.append(text);
 (actions||[]).forEach(([label,fn])=>{const b=document.createElement('button');b.textContent=label;b.onclick=fn;box.append(b);});
}
function clear(){clearTimeout(timeout);const box=document.getElementById('frontline-match-status');if(box)box.remove();}
const oldLobby=P._openLobbyUI;
P._openLobbyUI=function(){if(this._quickPending||this.quickSession){status('正在连接作战房间…',[['返回模式大厅',()=>{P.destroySession();VFEntry.goLobby();}]]);return;}return oldLobby.apply(this,arguments);};
const oldCreate=P.createRoom;
P.createRoom=function(opts){
 const quick=!!(opts&&opts.quick)||!!this._quickPending||!!this.quickSession;
 const mode=(opts&&opts.mode)||(this._quickPending&&this._quickPending.mode)||VF.GameModes.currentId();
 if(quick)this._quickPending={mode};
 oldCreate.call(this);
 if(!quick||this.mode!=='host')return;
 this.quickSession=true;
 this.matchSeed=(Date.now()^((Math.random()*1e9)|0))>>>0;
 const payload={type:'start',seed:this.matchSeed,hostTeam:'ally',guestTeam:'enemy',matchMode:mode,quick:true,createdAt:Date.now(),fromId:this._busClientId};
 this._pendingStart=payload;this._busPublish();this._send(payload);this._beginMatchFromNet(payload);
};
const oldBegin=P._beginMatchFromNet;
P._beginMatchFromNet=function(data){
 if(this._lobbyDone||VFEntry.navigating)return;
 if(this._quickPending&&(!data.quick||data.matchMode!==this._quickPending.mode)){
  this.destroySession();status('房间玩法已变化，请重新选择。',[['返回模式大厅',()=>VFEntry.goLobby()]]);return;
 }
 this.quickSession=!!data.quick;
 if(this.quickSession)clear();
 return oldBegin.call(this,data);
};
P.quickMatch=function(mode,code){
 if(this._quickBusy)return;
 this._quickBusy=true;
 const run=()=>{
  if(VFEntry.navigating)return;
  this._quickPending={mode};
  const known=code&&VFEntry.listSmallServers().find(r=>r.code===code);
  if(known&&(known.mode!==mode||known.players>=known.capacity||known.phase==='closed')){this._quickBusy=false;status('这个房间已满、已结束或玩法不匹配。',[['返回模式大厅',()=>VFEntry.goLobby()]]);return;}
  const rooms=VFEntry.listSmallServers().filter(r=>r.mode===mode&&r.players<r.capacity&&r.phase!=='closed');
  const best=code?rooms.find(r=>r.code===code):rooms.sort((a,b)=>b.createdAt-a.createdAt)[0];
  if(best||code){
   const room=code||best.code;
   this.els.joinCode.value=room;
   this.joinRoom();
   if(!this._lobbyDone)timeout=setTimeout(()=>{
    if(this._lobbyDone)return;
    this.destroySession();
    if(!code)this.createRoom({quick:true,mode});
    else status('暂时无法连接这个房间。',[['重新匹配',()=>{this._quickBusy=false;this.quickMatch(mode);}],['返回模式大厅',()=>VFEntry.goLobby()]]);
   },8000);
  }else this.createRoom({quick:true,mode});
 };
 // Serialize local discovery and seat claims across tabs.
 if(global.navigator.locks)global.navigator.locks.request('vf-small-match-'+mode,run).catch(()=>{this._quickBusy=false;status('匹配失败，请重试。',[['返回模式大厅',()=>VFEntry.goLobby()]]);});
 else run();
};
P.enterQuickBattle=function(loadout,onEnter){
 this.localLoadout=loadout;this.spawnReadyLocal=true;this._onEnterBattlefield=onEnter;
 VF.game._quickSeatApplied=this.remoteHumanSlots()>0;
 this._enterBattlefield({seed:this.matchSeed});
 [VF.TdmMatch,VF.FfaMatch,VF.GgMatch].forEach(match=>{if(match&&match.active&&match.phase==='prep')match.phaseLeft=0;});
 this._busPublish();
 this._send({type:'quickDeployed',loadout});
};
const oldData=P._onData;
P._onData=function(data){
 if(typeof data==='string'){try{data=JSON.parse(data);}catch(_){return;}}
 if(data&&data.type==='enter'&&this.quickSession)return;
 if(data&&data.type==='quickDeployed'){
  this.remotePresent=true;this.remoteLoadout=data.loadout;this._remoteDeployed=true;this._syncQuickSeat();
  return;
 }
 const result=oldData.call(this,data);
 if(data&&data.type==='hello'&&this.mode==='host'&&this.quickSession&&this._pendingStart){
  this._send(this._pendingStart);
  if(this.phase==='play')this._send({type:'quickDeployed',loadout:this.localLoadout});
 }
 return result;
};
// Reserve an AI slot only when the remote human has actually deployed.
P.remoteHumanSlots=function(team){
 if(!this.quickSession)return 0;
 const remoteTeam=VF.GameModes.isTeamless()?'enemy':(this.mode==='host'?'enemy':'ally');
 return this._remoteDeployed&&this.remotePresent&&(!team||team===remoteTeam)?1:0;
};
P._syncQuickSeat=function(){
 const g=VF.game;if(!this.quickSession||!g||!g.running||!g.ai)return;
 const deployed=this.remoteHumanSlots()>0;
 if(g._quickSeatApplied===deployed)return;
 g._quickSeatApplied=deployed;
 const ai=g.ai,team=VF.GameModes.isTeamless()?'enemy':(this.mode==='host'?'enemy':'ally');
 const list=team==='enemy'?ai.red:ai.blue;
 if(deployed){
  const index=list.findLastIndex(u=>u.alive);if(index>=0){const unit=list.splice(index,1)[0];if(unit.mesh&&unit.mesh.parent)unit.mesh.parent.remove(unit.mesh);unit.alive=false;}
 }else if(!VF.GameModes.isSd()){
  const pos=ai._sampleAroundBase(team);if(pos)ai.spawnReinforcement(team,pos);
 }
 const mine=VF.GameModes.isTeamless()?'ally':g.world._playerTeam;ai.allies=mine==='ally'?ai.blue:ai.red;ai.enemies=mine==='ally'?ai.red:ai.blue;
};
const oldIngest=P._ingestBus;
P._ingestBus=function(){const result=oldIngest.apply(this,arguments);if(this.quickSession){const s=this._readBus(),other=s&&(this.mode==='host'?s.guest:s.host);const peer=!!(this.conn&&this.conn.open);const alive=other&&Date.now()-(other.ts||0)<10000;if(alive){this._remoteDeployed=other.phase==='play';}else if(!peer){this._remoteDeployed=false;this.remotePresent=false;}this._syncQuickSeat();}return result;};
const oldDestroy=P.destroySession;
P.destroySession=function(){
 clear();this._quickBusy=false;this.quickSession=false;this._remoteDeployed=false;
 // Explicitly expire our advertised seat; do not delete the other player's state.
 if(this.roomCode&&this.mode){
  const s=this._readBus();if(s&&s[this.mode]&&s[this.mode].id===this._busClientId){s[this.mode].ts=0;this._writeBus(s);}
 }
 return oldDestroy.call(this);
};
global.addEventListener('pagehide',()=>P.destroySession());
})(window);
