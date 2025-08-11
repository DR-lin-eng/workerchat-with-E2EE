// 权限
export enum Permission {
    VIEW_MESSAGES = 'view_messages',
    SEND_MESSAGES = 'send_messages', 
    BAN_USERS = 'ban_users',
    GENERATE_INVITE_LINKS = 'generate_invite_links',
    MANAGE_PERMISSIONS = 'manage_permissions',
    SEND_FILES = 'send_files',
    SEND_VOICE = 'send_voice'
}

// 用户组
export enum UserRole {
    GUEST = 'guest',
    USER = 'user', 
    ADMIN = 'admin'
}

// 权限组配置
export interface RoleConfig {
    name: string;
    permissions: Permission[];
    description: string;
}

// IP(含v6/v4支持)
export interface IP {
    v6?: string;
    v4: string;
}

// 邀请链接
export interface InviteLink {
    id: string;
    role: UserRole;
    createdBy: string;
    createdAt: number;
    expiresAt?: number;
    usageCount: number;
    maxUsage?: number;
}

// 用户信息
export interface UserInfo {
    id: string;
    name: string;
    email: string;
    publicKey: string;
    webSocket: WebSocket;
    role: UserRole;
    ipAddress?: IP;
}

// 封禁记录
export interface BanRecord {
    type: 'ip' | 'keyFingerprint';
    value: IP|string;
}

// 用户信息
export interface UserProfile {
    id: string; // 即keyid(long)
    name: string;
    email: string;
}

// 文件分片信息
export interface FileChunk {
    chunkId: string;
    chunkIndex: number;
    totalChunks: number;
    data: string; // Base64 encoded encrypted chunk data
}

// 文件元数据
export interface FileMetadata {
    fileId: string;
    fileName: string;
    fileSize: number;
    fileType: string;
    totalChunks: number;
    chunkSize: number;
    hash?: string; // 文件哈希用于验证完整性
}

// 语音消息元数据
export interface VoiceMetadata {
    voiceId: string;
    duration: number; // 音频时长（秒）
    sampleRate: number;
    format: string; // 'webm', 'mp3', etc.
}

export interface RegisterMessage {
    type: 'register';
    publicKey: string;
}

export interface RegisteredMessage {
    type: 'registered';
    profile: UserProfile;
}

export interface UserListMessage {
    type: 'userList';
    users: Array<{
        id: string;
        name: string;
        email: string;
        publicKey: string;
    }>;
}

// 普通文本消息
export interface ChatMessage {
    type: 'message';
    encryptedData: string;
}

// 文件开始传输消息
export interface FileStartMessage {
    type: 'fileStart';
    metadata: FileMetadata;
    encryptedMetadata: string; // 加密的文件元数据
}

// 文件分片消息
export interface FileChunkMessage {
    type: 'fileChunk';
    fileId: string;
    chunk: FileChunk;
    encryptedChunk: string; // 加密的分片数据
}

// 文件传输完成消息
export interface FileCompleteMessage {
    type: 'fileComplete';
    fileId: string;
}

// 语音消息
export interface VoiceMessage {
    type: 'voice';
    metadata: VoiceMetadata;
    encryptedVoiceData: string; // 加密的语音数据
}

// 文件传输状态请求
export interface FileStatusRequest {
    type: 'fileStatus';
    fileId: string;
}

// 文件传输状态响应
export interface FileStatusResponse {
    type: 'fileStatusResponse';
    fileId: string;
    receivedChunks: number[];
    isComplete: boolean;
}

// 加密信息
export interface EncryptedMessage {
    type: 'encryptedMessage';
    senderId: string;
    encryptedData: string;
    timestamp: number;
}

// 文件开始传输通知
export interface FileStartNotification {
    type: 'fileStartNotification';
    senderId: string;
    fileId: string;
    metadata: FileMetadata;
    timestamp: number;
}

// 文件分片通知
export interface FileChunkNotification {
    type: 'fileChunkNotification';
    senderId: string;
    fileId: string;
    chunk: FileChunk;
    timestamp: number;
}

// 文件传输完成通知
export interface FileCompleteNotification {
    type: 'fileCompleteNotification';
    senderId: string;
    fileId: string;
    timestamp: number;
}

// 语音消息通知
export interface VoiceNotification {
    type: 'voiceNotification';
    senderId: string;
    voiceId: string;
    metadata: VoiceMetadata;
    encryptedVoiceData: string;
    timestamp: number;
}

export interface ErrorMessage {
    type: 'error';
    message: string;
}

// 文件传输进度跟踪
export interface FileTransferProgress {
    fileId: string;
    fileName: string;
    fileSize: number;
    uploadedChunks: Set<number>;
    totalChunks: number;
    isComplete: boolean;
    chunks: Map<number, string>; // chunkIndex -> encrypted data
    metadata?: FileMetadata;
}

// 语音录制状态
export enum VoiceRecordingState {
    IDLE = 'idle',
    RECORDING = 'recording',
    PROCESSING = 'processing',
    SENDING = 'sending'
}
