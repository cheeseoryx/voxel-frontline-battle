import {describe,it,expect} from 'vitest';
import fs from 'node:fs';import vm from 'node:vm';
import {installTdmMatch} from '../../original/tdm-match.ts';
import {installFfaMatch} from '../../original/ffa-match.ts';
import {installGgMatch} from '../../original/gg-match.ts';
import {installSdMatch} from '../../original/sd-match.ts';
import {paramsFor,original} from '../catalog.ts';
function environment(){return {VF:{WEAPONS:original.small.weapons,GameModes:{getParams:paramsFor},game:{mode:'pve',running:true,player:{id:'player',isPlayer:true,team:'ally'},ai:{blue:[],red:[]}}}} as any;}
function snapshot(m:any){return JSON.parse(JSON.stringify({phase:m.phase,phaseLeft:m.phaseLeft,timeLeft:m.timeLeft,stats:m.stats,score:m.score,feed:m.feed,ended:m.ended,winner:m.winner,reason:m.endReason,rank:m.ranking?.(),wins:m.wins,round:m.round,attacker:m.attackerTeam}));}
describe('original match rule equivalence',()=>{
 for(const [mode,file,property,install] of [['tdm','tdm-match','TdmMatch',installTdmMatch],['ffa','ffa-match','FfaMatch',installFfaMatch],['gungame','gg-match','GgMatch',installGgMatch]] as const)it(mode+' preserves preparation, attribution, progression and match completion',()=>{
  const native=install(environment()),oldEnv=environment();oldEnv.window=oldEnv;vm.createContext(oldEnv);vm.runInContext(fs.readFileSync('../modes/small-battle/js/'+file+'.js','utf8'),oldEnv);const old=oldEnv.VF[property];native.start();old.start();
  const invoke=(method:string,...args:any[])=>{native[method](...structuredClone(args));old[method](...structuredClone(args));expect(snapshot(native)).toEqual(snapshot(old));};
  invoke('registerKill',{victim:{id:'red',team:'enemy'},killer:'player'});expect(native.stats.player.kills).toBe(0);
  invoke('update',10);for(let i=0;i<65&&!native.ended;i++){invoke('registerKill',{victim:{id:'red-'+(i%7),name:'红',team:'enemy'},killer:'player',headshot:i%3===0,weaponId:mode==='gungame'?native.weaponAt(native.stats.player.level):'ar',maxHp:90});invoke('update',.125);}
  expect(native.ended).toBe(true);invoke('update',20);expect(native.active).toBe(false);
 });
 it('explosive mode preserves half-time exchange and the seven-round win condition',()=>{const e=environment(),oldEnv=environment();oldEnv.window=oldEnv;vm.createContext(oldEnv);vm.runInContext(fs.readFileSync('../modes/small-battle/js/sd-match.js','utf8'),oldEnv);const old=oldEnv.VF.SdMatch,native=installSdMatch(e);native.start();old.start();for(let round=0;round<7;round++){for(const m of [native,old]){m.update(15);m._endRound('ally','test');m.update(5);}expect(snapshot(native)).toEqual(snapshot(old));}expect(native.matchOver).toBe(true);expect(native.winner).toBe('ally');expect(native.attackerTeam).toBe('enemy');});
 it('simultaneous sessions never share score or a rule singleton',()=>{const a=installTdmMatch(environment()),b=installTdmMatch(environment());a.start();b.start();a.update(10);b.update(10);a.registerKill({victim:{id:'red',team:'enemy'},killer:'player'});expect(a.score.ally).toBe(1);expect(b.score.ally).toBe(0);a.stop();expect(b.isRunning()).toBe(true);});
});
