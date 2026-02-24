# Sonic — 完整使用与开发说明

---

## 一、项目概述

**Sonic** 是一个基于 Web Audio API 和 Three.js GPGPU 的实时可视化音乐演奏平台：

- **7 种合成器音色**，每种附带 5 个变体（共 42 种音色）
- **12 个合成鼓垫**，完整 GM MIDI 鼓组映射
- **MIDI 文件播放器**，支持变速、移调、轨道选择、Roll 预览
- **GPU 粒子可视化**，每个音高拥有独立视觉性格，和弦叠加时自动混合
- **调号系统**，12 根音 × 大/小调，加载 MIDI 时自动检测
- **多设备远程控制**，手机扫码即可控制合成器/混音/效果/鼓/键盘

技术栈：纯前端（Web Audio API + Three.js + GLSL 着色器），中继服务器使用 Node.js + Socket.IO。

---

## 二、环境要求

- **Node.js** ≥ 16（用于本地静态服务）：`node -v`
- **浏览器**：Chrome / Firefox / Edge / Safari（需支持 WebGL 2.0 和 Web Audio API）
- **可选**：若不用 Node，可用 `python3 -m http.server 3000` 或 `npx serve .`

---

## 三、运行方式

### 3.1 启动桌面端（推荐）

```bash
cd Sound_Interactions
node server.js
# → http://localhost:3000
```

端口被占用时自动尝试 3001、3002…直到可用。也可指定端口：

```bash
PORT=8080 node server.js
```

打开页面后 **必须先点击一次** 解锁浏览器 AudioContext，然后即可用键盘演奏。

### 3.2 启动中继服务器（本地开发远程控制时）

```bash
cd relay-server
npm install
npm start
# → http://localhost:4000
```

若要让桌面端连接本地中继（而非 Render），在浏览器控制台执行：

```js
window.__SONIC_RELAY_URL = 'http://localhost:4000';
```

然后刷新页面。

### 3.3 不使用 Node 时

**Python 3：**
```bash
cd Sound_Interactions
python3 -m http.server 3000
```

**npx：**
```bash
cd Sound_Interactions
npx serve .
```

### 3.4 直接打开 index.html

可双击 `index.html` 用浏览器打开，但 `file://` 协议下部分浏览器可能限制 AudioContext 或 ES Module import。若无法发声或报错，请改用本地服务器。

---

## 四、键盘映射

### 4.1 合成器音符键

音符键映射会随调号动态变化。以 C 大调为例：

| 低音区 (Z–M) | 中音区 (Q–P) | 高音区 |
|:---|:---|:---|
| Z → C3 | Q → C4 | [ → F5 |
| X → D3 | W → D4 | ] → G5 |
| C → E3 | E → E4 | |
| V → F3 | R → F4 | |
| B → G3 | T → G4 | |
| N → A3 | Y → A4 | |
| M → B3 | U → B4 | |
| | I → C5 | |
| | O → D5 | |
| | P → E5 | |

- **Shift + 任意音符键** → 升高一个八度
- **调号改变时**，所有键自动重映射到新调的自然音阶
- 同时按 **3 键以上** → 叠加高音 sparkle 视觉层
- 同时按 **5 键以上** → 额外叠加 pad swell 效果

### 4.2 鼓垫键（中间行，共 12 个）

| 键 | 鼓声 | 键 | 鼓声 |
|:---|:---|:---|:---|
| A | Kick | J | Rim |
| S | Snare | K | Snap |
| D | 808 | L | Tom Low |
| F | Clap | ; | Tom Mid |
| G | Hi-Hat (Closed) | ' | Ride |
| H | Hi-Hat (Open) | \ | Crash |

### 4.3 功能键

