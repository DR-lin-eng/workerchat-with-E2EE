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

    // 开始发送文件
    private async startFileSending(session: FileTransferSession): Promise<void> {
        const file = session.file!;
        const chunkSize = session.chunkSize || this.chunkSize;
        const reader = new FileReader();
        let chunkIndex = 0;

        const sendNextChunk = () => {
            if (chunkIndex >= session.totalChunks!) {
                // 发送完成
                this.onTransferComplete(session.transferId, true);
                this.activeTransfers.delete(session.transferId);
                return;
            }

            const start = chunkIndex * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            const chunk = file.slice(start, end);

            reader.onload = (e) => {
                if (e.target?.result) {
                    const chunkData = Array.from(new Uint8Array(e.target.result as ArrayBuffer));
                    
                    const chunkMessage = {
                        type: 'fileChunk',
                        transferId: session.transferId,
                        targetUserId: session.targetUserId,
                        chunkIndex,
                        chunkData,
                        isLast: chunkIndex === session.totalChunks! - 1
                    };

                    this.websocket.send(JSON.stringify(chunkMessage));
                    
                    chunkIndex++;
                    const progress = (chunkIndex / session.totalChunks!) * 100;
                    this.onTransferProgress(session.transferId, progress, 'send');
                    
                    // 适当延迟避免过载
                    setTimeout(sendNextChunk, 50);
                }
            };

            reader.readAsArrayBuffer(chunk);
        };

        sendNextChunk();
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