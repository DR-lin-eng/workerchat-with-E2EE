# 🔧 音频调试指南

## 问题诊断步骤

### 1. 基础功能测试
访问 `/quick-test.html` 进行快速验证：
- ✅ 检查浏览器音频API支持
- ✅ 测试麦克风权限
- ✅ 测试基础音频播放

### 2. 详细音频测试
访问 `/audio-test.html` 进行完整测试：
- 🎤 录制音频并查看支持的格式
- 🔊 测试实时音频块播放
- 📊 查看详细的测试日志

### 3. 音频流调试
访问 `/stream-debug.html` 进行深度调试：
- 📈 实时监控音频块录制
- 🧪 测试不同播放方法的成功率
- 🔍 分析音频流片段播放问题

## 常见问题及解决方案

### 问题1: "Failed to load because no supported source was found"
**原因**: 音频流片段缺少完整的文件头信息
**解决方案**: 
- 使用音频缓冲策略，合并多个块后播放
- 优先使用Web Audio API进行解码播放

### 问题2: 完整音频能播放，但实时块不能播放
**原因**: 单个音频块不是完整的音频文件
**解决方案**:
```javascript
// 缓冲策略
if (buffer.totalSize >= 2000 || buffer.chunks.length >= 2) {
    // 合并多个块后播放
    const mergedAudio = mergeAudioChunks(buffer.chunks);
    await tryPlayAudio(mergedAudio);
}
```

### 问题3: Web Audio API 解码失败
**原因**: 音频数据格式不完整或损坏
**解决方案**:
- 检查录制格式设置
- 使用更低的码率 (32kbps)
- 增加录制间隔 (200-300ms)

## 最佳实践

### 录制配置
```javascript
const recorderOptions = {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: 32000  // 降低码率提高兼容性
};

mediaRecorder.start(200);  // 200ms间隔，平衡延迟和完整性
```

### 播放策略
```javascript
// 1. 优先使用Web Audio API
if (await tryWebAudioPlay(audioData)) return;

// 2. 尝试直接播放
if (await tryDirectPlay(audioData)) return;

// 3. 显示接收指示器
showAudioIndicator();
```

### 缓冲管理
```javascript
// 智能缓冲：根据数据量和时间决定播放时机
const shouldPlay = 
    buffer.totalSize >= 2000 ||     // 足够的数据量
    buffer.chunks.length >= 2 ||    // 足够的块数
    waitTime > 300;                 // 等待时间够长
```

## 浏览器兼容性

| 浏览器 | Web Audio API | MediaRecorder | 推荐度 |
|--------|---------------|---------------|--------|
| Chrome | ✅ 完全支持 | ✅ 完全支持 | ⭐⭐⭐⭐⭐ |
| Edge | ✅ 完全支持 | ✅ 完全支持 | ⭐⭐⭐⭐⭐ |
| Firefox | ✅ 完全支持 | ✅ 完全支持 | ⭐⭐⭐⭐ |
| Safari | ⚠️ 部分支持 | ⚠️ 部分支持 | ⭐⭐⭐ |

## 调试工具使用

### stream-debug.html 功能
1. **实时监控**: 查看每个音频块的录制和播放状态
2. **播放测试**: 测试不同播放方法的成功率
3. **合并测试**: 测试合并多个块后的播放效果
4. **统计分析**: 查看播放成功率和失败原因

### 关键指标
- **播放成功率**: 应该 > 80%
- **音频块大小**: 建议 1000-3000 字节
- **录制间隔**: 建议 200-300ms
- **缓冲策略**: 2-3个块合并播放

## 性能优化建议

### 1. 减少延迟
- 使用较短的录制间隔 (200ms)
- 实现智能缓冲，不等待过多数据
- 优先使用Web Audio API

### 2. 提高成功率
- 自动检测支持的音频格式
- 实现多种播放方法的fallback
- 合并音频块提高完整性

### 3. 用户体验
- 显示音频接收指示器
- 提供详细的错误信息
- 实现优雅的降级处理

## 故障排除清单

- [ ] 浏览器是否支持MediaRecorder API？
- [ ] 是否获得了麦克风权限？
- [ ] 音频格式是否被浏览器支持？
- [ ] 是否使用了HTTPS（某些浏览器要求）？
- [ ] 网络连接是否稳定？
- [ ] 是否有其他应用占用音频设备？
- [ ] 浏览器音量是否正常？
- [ ] 是否启用了音频缓冲策略？

## 联系支持

如果问题仍然存在，请提供以下信息：
1. 浏览器类型和版本
2. 操作系统信息
3. `/stream-debug.html` 的测试结果
4. 控制台错误日志
5. 网络环境描述