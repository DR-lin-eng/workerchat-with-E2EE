# 流控机制错误修复总结

## 🐛 问题描述
```
文件传输暂停: Cannot access 'sendChunkData' before initialization
```

## 🔍 问题原因
在 `sendSingleChunk` 函数中，`sendChunkData` 函数在被调用之前还没有定义，导致了 JavaScript 的时间死区（Temporal Dead Zone）错误。

### 错误的代码结构：
```javascript
// ❌ 错误：在定义之前调用函数
if (condition) {
    sendChunkData(); // 这里调用了还未定义的函数
} else {
    sendChunkData(); // 这里也是
}

const sendChunkData = async () => { // 函数定义在调用之后
    // 函数体
};
```

## ✅ 修复方案
重新组织代码结构，将函数定义移到调用之前：

### 修复后的代码结构：
```javascript
// ✅ 正确：先定义函数
const sendChunkData = async () => {
    // 读取分片数据
    const start = chunkIndex * transfer.chunkSize;
    const end = Math.min(start + transfer.chunkSize, file.size);
    const chunk = file.slice(start, end);
    
    const chunkData = await this.readChunkAsArray(chunk);
    
    const chunkMessage = {
        type: 'realtimeFileChunk',
        transferId: transferId,
        targetUserId: transfer.targetUserId,
        chunkIndex,
        chunkData,
        isLast: chunkIndex === transfer.totalChunks - 1,
        requireAck: true
    };
    
    // 发送分片并记录待确认状态
    if (this.safeSend(chunkMessage, `发送分片 ${chunkIndex} 失败`)) {
        pendingChunks.set(chunkIndex, {
            timestamp: Date.now(),
            retries: 0,
            resolve,
            reject
        });
    } else {
        reject(new Error('WebSocket发送失败'));
    }
};

// 然后调用函数
if (this.websocket.bufferedAmount > 1024 * 1024) {
    const waitForBuffer = () => {
        if (this.websocket.bufferedAmount < 512 * 1024) {
            sendChunkData(); // 现在可以安全调用
        } else {
            setTimeout(waitForBuffer, 100);
        }
    };
    waitForBuffer();
} else {
    sendChunkData(); // 现在可以安全调用
}
```

## 🎯 修复效果
- ✅ 消除了 "Cannot access before initialization" 错误
- ✅ 保持了原有的缓冲区检查逻辑
- ✅ 维持了异步函数的正确结构
- ✅ 确保了流控机制的正常工作

## 🧪 测试验证
1. 打开 `/realtime.html`
2. 生成密钥并注册用户
3. 尝试发送文件
4. 检查控制台不再出现初始化错误
5. 验证文件传输流控机制正常工作

## 📝 相关文件
- `public/realtime.html` - 客户端文件传输逻辑
- `src/FileTransferManager.ts` - 服务端流控机制
- `src/ChatRoom.ts` - 消息路由处理

## 🔧 技术细节
这个错误是由于 JavaScript 的 `const` 和 `let` 声明的时间死区特性导致的。在 ES6+ 中，使用 `const` 或 `let` 声明的变量在声明之前无法访问，即使是在同一个作用域内。

修复方法是确保函数定义在所有调用之前，这样就避免了时间死区问题。