# WebSocket 实时文件传输功能说明

## 概述

基于你的要求，我重新设计了文件传输功能，优先使用 **WebSocket 实时传输**，WebRTC 作为可选功能。新的实现具有以下特点：

- ✅ **WebSocket 实时传输** - 主要传输方式，兼容性好
- ✅ **文件分片传输** - 支持大文件，64KB 分片大小
- ✅ **MD5 完整性验证** - 前端计算和验证文件哈希
- ✅ **实时进度显示** - 传输进度实时更新
- ✅ **用户确认机制** - 传输前需要接收方确认
- ✅ **传输状态管理** - 完整的传输生命周期管理

## 技术实现

### 1. 文件传输流程

```
发送方                    服务器                    接收方
  |                        |                        |
  |-- fileTransferRequest ->|                        |
  |                        |-- 转发请求 ----------->|
  |                        |                        |-- 用户确认
  |                        |<-- fileTransferResponse-|
  |<-- 转发响应 ------------|                        |
  |                        |                        |
  |-- 开始分片传输 -------->|                        |
  |-- fileChunk ---------->|-- 转发分片 ----------->|
  |-- fileChunk ---------->|-- 转发分片 ----------->|
  |-- ... (循环) --------->|-- ... (循环) --------->|
  |                        |                        |-- 组装文件
  |                        |                        |-- MD5 验证
  |                        |                        |-- 自动下载
```

### 2. 消息类型定义

#### 文件传输请求
```typescript
interface FileTransferRequest {
    type: 'fileTransferRequest';
    transferId: string;
    targetUserId: string;
    metadata: {
        fileName: string;
        fileSize: number;
        fileType: string;
        fileHash: string;      // MD5 哈希
        totalChunks: number;
        chunkSize: number;
    };
}
```

#### 文件传输响应
```typescript
interface FileTransferResponse {
    type: 'fileTransferResponse';
    transferId: string;
    senderId: string;
    accepted: boolean;
}
```

#### 文件分片
```typescript
interface FileTransferChunk {
    type: 'fileChunk';
    transferId: string;
    targetUserId: string;
    chunkIndex: number;
    chunkData: number[];    // 分片数据
    isLast: boolean;
}
```

### 3. 前端文件传输管理器

```typescript
class FileTransferManager {
    private chunkSize = 64 * 1024; // 64KB chunks
    
    // 发起文件传输
    async initiateFileTransfer(targetUserId: string, file: File): Promise<string>
    
    // 处理传输请求
    handleTransferRequest(message: any): void
    
    // 接受/拒绝传输
    acceptTransfer(transferId: string, senderId: string): void
    rejectTransfer(transferId: string, senderId: string): void
    
    // 处理文件分片
    handleFileChunk(message: any): void
    
    // 组装接收到的文件
    private async assembleReceivedFile(session: any): Promise<void>
    
    // MD5 计算和验证
    private async calculateMD5(file: File): Promise<string>
}
```

## 核心特性

### 1. MD5 完整性验证

**发送端**：
- 在传输前计算整个文件的 MD5 哈希
- 将哈希值包含在传输请求中

**接收端**：
- 接收完所有分片后重新组装文件
- 计算接收文件的 MD5 哈希
- 与发送端提供的哈希对比验证

```typescript
// 计算文件 MD5
async calculateMD5(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 验证文件完整性
if (receivedHash !== expectedHash) {
    throw new Error('File integrity check failed');
}
```

### 2. 分片传输策略

- **分片大小**：64KB（可配置）
- **传输间隔**：50ms 延迟避免过载
- **错误处理**：支持传输取消和重试
- **进度跟踪**：实时更新传输进度

### 3. 用户交互设计

**发送方**：
1. 选择文件和目标用户
2. 系统计算文件 MD5 并发送请求
3. 等待接收方确认
4. 开始分片传输
5. 显示传输进度

**接收方**：
1. 收到传输请求通知
2. 显示文件信息（名称、大小、MD5）
3. 用户选择接受或拒绝
4. 接受后开始接收分片
5. 完成后验证 MD5 并自动下载

