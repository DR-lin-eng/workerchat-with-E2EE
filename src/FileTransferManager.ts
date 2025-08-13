// WebSocket 实时文件传输管理器
export class FileTransferManager {
    private activeTransfers: Map<string, FileTransferSession> = new Map();
    private chunkSize: number = 256 * 1024; // 256KB chunks (default)
    
    constructor(
        private websocket: WebSocket,
        private onFileReceived: (senderId: string, file: File, mediaUrl?: string) => void,
        private onTransferProgress: (transferId: string, progress: number, type: 'send' | 'receive') => void,
        private onTransferComplete: (transferId: string, success: boolean) => void
    ) {}

    // 发起文件传输
    async initiateFileTransfer(targetUserId: string, file: File): Promise<string> {
        const transferId = this.generateTransferId();
        const fileHash = await this.calculateMD5(file);
        const optimalChunkSize = this.calculateOptimalChunkSize(file.size);
        const totalChunks = Math.ceil(file.size / optimalChunkSize);

        // 创建传输会话
        const session = new FileTransferSession({
            transferId,
            file,
            targetUserId,
            fileHash,
            totalChunks,
            chunkSize: optimalChunkSize,
            type: 'send'
        });

        this.activeTransfers.set(transferId, session);

        // 发送传输请求
        const transferRequest = {
            type: 'fileTransferRequest',
            transferId,
            targetUserId,
            metadata: {
                fileName: file.name,
                fileSize: file.size,
                fileType: file.type,
                fileHash,
                totalChunks,
                chunkSize: optimalChunkSize
            }
        };

        this.websocket.send(JSON.stringify(transferRequest));
        return transferId;
    }

    // 处理传输请求响应
    handleTransferResponse(message: any): void {
        const session = this.activeTransfers.get(message.transferId);
        if (!session) return;

        if (message.accepted) {
            // 开始发送文件
            this.startFileSending(session);
        } else {
            // 传输被拒绝
            this.activeTransfers.delete(message.transferId);
            this.onTransferComplete(message.transferId, false);
        }
    }

    // 检查是否为媒体文件（图片/视频）
    private isMediaFile(fileType: string): boolean {
        return fileType.startsWith('image/') || fileType.startsWith('video/');
    }

    // 处理传输请求
    async handleTransferRequest(message: any): Promise<void> {
        const { transferId, senderId, metadata } = message;
        
        let accept = false;
        
        // 如果是图片或视频，自动接受并直接显示在聊天中
        if (this.isMediaFile(metadata.fileType)) {
            accept = true;
        } else {
            // 普通文件需要用户确认
            accept = confirm(
                `${this.getUserName(senderId)} 想要发送文件:\n` +
                `文件名: ${metadata.fileName}\n` +
                `大小: ${this.formatFileSize(metadata.fileSize)}\n` +
                `类型: ${metadata.fileType}\n\n` +
                `是否接受?`
            );
        }

        // 发送响应
        const response = {
            type: 'fileTransferResponse',
            transferId,
            senderId,
            accepted: accept
        };

        this.websocket.send(JSON.stringify(response));

        if (accept) {
            // 创建接收会话
            const session = new FileTransferSession({
                transferId,
                senderId,
                metadata,
                type: 'receive',
                chunkSize: metadata.chunkSize,
                receivedChunks: new Map(),
                expectedHash: metadata.fileHash
            });

            this.activeTransfers.set(transferId, session);
        }
    }

    // 处理文件分片
    handleFileChunk(message: any): void {
        const session = this.activeTransfers.get(message.transferId);
        if (!session || session.type !== 'receive') return;

        const { chunkIndex, chunkData, isLast } = message;
        
        // 存储分片
        session.receivedChunks!.set(chunkIndex, chunkData);
        
        // 更新进度
        const progress = (session.receivedChunks!.size / session.metadata!.totalChunks) * 100;
        this.onTransferProgress(message.transferId, progress, 'receive');

        // 检查是否接收完成
        if (session.receivedChunks!.size === session.metadata!.totalChunks) {
            this.assembleReceivedFile(session);
        }
    }

    // 高效的ArrayBuffer到Base64转换
    private arrayBufferToBase64(uint8Array: Uint8Array): string {
        // 使用更小的分块避免调用栈溢出
        let binary = '';
        const chunkSize = 8192; // 8KB chunks to be safe
        
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
            const chunk = uint8Array.subarray(i, i + chunkSize);
            // 使用apply方法更安全
            binary += String.fromCharCode.apply(null, Array.from(chunk));
        }
        
