# ForgeaX Empty Game

这是 SDK 的最小 author 起点：一个资产目录、一份原生场景包，以及没有游戏逻辑的空插件组合。
需要添加逻辑时，把每个功能作为 `assets/` 下的原生 Cordis Plugin，并在 `forge.json#plugins[]`
中声明唯一的工程入口；不要重新引入 `src/main.ts` 或平行的运行入口。

```bash
pnpm exec forgeax project check --json
pnpm test
pnpm typecheck
pnpm exec forgeax project build --json
pnpm exec forgeax project package --output release/empty-game-web.zip --json
```

## 工程边界

| 路径 | 职责 |
|:--|:--|
| `forge.json` | 工程身份、默认场景和持久插件组合的权威配置。 |
| `assets/` | 唯一内容根；放场景、`*.pack.ts`、`*.pack.json`、外部文件与其 `.meta.json`。 |
| `assets/__tests__/` | 与 author source 就近的 Vitest 测试。 |
| `assets/world/world.scene.pack.json` | 可直接加载的最小场景资产。 |
| `docs/feedback.md` | 开发期间确认的 Engine、SDK、构建、资产或浏览器问题。 |

`pack-index.json`、cooked packages、DDC 和 `dist/` 都是可重建投影，不要手工编辑。外部图片、
glTF、字体、音频等文件的稳定身份放在同目录 `.meta.json`；程序化内容优先由 `*.pack.ts`
声明 GUID、依赖和输出，复用逻辑放在普通 `lib.ts`。

`forgeax project package --format web-zip` 会在构建后把根 `README.md` 和 `docs/feedback.md` 原样放入
归档；每条反馈应包含范围、复现步骤、期望、实际、证据和状态，并且不得包含敏感信息。
