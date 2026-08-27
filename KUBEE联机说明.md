# 体素战争 × Kubee 联机

参照 `本地开发包/threejs-3d-multiplayer` 的 **Kubee 房间 WebSocket** 实现跨电脑联机。

## 怎么玩（网页本地测）

在 **多人模板目录** 执行：

```bat
cd /d "C:\Users\Lenovo\Desktop\本地开发包\本地开发包\threejs-3d-multiplayer"
pnpm install
npx kubee game dev
```

浏览器打开提示的地址（一般是 `http://127.0.0.1:15180`）。

### 同一台电脑

1. 打开上述地址
2. **再开一个新窗口/无痕窗口**，同样打开该地址
3. 两边都进游戏 → 多人 PVP → **进入联机大厅**
4. 应看到一人房主、一人访客 → 双方准备 → 房主开始

Kubee **不用房号**。两边必须打开 **同一个已在跑的 Kubee 页面**。

### 两台不同主机

| 场景 | 做法 |
|------|------|
| 同一 WiFi / 局域网 | 主机用 `ipconfig` 查局域网 IP，对方打开 `http://192.168.x.x:15180`，防火墙放行 15180 |
| 不同公网（公司 ↔ 家里） | 本地 `kubee game dev` **无法直接联**；需要 Kubee 平台**发布后的公开房间链接**，或自建公网中继 |

`http://localhost:15180` 只能在跑 Kubee 的那台电脑打开。

## 改游戏后同步到模板

```bat
robocopy "C:\Users\Lenovo\Desktop\体素战争" "C:\Users\Lenovo\Desktop\本地开发包\本地开发包\threejs-3d-multiplayer\public\vf" /E /XD .git .netlify node_modules relay
```

## 注意

- 必须用 **`npx kubee game dev`**（或平台发布链接），直接打开 `体素战争/index.html` 没有 Kubee 房间服务
- 非 Kubee 环境仍可走原来的房号 + PeerJS（同机/同网较稳）
