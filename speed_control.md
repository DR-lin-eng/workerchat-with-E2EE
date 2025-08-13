# 传输速度控制

## 🎯 **速度目标**
每秒10个分片，稳定可控的传输速度

## ⚙️ **控制机制**

### 1. 基础参数
```javascript
const targetChunksPerSecond = 10;    // 目标：每秒10个分片
const chunkInterval = 100;           // 分片间隔：100ms
```

### 2. 时间窗口控制
```javascript
// 每秒重置计数器
if (now - currentSecondStart >= 1000) {
    currentSecondStart = now;
    chunksSentInCurrentSecond = 0;
}
```

### 3. 分片限制
```javascript
// 当前秒内已发送10个分片时，等待下一秒
if (chunksSentInCurrentSecond >= targetChunksPerSecond) {
    const waitTime = 1000 - (now - currentSecondStart);
    await new Promise(resolve => setTimeout(resolve, waitTime));
}
```

### 4. 间隔控制
```javascript
// 确保分片间至少间隔100ms
const timeSinceLastChunk = now - lastChunkTime;
if (timeSinceLastChunk < chunkInterval) {
    const waitTime = chunkInterval - timeSinceLastChunk;
    await new Promise(resolve => setTimeout(resolve, waitTime));
}
```

## 📊 **传输特性**

### 速度稳定性
- **理论速度**: 10分片/秒
- **实际速度**: 8-10分片/秒（考虑网络延迟）
- **间隔控制**: 100ms ± 网络延迟

### 网络友好
- **平滑传输**: 避免突发流量
- **可预测**: 稳定的发送节奏
- **低压力**: 不会过载WebSocket

## 🎮 **用户体验**

### 进度显示
```
发送中 (25/441) - 2.5 KB/s
传输速度稳定，预计剩余时间: 41.6秒
```

### 传输日志
```
已发送10个分片，等待234ms到下一秒
分片间隔控制: 等待67ms
速度控制: 当前9.8分片/秒
```

## 🔧 **配置优势**

### 1. 可控性
- 精确的速度控制
- 可预测的传输时间
- 稳定的网络使用

### 2. 稳定性
- 避免网络拥塞
- 减少连接超时
- 降低失败率

### 3. 兼容性
- 适用于各种网络环境
- 不会过载慢速连接
- 友好的服务器压力

## 📈 **性能计算**

### 传输时间估算
```javascript
// 示例：1000个分片的文件
const totalChunks = 1000;
const chunksPerSecond = 10;
const estimatedTime = totalChunks / chunksPerSecond; // 100秒

// 考虑2并发
const actualTime = estimatedTime / 2; // 约50秒
```

### 带宽使用
```javascript
// 假设每个分片256KB
const chunkSize = 256 * 1024; // 256KB
const chunksPerSecond = 10;
const bandwidthUsage = (chunkSize * chunksPerSecond) / 1024; // 2.5MB/s
```

## 💡 **调优建议**

### 网络状况好时
```javascript
const targetChunksPerSecond = 15; // 可适当提高到15
```

### 网络状况差时
```javascript
const targetChunksPerSecond = 5;  // 可降低到5
```

### 服务器压力大时
```javascript
const targetChunksPerSecond = 8;  // 适中的8个/秒
```

现在传输速度被精确控制在每秒10个分片左右，既保证了稳定性，又提供了可预测的传输体验！