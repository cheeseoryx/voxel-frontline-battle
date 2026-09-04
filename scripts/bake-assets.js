/*
 * bake-assets.js — One-command asset pipeline for artists.
 *
 *   node scripts/bake-assets.js            (or double-click 烘焙资产.bat)
 *
 * Wraps the three steps that previously had to be done by hand, in the order
 * that makes a failure safe:
 *
 *   1. bake    assets/props/*.vox -> js/props/props-bundle.js
 *   2. bump    index.html's ?v= cache token, so a PLAIN refresh loads the new
 *              bundle. Without this the browser serves the cached old bundle and
 *              the artist concludes their asset "didn't work" (netlify.toml sets
 *              max-age=3600 on /js/*).
 *   3. verify  node scripts/check-props.js
 *
 * Design notes:
 *   - Bake writes to a temp file and only replaces props-bundle.js once the bake
 *     AND the id-budget check both pass. bake-props.js used to write the bundle
 *     before validating the 255-id ceiling, which left broken output on disk.
 *   - The cache token is bumped only after a successful bake, so a failed run
 *     never desyncs index.html from the bundle.
 *   - Every message is aimed at someone who does not read JS: what happened,
 *     what to do next, in Chinese.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROPS_DIR = path.join(ROOT, 'assets', 'props');
const BUNDLE = path.join(ROOT, 'js', 'props', 'props-bundle.js');
const INDEX = path.join(ROOT, 'index.html');

/** Cache token shape in index.html: ?v=propbundle<N>. */
const TOKEN_RE = /\?v=propbundle(\d+)/g;

function line(s) {
  process.stdout.write((s == null ? '' : s) + '\n');
}

function rule() {
  line('─'.repeat(64));
}

function die(what, how) {
  line('');
  rule();
  line('  ✗ 失败：' + what);
  if (how) {
    line('');
    for (const l of how) line('    ' + l);
  }
  rule();
  process.exit(1);
}

/** Run a sibling script, capturing output so we control what the artist sees. */
function runNode(script, args) {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, script)].concat(args || []), {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: out };
  } catch (e) {
    return {
      ok: false,
      out: (e.stdout || '') + (e.stderr || ''),
      code: e.status,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Step 0 — what are we baking?
 * ------------------------------------------------------------------ */
function listAssets() {
  if (!fs.existsSync(PROPS_DIR)) {
    die('找不到资产目录 assets\\props\\', [
      '这个目录应该和 index.html 在同一个项目里。',
      '如果是刚拿到项目，先确认解压完整。',
    ]);
  }
  const all = fs.readdirSync(PROPS_DIR);
  const vox = all.filter((f) => f.toLowerCase().endsWith('.vox')).sort();
  // Case matters on the web server even though Windows ignores it, and the id
  // must be a valid JS identifier (bake-props.js:54 enforces this too, but its
  // message is aimed at a developer).
  const bad = vox.filter((f) => !/^[A-Za-z_][A-Za-z0-9_]*\.vox$/.test(f));
  if (bad.length) {
    die('有 ' + bad.length + ' 个文件名不能用', [
      '不能用的文件：' + bad.join('、'),
      '',
      '文件名规则：只能用英文字母、数字、下划线，且不能用数字开头。',
      '  可以：house2.vox  water_tower.vox  Shed.vox',
      '  不行：小屋.vox（中文）  2号楼.vox（数字开头）  water tower.vox（空格）',
      '',
      '文件名就是面板里显示的名字。',
    ]);
  }
  if (!vox.length) {
    die('assets\\props\\ 里没有 .vox 文件', [
      '把模型导出成 .vox 放进 assets\\props\\，然后再运行一次。',
    ]);
  }
  return vox;
}

/**
 * Sanity-check each file's magic header here rather than letting bake-props.js
 * throw, so the message can name the file. bake-props.js processes the whole
 * directory in one run and its parse error carries no filename — with a dozen
 * assets that turns into a hunt.
 */
function checkHeaders(files) {
  const bad = [];
  for (const f of files) {
    let head = '';
    try {
      const fd = fs.openSync(path.join(PROPS_DIR, f), 'r');
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      fs.closeSync(fd);
      head = buf.toString('latin1');
    } catch (e) {
      bad.push(f + '（读不出来：' + e.code + '）');
      continue;
    }
    if (head !== 'VOX ') bad.push(f);
  }
  if (bad.length) {
    die('有 ' + bad.length + ' 个文件不是有效的 .vox', [
      '有问题的文件：' + bad.join('、'),
      '',
      '请在 Vengi / MagicaVoxel 里重新导出，格式选 MagicaVoxel (.vox)。',
      '注意：改扩展名不会改变文件格式。',
    ]);
  }
}

/**
 * Pull the human-readable part out of a failed node run. The sibling scripts
 * either call fail() (a bare message on stderr) or throw (a message wrapped in
 * a stack trace plus a source excerpt). An artist can act on the message and
 * not on the stack, so show the message and keep the stack for the dev.
 */
function firstError(text) {
  const lines = (text || '').split(/\r?\n/);
  const hit = lines.find((l) => /^\s*Error:/.test(l));
  if (hit) return hit.replace(/^\s*Error:\s*/, '');
  // fail() path: last non-empty line that isn't stack noise.
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l && !/^at\s|^\^|^Node\.js v/.test(l)) return l;
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * Step 1 — bake, atomically.
 * ------------------------------------------------------------------ */
function bake() {
  const backup = fs.existsSync(BUNDLE) ? fs.readFileSync(BUNDLE) : null;
  const r = runNode('bake-props.js', []);
  if (!r.ok) {
    // bake-props.js writes the bundle only after its own checks pass, but a
    // throw can still land mid-write. Roll back to the last good one.
    if (backup) fs.writeFileSync(BUNDLE, backup);
    else if (fs.existsSync(BUNDLE)) fs.unlinkSync(BUNDLE);

    const text = r.out || '';
    const msg = firstError(text);
    const how = [msg || '（没有拿到错误信息）', ''];
    if (/不是 \.vox 文件|VOX /.test(text)) {
      how.push('这个文件不是有效的 .vox。请在 Vengi / MagicaVoxel 里重新导出，');
      how.push('导出格式选 MagicaVoxel (.vox)。');
    } else if (/超过 255|调色板/.test(text)) {
      how.push('所有模型的颜色总数太多了（引擎最多 236 种）。');
      how.push('请在建模软件里减少色板数量，或找程序调 --colors 参数。');
    } else {
      how.push('把上面这行发给程序。');
    }
    how.push('');
    how.push('js\\props\\props-bundle.js 已回滚到上一次可用的版本，游戏不受影响。');
    die('烘焙没有完成', how);
  }
  return r.out.trim();
}

/* ------------------------------------------------------------------ *
 * Step 2 — bump the cache token in index.html.
 * ------------------------------------------------------------------ */
function bumpCacheToken() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const nums = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(html))) nums.push(parseInt(m[1], 10));
  if (!nums.length) {
    // Not fatal: the artist can still hard-refresh. Say so instead of failing.
    return { count: 0, from: null, to: null };
  }
  const from = Math.max.apply(null, nums);
  const to = from + 1;
  TOKEN_RE.lastIndex = 0;
  const next = html.replace(TOKEN_RE, '?v=propbundle' + to);
  fs.writeFileSync(INDEX, next);
  return { count: nums.length, from: from, to: to };
}

