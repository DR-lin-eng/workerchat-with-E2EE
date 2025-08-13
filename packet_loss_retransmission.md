# 丢包重传机制

## 🎯 **问题场景**
```
发送端: 发送中 (4419/4419) ✅ 显示完成
接收端: 接收中 (3869/4419) ❌ 缺失550个分片
```

## 🔄 **三阶段传输机制**

### 第一阶段：批量高速发送
```
发送所有分片 → 记录发送状态 → 统计成功/失败
```

### 第二阶段：失败分片重传
```
重传发送失败的分片 → 使用确认模式 → 确保可靠传输
```

### 第三阶段：丢包检测和重传 ⭐ **新增**
```
查询接收端缺失分片 → 重传缺失分片 → 循环直到完整接收
```

## 📡 **丢包检测流程**

### 1. 触发条件
```javascript
// 发送成功率达到95%以上时触发丢包检测
if (totalSent >= transfer.totalChunks * 0.95) {
    await this.handlePacketLossRetransmission(transfer, transferId, config);
}
```

### 2. 检测循环
```javascript
const maxRetransmissionRounds = 5; // 最多5轮重传
while (retransmissionRound < maxRetransmissionRounds) {
    // 查询缺失分片
    const missingChunks = await this.queryMissingChunks(transfer, transferId);
    
    if (missingChunks.length === 0) {
        // ✅ 传输完成
        break;
    }
    
    // 🔄 重传缺失分片
    await this.retransmitMissingChunks(transfer, transferId, missingChunks);
}
```

### 3. 状态查询协议
```javascript
// 发送端查询
{
    type: 'fileTransferStatusRequest',
    transferId: 'xxx',
    targetUserId: 'receiver_id'
}

// 接收端响应
{
    type: 'fileTransferStatusResponse',
    transferId: 'xxx',
    receivedChunks: [0, 1, 2, ...],     // 已接收分片
    missingChunks: [550, 551, ...],    // 缺失分片
    totalReceived: 3869                 // 已接收总数
}
```

## 🔧 **重传策略**

### 批量重传
```javascript
const batchSize = 5; // 每批重传5个分片
for (let i = 0; i < missingChunks.length; i += batchSize) {
    const batch = missingChunks.slice(i, i + batchSize);
    await Promise.allSettled(batch.map(chunkIndex => 
        this.retransmitSingleChunk(transfer, transferId, chunkIndex)
    ));
}
```

### 重传优化
```javascript
const chunkMessage = {
    type: 'realtimeFileChunk',
    transferId: transferId,
    chunkIndex,
    chunkData,
    requireAck: false,        // 重传时不要求确认，提高速度
    isRetransmission: true    // 标记为重传
};
```

### 成功率评估
```javascript
const successRate = (successCount / totalMissing) * 100;
return successRate >= 90; // 90%以上成功率认为重传成功
```

## 📊 **状态显示**

### 传输状态
```
✅ 发送中 (4419/4419)
🔍 检测丢包 (第1轮)
🔄 重传中 (550个分片)
✅ 传输完成，无丢包
```

### 状态映射
```javascript
const statusMap = {
    'checking_missing': '检测丢包',
    'retransmitting': '重传中',
    'completed': '已完成'
};
```

## 🎮 **用户体验**

### 进度显示
```
发送端: 发送中 (4419/4419) → 检测丢包 → 重传中 → 已完成
接收端: 接收中 (3869/4419) → 接收中 (4419/4419) → 已完成
```

### 消息提示
```
✅ 初步传输完成，成功: 4419/4419
🔍 检测丢包: run.7z (第1轮)
🔄 重传丢包: run.7z (550个分片)
✅ 文件 "run.7z" 传输完成，无丢包
```

## 🛡️ **容错机制**

### 1. 查询超时保护
```javascript
setTimeout(() => {
    if (!responseReceived) {
        console.warn('查询缺失分片超时');
        resolve(null); // 超时返回null
    }
}, 10000); // 10秒超时
```

### 2. 重传轮数限制
```javascript
const maxRetransmissionRounds = 5; // 最多5轮重传
if (retransmissionRound >= maxRetransmissionRounds) {
    // 标记为失败
    transfer.status = 'failed';
}
```

### 3. 最终状态检查
```javascript
// 最终检查
const finalMissingChunks = await this.queryMissingChunks(transfer, transferId);
if (finalMissingChunks.length === 0) {
    transfer.status = 'completed'; // ✅ 成功
} else {
    transfer.status = 'failed';    // ❌ 失败
    transfer.error = `仍有${finalMissingChunks.length}个分片缺失`;
}
```

## 📈 **性能优化**

### 1. 智能触发
- 只有发送成功率≥95%时才进行丢包检测
- 避免对明显失败的传输进行无效重传

### 2. 批量处理
- 每批重传5个分片，避免过载
- 批次间500ms延迟，平衡速度和稳定性

### 3. 无确认重传
- 重传时不要求分片确认，提高速度
- 依靠最终状态查询验证完整性

## 🧪 **测试场景**

### 1. 正常丢包
- 发送4419个分片，丢失550个
- 检测到缺失分片并成功重传
- 最终完整接收4419个分片

### 2. 网络不稳定
- 多轮重传，每轮都有部分成功
- 最多5轮重传后完成或失败

### 3. 严重丢包
- 丢包率>10%，多轮重传
- 验证重传机制的鲁棒性

## 💡 **关键优势**

1. **自动检测** - 发送完成后自动检测丢包
2. **精确重传** - 只重传真正缺失的分片
3. **多轮保障** - 最多5轮重传确保完整性
4. **用户友好** - 清晰的状态显示和进度反馈
5. **高效可靠** - 批量重传，无确认模式提高速度

现在即使有丢包，也能自动检测并重传，确保文件完整传输！