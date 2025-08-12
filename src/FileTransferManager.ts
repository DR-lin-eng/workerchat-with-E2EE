// WebSocket 实时文件传输管理器
export class FileTransferManager {
    private activeTransfers: Map<string, FileTransferSession> = new Map();
    private chunkSize: number = 256 * 1024; // 256KB chunks (default)
    
    constructor(
        private websocket: WebSocket,
        private onFileReceived: (senderId: string, file: File) => void,
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

    // 处理传输请求
    async handleTransferRequest(message: any): Promise<void> {
        const { transferId, senderId, metadata } = message;
        
        // 询问用户是否接受文件
        const accept = confirm(
            `${this.getUserName(senderId)} 想要发送文件:\n` +
            `文件名: ${metadata.fileName}\n` +
            `大小: ${this.formatFileSize(metadata.fileSize)}\n` +
            `类型: ${metadata.fileType}\n\n` +
            `是否接受?`
        );

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

    // 开始发送文件 - 使用30并发传输
    private async startFileSending(session: FileTransferSession): Promise<void> {
        const file = session.file!;
        const chunkSize = session.chunkSize || this.chunkSize;
        const totalChunks = session.totalChunks!;
        
        // 并发传输配置
        const maxConcurrentChunks = 100; // 默认使用30并发
        const sendQueue = new Set<number>(); // 正在发送的分片索引
        const completedChunks = new Set<number>(); // 已完成的分片索引
        let nextChunkIndex = 0;
        let hasError = false;

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

        // 计算动态延迟
        const calculateDelay = () => {
            const avgSpeed = bandwidthMonitor.speedHistory.length > 0 
                ? bandwidthMonitor.speedHistory.reduce((a, b) => a + b, 0) / bandwidthMonitor.speedHistory.length 
                : 0;
            
            if (avgSpeed > 500) return 5;       // 高速网络: 5ms延迟
            else if (avgSpeed > 200) return 10; // 中速网络: 10ms延迟
            else if (avgSpeed > 100) return 20; // 低速网络: 20ms延迟
            else return 50;                     // 慢速网络: 50ms延迟
        };

        // 发送单个分片
        const sendSingleChunk = async (chunkIndex: number): Promise<void> => {
            return new Promise((resolve, reject) => {
                const start = chunkIndex * chunkSize;
                const end = Math.min(start + chunkSize, file.size);
                const chunk = file.slice(start, end);
                
                const reader = new FileReader();
                reader.onload = (e) => {
                    if (e.target?.result && !hasError) {
                        const chunkData = Array.from(new Uint8Array(e.target.result as ArrayBuffer));
                        
                        const chunkMessage = {
                            type: 'fileChunk',
                            transferId: session.transferId,
                            targetUserId: session.targetUserId,
                            chunkIndex,
                            chunkData,
                            isLast: chunkIndex === totalChunks - 1
                        };

                        try {
                            this.websocket.send(JSON.stringify(chunkMessage));
                            updateBandwidthMonitor(chunk.size);
                            resolve();
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

        // 并发工作线程
        const sendChunkWorker = async (): Promise<void> => {
            while (nextChunkIndex < totalChunks && !hasError) {
                // 获取下一个要发送的分片索引
                const chunkIndex = nextChunkIndex++;
                if (chunkIndex >= totalChunks) break;
                
                sendQueue.add(chunkIndex);
                
                try {
                    await sendSingleChunk(chunkIndex);
                    
                    // 分片发送成功
                    sendQueue.delete(chunkIndex);
                    completedChunks.add(chunkIndex);
                    
                    // 更新进度
                    const progress = (completedChunks.size / totalChunks) * 100;
                    this.onTransferProgress(session.transferId, progress, 'send');
                    
                    // 动态延迟
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
                console.log(`传输完成: ${file.name}, 总用时: ${((Date.now() - bandwidthMonitor.startTime) / 1000).toFixed(1)}s`);
                this.onTransferComplete(session.transferId, true);
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
                const chunkData = session.receivedChunks!.get(i);
                if (!chunkData) {
                    throw new Error(`Missing chunk ${i}`);
                }
                chunks.push(new Uint8Array(chunkData));
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

            // 通知文件接收完成
            this.onFileReceived(session.senderId!, file);
            this.onTransferComplete(session.transferId, true);
            
        } catch (error) {
            console.error('File assembly failed:', error);
            this.onTransferComplete(session.transferId, false);
        } finally {
            this.activeTransfers.delete(session.transferId);
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

    // 计算最优分片大小 (考虑WebSocket消息大小限制)
    private calculateOptimalChunkSize(fileSize: number): number {
        // WebSocket消息大小限制约12KB
        // 测试显示2KB数据产生约7.28KB消息，1KB数据产生约3.71KB消息
        // 为了安全起见，使用更小的分片大小
        const maxSafeChunkSize = 2 * 1024; // 2KB 安全分片大小
        
        // 根据文件大小调整分片大小，但不超过安全限制
        if (fileSize < 1024 * 1024) { // < 1MB
            return 1 * 1024; // 1KB
        } else if (fileSize < 10 * 1024 * 1024) { // < 10MB
            return Math.floor(1.5 * 1024); // 1.5KB
        } else { // >= 10MB
            return maxSafeChunkSize; // 2KB
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