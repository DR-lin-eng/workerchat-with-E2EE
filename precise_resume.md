# 精确断点续传机制

## 🎯 **核心思想**
发送端询问接收端的真实接收状态，根据接收端反馈精确恢复传输，优先重传缺失分片。

## 🔄 **工作流程**

### 1. 网络中断处理
```
网络中断 → 暂停传输 → 保存本地状态
```

### 2. 网络恢复 - 状态查询
```
网络恢复 → 发送状态查询 → 等待接收端响应
     ↓
接收端分析 → 返回接收状态 → 发送端精确恢复
```

### 3. 精确恢复传输
```
更新本地状态 → 优先重传缺失分片 → 继续正常传输
```

## 📡 **消息协议**

### 状态查询请求
```javascript
// 发送端 → 接收端
{
    type: 'fileTransferStatusRequest',
    transferId: 'xxx',
    targetUserId: 'receiver_id'
}
```

### 状态查询响应
```javascript
// 接收端 → 发送端
{
    type: 'fileTransferStatusResponse',
    transferId: 'xxx',
    senderId: 'sender_id',
    receivedChunks: [0, 1, 2, 5, 6, 8, ...], // 已接收分片列表
    missingChunks: [3, 4, 7, 9, ...],        // 缺失分片列表
    totalReceived: 156                        // 已接收总数
}
```

## 🧠 **智能恢复逻辑**

### 接收端状态分析
```javascript
// 分析已接收分片
const receivedChunks = Array.from(transfer.receivedChunks.keys());
const missingChunks = [];

// 找出缺失分片
for (let i = 0; i < totalChunks; i++) {
    if (!transfer.receivedChunks.has(i)) {
        missingChunks.push(i);
    }
}
```

### 发送端状态同步
```javascript
// 根据接收端状态更新本地状态
transfer.sentChunkSet = new Set(statusMessage.receivedChunks);
transfer.sentChunks = statusMessage.totalReceived;
transfer.progress = (statusMessage.totalReceived / transfer.totalChunks) * 100;
transfer.missingChunks = new Set(statusMessage.missingChunks);
```

### 优先重传策略
```javascript
// 优先发送缺失分片
if (transfer.missingChunks && transfer.missingChunks.size > 0) {
    const missingArray = Array.from(transfer.missingChunks);
    for (let i = 0; i < Math.min(batchSize, missingArray.length); i++) {
        const chunkIndex = missingArray[i];
        batch.push(chunkIndex);
        transfer.missingChunks.delete(chunkIndex);
    }
}
```

## 📊 **优势对比**

| 恢复方式 | 准确性 | 效率 | 可靠性 |
|---------|--------|------|--------|
| **本地状态恢复** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **精确状态查询** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |

## 🎮 **用户体验**

### 状态查询过程
```
✅ 查询接收端状态: run.7z
✅ 收到状态响应: 已接收1071个分片, 缺失15个分片
✅ 精确恢复传输: run.7z (1071/4419)
✅ 优先重传缺失分片: 15个
```

### 超时保护
```javascript
// 5秒超时保护
setTimeout(() => {
    if (transfer.status === 'querying_status') {
        console.warn('查询接收状态超时，使用本地状态恢复');
        this.resumeWithLocalState();
    }
}, 5000);
```

## 🔧 **容错机制**

### 1. 查询失败处理
- WebSocket发送失败 → 立即使用本地状态恢复
- 接收端无响应 → 5秒超时后本地恢复
- 接收端不存在 → 静默处理，本地恢复

### 2. 状态不一致处理
- 接收端分片数 > 发送端记录 → 以接收端为准
- 发现新的缺失分片 → 添加到重传队列
- 状态同步完成 → 继续正常传输

### 3. 网络异常处理
- 查询过程中断网 → 重连后重新查询
- 响应消息丢失 → 超时后本地恢复
- 多次查询失败 → 降级到本地恢复

## 💡 **关键特性**

### 1. 双重保障
- **主要方式**: 精确状态查询
- **备用方式**: 本地状态恢复

### 2. 智能重传
- **优先级**: 缺失分片 > 新分片
- **批量处理**: 一次重传多个缺失分片
- **动态调整**: 根据缺失情况调整策略

### 3. 状态同步
- **实时更新**: 根据接收端状态更新本地
- **进度准确**: 显示真实的传输进度
- **一致性**: 确保双端状态一致

## 🧪 **测试场景**

### 1. 正常断点续传
- 传输中断 → 查询状态 → 精确恢复
- 验证不重传已接收分片

### 2. 分片丢失场景
- 部分分片丢失 → 查询发现缺失 → 优先重传
- 验证缺失分片被正确重传

### 3. 网络不稳定
- 多次中断 → 每次精确查询 → 累积恢复
- 验证状态始终准确

现在断点续传功能更加智能和可靠，能够精确知道接收端的真实状态并优先重传缺失的分片！