### 4. 传输状态管理

```typescript
interface TransferSession {
    transferId: string;
    type: 'send' | 'receive';
    status: 'requesting' | 'sending' | 'receiving' | 'completed' | 'failed';
    progress: number;
    file?: File;
    metadata?: FileMetadata;
    // ...
}
```

状态转换：
- `requesting` → `sending`/`failed`
- `sending` → `completed`/`failed`
- `receiving` → `completed`/`failed`

## 服务器端处理

### 1. 消息转发

服务器主要负责消息转发，不存储文件内容：

```typescript
// 转发传输请求
private handleFileTransferRequest(webSocket: WebSocket, message: FileTransferRequest): void {
    // 验证用户和文件大小限制
    // 转发给目标用户
}

// 转发文件分片
private handleFileTransferChunk(webSocket: WebSocket, message: FileTransferChunk): void {
    // 验证分片大小
    // 转发给目标用户
}
```

### 2. 安全限制

- **文件大小限制**：最大 500MB
- **分片大小限制**：最大 128KB
- **用户验证**：确保用户已注册
- **目标用户验证**：确保目标用户存在

## 使用方法

### 1. 访问页面
访问 `/realtime.html` 使用实时文件传输功能。

### 2. 发送文件
1. 在用户列表中点击"发送文件"按钮
2. 选择要发送的文件
3. 等待对方确认
4. 查看传输进度

### 3. 接收文件
1. 收到文件传输请求时会显示确认对话框
2. 查看文件信息（名称、大小、MD5）
3. 选择接受或拒绝
4. 接受后文件自动下载

### 4. 传输管理
- 右下角显示传输状态面板
- 可以取消正在进行的传输
- 查看传输进度和状态

## 优势对比

### WebSocket 实时传输 vs WebRTC P2P

| 特性 | WebSocket 实时传输 | WebRTC P2P |
|------|-------------------|------------|
| **兼容性** | ✅ 优秀 | ⚠️ 需要网络支持 |
| **实现复杂度** | ✅ 简单 | ❌ 复杂 |
| **传输速度** | ✅ 快速 | ✅ 更快 |
| **服务器负载** | ⚠️ 中等 | ✅ 最小 |
| **NAT 穿透** | ✅ 无需处理 | ❌ 需要 STUN/TURN |
| **企业网络** | ✅ 兼容 | ❌ 可能被阻止 |
| **移动网络** | ✅ 稳定 | ⚠️ 不稳定 |

## 性能特点

### 1. 内存使用
- 分片处理避免大文件内存溢出
- 接收端逐步组装，内存占用可控
- 传输完成后及时清理临时数据

### 2. 网络优化
- 50ms 传输间隔避免网络拥塞
- 支持传输取消和错误恢复
- 实时进度反馈提升用户体验

### 3. 安全性
- MD5 完整性验证防止文件损坏
- 用户确认机制防止恶意传输
- 文件大小限制防止资源滥用

## 扩展功能

### 1. 可能的改进
- **断点续传**：支持传输中断后继续
- **多文件传输**：批量文件传输队列
- **传输加密**：在分片级别添加加密
- **压缩传输**：自动压缩减少传输时间
- **传输历史**：记录传输历史和统计

### 2. WebRTC 集成
WebRTC 功能仍然保留在 `/webrtc.html` 页面，作为高级用户的选择：
- 适合网络环境良好的用户
- 提供最快的传输速度
- 完全点对点，服务器零负载

## 总结

新的 WebSocket 实时文件传输功能提供了：

1. **可靠性** - 基于 WebSocket，兼容性好
2. **完整性** - MD5 验证确保文件完整
3. **实时性** - 分片传输，实时进度显示
4. **易用性** - 简单的用户交互流程
5. **安全性** - 多层安全验证和限制

这个实现既满足了你对实时传输的需求，又保持了良好的用户体验和系统稳定性。WebRTC 作为可选功能，为有特殊需求的用户提供了更高性能的选择。