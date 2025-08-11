import {
    UserInfo, RegisterMessage, ChatMessage, RegisteredMessage, UserListMessage, 
    EncryptedMessage, ErrorMessage, UserProfile, UserRole,
    FileStartMessage, FileChunkMessage, FileCompleteMessage, VoiceMessage,
    FileStartNotification, FileChunkNotification, FileCompleteNotification, VoiceNotification,
    FileStatusRequest, FileStatusResponse, FileTransferProgress,
    WebRTCSignalingMessage, WebRTCSignalingNotification,
    FileTransferRequest, FileTransferResponse, FileTransferChunk, FileTransferCancel,
    FileTransferRequestNotification, FileTransferResponseNotification, 
    FileChunkNotification, FileTransferCancelNotification
} from "./models";
import {readKey} from "openpgp";

export class ChatRoom {
    private state: DurableObjectState;
    private users: Map<WebSocket, UserInfo> = new Map();
    private sessions: Set<WebSocket> = new Set();
    // 文件传输状态跟踪
    private fileTransfers: Map<string, FileTransferProgress> = new Map();
    // 文件分片临时存储 (fileId -> Map<chunkIndex, encryptedData>)
    private fileChunks: Map<string, Map<number, string>> = new Map();

    constructor(state: DurableObjectState) {
        this.state = state;
    }

