const fs=require('fs'),p=require('path'),dir=__dirname;
let build=fs.readFileSync(p.join(dir,'build.cjs'),'utf8');
function swap(a,b){if(!build.includes(a))throw Error('Missing replacement: '+a.slice(0,100));build=build.replace(a,b)}
swap("const inline=s=>escape(s).replace(/\\*\\*(.*?)\\*\\*/g,'<strong>$1</strong>');", "const inline=s=>escape(s).replace(/\\*\\*(.*?)\\*\\*/g,'<strong>$1</strong>').replace(/\\[([^\\]]+)\\]\\((https:\\/\\/[^\\s)]+)\\)/g,'<a href=\"$2\" target=\"_blank\" rel=\"noopener noreferrer\">$1</a>');");
swap('const html=`',`const refSources=JSON.parse(fs.readFileSync(path.join(dir,'references/sources.json'),'utf8').replace(/^\\uFEFF/,''));
const refCaptions=[
 {title:'参考 01 · 街区爆炸与结构破坏',body:'观察爆闪、烟尘、飞散碎片与破损建筑的融合，以及交战中的空间层次。动态物理和时序需结合录像评审。'},
 {title:'参考 02 · 建筑破损与室内外关系',body:'观察建筑开口、分离物件、内部受光及地面残留。对本项目重点验证：真实几何与碰撞更新后，玩家仍能继续行动。'},
 {title:'参考 03 · 体素细节、植被与日间光照',body:'观察建筑尺度、植被密度、亮暗层次和材料区分。用于对齐整体场景质感，不要求复制画面内容。'}
];
const targetGallery=refSources.map((s,i)=>'<figure class="target-ref"><div class="reference-label">TEARDOWN · 目标游戏参考</div><img loading="lazy" src="data:image/jpeg;base64,'+fs.readFileSync(path.join(dir,'references',s.file)).toString('base64')+'" alt="Teardown 官方商店参考图：'+refCaptions[i].title+'"><figcaption><strong>'+refCaptions[i].title+'</strong><br>'+refCaptions[i].body+'<br><a href="'+s.source+'" target="_blank" rel="noopener noreferrer">来源：Teardown 官方 Steam 商店</a> · 获取日期 '+s.retrieved+' · 图片归原权利人所有。<br><a href="'+s.url+'" target="_blank" rel="noopener noreferrer">查看原始图片</a>。此图不代表本项目当前成果。</figcaption></figure>').join('');
const html=\x60`);
swap('<title>体素前线 · 引擎平台项目对齐</title>','<title>体素前线 · Teardown 目标对齐 · V2</title>');
swap('现有进展、参赛形态与引擎支持需求。含会议口头文稿及实际界面截图。','V2：向 Teardown 对齐极高自由度、大部分可破坏体素场景及画面品质。含官方参考图、项目进展和会议文稿。');
swap('会前讨论稿 · 2026.09.11','V2 · Teardown 目标修订');
swap('从当前进展，<br>对齐最终可玩的形态。','以 Teardown 为标杆，<br>对齐可破坏世界与画面。');
swap('以现有项目为基础，明确单机与 PVP 的参赛目标，以及实现碰撞、画面和战斗特效所需的平台支持。','极高自由度 · 大部分场景可破坏 · 画面向 Teardown 对齐。以同一环境能力支撑单机搜打撤与 PVP 对抗。');
swap('<div class="agenda"><div><b>01 / 当前完成内容', '<a class="btn" href="#part7">查看 Teardown 参考画面</a><div class="agenda"><div><b>01 / 当前完成内容');
swap('<span>工具、物理、画面与特效</span>','<span>动态破坏、渲染、特效与同步</span>');
swap("+gallery+'</div>':'')+'</section>'", "+gallery+'</div>':i===6?'<div class=\"gallery target-gallery\">'+targetGallery+'</div>':'')+'</section>'");
swap('本 HTML 内嵌全部截图，可离线打开。','V2 · 2026-09-11。包含 3 张本项目 UI 截图与 3 张 Teardown 官方商店参考截图；可离线打开，来源及视频链接需要联网。');
swap("'# 项目对齐会议口头文稿\\n\\n'+speech.body", "'# 项目对齐会议口头文稿 · V2 Teardown 目标修订版\\n\\n'+speech.body");
swap("if((html.match(/data:image\\/png;base64,/g)||[]).length!==3)throw Error('missing images');console.log('Verified: 11 sections, 3 embedded images, navigation anchors, JavaScript syntax. HTML bytes: '+Buffer.byteLength(html));", "if((html.match(/data:image\\/(?:png|jpeg);base64,/g)||[]).length!==6)throw Error('missing images');console.log('Verified: 11 sections, 6 embedded images, source links, navigation anchors, JavaScript syntax. HTML bytes: '+Buffer.byteLength(html));");
swap('.gallery{margin-top:30px}', '.gallery{margin-top:30px}.reference-label{font-size:14px;color:var(--accent);letter-spacing:1px;margin-bottom:10px}.target-ref{padding-top:20px;border-top:1px solid var(--line)}.target-ref figcaption{font-size:16px;line-height:1.85}.target-ref figcaption strong{font-size:18px}main a:not(.btn){text-decoration-thickness:1px;text-underline-offset:3px;overflow-wrap:anywhere}');
fs.writeFileSync(p.join(dir,'build.cjs'),build);
console.log('Updated offline page builder and official reference gallery.');
