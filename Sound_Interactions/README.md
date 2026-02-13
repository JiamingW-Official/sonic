# Sound Matrix

基于 Web Audio API 的键盘合成器：用 QWERTY 键盘触发音高，无 2D/3D 与网格，仅音效与键盘交互。

## 快速开始

```bash
npm start
```

浏览器打开 http://localhost:3000 ，**先点击页面一次**解锁音频，再按键盘演奏。

## 交互

- **单键**：对应 MIDI 音高发声（C、D、E、F 为持续音，按住发声、松开停止）。
- **3 键以上**：高音闪烁（sparkle）。
- **5 键以上**：额外低音 Pad。

详细说明见 [INSTRUCTIONS.md](./INSTRUCTIONS.md)。
