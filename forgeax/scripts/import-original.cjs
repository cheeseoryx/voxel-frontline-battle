const {spawnSync}=require('node:child_process'),path=require('node:path');
for(const script of ['audit-original.cjs','import-original-rules.cjs','import-original-economy.cjs','import-original-math.cjs','import-original-matches.cjs','import-original-ai.cjs','import-original-models.cjs','import-original-weapons.cjs','import-original-vehicles.cjs','import-original-audio.cjs','import-original-building.cjs','import-original-map.cjs','import-original-arenas.cjs','import-original-icons.cjs','import-original-ui.cjs']){
 const result=spawnSync(process.execPath,[path.join(__dirname,script)],{stdio:'inherit',windowsHide:true,cwd:path.resolve(__dirname,'..')});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);
}