    async fetch(request: Request): Promise<Response> {
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected websocket', { status: 400 });
        }

        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);

        this.handleSession(server);

        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }

    private handleSession(webSocket: WebSocket): void {
        webSocket.accept();
        this.sessions.add(webSocket);

        webSocket.addEventListener('message', (event) => {
            try {
                const message = JSON.parse(event.data as string);
                this.handleMessage(webSocket, message);
            } catch (error) {
                this.sendError(webSocket, 'Invalid JSON format');
            }
        });

        webSocket.addEventListener('close', () => {
            this.handleDisconnect(webSocket);
        });

        webSocket.addEventListener('error', () => {
            this.handleDisconnect(webSocket);
        });
    }

    private handleMessage(webSocket: WebSocket, message: any): void {
        switch (message.type) {
            case 'register':
                this.handleRegister(webSocket, message);
                break;
            case 'getUsers':
                this.handleGetUsers(webSocket);
                break;
            case 'message':
                this.handleChatMessage(webSocket, message);
                break;
            case 'fileStart':
                this.handleFileStart(webSocket, message);
                break;
            case 'fileChunk':
                this.handleFileChunk(webSocket, message);
                break;
            case 'fileComplete':
                this.handleFileComplete(webSocket, message);
                break;
            case 'voice':
                this.handleVoiceMessage(webSocket, message);
                break;
            case 'fileStatus':
                this.handleFileStatusRequest(webSocket, message);
                break;
            case 'webrtc-signaling':
                this.handleWebRTCSignaling(webSocket, message);
                break;
            case 'fileTransferRequest':
                this.handleFileTransferRequest(webSocket, message);
                break;
            case 'fileTransferResponse':
                this.handleFileTransferResponse(webSocket, message);
                break;
            case 'realtimeFileChunk':
                this.handleFileTransferChunk(webSocket, message);
                break;
            case 'fileTransferCancel':
                this.handleFileTransferCancel(webSocket, message);
                break;
            default:
                this.sendError(webSocket, `Unknown message type: ${message.type}`);
        }
    }

    private async handleRegister(webSocket: WebSocket, message: RegisterMessage): Promise<void> {
        try {
            if (!message.publicKey || typeof message.publicKey !== 'string') {
                this.sendError(webSocket, 'Invalid public key format');
                return;
            }

            if (!this.isValidPGPPublicKey(message.publicKey)) {
                this.sendError(webSocket, 'Invalid PGP public key format');
                return;
            }

            const userProfile = await this.extractUserProfile(message.publicKey);
            
            const userInfo: UserInfo = {
                id: userProfile.id,
                name: userProfile.name,
                email: userProfile.email,
                publicKey: message.publicKey,
                webSocket: webSocket,
                role: UserRole.GUEST
            };
            
            const existingUser = this.findUserById(userInfo.id);
            if (existingUser && existingUser.webSocket !== webSocket) {
                this.users.delete(existingUser.webSocket);
                existingUser.webSocket.close();
            }

            this.users.set(webSocket, userInfo);

            const response: RegisteredMessage = {
                type: 'registered',
                profile: {
                    id: userInfo.id,
                    name: userInfo.name,
                    email: userInfo.email
                }
            };
            
            webSocket.send(JSON.stringify(response));
            this.broadcastUserList();

        } catch (error) {
            this.sendError(webSocket, 'Registration failed');
        }
    }

    private handleGetUsers(webSocket: WebSocket): void {
        const users = Array.from(this.users.values()).map(user => ({
            id: user.id,
            name: user.name,
            email: user.email,
            publicKey: user.publicKey
        }));

        const response: UserListMessage = {
            type: 'userList',
            users: users
        };

        webSocket.send(JSON.stringify(response));
    }

    private handleChatMessage(webSocket: WebSocket, message: ChatMessage): void {
        const sender = this.users.get(webSocket);
        if (!sender) {
            this.sendError(webSocket, 'User not registered');
            return;
        }

        if (!message.encryptedData || typeof message.encryptedData !== 'string') {
            this.sendError(webSocket, 'Invalid encrypted data format');
            return;
        }

        if (!this.isValidPGPMessage(message.encryptedData)) {
            this.sendError(webSocket, 'Invalid PGP message format');
            return;
        }

        const broadcastMessage: EncryptedMessage = {
            type: 'encryptedMessage',
            senderId: sender.id,
            encryptedData: message.encryptedData,
            timestamp: Date.now()
        };

        this.broadcast(broadcastMessage);
    }

    private handleFileStart(webSocket: WebSocket, message: FileStartMessage): void {
        const sender = this.users.get(webSocket);
        if (!sender) {
            this.sendError(webSocket, 'User not registered');
            return;
        }

        // 验证文件元数据
        if (!message.metadata || !message.metadata.fileId || !message.metadata.fileName) {
            this.sendError(webSocket, 'Invalid file metadata');
            return;
        }

        // 检查文件大小限制 (例如最大5GB)
        const maxFileSize = 5 * 1024 * 1024 * 1024; // 5GB
        if (message.metadata.fileSize > maxFileSize) {
            this.sendError(webSocket, 'File too large');
            return;
        }

        // 初始化文件传输状态
        const fileTransfer: FileTransferProgress = {
            fileId: message.metadata.fileId,
            fileName: message.metadata.fileName,
            fileSize: message.metadata.fileSize,
            uploadedChunks: new Set(),
            totalChunks: message.metadata.totalChunks,
            isComplete: false,
            chunks: new Map(),
            metadata: message.metadata
        };

        this.fileTransfers.set(message.metadata.fileId, fileTransfer);
        this.fileChunks.set(message.metadata.fileId, new Map());

        // 广播文件开始传输通知
        const notification: FileStartNotification = {
            type: 'fileStartNotification',
            senderId: sender.id,
            fileId: message.metadata.fileId,
            metadata: message.metadata,
            timestamp: Date.now()
        };

        this.broadcast(notification);
    }

    private handleFileChunk(webSocket: WebSocket, message: FileChunkMessage): void {
        const sender = this.users.get(webSocket);
        if (!sender) {
            this.sendError(webSocket, 'User not registered');
            return;
        }

        const fileTransfer = this.fileTransfers.get(message.fileId);
        if (!fileTransfer) {
            this.sendError(webSocket, 'File transfer not found');
            return;
        }

        // 验证分片数据
        if (!message.chunk || !message.encryptedChunk) {
            this.sendError(webSocket, 'Invalid chunk data');
            return;
        }

        // 存储分片
        const chunkMap = this.fileChunks.get(message.fileId);
        if (chunkMap) {
            chunkMap.set(message.chunk.chunkIndex, message.encryptedChunk);
            fileTransfer.uploadedChunks.add(message.chunk.chunkIndex);
        }

        // 广播分片通知
        const notification: FileChunkNotification = {
            type: 'fileChunkNotification',
            senderId: sender.id,
            fileId: message.fileId,
            chunk: message.chunk,
            timestamp: Date.now()
        };

        this.broadcast(notification);
    }

    private handleFileComplete(webSocket: WebSocket, message: FileCompleteMessage): void {
        const sender = this.users.get(webSocket);
        if (!sender) {
            this.sendError(webSocket, 'User not registered');
            return;
        }

        const fileTransfer = this.fileTransfers.get(message.fileId);
        if (!fileTransfer) {
            this.sendError(webSocket, 'File transfer not found');
            return;
        }

        // 标记传输完成
        fileTransfer.isComplete = true;

        // 广播传输完成通知
        const notification: FileCompleteNotification = {
            type: 'fileCompleteNotification',
            senderId: sender.id,
            fileId: message.fileId,
            timestamp: Date.now()
        };

        this.broadcast(notification);

        // 清理传输状态 (可选择保留一段时间用于重传)
        setTimeout(() => {
            this.fileTransfers.delete(message.fileId);
            this.fileChunks.delete(message.fileId);
        }, 5 * 60 * 1000); // 5分钟后清理
    }

    private handleVoiceMessage(webSocket: WebSocket, message: VoiceMessage): void {
        const sender = this.users.get(webSocket);
        if (!sender) {
            this.sendError(webSocket, 'User not registered');
            return;
        }

        // 验证语音数据
        if (!message.metadata || !message.encryptedVoiceData) {
            this.sendError(webSocket, 'Invalid voice message data');
            return;
        }

        // 检查语音文件大小限制 (例如最大50MB)
        const maxVoiceSize = 50 * 1024 * 1024; // 50MB
        const estimatedSize = message.encryptedVoiceData.length * 0.75; // Base64大致大小估算
        if (estimatedSize > maxVoiceSize) {
            this.sendError(webSocket, 'Voice message too large');
            return;
        }

        // 广播语音消息
        const notification: VoiceNotification = {
            type: 'voiceNotification',
            senderId: sender.id,
            voiceId: message.metadata.voiceId,
            metadata: message.metadata,
            encryptedVoiceData: message.encryptedVoiceData,
            timestamp: Date.now()
        };

        this.broadcast(notification);
    }

    private handleFileStatusRequest(webSocket: WebSocket, message: FileStatusRequest): void {
        const sender = this.users.get(webSocket);
        if (!sender) {
            this.sendError(webSocket, 'User not registered');
            return;
        }

        const fileTransfer = this.fileTransfers.get(message.fileId);
        if (!fileTransfer) {
            this.sendError(webSocket, 'File transfer not found');
            return;
        }

        const response: FileStatusResponse = {
            type: 'fileStatusResponse',
            fileId: message.fileId,
            receivedChunks: Array.from(fileTransfer.uploadedChunks),
            isComplete: fileTransfer.isComplete
        };

        webSocket.send(JSON.stringify(response));
    }

    private handleDisconnect(webSocket: WebSocket): void {
        this.sessions.delete(webSocket);
        this.users.delete(webSocket);
        this.broadcastUserList();
    }

    private broadcast(message: any): void {
        const messageStr = JSON.stringify(message);
        for (const session of this.sessions) {
            try {
                session.send(messageStr);
            } catch (error) {
                this.sessions.delete(session);
                this.users.delete(session);
            }
        }
    }

    private broadcastUserList(): void {
        const users = Array.from(this.users.values()).map(user => ({
            id: user.id,
            name: user.name,
            email: user.email,
            publicKey: user.publicKey
        }));

        const message: UserListMessage = {
            type: 'userList',
            users: users
        };

        this.broadcast(message);
    }

    private sendError(webSocket: WebSocket, message: string): void {
        const errorMessage: ErrorMessage = {
            type: 'error',
            message: message
        };
        
        try {
            webSocket.send(JSON.stringify(errorMessage));
        } catch (error) {
            // 连接已关闭，忽略错误
        }
    }

    private findUserById(id: string): UserInfo | undefined {
        for (const user of this.users.values()) {
            if (user.id === id) {
                return user;
            }
        }
        return undefined;
    }

    private isValidPGPPublicKey(publicKey: string): boolean {
        return publicKey.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----') &&
               publicKey.includes('-----END PGP PUBLIC KEY BLOCK-----');
    }

    private isValidPGPMessage(message: string): boolean {
        return message.includes('-----BEGIN PGP MESSAGE-----') &&
               message.includes('-----END PGP MESSAGE-----');
    }

    private async extractUserProfile(publicKeyArmored: string): Promise<UserProfile> {
        try {
            const publicKey = await readKey({ armoredKey: publicKeyArmored });
            const primaryUser = await publicKey.getPrimaryUser();
            const userID = primaryUser.user.userID;
            
            let name = '';
            let email = '';
            let id = '';
            
            if (userID) {
                const userIdString = userID.userID || '';
                const match = userIdString.match(/^(.+?)\s*<([^>]+)>$/);
                
                if (match) {
                    name = match[1].trim();
                    email = match[2].trim();
                } else {
                    if (userIdString.includes('@')) {
                        email = userIdString.trim();
                        name = email.split('@')[0];
                    } else {
                        name = userIdString.trim();
                    }
                }
            }
            
            id = publicKey.getFingerprint().toUpperCase();
            
            if (!name) {
                name = `User_${Math.random().toString(36).substr(2, 8)}`;
            }
            if (!email) {
                email = `${name.toLowerCase().replace(/\s+/g, '')}@example.com`;
            }
            
            return { id, name, email };
            
        } catch (error) {
            console.error('解析公钥时出错:', error);
            return this.fallbackExtractUserProfile(publicKeyArmored);
        }
    }
    
    private fallbackExtractUserProfile(publicKey: string): UserProfile {
        const lines = publicKey.split('\n');
        let name = `User_${Math.random().toString(36).substr(2, 8)}`;
        let email = `${name.toLowerCase()}@example.com`;
        let id = this.generateUserIdFromKey(publicKey);

        for (const line of lines) {
            if (line.includes('Comment:') || line.includes('Name:')) {
                const match = line.match(/([\w\s]+)\s*<([^>]+)>/);
                if (match) {
                    name = match[1].trim();
                    email = match[2].trim();
                }
            }
        }

        return { id, name, email };
    }

    private handleWebRTCSignaling(webSocket: WebSocket, message: WebRTCSignalingMessage): void {
        const sender = this.users.get(webSocket);
        if (!sender) {
            this.sendError(webSocket, 'User not registered');
            return;
        }

        // 查找目标用户
        const targetUser = this.findUserById(message.targetId);
        if (!targetUser) {
            this.sendError(webSocket, 'Target user not found');
            return;
        }

        // 转发信令消息给目标用户
        const notification: WebRTCSignalingNotification = {
            type: 'webrtc-signaling-notification',
            senderId: sender.id,
            data: message.data
        };

        try {
            targetUser.webSocket.send(JSON.stringify(notification));
        } catch (error) {
            this.sendError(webSocket, 'Failed to deliver signaling message');
        }
    }

    private handleFileTransferRequest(webSocket: WebSocket, message: FileTransferRequest): void {
        const sender = this.users.get(webSocket);
        if (!sender) {
            this.sendError(webSocket, 'User not registered');
            return;
        }

        // 查找目标用户
        const targetUser = this.findUserById(message.targetUserId);
        if (!targetUser) {
            this.sendError(webSocket, 'Target user not found');
            return;
        }

        // 验证文件大小限制 (例如最大 500MB)
        const maxFileSize = 500 * 1024 * 1024; // 500MB
        if (message.metadata.fileSize > maxFileSize) {
            this.sendError(webSocket, 'File too large');
            return;
        }

        // 转发传输请求给目标用户
        const notification: FileTransferRequestNotification = {
            type: 'fileTransferRequestNotification',
            transferId: message.transferId,
            senderId: sender.id,
            metadata: message.metadata
        };

        try {
            targetUser.webSocket.send(JSON.stringify(notification));
        } catch (error) {
            this.sendError(webSocket, 'Failed to deliver transfer request');
        }
    }

    private handleFileTransferResponse(webSocket: WebSocket, message: FileTransferResponse): void {
        const sender = this.users.get(webSocket);
        if (!sender) {
            this.sendError(webSocket, 'User not registered');
            return;
        }

        // 查找发起传输的用户
        const targetUser = this.findUserById(message.senderId);
        if (!targetUser) {
            this.sendError(webSocket, 'Original sender not found');
            return;
        }

        // 转发响应给发起者
        const notification: FileTransferResponseNotification = {
            type: 'fileTransferResponseNotification',
            transferId: message.transferId,
            targetUserId: sender.id,
            accepted: message.accepted
        };

        try {
            targetUser.webSocket.send(JSON.stringify(notification));
        } catch (error) {
            this.sendError(webSocket, 'Failed to deliver transfer response');
        }
    }

    private handleFileTransferChunk(webSocket: WebSocket, message: FileTransferChunk): void {
        const sender = this.users.get(webSocket);
        if (!sender) {
            this.sendError(webSocket, 'User not registered');
            return;
        }

        // 查找目标用户
        const targetUser = this.findUserById(message.targetUserId);
        if (!targetUser) {
            this.sendError(webSocket, 'Target user not found');
            return;
        }

        // 验证分片大小
        const maxChunkSize = 128 * 1024; // 128KB
        if (message.chunkData.length > maxChunkSize) {
            this.sendError(webSocket, 'Chunk too large');
            return;
        }

        // 转发分片给目标用户
        const notification: FileChunkNotification = {
            type: 'realtimeFileChunkNotification',
            transferId: message.transferId,
            senderId: sender.id,
            chunkIndex: message.chunkIndex,
            chunkData: message.chunkData,
            isLast: message.isLast
        };

        try {
            targetUser.webSocket.send(JSON.stringify(notification));
        } catch (error) {
            this.sendError(webSocket, 'Failed to deliver file chunk');
        }
    }

    private handleFileTransferCancel(webSocket: WebSocket, message: FileTransferCancel): void {
        const sender = this.users.get(webSocket);
        if (!sender) {
            this.sendError(webSocket, 'User not registered');
            return;
        }

        // 查找目标用户
        const targetUser = this.findUserById(message.targetUserId);
        if (!targetUser) {
            return; // 目标用户不存在，静默处理
        }

        // 转发取消消息给目标用户
        const notification: FileTransferCancelNotification = {
            type: 'fileTransferCancelNotification',
            transferId: message.transferId,
            senderId: sender.id
        };

        try {
            targetUser.webSocket.send(JSON.stringify(notification));
        } catch (error) {
            // 静默处理错误
        }
    }

    private generateUserIdFromKey(publicKey: string): string {
        let hash = 0;
        for (let i = 0; i < publicKey.length; i++) {
            const char = publicKey.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(16).padStart(8, '0');
    }
}
