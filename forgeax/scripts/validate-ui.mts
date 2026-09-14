import {readFileSync,writeFileSync} from 'node:fs';import {validateUiAuthoring} from '@forgeax/engine/ui/authoring';
const r=await validateUiAuthoring({sourcePath:'assets/ui/frontline.ui.html',html:readFileSync('assets/ui/frontline.ui.html','utf8'),css:readFileSync('assets/ui/frontline.ui.css','utf8')});
const diagnostics=r.ok?r.value.diagnostics:r.error.detail?.diagnostics||[];writeFileSync('docs/migration/ui-validation.json',JSON.stringify(diagnostics,null,2));
const groups={};for(const d of diagnostics){if(d.severity!=='error')continue;const key=d.code+': '+(d.actual||'').slice(0,100);groups[key]=(groups[key]||0)+1;}console.log(JSON.stringify({ok:r.ok,groups}));
