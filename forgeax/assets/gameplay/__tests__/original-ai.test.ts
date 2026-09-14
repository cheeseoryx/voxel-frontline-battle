import {describe,it,expect} from 'vitest';
import fs from 'node:fs';import vm from 'node:vm';
import * as math from '../../original/math.ts';
import {installOriginalAI} from '../../original/small-ai.ts';
import {installTdmMatch} from '../../original/tdm-match.ts';
import {paramsFor,original} from '../catalog.ts';
function fixture(legacy:boolean){
 let seed=123,clock=0;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;},m=Object.create(Math);m.random=random;
 const scene={add:()=>{},remove:()=>{}},world:any={worldSize:320,height:30,buildings:[],props:[],ziplines:[],_playerTeam:'ally',_allyBasePos:new math.Vector3(145,5,160),_enemyBasePos:new math.Vector3(175,5,160),_plannedLandmarks:[],_tdmArenaCenter:{x:160,z:160},_tdmArenaRadius:70,_isSolid:(_x:number,y:number)=>y<5,get:(_x:number,y:number)=>y<5?3:0,getWalkHeight:()=>5};
 const player:any={isPlayer:true,team:'ally',health:1000,dead:false,alive:true,object:{position:new math.Vector3(150,5,150)},takeDamage(amount:number){this.health-=amount;},getEyePosition(){return this.object.position.clone().add(new math.Vector3(0,1.8,0));}};
 const env:any={Math:m,performance:{now:()=>clock},VF:{BLOCK:original.small.blocks,Feel:original.small.feel,GameModes:{getParams:paramsFor,param:(k:string,d:any)=>paramsFor('tdm')[k]??d,isGg:()=>false,isTeamless:()=>false,prepFrozen:()=>false},game:{player,mode:'pve'},Soldier:{createSoldier:()=>({position:new math.Vector3(),rotation:{x:0,y:0,z:0},visible:true,traverse:()=>{}})}}};env.window=env;env.self=env;env.globalThis=env;
 const visual={clear:()=>{},update:()=>{},hit:()=>{},death:(unit:any)=>{unit.mesh.visible=false;}};
 let AI:any;if(legacy){vm.createContext(env);vm.runInContext(fs.readFileSync('../js/vendor/three.gltf.global.js','utf8'),env);vm.runInContext(fs.readFileSync('../modes/small-battle/js/ai.js','utf8'),env);AI=env.VF.AIController;AI.prototype._playVoxelDeath=visual.death;AI.prototype._updateDeathChunks=visual.update;AI.prototype._clearDeathFx=visual.clear;}else AI=installOriginalAI(env,visual,env.performance,m,math);
 const match=installTdmMatch(env);match.start();match.update(10);const ai=new AI(scene,world,player);env.VF.game.ai=ai;seed=123;ai.applyPlayerTeam();return {ai,player,match,tick:()=>{clock+=1000/60;ai.update(1/60);}};
}
describe('AI decisions migrated to the native port',()=>{
 it('preserves both teams, movement, combat, kill attribution and damage over 600 updates',()=>{const old=fixture(true),native=fixture(false);expect(native.ai.blue).toHaveLength(11);expect(native.ai.red).toHaveLength(12);
 for(let i=0;i<600;i++){old.tick();native.tick();}
 const state=(f:ReturnType<typeof fixture>)=>({health:f.player.health,score:f.match.score,units:f.ai.blue.concat(f.ai.red).map((u:any)=>({id:u.id,hp:u.hp,alive:u.alive,state:u.state,pos:[u.mesh.position.x,u.mesh.position.y,u.mesh.position.z]}))});
 expect(state(native)).toEqual(state(old));const victim=native.ai.red.find((u:any)=>u.alive),oldVictim=old.ai.red.find((u:any)=>u.id===victim.id);native.ai.damageEnemy(victim,999,new math.Vector3(1,0,0),{});old.ai.damageEnemy(oldVictim,999,new math.Vector3(1,0,0),{});expect(state(native)).toEqual(state(old));expect(native.match.stats.player.kills).toBe(1);
 });
});
