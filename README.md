# Sonic

**实时可视化音乐演奏平台** — 键盘合成器 + 鼓机 + MIDI 播放器 + GPU 粒子可视化 + 多设备远程控制。

→ [启动应用](Sound_Interactions/)

## 架构

```
桌面主机 (Sound_Interactions/)        中继服务器 (relay-server/)        手机终端 (relay-server/public/)
  Three.js + Web Audio + GPGPU         Express + Socket.IO               5 个控制槽位 + 弹幕 + 表情
  所有音频/视觉处理在本地执行            仅转发 JSON 控制消息               仅发送控制指令，不处理音频
```

## 快速开始

```bash
cd Sound_Interactions
node server.js        # → http://localhost:3000
```

点击页面一次解锁音频，再用键盘演奏。详见 [Sound_Interactions/INSTRUCTIONS.md](Sound_Interactions/INSTRUCTIONS.md)。

## 远程控制

页面加载后自动连接 Render 中继服务器，左上角出现管理员面板及二维码。手机扫码即可加入房间，选择控制槽位。

详见 [INSTRUCTIONS.md § 远程控制](Sound_Interactions/INSTRUCTIONS.md#八远程控制)。
