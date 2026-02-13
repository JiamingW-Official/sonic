# 画面与麦克风响应机制 / Visual & Mic Responsive Mechanism

本文档说明画面如何随键盘、鼓、音频与麦克风响应，以及如何更直观地调节。

---

## 一、画面响应机制（Visual Responsive Mechanism）

### 1. 键盘 / 鼓 → 吸引子 + 每键风格（KEY_PROFILES）

- **吸引子（attractor）**：每次按下**合成器键**（Z–M, Q–P, [ ]）或**鼓键**（A–L, ;, '），会在 3D 空间里设一个“引力点”，粒子会向该点聚集，同时触发爆发环（burst ring）、等离子体等。
- **KEY_PROFILES**：每个合成器键对应一套视觉风格（色相、万花筒折数、bloom、色差、螺旋、glitch、镜像、扭曲、对比度）。不同键 = 不同颜色与失真风格；多键同时按时会**混合**这些风格，并随键数增强（和弦叠加）。
- **衔接**：所有目标值（kaleidoMix、spiral、glitch 等）都用**插值（lerp）**平滑过渡，不会突变。

### 2. 主输出音频分析（Audio analyser）

- 合成器 + 鼓的**总输出**经过 `AnalyserNode`，得到**低 / 中 / 高**频能量和总 `audioEnergy`。
- **影响**：
  - **bloom**（光晕）：总能量 + 中高频会加强光晕。
  - **warp**（扭曲）：中频参与。
  - **spiral**（螺旋）：高频参与。
  - **glitch**：在 bass 冲击（bassHit）时加强。
  - **粒子吸引子强度**：bass 冲击会额外加强粒子被“吸过去”的力度。

因此：你弹得越响、低频越重，画面整体会更亮、更扭曲、粒子更聚拢。

### 3. 麦克风（Mic）

- **原理**：对麦克风做**时域 RMS**（响度），再经过：
  - **平滑**：`micLevelSmoothed` 每帧向当前 RMS 插值，避免画面随音量抖动。
  - **门限（gate）**：低于 `MIC_GATE` 视为静音，避免环境噪音驱动画面。
  - **缩放**：`micVisual = micLevelSmoothed * MIC_VISUAL_SCALE`，再参与画面。
- **影响**：`micVisual` 参与 **bloom**、**warp**、**色差**、**粒子吸引子强度**。  
  设计成：小声 = 轻微变化，正常说话/唱歌 = 温和增强，很大声 = 明显但不夸张，更符合直觉。

### 4. 鼠标 / 触摸速度（touchIntensity）

- 移动鼠标或手指越快，`touchIntensity` 越大。
- **影响**：加强 **warp**、**spiral**、**glitch**，让快速滑动时有更明显的画面反应。

### 5. 头部追踪（Head tracking）

- 摄像头或陀螺仪得到头部左右位置 `headX`。
- **影响**：相机轻微**左右偏转（yaw）** + 万花筒旋转的微调，画面随头部移动有轻微跟随感。

### 5a. 手势（Hand gesture，与头部共用摄像头）

- 按 **3** 开启摄像头后，画面**下半部分**用于识别手：左右位置 + 运动量 + 快速滑动。
- **旋钮 1**：手在画面中的**左右位置** → 控制 **warp（扭曲）** 和 **kaleido 旋转偏移**（手左 = 少，手右 = 多）。
- **旋钮 2**：手的**运动强度**（帧间变化）→ 控制 **bloom**、**spiral** 增强。
- **快速滑动**：手快速从左滑到右（或反）→ 约 0.45 秒的 **glitch 爆发** + **sparkle**，界面显示「← SWIPE」或「SWIPE →」。
- **显示**：顶部**手势条**（紫色填充 = 旋钮 1），下方文字 NORMAL / ACTIVE / SWIPE，以及「L← knob →R · motion %」。

### 6. 和弦与额外层

- **2 键以上**：混合多键的 KEY_PROFILES，并随键数略微加强强度。
- **3 键以上**：触发高音 **sparkle** 层。
- **5 键以上**：触发 **pad** 层（粒子光晕增强）。

---

## 二、麦克风响应原理（Mic Response）

- **采集**：`getUserMedia({ audio: true })` → `AnalyserNode`，用 **getByteTimeDomainData** 取时域波形。
- **响度**：对每帧波形做 RMS：`sqrt(mean(sample^2))`，得到 0–1 的 `micLevel`（原始）。
- **门限**：若 RMS &lt; `MIC_GATE`（约 0.012），视为静音，输出 0，避免房间底噪让画面一直动。
- **平滑**：`micLevelSmoothed += (micLevel - micLevelSmoothed) * MIC_SMOOTH`，响应更顺滑。
- **视觉缩放**：`micVisual = micLevelSmoothed * MIC_VISUAL_SCALE`（约 0.65），再参与 bloom、warp、粒子等，使“正常说话”对应温和的视觉变化，“大声”对应明显但不过分的反应。

调节直觉性：  
- 若觉得麦太敏感：增大 `MIC_GATE` 或减小 `MIC_VISUAL_SCALE`。  
- 若觉得反应太慢：增大 `MIC_SMOOTH`（如 0.15–0.2）。

---

## 三、常量位置（main.js）

- **Ambient**：`AMBIENT_DELAY`（空闲多久后自动进入）、`ambientStep` 内 velocity 与 `nextMs`。
- **鼓音量**：`DRUM_GAIN`（整体鼓与合成器/环境音的平衡）。
- **麦克风**：`MIC_GATE`、`MIC_SMOOTH`、`MIC_VISUAL_SCALE`（见上文）。

以上机制均为**叠加**：键盘 + 音频 + 麦 + 触摸一起决定最终画面，且只做加法、不删既有效果。
