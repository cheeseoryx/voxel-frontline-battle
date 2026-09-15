const fs=require('fs'),path=require('path'),crypto=require('crypto'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'../..'),source='modes/small-battle/assets/sfx',index=JSON.parse(fs.readFileSync(path.join(root,source,'index.json')));
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
 const page=await browser.newPage(),clips={},sounds={},sources=[];
 for(const [name,layers]of Object.entries(index.sfx)){
  const inputs=layers.map(layer=>{const file=path.join(root,source,layer.file),bytes=fs.readFileSync(file);sources.push({path:source+'/'+layer.file,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});return {...layer,bytes:bytes.toString('base64')};});
  const pcm=await page.evaluate(async inputs=>{
   const rate=32000,decoder=new OfflineAudioContext(1,rate,rate),layers=[];
   for(const input of inputs){const data=Uint8Array.from(atob(input.bytes),c=>c.charCodeAt(0)),buffer=await decoder.decodeAudioData(data.buffer);layers.push({...input,buffer});}
   const duration=Math.max(...layers.map(l=>(l.delay||0)+Math.min(l.dur||99,l.buffer.duration/(l.rate||1))))+.03;
   const ctx=new OfflineAudioContext(1,Math.ceil(duration*rate),rate);
   for(const l of layers){const node=ctx.createBufferSource();node.buffer=l.buffer;node.playbackRate.value=l.rate||1;let tail=node;
    if(l.lowpass){const filter=ctx.createBiquadFilter();filter.type='lowpass';filter.frequency.value=l.lowpass;tail.connect(filter);tail=filter;}
    const gain=ctx.createGain(),start=l.delay||0,dur=Math.min(l.dur||99,l.buffer.duration/(l.rate||1));gain.gain.setValueAtTime(l.gain??1,start);gain.gain.setValueAtTime(l.gain??1,start+Math.max(0,dur-.025));gain.gain.linearRampToValueAtTime(0,start+dur);tail.connect(gain);gain.connect(ctx.destination);node.start(start);node.stop(start+dur);
   }
   const output=await ctx.startRendering();return Array.from(output.getChannelData(0));
  },inputs);
  const wav=Buffer.alloc(44+pcm.length*2);wav.write('RIFF');wav.writeUInt32LE(36+pcm.length*2,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(32000,24);wav.writeUInt32LE(64000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length*2,40);pcm.forEach((n,i)=>wav.writeInt16LE(Math.round(Math.max(-1,Math.min(1,n))*32767),44+i*2));
  const key='small/throwables/'+name+'.wav';clips[key]={mediaType:'audio/wav',base64:wav.toString('base64')};sounds['small.source.'+name]={files:[key],gain:1,maxDistance:['nade_pin','nade_throw','semtex_beep','semtex_stick'].includes(name)?45:200};
 }
 for(const kind of ['frag','semtex','molotov','flash','stun','smoke']){
  for(const action of ['pin','throw','bounce'])sounds['small.throwable.'+kind+'.'+action]={alias:'small.source.nade_'+action};
  const action=kind==='smoke'?'ignite':'detonate',name={frag:'explosion',flash:'flashbang',smoke:'smoke'}[kind]||kind;
  sounds['small.throwable.'+kind+'.'+action]={alias:'small.source.'+name};
 }
 for(const action of ['stick','beep'])sounds['small.throwable.semtex.'+action]={alias:'small.source.semtex_'+action};
 for(const [key,value]of Object.entries(sounds))if(/^small.throwable.(semtex|molotov|stun)/.test(key))sounds[key.slice(6)]={alias:key};
 fs.writeFileSync(path.join(__dirname,'../assets/original/small-throwable-audio.ts'),'// Original CC0 layers, rate/filter/duration baked offline; no runtime legacy audio.\nexport const sounds='+JSON.stringify(sounds)+';\nexport const clips='+JSON.stringify(clips)+';\n');
 fs.writeFileSync(path.join(__dirname,'../docs/migration/eq-02-audio-provenance.json'),JSON.stringify({source:source+'/index.json',license:index._license,processing:'OfflineAudioContext, 32000 Hz mono PCM; original gain/delay/rate/lowpass/duration',sources},null,2));
 console.log('Baked '+Object.keys(clips).length+' original small-battle sound cues');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
