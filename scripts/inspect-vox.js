/*
 * Inspect a MagicaVoxel .vox file (Vengi exports this format).
 * Reports model dimensions, voxel count and palette usage, then matches each
 * colour against the game's existing BLOCK palette so we can decide between
 * quantising to current materials and registering new block types.
 *
 *   node scripts/inspect-vox.js assets/props/house.vox
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vox = require('./lib/vox.js');

function hex6(v) {
  return '#' + v.toString(16).padStart(6, '0');
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('用法: node scripts/inspect-vox.js <文件.vox>');
    process.exit(2);
  }
  const file = path.resolve(vox.ROOT, arg);
  if (!fs.existsSync(file)) {
    console.error('找不到文件: ' + file);
    process.exit(2);
  }

  const { version, models, palette } = vox.parseVox(fs.readFileSync(file));
  const game = vox.gamePalette();

  console.log('文件      ' + path.relative(vox.ROOT, file));
  console.log('版本      ' + version);
  console.log('模型数    ' + models.length);
  console.log('');

  models.forEach(function (m, mi) {
    const solid = m.voxels.length;
    const bbox = m.w * m.d * m.h;
    console.log('── 模型 ' + mi + ' ' + '─'.repeat(46));
    console.log('  尺寸      ' + m.w + ' × ' + m.d + ' 宽深 × ' + m.h + ' 高');
    console.log('  实心体素  ' + solid + ' / ' + bbox + ' (' + ((solid / bbox) * 100).toFixed(1) + '% 填充)');
    console.log('  游戏内    1 体素 = 1 米 → 占地 ' + m.w + 'm × ' + m.d + 'm，高 ' + m.h + 'm');

    // 1024-wide world, ground ~y=9, ceiling y=101
    if (m.h > 92) console.log('  ⚠ 高度超过世界上限（地面 y≈9，天花板 y=101），必须降采样');
    const kit = { house: '14×12', midrise: '13×13', skyscraper: '16×16', factory: '40×28' };
    console.log('  参考      现有 kit 件占地 小屋 ' + kit.house + ' · 中楼 ' + kit.midrise +
      ' · 摩天楼 ' + kit.skyscraper + ' · 工厂 ' + kit.factory);
    for (const f of [2, 3, 4]) {
      console.log('    降采样 1/' + f + ' → ' +
        Math.ceil(m.w / f) + '×' + Math.ceil(m.d / f) + '×' + Math.ceil(m.h / f));
    }

    const used = new Map();
    for (const v of m.voxels) used.set(v.c, (used.get(v.c) || 0) + 1);
    const sorted = [...used.entries()].sort((a, b) => b[1] - a[1]);
    console.log('  用色数    ' + sorted.length);
    console.log('');
    console.log('  色号  颜色      体素数   占比    最近的现有材质');
    for (const [idx, count] of sorted) {
      const rgb = palette[idx] || 0;
      let best = game[0];
      let bestD = Infinity;
      for (const g of game) {
        const dd = vox.colorDist(rgb, g.hex);
        if (dd < bestD) { bestD = dd; best = g; }
      }
      const near = bestD < 28 ? '≈' : bestD < 60 ? '~' : '✗';
      console.log(
        '  ' + String(idx).padStart(4) +
        '  ' + hex6(rgb) +
        '  ' + String(count).padStart(7) +
        '  ' + ((count / solid) * 100).toFixed(1).padStart(5) + '%' +
        '  ' + near + ' ' + best.name + ' ' + hex6(best.hex) + ' (Δ' + bestD.toFixed(0) + ')'
      );
    }
    console.log('');
    const far = sorted.filter(([i]) => {
      const rgb = palette[i] || 0;
      return Math.min(...game.map((g) => vox.colorDist(rgb, g.hex))) >= 60;
    }).length;
    console.log('  ✗ 现有材质配不上的颜色: ' + far + ' / ' + sorted.length +
      (far ? ' → 建议扩展调色板' : ' → 量化到现有材质即可'));
    console.log('');
  });
}

main();