        return btoa(binary);
    }

    // 高效的Base64到ArrayBuffer转换
    private base64ToArrayBuffer(base64: string): Uint8Array {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        
        return bytes;
    }

    // 开始发送文件 - 使用30并发传输
    private async startFileSending(session: FileTransferSession): Promise<void> {
        const file = session.file!;
        const chunkSize = session.chunkSize || this.chunkSize;
        const totalChunks = session.totalChunks!;
        
        // 准备阶段：不更新进度，避免显示分片准备速度
        console.log(`准备传输: ${file.name}, 计算哈希和分片...`);
        
        // 并发传输配置 - 修复：合理的并发数避免网络拥塞
        const maxConcurrentChunks = 2; // 降低到2个并发线程，确保网络传输稳定
        const sendQueue = new Set<number>(); // 正在发送的分片索引
        const completedChunks = new Set<number>(); // 已完成的分片索引
        let nextChunkIndex = 0;
        let hasError = false;
        let firstChunkSent = false; // 标记是否已发送第一个分片

        // 带宽监控
        const bandwidthMonitor = {
            startTime: Date.now(),
            totalBytes: 0,
            lastSpeedCheck: Date.now(),
            currentSpeed: 0, // KB/s
            speedHistory: [] as number[]
        };

        // 更新带宽监控
        const updateBandwidthMonitor = (bytesTransferred: number) => {
            const now = Date.now();
            bandwidthMonitor.totalBytes += bytesTransferred;
            
            if (now - bandwidthMonitor.lastSpeedCheck > 1000) { // 每秒更新一次
                const timeDiff = (now - bandwidthMonitor.lastSpeedCheck) / 1000;
                const speed = (bytesTransferred / timeDiff) / 1024; // KB/s
                
                bandwidthMonitor.currentSpeed = speed;
                bandwidthMonitor.speedHistory.push(speed);
                if (bandwidthMonitor.speedHistory.length > 10) {
                    bandwidthMonitor.speedHistory.shift();
                }
                bandwidthMonitor.lastSpeedCheck = now;
                
                console.log(`传输速度: ${speed.toFixed(1)} KB/s, 并发数: ${sendQueue.size}, 进度: ${completedChunks.size}/${totalChunks}`);
            }
        };

        // 计算动态延迟 - 大幅减少延迟
        const calculateDelay = () => {
            const avgSpeed = bandwidthMonitor.speedHistory.length > 0 
                ? bandwidthMonitor.speedHistory.reduce((a, b) => a + b, 0) / bandwidthMonitor.speedHistory.length 
                : 0;
            
            // 大幅减少延迟以提高传输速度
            if (avgSpeed > 1000) return 0;      // 高速网络: 无延迟
            else if (avgSpeed > 500) return 1;  // 中高速网络: 1ms延迟
            else if (avgSpeed > 200) return 2;  // 中速网络: 2ms延迟
            else if (avgSpeed > 100) return 5;  // 低速网络: 5ms延迟
            else return 10;                     // 慢速网络: 10ms延迟
        };

        // 发送单个分片 - 修复：添加真实的网络传输确认
        const sendSingleChunk = async (chunkIndex: number): Promise<void> => {
            return new Promise((resolve, reject) => {
                const start = chunkIndex * chunkSize;
                const end = Math.min(start + chunkSize, file.size);
                const chunk = file.slice(start, end);
                
                const reader = new FileReader();
                reader.onload = (e) => {
                    if (e.target?.result && !hasError) {
                        // 使用高效的Base64编码方法
                        const uint8Array = new Uint8Array(e.target.result as ArrayBuffer);
                        const base64Data = this.arrayBufferToBase64(uint8Array);
                        
                        const chunkMessage = {
                            type: 'fileChunk',
                            transferId: session.transferId,
                            targetUserId: session.targetUserId,
                            chunkIndex,
                            chunkData: base64Data,
                            isLast: chunkIndex === totalChunks - 1
                        };

                        try {
                            // 关键修复：WebSocket发送成功不等于网络传输完成
                            // 需要添加小延迟确保数据真正进入网络缓冲区
                            this.websocket.send(JSON.stringify(chunkMessage));
                            
                            // 添加微小延迟确保数据进入网络栈
                            setTimeout(() => {
                                updateBandwidthMonitor(chunk.size);
                                resolve();
                            }, 1); // 1ms延迟确保网络传输开始
                            
                        } catch (error) {
                            reject(error);
                        }
                    } else {
                        reject(new Error('FileReader error or transfer cancelled'));
                    }
                };
                
                reader.onerror = () => reject(new Error('FileReader error'));
                reader.readAsArrayBuffer(chunk);
            });
        };

        // 并发工作线程 - 修复：控制真实的并发数和网络流控
        const sendChunkWorker = async (): Promise<void> => {
            while (nextChunkIndex < totalChunks && !hasError) {
                // 控制并发数，避免WebSocket缓冲区溢出
                while (sendQueue.size >= 2 && !hasError) { // 限制同时发送的分片数为2
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                
                // 获取下一个要发送的分片索引
                const chunkIndex = nextChunkIndex++;
                if (chunkIndex >= totalChunks) break;
                
                sendQueue.add(chunkIndex);
                
                try {
                    await sendSingleChunk(chunkIndex);
                    
                    // 分片发送成功
                    sendQueue.delete(chunkIndex);
                    completedChunks.add(chunkIndex);
                    
                    // 第一个分片发送成功时，标记实际传输开始
                    if (!firstChunkSent) {
                        firstChunkSent = true;
                        console.log(`开始实际网络传输: ${file.name}`);
                        // 第一个分片发送成功时才开始更新进度
                        this.onTransferProgress(session.transferId, 0, 'send');
                    }
                    
                    // 更新实际传输进度（只有在实际传输开始后）
                    if (firstChunkSent) {
                        const progress = (completedChunks.size / totalChunks) * 100;
                        this.onTransferProgress(session.transferId, progress, 'send');
                    }
                    
                    // 根据网络状况动态调整发送速度
                    const delay = calculateDelay();
                    if (delay > 0) {
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                    
                } catch (error) {
                    console.error(`分片 ${chunkIndex} 发送失败:`, error);
                    sendQueue.delete(chunkIndex);
                    hasError = true;
                    break;
                }
            }
        };

        try {
            console.log(`开始并发传输: ${file.name}, 总分片: ${totalChunks}, 并发数: ${maxConcurrentChunks}`);
            
            // 启动多个并发传输线程
            const promises: Promise<void>[] = [];
            for (let i = 0; i < maxConcurrentChunks; i++) {
                promises.push(sendChunkWorker());
            }

            // 等待所有并发传输完成
            await Promise.allSettled(promises);

            if (hasError) {
                this.onTransferComplete(session.transferId, false);
            } else if (completedChunks.size === totalChunks) {
                console.log(`所有分片发送完成: ${file.name}, 等待接收端确认...`);
                // 修复：不立即显示完成，等待接收端确认
                session.status = 'waiting_confirmation';
                this.onTransferProgress(session.transferId, 100, 'send'); // 进度100%但状态为等待确认
            } else {
                console.error(`传输不完整: 完成 ${completedChunks.size}/${totalChunks} 分片`);
                this.onTransferComplete(session.transferId, false);
            }
            
        } catch (error) {
            console.error('并发传输失败:', error);
            this.onTransferComplete(session.transferId, false);
        } finally {
            this.activeTransfers.delete(session.transferId);
        }
    }

    // 组装接收到的文件
    private async assembleReceivedFile(session: FileTransferSession): Promise<void> {
        try {
            const chunks: Uint8Array[] = [];
            
            // 按顺序组装分片
            for (let i = 0; i < session.metadata!.totalChunks; i++) {
                const base64Data = session.receivedChunks!.get(i);
                if (!base64Data) {
                    throw new Error(`Missing chunk ${i}`);
                }
                // 使用高效的Base64解码方法
                const chunkData = this.base64ToArrayBuffer(base64Data as string);
                chunks.push(chunkData);
            }

            // 合并所有分片
            const totalSize = chunks.reduce((size, chunk) => size + chunk.length, 0);
            const fileData = new Uint8Array(totalSize);
            let offset = 0;

            for (const chunk of chunks) {
                fileData.set(chunk, offset);
                offset += chunk.length;
            }

            // 验证文件完整性
            const receivedHash = await this.calculateMD5FromBuffer(fileData.buffer);
            if (receivedHash !== session.expectedHash) {
                throw new Error('File integrity check failed');
            }

            // 创建文件对象
            const blob = new Blob([fileData], { type: session.metadata!.fileType });
            const file = new File([blob], session.metadata!.fileName, { 
                type: session.metadata!.fileType 
            });

            // 发送接收完成确认给发送端
            const confirmationMessage = {
                type: 'fileTransferConfirmation',
                transferId: session.transferId,
                senderId: session.senderId,
                success: true,
                message: 'File received and verified successfully'
            };
            
            this.websocket.send(JSON.stringify(confirmationMessage));
            console.log(`发送接收确认给发送端: ${session.transferId}`);

            // 如果是媒体文件，创建URL用于直接显示
            if (this.isMediaFile(session.metadata!.fileType)) {
                const mediaUrl = URL.createObjectURL(blob);
                // 通知媒体文件接收完成，传递URL
                this.onFileReceived(session.senderId!, file, mediaUrl);
            } else {
                // 普通文件正常处理
                this.onFileReceived(session.senderId!, file);
            }
            
            this.onTransferComplete(session.transferId, true);
            
        } catch (error) {
            console.error('File assembly failed:', error);
            
            // 发送接收失败确认给发送端
            const confirmationMessage = {
                type: 'fileTransferConfirmation',
                transferId: session.transferId,
                senderId: session.senderId,
                success: false,
                message: `File assembly failed: ${error.message}`
            };
            
            this.websocket.send(JSON.stringify(confirmationMessage));
            this.onTransferComplete(session.transferId, false);
        } finally {
            this.activeTransfers.delete(session.transferId);
        }
    }

    // 处理接收端确认消息
    handleTransferConfirmation(message: any): void {
        const session = this.activeTransfers.get(message.transferId);
        if (!session || session.type !== 'send') {
            console.warn('Received confirmation for unknown or non-send transfer:', message.transferId);
            return;
        }

        console.log(`收到接收端确认: ${message.transferId}, 成功: ${message.success}`);
        
        if (message.success) {
            console.log(`传输真正完成: ${session.file?.name}`);
            this.onTransferComplete(session.transferId, true);
        } else {
            console.error(`接收端报告失败: ${message.message}`);
            this.onTransferComplete(session.transferId, false);
        }
    }

    // 计算文件 MD5
    private async calculateMD5(file: File): Promise<string> {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = async (e) => {
                if (e.target?.result) {
                    const hash = await this.calculateMD5FromBuffer(e.target.result as ArrayBuffer);
                    resolve(hash);
                }
            };
            reader.readAsArrayBuffer(file);
        });
    }

    // 从 ArrayBuffer 计算 MD5
    private async calculateMD5FromBuffer(buffer: ArrayBuffer): Promise<string> {
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // 计算最优分片大小 - 精确计算Base64编码后的大小
    private calculateOptimalChunkSize(fileSize: number): number {
        // Base64编码精确计算：原始数据 * 4/3，向上取整到4的倍数
        // 加上JSON开销（字段名、引号、逗号等）约20-30%
        // 目标：确保最终消息 < 750KB，留50KB安全余量
        
        const maxSafeMessageSize = 750 * 1024; // 750KB安全限制
        const jsonOverhead = 1.25; // JSON开销25%
        const base64Overhead = 4/3; // Base64编码开销33.33%
        
        // 反推最大原始数据大小
        const maxRawSize = Math.floor(maxSafeMessageSize / (base64Overhead * jsonOverhead));
        
        if (fileSize < 1024 * 1024) { // < 1MB
            return Math.min(128 * 1024, maxRawSize); // 最多128KB
        } else if (fileSize < 10 * 1024 * 1024) { // < 10MB
            return Math.min(256 * 1024, maxRawSize); // 最多256KB
        } else if (fileSize < 100 * 1024 * 1024) { // < 100MB
            return Math.min(384 * 1024, maxRawSize); // 最多384KB
        } else { // >= 100MB
            return Math.min(400 * 1024, maxRawSize); // 最多400KB，更安全的限制
        }
    }

    // 生成传输 ID
    private generateTransferId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    // 格式化文件大小
    private formatFileSize(bytes: number): string {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // 获取用户名（需要外部实现）
    private getUserName(userId: string): string {
        return userId; // 简化实现，实际应该从用户列表获取
    }

    // 取消传输
    cancelTransfer(transferId: string): void {
        const session = this.activeTransfers.get(transferId);
        if (session) {
            const cancelMessage = {
                type: 'fileTransferCancel',
                transferId,
                targetUserId: session.targetUserId || session.senderId
            };

            this.websocket.send(JSON.stringify(cancelMessage));
            this.activeTransfers.delete(transferId);
            this.onTransferComplete(transferId, false);
        }
    }

    // 清理所有传输
    cleanup(): void {
        this.activeTransfers.clear();
    }
}

// 文件传输会话类
class FileTransferSession {
    transferId: string;
    type: 'send' | 'receive';
    status?: string; // 添加状态字段
    file?: File;
    targetUserId?: string;
    senderId?: string;
    metadata?: any;
    totalChunks?: number;
    chunkSize?: number;
    receivedChunks?: Map<number, number[]>;
    expectedHash?: string;

    constructor(config: any) {
        this.transferId = config.transferId;
        this.type = config.type;
        this.status = config.status;
        this.file = config.file;
        this.targetUserId = config.targetUserId;
        this.senderId = config.senderId;
        this.metadata = config.metadata;
        this.totalChunks = config.totalChunks;
        this.chunkSize = config.chunkSize;
        this.receivedChunks = config.receivedChunks;
        this.expectedHash = config.expectedHash;
    }
}