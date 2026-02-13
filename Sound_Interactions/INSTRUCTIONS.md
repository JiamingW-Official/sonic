# Sound Matrix — 完整使用与开发说明

本文档提供从零运行、扩展与重新开项目的完整步骤，适用于本地开发、协作与部署参考。

---

## 一、项目概述

**Sound Matrix** 是一个基于 Web Audio API 的键盘合成器：在浏览器中通过 QWERTY 键盘触发音高，无 2D/3D 视觉与网格点击，仅保留音效与键盘交互。

- **交互方式**：键盘按键 → 对应 MIDI 音高发声；C、D、E、F 为持续音（按住发声、松开停止）。
- **和弦逻辑**：同时按 3 键以上触发高音闪烁（sparkle）；5 键以上叠加低音 pad。
- **技术栈**：纯前端，Web Audio API；可选 Node 静态服务（无第三方依赖）。
- **当前形态**：无 Three.js / Two.js，无 canvas 或网格 DOM，仅 `index.html` + `js/main.js` + 可选 CSS。

---

## 二、环境要求

- **Node.js**：≥ 16（若使用 `npm start`）。  
  检查：`node -v`
- **浏览器**：支持 Web Audio API 的现代浏览器（Chrome、Firefox、Safari、Edge 等）。  
  移动端需用户手势后才会创建 AudioContext。
- **可选**：若不用 Node，可用 Python 3 的 `http.server` 或 `npx serve` 提供静态服务。

---

## 三、运行方式

### 3.1 使用 Node.js（推荐）

1. 进入项目根目录：
   ```bash
   cd /path/to/project
   ```
2. 启动服务：
   ```bash
   npm start
   ```
3. 浏览器访问：http://localhost:3000
4. **首次使用**：必须先点击页面任意位置一次，以解除浏览器对 AudioContext 的自动静音策略，再按键盘即可发声。

### 3.2 自定义端口

- 环境变量：`PORT=8080 npm start`
- 或直接修改 `server.js` 中的 `const PORT = process.env.PORT || 3000;` 为所需端口。

### 3.3 不使用 Node 时

**Python 3：**
```bash
python3 -m http.server 3000
```
访问 http://localhost:3000

**npx（需已安装 Node）：**
```bash
npx serve .
```
按终端提示的地址访问。

### 3.4 直接打开 index.html

可双击 `index.html` 用默认浏览器打开，但部分浏览器对 `file://` 下的 AudioContext 有限制，若无法发声，请改用上述任一本地服务器方式。

---

## 四、项目结构说明

```
project/
├── index.html              # 入口：仅加载 style.css 与 js/main.js，无 canvas/网格
├── js/
│   └── main.js             # 全部逻辑：键盘映射、音频图、合成器、playNote、键盘事件
├── css/
│   └── style.css           # 全局样式（如 body 背景等），可选
├── assets/
│   └── sounds/             # 预留目录，当前未使用；可放采样供后续扩展
├── server.js               # Node 静态文件服务，仅使用 Node 内置 http/fs/path
├── package.json            # 定义 "start": "node server.js" 等脚本
├── README.md               # 项目简介与快速开始
└── INSTRUCTIONS.md         # 本说明文档
```

**各文件职责简述：**

- **index.html**：最小 HTML，`<script src="js/main.js"></script>`，不引入 Three.js/Two.js。
- **js/main.js**：
  - 常量：`KEY_TO_NOTE`、`SUSTAIN_OFFSETS`、`midiToFreq`
  - 音频：`audioCtx`、`masterGain`、延迟链（delay + feedback + mix）
  - 合成器：`createSynthVoice`（双振荡器 + 可选 Sub + 滤波 + ADSR + 持续音 LFO）、`playChordSparkle`、`playNote`、`stopSustained`
  - 交互：首次点击恢复 AudioContext、keydown/keyup 驱动发音与持续音
- **server.js**：根据请求路径提供静态文件，根路径返回 index.html。

---

## 五、键盘映射速查

| 键位 | 音名 | MIDI | 键位 | 音名 | MIDI | 键位 | 音名 | MIDI |
|------|------|------|------|------|------|------|------|------|
| Z | C3 | 48 | A | C4 | 60 | Q | C5 | 72 |
| X | D3 | 50 | S | D4 | 62 | W | D5 | 74 |
| C | E3 | 52 | D | E4 | 64 | E | E5 | 76 |
| V | F3 | 53 | F | F4 | 65 | R | F5 | 77 |
| B | G3 | 55 | G | G4 | 67 | T | G5 | 79 |
| N | A3 | 57 | H | A4 | 69 | Y | A5 | 81 |
| M | B3 | 59 | J | B4 | 71 | U | B5 | 83 |
|   |   |   | K | C5 | 72 | I | C6 | 84 |
|   |   |   | L | D5 | 74 | O | D6 | 86 |
|   |   |   |   |   |   | P | E6 | 88 |

- **持续音**（按住发声、松开停止）：对应音名为 C、D、E、F 的键（MIDI % 12 为 0、2、4、5）。
- **和弦**：3 键以上 → 高音 sparkle；5 键以上 → 额外低音 pad。

---

## 六、重新开一个 project 的完整步骤

1. **获取代码**  
   克隆或下载本仓库；或新建空目录，按「四、项目结构」创建 `index.html`、`js/main.js`、`css/style.css`、`server.js`、`package.json`。

2. **确认入口**  
   `index.html` 中仅保留对 `css/style.css` 和 `js/main.js` 的引用，不要引入 Three.js、Two.js 或其他未使用的库。

3. **本地运行**  
   在项目根目录执行 `npm start` 或 `python3 -m http.server 3000`，用浏览器打开对应地址，点击页面一次后再用键盘试音。

4. **扩展方向（可选）**
   - **加视觉**：引入 Three.js，在 main.js 中增加场景、相机、渲染循环；在现有 `playNote` 或键盘事件中驱动视觉变化。
   - **加网格点击**：在 HTML 中增加 12×3（或 10×3）格子 div，在 main.js 中为每个格子绑定 click/mousedown，调用与键盘相同的 `playNote(midiNote, cellIndex, sustained, velocity, chordNotes)`。
   - **换音色**：修改 `createSynthVoice` 中波形（osc type）、滤波（frequency、Q）、包络时间；或使用 `AudioBufferSourceNode` 播放 `assets/sounds/` 中的采样。
   - **部署**：将本项目放到 GitHub 等静态托管（如 GitHub Pages），确保入口为 index.html，无需后端。

---

## 七、常见问题

- **没有声音**  
  先点击页面一次再按键盘。检查系统与浏览器标签页是否静音；确认扬声器/耳机正常。若为 `file://` 打开，请改用本地服务器（见第三节）。

- **端口被占用**  
  使用 `PORT=8080 npm start` 或修改 `server.js` 中的 PORT。

- **想恢复之前的 2D/网格/Three.js**  
  当前仓库为「仅音效」精简版，历史版本需从 Git 历史或备份中恢复；新功能建议在现有 `playNote` 与键盘事件上扩展，避免重复造轮子。

- **移动端无声音**  
  需在用户手势（如 tap）后创建或 resume AudioContext；当前 main.js 已在首次 click 时调用 `audioCtx.resume()`，确保在交互后再按键盘或触发发音。

---

## 八、总结

按上述说明即可在本地或新环境中运行、修改与扩展 Sound Matrix。所有音效逻辑集中在 `js/main.js`，入口为 `index.html`，无后端依赖；复制本文件（INSTRUCTIONS.md）到新仓库即可作为完整使用与开发说明。
