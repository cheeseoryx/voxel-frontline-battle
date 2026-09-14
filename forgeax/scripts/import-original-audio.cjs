const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'../..'),manifestPath=path.join(root,'assets/sfx/manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestPath));
const sounds={...manifest.sounds},files=new Set(Object.values(sounds).flatMap(s=>[...(s.files||[]),...(s.distantFiles||[])]));
const clips={},sources=[];for(const file of files){const rel='assets/sfx/'+file,bytes=fs.readFileSync(path.join(root,rel));clips[file]={base64:bytes.toString('base64'),mediaType:'audio/'+(file.endsWith('.ogg')?'ogg':'wav')};sources.push({path:rel,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}
fs.writeFileSync(path.join(__dirname,'../assets/original/audio-clips.ts'),'export default '+JSON.stringify(clips)+';\n');
fs.writeFileSync(path.join(__dirname,'../assets/original/audio-manifest.ts'),'export default '+JSON.stringify(manifest)+';\n');
fs.writeFileSync(path.join(__dirname,'../docs/migration/audio-provenance.json'),JSON.stringify({manifestSha256:crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex'),sources},null,2));
console.log('Imported '+files.size+' original audio clips ('+sources.reduce((n,s)=>n+s.bytes,0)+' bytes).');
