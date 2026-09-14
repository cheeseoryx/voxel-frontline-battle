const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'../..');
const inventory=JSON.parse(fs.readFileSync(path.join(__dirname,'../docs/migration/source-inventory.json'),'utf8'));
const mismatches=[];for(const file of inventory.files){const absolute=path.join(root,file.path);if(!fs.existsSync(absolute)){mismatches.push({path:file.path,reason:'missing'});continue;}const data=fs.readFileSync(absolute);if(data.length!==file.bytes||crypto.createHash('sha256').update(data).digest('hex')!==file.sha256)mismatches.push({path:file.path,reason:'changed'});}
const report={ok:mismatches.length===0,checked:inventory.files.length,mismatches};
fs.mkdirSync(path.join(__dirname,'../artifacts'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../artifacts/original-integrity.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.ok)process.exitCode=1;
