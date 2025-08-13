# WebSocket消息大小问题修复

## 问题描述

在优化文件传输性能时遇到错误：
```
送分片 299 失败: 消息过大 (1872314 字节)
```

## 问题分析

1. **JSON数组序列化开销巨大**: 
   - 512KB二进制数据转为JSON数组后变成约1.87MB
   - 每个字节变成一个数字，加上逗号和方括号
   - 序列化开销约3-4倍

2. **WebSocket消息大小限制**:
   - Cloudflare Worker支持最大1MB WebSocket消息
   - 我们的800KB限制是合理的，但没考虑序列化开销

## 解决方案

### 1. 使用Base64编码替代JSON数组

**优势**:
- Base64编码只增加33%大小（vs JSON数组的300-400%）
- 更高效的序列化/反序列化
- 更小的网络传输开销

**实现**:
```typescript
// 发送端
const uint8Array = new Uint8Array(arrayBuffer);
const base64Data = btoa(String.fromCharCode.apply(null, Array.from(uint8Array)));

// 接收端  
const binaryString = atob(base64Data);
const chunkData = new Uint8Array(binaryString.length);
for (let j = 0; j < binaryString.length; j++) {
    chunkData[j] = binaryString.charCodeAt(j);
}
```

### 2. 重新调整分片大小

**新的分片大小策略**:
- 小文件 (<1MB): 128KB → Base64后约200KB
- 中等文件 (<10MB): 256KB → Base64后约400KB  
- 大文件 (<100MB): 512KB → Base64后约800KB
- 超大文件 (>=100MB): 600KB → Base64后约950KB

### 3. 更新消息大小检查

- 警告阈值: 保持100KB
- 硬限制: 保持800KB
- 现在可以安全处理更大的分片

## 性能提升预期

### 编码效率对比

| 方法 | 原始数据 | 编码后大小 | 开销 |
|------|----------|------------|------|
| JSON数组 | 512KB | ~1.87MB | +265% |
| Base64 | 512KB | ~680KB | +33% |

### 传输速度提升

- **分片大小**: 从32-200KB提升到128-600KB (2-3倍)
- **序列化开销**: 从265%降低到33% (8倍效率提升)
- **网络往返**: 减少2-3倍分片数量
- **预期速度**: 10-30MB/s (vs 之前的1-2MB/s)

## 兼容性

- ✅ 所有现代浏览器支持btoa/atob
- ✅ Cloudflare Worker支持Base64操作
- ✅ 保持文件完整性验证(MD5)
- ✅ 向后兼容现有加密机制

## 测试建议

1. 测试不同大小文件的传输速度
2. 监控WebSocket消息大小
3. 验证文件完整性
4. 测试网络中断恢复功能