| 键 | 功能 | 说明 |
|:---|:---|:---|
| **0** | 切换合成器 | 7 种音色循环切换 |
| **1** | 麦克风 | 开启/关闭麦克风输入（驱动视觉） |
| **2** | 琶音器 | 开启/关闭自动琶音 |
| **3** | 陀螺仪 | 初始化设备陀螺仪（移动端适用） |
| **4** | 环境模式 | 开启/关闭程序性环境音纹理 |
| **5** | 视觉冻结 | 冻结当前画面 2 秒 |
| **6** | 和声模式 | 循环：OFF → AUTO3 → MAJ3 → MIN3 → 5TH → 9TH |
| **7** | 像素模式 | 循环：Soft → Dense → Hard |
| **8** | 模拟模式 | 循环：Clean → CRT → VHS |
| **9** | 文字模式 | 循环：Clean → Glitch → Overclock |
| **Space** | 延音踏板 | 按住持续发声，松开衰减 |
| **−** | 音量减 | 每次 −8% |
| **= / +** | 音量加 | 每次 +8% |
| **?** | 帮助 | 显示/隐藏帮助面板 |
| **Esc** | 取消 | 关闭帮助；或停止所有延音、重置缩放 |

---

## 五、合成器音色

共 7 种预设，按 **0** 循环切换。每种附带 5 个变体（可在手机端 Instrument 控制面板选择）。

| # | 名称 | 特色 | 变体 |
|:---|:---|:---|:---|
| 0 | **Crystalline Lead** | 锯齿波 unison chorus，穿透力强 | Init · Supersaw · Acid · Soft · Portamento · Brass |
| 1 | **Glass Bell** | 正弦载波 + 非谐波调制，金属钟声 | Init · EP · Chime · Kalimba · Celesta · Vibes |
| 2 | **Hypersaw** | 失谐锯齿波对 + 气声层，立体宽广 | Init · Trance · Cinematic · Gritty · Ambient · Hoover |
| 3 | **Pluck** | 锯齿 + 三角软化，剧烈滤波扫频 | Init · Guitar · Marimba · SynthPlk · Harp · Pizz |
| 4 | **Cathedral Organ** | 正弦基音 + 8'/4'/2⅔' 泛音，管风琴 | Init · Jazz · Church · Perc · Gospel · Reed |
| 5 | **Abyss Bass** | 失谐锯齿 Reese + 正弦 Sub，深沉贝斯 | Init · Sub · Growl · Acid · FM Bass · Wobble |
| 6 | **Chip Crunch** | 方波 + 八度方波，NES/Game Boy 芯片音 | Init · NES · C64 · Crush · Arp · Retro |

---

## 六、MIDI 播放器

### 加载 MIDI 文件

1. 页面打开后，点击左上角 HUD 菜单栏 → MIDI 面板
2. 拖入 `.mid` / `.midi` 文件，或点击内置示例
3. 自动解析轨道，检测打击乐轨（通道 9 / percussion 标记 / 名称匹配）

### 内置示例

- Better Off Alone
- Kawaikute Gomen
- Midu

### 播放控制

| 操作 | 说明 |
|:---|:---|
| ▶ / ⏸ | 播放 / 暂停 |
| 进度条 | 拖动跳转 |
| 速度 | 10 档可选：×0.5、×0.66、×0.75、×0.9、×1.0、×1.1、×1.25、×1.5、×1.75、×2.0 |
| 移调 | 上下移调（半音为单位） |
| 轨道开关 | 单独启用/禁用每条轨道 |

### Roll 预览

播放时在进度条上方显示 9 秒窗口的音符预览条，颜色区分不同轨道。

### 自动调号检测

加载 MIDI 时使用 Krumhansl-Kessler 算法自动检测调号，键盘映射随之变化。检测结果显示在 toast 中（如 "Key: C Maj  C D E F G A B"）。

### 性能参数

- 复音上限：桌面 10 音，移动端 8 音
- 预读缓冲：桌面 200ms，移动端 140ms
- 单音最长持续：10 秒

---

## 七、视觉系统

### GPU 粒子

使用 Three.js + GPUComputationRenderer 驱动的粒子系统。每次按键触发粒子发射，粒子行为受多种物理模型驱动：
- Lorenz 吸引子
- 卷曲噪声场 (Curl Noise)
- 晶体分支生长
- 神经波传播

### 每键视觉性格 (KEY_PROFILES)

12 个音高各对应一种独特的视觉预设：

