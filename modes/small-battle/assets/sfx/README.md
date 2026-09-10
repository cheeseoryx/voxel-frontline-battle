# 投掷物音效 / 界面 BGM

## 现状：已装好 CC0 素材

投掷物的 11 个音位和大厅 BGM 都已经换成真实录音采样，全部 **CC0（公共领域）**，
可商用、无需署名。程序化合成音仍在代码里兜底：删掉这个目录游戏照常出声。

## 不能用 COD 原始音频

Call of Duty 的音频文件是 Activision Blizzard 的版权素材，不能提取、打包或分发。
下面装的是音色接近的公共领域替代品。

## 素材来源

| 包 | 作者 | 许可 | 链接 |
|---|---|---|---|
| 25 CC0 bang / firework SFX | rubberduck | CC0 | <https://opengameart.org/content/25-cc0-bang-firework-sfx> |
| 100 CC0 SFX #2 | rubberduck | CC0 | <https://opengameart.org/content/100-cc0-sfx-2> |
| 75 CC0 breaking / falling / hit sfx | rubberduck | CC0 | <https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx> |
| 100 CC0 metal and wood SFX | rubberduck | CC0 | <https://opengameart.org/content/100-cc0-metal-and-wood-sfx> |
| 50 CC0 Sci-Fi SFX | rubberduck | CC0 | <https://opengameart.org/content/50-cc0-sci-fi-sfx> |
| Sci-Fi Sounds | Kenney | CC0 | <https://opengameart.org/content/sci-fi-sounds> |
| War on Water: Tracks（`wowmenu.ogg`） | yd | CC0 | <https://opengameart.org/content/war-on-water-tracks> |

## 当前映射

分层写在 `index.json` 里，`gain` 调音量、`delay` 调层与层的间隔（秒）。

| 音位 | 层 | 原始文件 |
|---|---|---|
| `nade_pin` | `pin_spring.ogg` + `pin_click.ogg`（+50ms） | `metal_spring_02` + `sfx100v2_switch_01` |
| `nade_throw` | `throw_whoosh.ogg` | `sfx100v2_air_03` |
| `nade_bounce` | `bounce_metal.ogg` | `bfh1_metal_hit_01` |
| `explosion` | `frag_boom.ogg` + `debris.ogg`（+120ms） | `cannon_01` + `bfh1_rock_falling_03` |
| `semtex_stick` | `stick_thud.ogg` | `bfh1_hit_05` |
| `semtex_beep` | `beep.ogg` | `beep_03` |
| `semtex` | `semtex_boom.ogg` | `bang_02` |
| `molotov` | `glass_smash.ogg` + `fire_whoosh.ogg`（+50ms） | `bfh1_glass_breaking_02` + `sfx100v2_air_01` |
| `flashbang` | `flash_crack.ogg` | `bang_08` |
| `stun` | `stun_body.ogg` + `stun_sub.ogg`（+10ms） | `cannon_02` + `lowFrequency_explosion_001` |
| `smoke` | `smoke_hiss.ogg` | `sfx100v2_air_02` |

### 震撼弹为什么要滤波

第一版用了 `cannon_03`（礼花爆响），听起来又轻又脆，完全不像震撼弹。实测它的能量
分布是低频 14.5% / 中频 53.5% / **高频 32%**，起音 66ms——一个偏亮的中高频爆响。

震撼弹要的是"重而闷"：能量压到低频、高频清零，但还得保留一个能定位的瞬态。现在的
配置是 `cannon_02`（起音仅 9ms，全部候选里打击感最好）降调到 0.8 倍、900 Hz 低通
去掉所有脆感，再叠一层 `lowFrequency_explosion_001`（纯低频）补重量：

| | 低频 <300Hz | 中频 | 高频 >2kHz | 起音 |
|---|---|---|---|---|
| 旧 `cannon_03` | 14.5% | 53.5% | 32% | 66ms |
| **现在** | **65.9%** | 34.0% | **0%** | **12ms** |
| 手雷 `explosion` | 50.3% | 33.1% | 16.6% | 89ms |
| 闪光弹 `flashbang` | 16.3% | 79.1% | 4.6% | 132ms |

高频 0% 是全部投掷物里唯一的，所以现在闭着眼也能分出震撼弹。

想再重就把 `stun_sub.ogg` 的 `gain` 从 0.2 往上调（到 0.3 时低频约 70%，但中频轮廓
会变糊）；想更有"啪"的实感就把 `stun_body.ogg` 的 `lowpass` 从 900 往上开。
**别把 `rate` 降到 0.7 以下**，再低就开始像慢放的雷声了。

