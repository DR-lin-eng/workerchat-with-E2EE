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

        const { chunkIndex, chunkData, isLast, requireAck } = message;
        
        try {
            // 验证分片数据
            if (!chunkData || typeof chunkData !== 'string') {
                throw new Error('Invalid chunk data');
            }
            
            // 存储分片
            session.receivedChunks!.set(chunkIndex, chunkData);
            
            // 发送分片确认（如果需要）
            if (requireAck) {
                const ackMessage = {
                    type: 'fileChunkAck',
                    transferId: message.transferId,
                    chunkIndex,
                    success: true,
                    senderId: session.senderId
                };
                
                this.websocket.send(JSON.stringify(ackMessage));
            }
            
            // 更新进度
            const progress = (session.receivedChunks!.size / session.metadata!.totalChunks) * 100;
            this.onTransferProgress(message.transferId, progress, 'receive');

            // 检查是否接收完成
            if (session.receivedChunks!.size === session.metadata!.totalChunks) {
                this.assembleReceivedFile(session);
            }
            
        } catch (error) {
            console.error(`处理分片 ${chunkIndex} 失败:`, error);
            
            // 发送分片失败确认
            if (requireAck) {
                const ackMessage = {
                    type: 'fileChunkAck',
                    transferId: message.transferId,
                    chunkIndex,
                    success: false,
                    error: error.message,
                    senderId: session.senderId
                };
                
                this.websocket.send(JSON.stringify(ackMessage));
            }
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

    // 开始发送文件 - 改进的流控机制
    private async startFileSending(session: FileTransferSession): Promise<void> {
        const file = session.file!;
        const chunkSize = session.chunkSize || this.chunkSize;
        const totalChunks = session.totalChunks!;
        
        console.log(`准备传输: ${file.name}, 总分片: ${totalChunks}`);
        
        // 流控配置 - 防止缓冲区溢出
        const maxPendingChunks = 1; // 最多1个待确认分片，严格控制流量
        const chunkTimeout = 10000; // 10秒超时
        const maxRetries = 3; // 最大重试次数
        
        // 传输状态跟踪
        const pendingChunks = new Map<number, { timestamp: number, retries: number }>(); // 待确认的分片
        const confirmedChunks = new Set<number>(); // 已确认的分片
        const failedChunks = new Set<number>(); // 失败的分片
        let nextChunkIndex = 0;
        let hasError = false;
        
        // 网络状态监控
        const networkMonitor = {
            lastConfirmTime: Date.now(),
            avgConfirmTime: 1000, // 平均确认时间
            confirmTimes: [] as number[]
        };

        // 更新网络监控
        const updateNetworkMonitor = (confirmTime: number) => {
            networkMonitor.confirmTimes.push(confirmTime);
            if (networkMonitor.confirmTimes.length > 10) {
                networkMonitor.confirmTimes.shift();
            }
            networkMonitor.avgConfirmTime = networkMonitor.confirmTimes.reduce((a, b) => a + b, 0) / networkMonitor.confirmTimes.length;
            networkMonitor.lastConfirmTime = Date.now();
        };

        // 计算动态延迟 - 基于网络确认时间
        const calculateDelay = () => {
            const timeSinceLastConfirm = Date.now() - networkMonitor.lastConfirmTime;
            const avgTime = networkMonitor.avgConfirmTime;
            
            // 如果最近没有确认，增加延迟
            if (timeSinceLastConfirm > avgTime * 2) {
                return Math.min(avgTime, 2000); // 最多2秒延迟
            } else if (avgTime > 3000) {
                return 1000; // 慢网络1秒延迟
            } else if (avgTime > 1000) {
                return 500; // 中等网络500ms延迟
            } else {
                return 100; // 快网络100ms延迟
            }
        };

        // 发送单个分片 - 等待真实网络传输
        const sendSingleChunk = async (chunkIndex: number): Promise<void> => {
            return new Promise((resolve, reject) => {
                const start = chunkIndex * chunkSize;
                const end = Math.min(start + chunkSize, file.size);
                const chunk = file.slice(start, end);
                
                const reader = new FileReader();
                reader.onload = (e) => {
                    if (e.target?.result && !hasError) {
                        const uint8Array = new Uint8Array(e.target.result as ArrayBuffer);
                        const base64Data = this.arrayBufferToBase64(uint8Array);
                        
                        const chunkMessage = {
                            type: 'fileChunk',
                            transferId: session.transferId,
                            targetUserId: session.targetUserId,
                            chunkIndex,
                            chunkData: base64Data,
                            isLast: chunkIndex === totalChunks - 1,
                            requireAck: true // 要求确认
                        };

                        try {
                            // 检查WebSocket缓冲区状态
                            if (this.websocket.bufferedAmount > 1024 * 1024) { // 1MB缓冲区限制
                                console.warn(`WebSocket缓冲区过大: ${this.websocket.bufferedAmount} bytes, 等待清空...`);
                                
                                // 等待缓冲区清空
                                const waitForBuffer = () => {
                                    if (this.websocket.bufferedAmount < 512 * 1024) { // 等到小于512KB
                                        this.websocket.send(JSON.stringify(chunkMessage));
                                        pendingChunks.set(chunkIndex, { timestamp: Date.now(), retries: 0 });
                                        resolve();
                                    } else {
                                        setTimeout(waitForBuffer, 100);
                                    }
                                };
                                waitForBuffer();
                            } else {
                                this.websocket.send(JSON.stringify(chunkMessage));
                                pendingChunks.set(chunkIndex, { timestamp: Date.now(), retries: 0 });
                                resolve();
                            }
                            
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

        // 处理分片确认
        const handleChunkAck = (chunkIndex: number, success: boolean) => {
            const pending = pendingChunks.get(chunkIndex);
            if (!pending) return;

            if (success) {
                const confirmTime = Date.now() - pending.timestamp;
                updateNetworkMonitor(confirmTime);
                
                pendingChunks.delete(chunkIndex);
                confirmedChunks.add(chunkIndex);
                
                // 更新真实进度（基于确认的分片）
                const progress = (confirmedChunks.size / totalChunks) * 100;
                this.onTransferProgress(session.transferId, progress, 'send');
                
                console.log(`分片 ${chunkIndex} 确认成功, 进度: ${progress.toFixed(1)}%, 确认时间: ${confirmTime}ms`);
            } else {
                // 分片失败，标记重试
                pending.retries++;
                if (pending.retries >= maxRetries) {
                    pendingChunks.delete(chunkIndex);
                    failedChunks.add(chunkIndex);
                    console.error(`分片 ${chunkIndex} 重试失败，放弃传输`);
                    hasError = true;
                } else {
                    console.warn(`分片 ${chunkIndex} 失败，准备重试 (${pending.retries}/${maxRetries})`);
                }
            }
        };

        // 设置分片确认监听器
        const originalHandleMessage = this.handleFileChunkAck?.bind(this);
        this.handleFileChunkAck = (message: any) => {
            if (message.transferId === session.transferId) {
                handleChunkAck(message.chunkIndex, message.success);
            }
            originalHandleMessage?.(message);
        };

        // 超时检查器
        const timeoutChecker = setInterval(() => {
            const now = Date.now();
            for (const [chunkIndex, pending] of pendingChunks.entries()) {
                if (now - pending.timestamp > chunkTimeout) {
                    console.warn(`分片 ${chunkIndex} 超时，标记重试`);
                    handleChunkAck(chunkIndex, false);
                }
            }
        }, 1000);

        // 主传输循环 - 严格的流控
        const sendNextChunk = async (): Promise<void> => {
            while (nextChunkIndex < totalChunks && !hasError) {
                // 严格控制待确认分片数量
                while (pendingChunks.size >= maxPendingChunks && !hasError) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                
                if (hasError) break;
                
                // 检查是否有需要重试的分片
                let chunkToSend = -1;
                for (const [chunkIndex, pending] of pendingChunks.entries()) {
                    if (pending.retries > 0 && Date.now() - pending.timestamp > 1000) {
                        chunkToSend = chunkIndex;
                        break;
                    }
                }
                
                // 如果没有重试分片，发送下一个新分片
                if (chunkToSend === -1 && nextChunkIndex < totalChunks) {
                    chunkToSend = nextChunkIndex++;
                }
                
                if (chunkToSend >= 0) {
                    try {
                        await sendSingleChunk(chunkToSend);
                        
                        // 动态延迟控制
                        const delay = calculateDelay();
                        if (delay > 0) {
                            await new Promise(resolve => setTimeout(resolve, delay));
                        }
                        
                    } catch (error) {
                        console.error(`分片 ${chunkToSend} 发送失败:`, error);
                        hasError = true;
                        break;
                    }
                } else {
                    // 没有分片需要发送，短暂等待
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
        };

        try {
            console.log(`开始流控传输: ${file.name}, 最大待确认分片: ${maxPendingChunks}`);
            
            // 开始传输
            await sendNextChunk();
            
            // 等待所有分片确认完成
            const waitForCompletion = async (): Promise<boolean> => {
                const maxWaitTime = 60000; // 最多等待60秒
                const startTime = Date.now();
                
                while (Date.now() - startTime < maxWaitTime) {
                    if (hasError || failedChunks.size > 0) {
                        return false;
                    }
                    
                    if (confirmedChunks.size === totalChunks) {
                        return true;
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                
                console.error(`传输超时: 确认 ${confirmedChunks.size}/${totalChunks} 分片`);
                return false;
            };
            
            const success = await waitForCompletion();
            
            if (success) {
                console.log(`传输完成: ${file.name}, 所有分片已确认`);
                this.onTransferComplete(session.transferId, true);
            } else {
                console.error(`传输失败: ${file.name}`);
                this.onTransferComplete(session.transferId, false);
            }
            
        } catch (error) {
            console.error('流控传输失败:', error);
            this.onTransferComplete(session.transferId, false);
        } finally {
            clearInterval(timeoutChecker);
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

    // 处理分片确认消息
    handleFileChunkAck?: (message: any) => void;

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