| 音高 | 名称 | 色调特征 |
|:---|:---|:---|
| C | Prismatic Supernova | 红橙，爆炸射线，高棱镜 |
| C# | Quantum Crystal | 电紫，几何对称，高对比 |
| D | Cosmic Eye | 深青，有机流动，虹膜状 |
| D# | Black Hole | 紫外到黑，极端扭曲 |
| E | Lightning Swarm | 电青白，混沌，最大故障 |
| F | Nebula Bloom | 暖品红，梦幻流动 |
| F# | Diamond Shard | 金黄，三角镜面，闪耀 |
| G | Solar Flare | 强橙红，脉冲爆发 |
| G# | Vortex Ring | 海绿，环形波浪，催眠 |
| A | Fractal Frost | 冰蓝白，结晶，高对称 |
| A# | Plasma Cell | 生物绿，细胞脉动 |
| B | Sacred Geometry | 皇家紫金，极致对称 |

同时按 2 键以上时自动混合视觉参数。

### 视觉模式

每种模式有三档，独立循环：

- **像素 (7)**：Soft → Dense → Hard — 控制像素化强度
- **模拟 (8)**：Clean → CRT → VHS — CRT 扫描线 / VHS 抖动效果
- **文字 (9)**：Clean → Glitch → Overclock — 文字覆盖 + 故障艺术

---

## 八、远程控制

### 概述

页面加载后，`remote-bridge.js` 自动连接中继服务器（默认 `https://sonic-o6bm.onrender.com`），创建房间并在左上角显示 Windows 95 风格的管理员面板和二维码。

手机扫描二维码即可加入房间。**所有音频处理在桌面端执行**，手机仅发送 JSON 控制消息。

### 消息流

```
手机终端 ─── WebSocket ──→ 中继服务器 ─── WebSocket ──→ 桌面主机
                                                          ↓
                                                    调用本地 Audio API
                                                          ↓
桌面主机 ─── WebSocket ──→ 中继服务器 ─── WebSocket ──→ 手机终端
                                                    (状态同步/VU表)
```

### 管理员面板

桌面端自动显示的 Win95 风格窗口，包含：
- 房间 ID（6 位 hex）
- 二维码（手机扫描加入）
- 5 个槽位的实时占用状态（用户名 + 踢出按钮）
- 排队等待列表

面板可拖拽移动、折叠、关闭。

### 5 个控制槽位

| 槽位 | 功能 | 移动端控制内容 |
|:---|:---|:---|
| **Instrument** | 合成器 | 预设选择、变体切换、振荡器/滤波器/包络参数旋钮 |
| **Mixer** | 混音 | 各轨道音量推子、Pan 旋钮、VU 表（主机 ~15fps 推送） |
| **FX** | 效果器 | 轨道选择、6 种效果开关及参数（EQ/Phaser/Reverb/Delay/Chorus/Distortion） |
| **Drums** | 鼓机 | 12 个鼓垫触发、力度控制 |
| **Keys** | 键盘 | 音符触发、八度切换、调号选择（大/小调 × 12 根音） |

每个槽位同时只能由一人控制。槽位被占时其他人进入排队，释放后自动分配给队首。

### 弹幕与表情

未占用槽位的观众可以：

- **发送弹幕**：输入文字评论，在桌面画面从右到左匀速滚动（120px/s），随机垂直位置
- **发送表情包**：8 种 Win95 像素风表情，全屏霸屏约 4 秒并显示发送者用户名

8 种表情：❤️ 爱心 · 😊 开心 · 😢 哭泣 · 💀 骷髅 · 🔥 火焰 · 😎 酷 · ⭐ 星星 · 😡 愤怒

**已占用槽位的用户不可发弹幕/表情**（专注控制）。

### 手机端加入流程

1. 手机扫描桌面二维码（或手动输入 URL + 房间号）
2. 输入用户名
3. 看到 5 个槽位状态，点击空闲槽位加入
4. 进入对应控制面板，开始操控
5. 离开时自动释放槽位

### 延迟与冷启动

- 中继服务器部署在 Render（美国），中国用户约 200ms 延迟
- 旋钮和推子采用乐观更新策略（先本地响应，再等待同步）
- Render 免费版 15 分钟无活动后休眠，首次扫码需约 30 秒唤醒。桌面端打开时已自动连接进行预热

---

## 九、项目结构