`flash_ring`（被闪到的耳鸣尾音）故意没配采样——它是一条纯正弦，合成器做得比任何
录音都干净，继续走 `js/audio.js` 里的 `SOUNDS.flash_ring`。

### 挑选依据与已知短板

除了 `stun`（那个是按频谱实测调的，见上），其余文件是按**名字语义 + 时长**挑的，
没有逐条试听，所以下面几个最可能需要你换：

- `fire_whoosh.ogg` 有 2.65 秒，比莫洛托夫的点燃过程长，尾巴可能拖。想更短就换成
  上表里 `sfx100v2_air_02`（1.11 秒），或者把 `gain` 从 0.5 再压低。
- `flash_crack.ogg` 用的是 `bang_08`，中频占 79%、起音 132ms，偏"钝"而不是"炸"。
  想更刺就换 `shot_01/02/03`（0.26–0.46 秒），它们脆得多。
- `semtex_boom.ogg`（中频 63%）和 `explosion`（中频 33% + 高频 16.6%）区分度一般，
  手雷和黏弹可能听着接近。`sci-fi-sfx/explosion_01` 是另一种质感，可以试。

### 怎么客观判断"闷不闷"

不用试听也能量化。在游戏页面控制台里把音频渲染到 `OfflineAudioContext`，做 FFT
后按 300 Hz / 2 kHz 切三段算功率占比：低频占比越高越"重"，高频占比越低越"闷"，
再看包络到达 90% 峰值的时间就是起音快慢。上面那张表就是这么测出来的。

两个坑：不要为了省算力对信号做抽取（等间隔取样）后再 FFT，没有抗混叠的话高频会
折回低频，数据全错；也不要用级联 biquad 滤波器去量频段能量，默认 Q=1 在转折频率
处有增益，会算出超过 100% 的占比。直接从 FFT 频谱分段求和最稳。

## 换素材的方法

把新文件丢进 `assets/sfx/throwables/`，改 `index.json` 里对应的 `file` 即可，
支持 `.ogg` / `.wav` / `.mp3`。**不要重新压制文件来调音量或音色**，用下面的参数——
这样不装音频编辑器也能改：

| 参数 | 作用 | 例 |
|---|---|---|
| `gain` | 音量倍率 | `0.55` |
| `delay` | 相对本音位起点延迟播放（秒） | `0.12` |
| `rate` | 播放速率 = 变调，`<1` 变低变长 | `0.8` |
| `lowpass` | 低通转折频率（Hz），砍高频 → 变闷 | `900` |
| `highpass` | 高通转折频率（Hz），砍低频 → 变薄 | `200` |
| `dur` | 截到多长（秒），带淡出所以不会爆音 | `1.05` |

单层写法也支持，下面三种等价：

```json
"smoke": "throwables/smoke_hiss.ogg"
"smoke": { "file": "throwables/smoke_hiss.ogg", "gain": 0.7 }
"smoke": [ { "file": "throwables/smoke_hiss.ogg", "gain": 0.7 } ]
```

删掉某个音位的条目，它就回落到程序化合成音。

## 界面 / 大厅 BGM

不走 `index.json`，按固定文件名放到 `assets/music/`，命中即循环：

```
assets/music/menu.mp3   ← 优先
assets/music/menu.ogg   ← 现在装的（wowmenu.ogg，41.5 秒循环）
assets/music/theme.mp3
assets/music/theme.ogg
assets/music/theme.wav  ← 旧的占位音
```

局内不放音乐（`Audio.setInMatch(true)` 会停掉），只有封面 / 大厅 / 结算会响。

想换风格，同站 Ruskerdax 的 `Open Warfare`（CC0）更重
<https://opengameart.org/content/open-warfare>；Free Music Archive 上
`HoliznaCC0 - War (Game Commission)`（CC0）有 7 条 3 分钟的战争主题。
注意 soundimage.org（Eric Matyas）的曲子量最大但是 **CC-BY**，用了必须署名。

## 验证

Ctrl+F5 后在控制台跑：

```js
Object.keys(VF.Audio._samples)   // 应该有 11 个音位
VF.Audio.play('explosion')       // 有采样就放采样，没有就回落合成音
```

采样是在第一次用户交互（解锁 AudioContext）之后才加载的，所以刚打开页面时
`_samples` 可能还是空的，点一下再看。
