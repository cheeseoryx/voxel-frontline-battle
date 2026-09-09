# Audacity 音效处理交接

## 本机检测结果（2026-09-08，写实化重做）

- 安装路径：`C:\Program Files\Audacity 4\bin\Audacity4.exe`
- 文件版本：`4.0.0` / 产品名 `Audacity 4.0`
- 未发现 `\\.\pipe\ToSrvPipe` / `FromSrvPipe`，安装目录没有
  `mod-script-pipe`；因此不能用脚本管道批处理或导出。
- Audacity 4 带有 Nyquist runtime 与 `nyquist-plug-in-installer.ny`，
  但当前构建没有可调用的 Macro / 脚本管道入口。不要把 Node 输出
  冒充成 Audacity 处理结果。
- 本机没有 `ffmpeg`。发布格式保持浏览器可解码的 mono 44.1 kHz
  PCM16 WAV（manifest `format: wav-pcm16-mono-44100`）。若日后
  安装 FFmpeg，可人工导出 OGG Vorbis quality 5，并同步改检查脚本。

发布素材由 `node scripts/audio-gen/generate-sfx.js` 生成：Friedlander
冲击、多层滤波噪声、非谐机械模态、短 IR/梳状尾音、lookahead 限幅到
0.82。旧版振荡器/方波/锯齿床已移除。

## 可复现流程

1. 运行 `node scripts/audio-gen/generate-sfx.js`，覆盖 `assets/sfx`
   发布 WAV、`manifest.json` 与 `_manifest/licenses.csv`。
2. 在 Audacity 导入
   `assets/sfx/_source/audacity_batch_source.wav` 或任意生成 WAV。
3. 在支持插件管理的 Audacity 3.x 中打开
   `工具 → Nyquist 插件安装器`，选择 `voxel-frontline-master.ny`；
   重启后在 `效果 → 添加/移除插件` 中启用，再选择整轨运行。
   Audacity 4.0 当前构建没有暴露该入口，需换用 3.x 稳定版后执行。
4. 也可在支持 Macro 的 Audacity 3.x 中打开 `工具 → 宏`，按
   `VoxelFrontline-Master-Macro.txt` 新建同名 Macro。
5. 导出为 mono 44.1 kHz；有 OGG 编码支持时使用 Vorbis quality 5，
   否则保留 PCM16 WAV。

Nyquist/Macro 只做轻量人工抛光：18 Hz 高通（保留爆炸/炮口亚音）、
16 kHz 低通、短淡化、峰值归一到约 -1.7 dB（0.82），**不做硬削波**。
游戏发布峰值由生成器 lookahead limiter 保证。

建议在 Audacity 里继续做的事：按枪族微调中频机械层、给远距尾音加
更长空间、给履带循环做 2–4 拍人工变速。不要加方波/芯片音插件。

`audacity-session.log` 记录本机实际检测，不把 Node 批处理冒充成
Audacity 输出。