```
sonic/
├── README.md                              # 项目入口说明
│
├── Sound_Interactions/                    # 桌面端应用
│   ├── index.html                         # 入口页面（加载 Three.js + Socket.IO CDN）
│   ├── server.js                          # Node.js 静态文件服务器（端口自动递增）
│   ├── package.json                       # npm 配置
│   ├── README.md                          # 桌面端快速开始
│   ├── INSTRUCTIONS.md                    # 本文档
│   ├── js/
│   │   ├── main.js                        # 核心：合成器引擎 + 鼓机 + 可视化 + 键盘事件 + 远程 API
│   │   ├── midi-player.js                 # MIDI 播放器：解析 + 调度 + UI + 轨道/速度/移调控制
│   │   ├── remote-bridge.js               # 远程桥接：WebSocket + 管理员面板 + 弹幕渲染 + 表情霸屏
│   │   ├── remote-protocol.js             # 远程协议辅助常量
│   │   └── vendor/
│   │       └── GPUComputationRenderer.js  # Three.js GPU 计算渲染器
│   ├── css/
│   │   └── style.css                      # 全局样式（Win95 窗口、HUD 菜单、帮助面板）
│   └── midi-examples/                     # 内置 MIDI 示例文件
│       ├── better-off-alone.mid
│       ├── ke-aikutegomen-*.mid
│       └── mi-du-shan-ge-midu.mid
│
├── relay-server/                          # 中继服务器（部署到 Render）
│   ├── server.js                          # Express + Socket.IO：房间管理 + 槽位 + 队列 + 弹幕/表情转发
│   ├── package.json                       # 依赖：express ^4.21, socket.io ^4.7
│   └── public/                            # 移动端界面（express.static 服务）
│       ├── index.html                     # 移动端入口
│       ├── mobile.css                     # Win95 移动端样式
│       ├── mobile-app.js                  # 连接逻辑 + 路由 + 角色选择 + 弹幕/表情 UI
│       ├── mobile-instrument.js           # 合成器控制面板
│       ├── mobile-mixer.js                # 混音控制面板
│       ├── mobile-fx.js                   # 效果器控制面板
│       ├── mobile-drums.js                # 鼓机控制面板
│       ├── mobile-keys.js                 # 键盘控制面板
│       └── mobile-emoji.js                # 像素表情包定义（8 种 SVG 像素画）
│
└── Example_MIDI/                          # 额外 MIDI 示例
```

---

## 十、部署

### 桌面端

桌面端是纯静态页面（通过 importmap 从 CDN 加载 Three.js 和 @tonejs/midi），可部署到 GitHub Pages 或任何静态托管。确保 `index.html` 为入口。

### 中继服务器（Render）

1. 在 Render 创建 Web Service，指向仓库的 `relay-server/` 目录
2. Build Command: `npm install`
3. Start Command: `npm start`
4. Render 自动提供 `PORT` 环境变量

部署后手机扫码访问的 URL 为 `https://<your-app>.onrender.com/?room=<roomId>`。

若更换中继服务器地址，需修改 `remote-bridge.js` 第 9 行的 `RELAY_URL`。

---

## 十一、常见问题

**没有声音**
→ 先点击页面一次解锁 AudioContext。检查系统/浏览器是否静音。若用 `file://` 打开请改用本地服务器。

**端口被占用**
→ 服务器会自动尝试下一个端口（3000 → 3001 → ...），也可 `PORT=8080 node server.js` 指定。

**远程控制面板没出现**
→ 检查浏览器控制台是否有 Socket.IO 连接错误。Render 免费版首次连接可能需要 ~30 秒唤醒。

**手机扫码后加载很慢**
→ Render 免费版休眠唤醒需要时间。桌面端页面打开时已自动发起连接进行预热。

**MIDI 文件没有声音**
→ 确保至少有一条轨道处于启用状态。检查音量是否调低。部分 MIDI 可能不含有效音符。

**视觉卡顿**
→ GPU 粒子系统需要 WebGL 2.0。确保使用独立显卡，关闭浏览器的节能模式。在低端设备上可尝试降低像素模式（按 7 切换到 Soft）。

**弹幕/表情不显示**
→ 确认发送者未占用任何控制槽位。已占槽位的用户需先释放才能发送弹幕和表情。
