const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'../..'),out=path.resolve(__dirname,'../assets/ui');fs.mkdirSync(path.join(out,'media'),{recursive:true});const copied=new Map();
function reference(raw,base){if(/^(data:|https?:|#|blob:)/.test(raw))return raw;const file=raw.split(/[?#]/)[0];let source=path.resolve(base,file);if(!fs.existsSync(source)&&file.startsWith('../'))source=path.resolve(root,file.replace(/^(\.\.\/)+/,''));if(!fs.existsSync(source))throw Error('Missing UI companion '+raw+' from '+base);const bytes=fs.readFileSync(source),name=crypto.createHash('sha256').update(bytes).digest('hex').slice(0,16)+path.extname(source);fs.copyFileSync(source,path.join(out,'media',name));copied.set(source,{name,bytes:bytes.length});return './media/'+name;}
function urls(text,base){return text.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g,(all,q,url)=>'url("'+reference(url,base)+'")');}
let html=fs.readFileSync(path.join(root,'index.html'),'utf8').match(/<body[^>]*>([\s\S]*?)<\/body>/i)[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
html=html.replace(/\bsrc="([^"]+)"/g,(all,src)=>'src="'+reference(src,root)+'"');
// Keep inline style quotes valid when normalizing legacy URLs.
html=html.replace(/style="([^"]*)"/g,(all,s)=>'style="'+urls(s,root).replace(/"/g,"'")+'"');
const cssPaths=['style.css','styles/deployment-base.css','styles/frontline-ui.css','styles/preview-fidelity.css','styles/squad-ui.css'];
let css=cssPaths.map(p=>'/* Original: '+p+' */\n'+urls(fs.readFileSync(path.join(root,p),'utf8'),path.dirname(path.join(root,p)))).join('\n');css=css.replace(/:root\b/g,':host').replace(/\bbody\b/g,':host').replace(/\bhtml\b/g,':host');
css+='\n:host{display:block;position:absolute;inset:0;width:100%;height:100%;pointer-events:none;} :host > * {pointer-events:auto;} .hidden{display:none!important;}\n';
let inlineIndex=0;html=html.replace(/style="([^"]*)"/g,(all,style)=>{const id='inline-'+inlineIndex++;css+='\n[data-original-style="'+id+'"]{'+style+'}';return 'data-original-style="'+id+'"';});
html=html.replace(/<svg\b[\s\S]*?<\/svg>/g,svg=>{const name=crypto.createHash('sha256').update(svg).digest('hex').slice(0,16)+'.svg';fs.writeFileSync(path.join(out,'media',name),svg);return '<img alt="" src="./media/'+name+'" />';});
for(const tag of ['i','legend','kbd','time','br','canvas']){html=html.replace(new RegExp('<'+tag+'(\\s|>)','g'),'<span data-original-tag="'+tag+'"$1').replace(new RegExp('</'+tag+'>','g'),'</span>');css=css.replace(new RegExp('(^|[\\s>+~,])'+tag+'(?=[\\s.#:[>+~,]|$)','gm'),'$1[data-original-tag="'+tag+'"]');}
html=html.replace(/<span data-original-tag="br"\s*\/?>(?!<\/span>)/g,'<span data-original-tag="br"></span>');
css+='\n[data-original-tag="kbd"]{font-family:monospace;}[data-original-tag="br"]{display:block;}';
fs.writeFileSync(path.join(out,'frontline.ui.html'),html);fs.writeFileSync(path.join(out,'frontline.ui.css'),css);
const identity=fs.readFileSync(path.resolve(__dirname,'../assets/identity.ts'),'utf8').match(/export const IDS=(.*);/)[1];const id=JSON.parse(identity).ui;
fs.writeFileSync(path.join(out,'frontline.ui.html.meta.json'),JSON.stringify({schemaVersion:'1.0.0',kind:'external-asset-package',importer:'ui',source:'frontline.ui.html',importSettings:{},subAssets:[{guid:id,sourceIndex:0,sourceKey:'ui/frontline',kind:'ui'}]},null,2));
fs.writeFileSync(path.resolve(__dirname,'../docs/migration/ui-companions.json'),JSON.stringify([...copied].map(([source,v])=>({source:path.relative(root,source).replaceAll('\\','/'),...v})),null,2));console.log(JSON.stringify({companions:copied.size,htmlBytes:Buffer.byteLength(html),cssBytes:Buffer.byteLength(css)}));
