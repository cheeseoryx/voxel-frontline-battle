/** Detailed, cached presentation models. Gameplay meshes and hitboxes stay in Soldier. */
(function(global){
'use strict';
const VF=global.VF,T=global.THREE;
if(!VF||!VF.Soldier||!T)return;
const geometry=new T.BoxGeometry(1,1,1);
const material=new T.MeshStandardMaterial({roughness:.92,metalness:.04});
const cache=new Map();
function build(id,team){
 const root=new T.Group(),facing=new T.Group();facing.name='SoldierFacing';facing.rotation.y=Math.PI;root.add(facing);
 const voxels=[];let seed=173+id.split('').reduce((n,c)=>n+c.charCodeAt(0),0);
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const heavy=/support|juggernaut/.test(id),recon=/recon|ghost/.test(id),medic=id==='medic',engineer=id==='engineer';
 const cloth=recon?['#777f65','#4c5845','#9c9c79','#626c51']:heavy?['#676b59','#454c43','#858575','#555e50']:['#888875','#626b59','#a4a08a','#535b4d'];
 const vest=heavy?'#4a5148':'#666750',dark='#292f2b',boots='#383c35',skin='#b69778';
 function box(x,y,z,w,h,d,c,rz=0){voxels.push({x,y,z,w,h,d,c,rz});}
 function camo(x,y,z,w,h,d,step=.032){
  const nx=Math.ceil(w/step),ny=Math.ceil(h/step),nz=Math.ceil(d/step);
  for(let i=0;i<nx;i++)for(let j=0;j<ny;j++)for(let k=0;k<nz;k++){
   if(i&&i<nx-1&&j&&j<ny-1&&k&&k<nz-1)continue;
   box(x-w/2+(i+.5)*w/nx,y-h/2+(j+.5)*h/ny,z-d/2+(k+.5)*d/nz,w/nx,h/ny,d/nz,cloth[Math.floor(random()*cloth.length)]);
  }
 }
 // Proportioned boots, articulated trouser silhouette, pockets and kneepads.
 for(const side of [-1,1]){
  const x=side*.145;
  box(x,.075,.05,.225,.15,.36,boots);
  box(x,.025,.075,.23,.035,.39,'#222a28');
  for(let i=0;i<4;i++)box(x,.155+i*.038,.108,.11,.018,.026,'#777767');
  camo(x,.33,0,.19,.32,.205);
  camo(x,.73,-.015,.23,.39,.245);
  box(x,.525,.129,.158,.2,.066,'#4b544b');
  box(x,.545,.168,.125,.13,.025,'#777c6b');
  box(x+side*.098,.77,.01,.075,.19,.2,vest);
  box(x+side*.106,.86,.017,.083,.04,.21,'#979782');
  for(const y of [.45,.63])box(x,y,.015,.235,.035,.255,dark);
 }
 camo(0,1.0,-.01,.47,.18,.26);
 box(0,1.075,.015,.49,.064,.31,dark);
 box(0,1.075,.181,.074,.058,.025,'#9c9b86');
 camo(0,1.365,-.01,heavy?.57:.48,.53,.29);
 box(0,1.36,.174,heavy?.51:.445,.38,.12,vest);
 box(0,1.445,.247,.3,.16,.035,'#747763');
 for(let i=0;i<16;i++)for(let j=0;j<6;j++)box(-.207+i*.027,1.36+j*.031,.241+random()*.007,.026,.03,.023,cloth[Math.floor(random()*cloth.length)]);
 // MOLLE webbing and magazine pouches.
 for(let j=0;j<4;j++)for(let i=0;i<6;i++)box(-.18+i*.072,1.23+j*.068,.253,.049,.018,.016,'#999885');
 for(let i=0;i<3;i++){
  box(-.142+i*.142,1.245,.294,.115,.19,.085,vest);
  box(-.142+i*.142,1.33,.34,.122,.038,.017,'#91917b');
  box(-.142+i*.142,1.265,.341,.02,.087,.016,'#434b40');
 }
 for(const x of [-.188,.188]){box(x,1.545,.174,.075,.2,.057,'#b0ab8d');box(x,1.52,.212,.045,.042,.027,dark);}
 // Backpack and radio visible on rotation.
 box(0,1.36,-.24,.38,.43,.2,vest);box(0,1.38,-.352,.28,.26,.025,'#90917c');
 box(-.2,1.43,-.24,.065,.16,.1,dark);box(-.2,1.63,-.24,.014,.27,.014,dark);
 // Upper arms are narrow and stepped; forearms hold the weapon across the chest.
 for(const side of [-1,1]){
  camo(side*.31,1.43,0,.165,.29,.23);
  box(side*.326,1.515,.12,.126,.09,.02,team==='enemy'?'#8e5148':'#567e91');
  box(side*.326,1.515,.134,.085,.015,.009,'#d1dad0');
  camo(side*.333,1.21,.08,.17,.17,.2);
  box(side*.3,1.18,.225,.185,.14,.31,vest,side*-.2);
  box(side*.2,1.21,.365,.155,.13,.135,'#535a4e');
  for(let i=0;i<3;i++)box(side*.2+i*.028-.028,1.212,.438,.02,.082,.025,'#94957e');
 }
 // Balaclava, stepped helmet, dark goggles and communications headset.
 box(0,1.685,0,.15,.14,.16,skin);
 box(0,1.855,.012,.255,.285,.245,'#51594b');
 box(0,1.868,.143,.21,.13,.026,skin);
 box(0,1.80,.164,.217,.074,.022,'#777b68');
 box(0,1.921,.153,.248,.075,.035,dark);
 for(const x of [-.063,.063]){
  box(x,1.927,.176,.09,.049,.021,'#1e3032');
  box(x-.018,1.94,.189,.038,.009,.004,'#819e9d');
 }
 for(let level=0;level<4;level++){
  const width=.348-level*.025,depth=.32-level*.026;
  camo(0,1.982+level*.036,-.012,width,.038,depth,.04);
 }
 box(0,1.985,.163,.36,.035,.055,'#626953');
 box(0,2.03,.163,.053,.08,.04,'#383f38');
 for(const side of [-1,1]){
  box(side*.15,1.895,-.018,.047,.125,.126,'#707765');
  box(side*.178,1.895,-.018,.022,.09,.083,'#343e35');
 }
 box(.145,1.835,.104,.023,.023,.16,dark);box(.093,1.822,.175,.11,.026,.027,dark);
 if(medic){box(.19,1.45,.26,.075,.10,.012,'#d7d8c7');box(.19,1.45,.268,.02,.07,.005,'#984f45');box(.19,1.45,.269,.054,.02,.005,'#984f45');}
 if(engineer){box(.25,1.0,-.26,.13,.68,.14,'#505b45');box(.25,1.37,-.26,.16,.095,.16,'#878874');}
 if(recon)for(let i=0;i<100;i++){const a=random()*Math.PI*2,r=.18+random()*.035;box(Math.cos(a)*r,1.91+random()*.14,Math.sin(a)*r,.025,.06+random()*.07,.025,cloth[i%4]);}
 // Rifle: metal receiver, rail, barrel, stock, magazine, optic and grips.
 const gun=new T.Group();gun.name='Weapon';facing.add(gun);
 const weapon=[];
 function g(x,y,z,w,h,d,c){weapon.push({x,y,z,w,h,d,c,rz:0});}
 const metal='#343b38';
 g(0,1.285,.424,.49,.09,.075,metal);g(-.30,1.285,.424,.18,.065,.066,'#727863');
 g(-.405,1.257,.424,.06,.135,.07,'#505a49');g(.35,1.285,.424,recon?.39:.27,.028,.028,metal);
 g(.185,1.285,.424,.19,.08,.069,heavy?'#5e6655':'#8b8b70');
 for(let i=0;i<9;i++)g(-.18+i*.049,1.345,.424,.019,.017,.078,'#899080');
 g(-.02,1.17,.424,heavy?.15:.074,.19,heavy?.115:.053,metal);
 g(-.135,1.195,.424,.052,.13,.063,'#5f6957');
 if(recon){g(-.06,1.395,.425,.22,.052,.058,metal);g(-.17,1.395,.425,.035,.08,.08,'#4a5447');}
 else{g(-.07,1.382,.424,.07,.057,.047,metal);g(-.07,1.4,.452,.033,.026,.009,'#668581');}
 function mesh(data,parent){
  const m=new T.InstancedMesh(geometry,material,data.length),dummy=new T.Object3D(),color=new T.Color();
  data.forEach((v,i)=>{dummy.position.set(v.x,v.y,v.z);dummy.scale.set(v.w,v.h,v.d);dummy.rotation.set(0,0,v.rz);dummy.updateMatrix();m.setMatrixAt(i,dummy.matrix);m.setColorAt(i,color.set(v.c));});
  m.instanceMatrix.needsUpdate=true;m.instanceColor.needsUpdate=true;m.frustumCulled=false;parent.add(m);
 }
 mesh(voxels,facing);mesh(weapon,gun);
 root.userData.presentationOnly=true;
 return root;
}
VF.MenuSoldier={create(id,opts){const requestedTeam=(opts&&opts.team)||(VF.UI._playerTeam&&VF.UI._playerTeam());const team=requestedTeam==='enemy'?'enemy':'ally',key=id+':'+team;if(!cache.has(key))cache.set(key,build(id,team));return cache.get(key).clone(true);}};
VF.Soldier.createPreviewSoldier=VF.MenuSoldier.create;
// Release per-instance GPU buffers; cached shared geometry/material remain reusable.
for(const [method,field] of [['_stopClassPreviews','_classPreview'],['_stopSquadIntroPreview','_squadIntroPreview'],['_stopLoadoutCustomizePreview','_loadoutCustomizePreview']]){
 const stop=VF.UI[method];if(!stop)continue;VF.UI[method]=function(){const preview=this[field];if(preview&&preview.models)Object.values(preview.models).forEach(model=>model.traverse(item=>{if(item.isInstancedMesh&&item.dispose)item.dispose();}));return stop.apply(this,arguments);};
}
})(window);
