# workerchat-with-E2EE

一个基于 Cloudflare Workers 和 OpenPGP 的极简端到端加密聊天室应用。

## ✨ 特性

- 🔒 **端到端加密** - 使用 PGP 协议确保消息安全
- 🌐 **无服务器架构** - 基于 Cloudflare Workers 和 Durable Objects
- 🔑 **密钥管理** - 支持生成、导入和导出 PGP 密钥
- 💬 **实时通信** - WebSocket 实现实时消息传输
- 📁 **实时文件传输** - WebSocket 实时文件传输，支持大文件分片传输
- 🔍 **文件完整性验证** - MD5 哈希验证确保文件传输完整性
- 🚀 **实时进度** - 实时显示传输进度和状态
- 🌐 **P2P 选项** - 可选的 WebRTC 点对点传输（需要网络支持）

## 🚀 快速开始

### 部署到 Cloudflare Workers
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gxxk-dev/workerchat-with-E2EE.git)

## 💻 使用说明

1. **创建/加入聊天室** - 访问部署域名，系统自动创建房间或通过 URL 参数加入指定房间
2. **密钥管理** - 生成密钥对或导入现有密钥，支持导出公钥分享
3. **发送消息** - 消息自动端到端加密，确保通信安全
4. **P2P 文件传输** - 访问 `/webrtc.html` 使用点对点文件传输功能
5. **移动端** - 移动设备自动跳转到优化的移动端界面

### 实时文件传输使用方法
1. **WebSocket 实时传输**（推荐）- 访问 `/realtime.html` 页面
   - 点击用户旁边的"发送文件"按钮
   - 选择文件后自动分片传输
   - 支持 MD5 完整性验证
   - 实时显示传输进度

2. **WebRTC P2P 传输**（可选）- 访问 `/webrtc.html` 页面
   - 点击其他用户建立 P2P 连接
   - 文件直接在用户间传输
   - 需要网络环境支持 WebRTC

## 🛠️ 技术栈

- **后端**: Cloudflare Workers + Durable Objects + WebSocket
- **前端**: 原生 JavaScript + OpenPGP.js + CSS3

## 🔐 安全特性

- 消息在客户端加密，服务器无法读取明文
- 私钥仅存储在用户浏览器本地(localStorage)
- WSS 加密传输
- **实时文件传输** - 文件通过 WebSocket 实时传输，支持大文件分片
- **文件完整性验证** - 使用 MD5 哈希确保文件传输完整性
- **可选 P2P 传输** - WebRTC 点对点传输，文件不经过服务器

## 📄 许可证

本项目以 AGPLv3(orlater) 许可证发布，欢迎贡献代码和提出建议。