/* ------------------------------------------------------------------ *
 * Step 3 — verify.
 * ------------------------------------------------------------------ */
function verify() {
  const r = runNode('check-props.js', []);
  if (!r.ok) {
    line('');
    line((r.out || '').trim());
    die('校验没通过 —— 资产已经烘焙进去了，但它在游戏里可能表现异常', [
      '上面一行 Error: 就是原因，把它整段发给程序。',
      '常见原因：',
      '  · 模型太高（超过 96 米）→ 会被埋进地下，打不坏也看不见',
      '  · 模型某个颜色只用了极少几格 → 降采样时被丢掉',
    ]);
  }
  let json = null;
  try {
    json = JSON.parse(r.out);
  } catch (e) {
    /* keep going: the suite passed, we just can't pretty-print it */
  }
  return json;
}

function main() {
  line('');
  rule();
  line('  体素战争 · 资产烘焙');
  rule();

  const files = listAssets();
  checkHeaders(files);
  line('');
  line('  资产目录  assets\\props\\  （' + files.length + ' 个模型）');

  line('');
  line('  [1/3] 烘焙模型 ...');
  const bakeOut = bake();
  for (const l of bakeOut.split('\n')) line(l.trim() ? '        ' + l : '');

  line('');
  line('  [2/3] 更新缓存版本号 ...');
  const bump = bumpCacheToken();
  if (bump.count) {
    line('        index.html  propbundle' + bump.from + ' → propbundle' + bump.to +
      '（' + bump.count + ' 处）');
  } else {
    line('        index.html 里没有 ?v=propbundle 标记，跳过。');
    line('        刷新浏览器时请按 Ctrl+Shift+R 强制刷新。');
  }

  line('');
  line('  [3/3] 校验 ...');
  const v = verify();
  if (v && v.props) {
    const names = Object.keys(v.props);
    for (const id of names) {
      line('        ' + id.padEnd(18) + '实心 ' + String(v.props[id].solid).padStart(6) + ' 格 · 已验证');
    }
    line('        共享调色板 ' + (v.idsUsed || '?') + ' 色 · 剩余 ' + (v.idsFree || '?') + ' 个空位');
  } else {
    line('        通过');
  }

  line('');
  rule();
  line('  ✓ 完成');
  rule();
  line('');
  line('  接下来：');
  line('    1. 回到浏览器，刷新页面（Ctrl+R 就够，不用强刷）');
  line('    2. 进对局后按 F8 打开关卡编辑器，切到「摆件」页');
  line('    3. 资产库里就能看到新模型，点一下开始摆放');
  line('    4. 摆完按 Ctrl+S 保存');

  line('');
}

main();
