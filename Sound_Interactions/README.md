# Sonic — Sound Interactions

基于 Web Audio API + Three.js GPGPU 的实时可视化音乐演奏平台。

## 快速开始

```bash
node server.js
# → http://localhost:3000（端口被占用时自动递增）
```

浏览器打开后 **点击页面一次** 解锁音频，然后：

- **Z–M** 低音区 · **Q–P** 中音区 · **[ ]** 高音区
- **A–L ; ' \\** 12 个鼓垫
- **Space** 延音踏板（按住）
- **0** 切换合成器音色（共 7 种）
- **?** 显示帮助

## 功能概览

| 功能 | 说明 |
|------|------|
| 7 种合成器 | Crystalline Lead · Glass Bell · Hypersaw · Pluck · Cathedral Organ · Abyss Bass · Chip Crunch |
| 12 个鼓垫 | Kick · Snare · 808 · Clap · Hi-Hat · Rim · Snap · Toms · Ride · Crash |
| MIDI 播放器 | 拖入 .mid 文件，支持变速、移调、轨道选择 |
| GPU 粒子可视化 | 每个音高有独立视觉性格，和弦叠加混合 |
| 视觉模式 | Pixel (7)、Analog (8)、Text (9) 各三档 |
| 和声模式 | OFF · AUTO3 · MAJ3 · MIN3 · 5TH · 9TH (6) |
| 调号系统 | 12 根音 × 大/小调，MIDI 加载时自动检测 |
| 远程控制 | 手机扫码加入，5 个控制槽位 + 弹幕 + 表情 |

完整使用说明见 [INSTRUCTIONS.md](./INSTRUCTIONS.md)。
