// WebRTC 点对点文件传输管理器
export class WebRTCManager {
    private peerConnections: Map<string, RTCPeerConnection> = new Map();
    private dataChannels: Map<string, RTCDataChannel> = new Map();
    private pendingOffers: Map<string, RTCSessionDescriptionInit> = new Map();
    private pendingAnswers: Map<string, RTCSessionDescriptionInit> = new Map();
    private iceCandidates: Map<string, RTCIceCandidate[]> = new Map();
    
    // STUN 服务器配置
    private readonly rtcConfiguration: RTCConfiguration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

    constructor(
        private onFileReceived: (senderId: string, file: File) => void,
        private onTransferProgress: (senderId: string, progress: number) => void,
        private onConnectionStateChange: (peerId: string, state: string) => void
    ) {}

    // 创建与指定用户的 P2P 连接
    async createConnection(peerId: string): Promise<void> {
        if (this.peerConnections.has(peerId)) {
            return; // 连接已存在
        }

        const peerConnection = new RTCPeerConnection(this.rtcConfiguration);
        this.peerConnections.set(peerId, peerConnection);

        // 创建数据通道
        const dataChannel = peerConnection.createDataChannel('fileTransfer', {
            ordered: true
        });
        
        this.setupDataChannel(dataChannel, peerId);
        this.dataChannels.set(peerId, dataChannel);

        // 处理 ICE 候选
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendSignalingMessage(peerId, {
                    type: 'ice-candidate',
                    candidate: event.candidate
                });
            }
        };

        // 处理连接状态变化
        peerConnection.onconnectionstatechange = () => {
            this.onConnectionStateChange(peerId, peerConnection.connectionState);
        };

        // 处理接收到的数据通道
        peerConnection.ondatachannel = (event) => {
            const channel = event.channel;
            this.setupDataChannel(channel, peerId);
            this.dataChannels.set(peerId, channel);
        };
    }

    // 发起文件传输请求
    async initiateFileTransfer(peerId: string, file: File): Promise<void> {
        await this.createConnection(peerId);
        
        const peerConnection = this.peerConnections.get(peerId);
        if (!peerConnection) {
            throw new Error('Failed to create peer connection');
        }

        // 创建 offer
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        // 发送 offer 到对方
        this.sendSignalingMessage(peerId, {
            type: 'offer',
            offer: offer,
            fileInfo: {
                name: file.name,
                size: file.size,
                type: file.type
            }
        });
    }

    // 处理信令消息
    async handleSignalingMessage(senderId: string, message: any): Promise<void> {
        switch (message.type) {
            case 'offer':
                await this.handleOffer(senderId, message);
                break;
            case 'answer':
                await this.handleAnswer(senderId, message);
                break;
            case 'ice-candidate':
                await this.handleIceCandidate(senderId, message);
                break;
            case 'file-transfer-request':
                await this.handleFileTransferRequest(senderId, message);
                break;
            case 'file-transfer-response':
                await this.handleFileTransferResponse(senderId, message);
                break;
        }
    }

    // 处理 offer
    private async handleOffer(senderId: string, message: any): Promise<void> {
        await this.createConnection(senderId);
        
        const peerConnection = this.peerConnections.get(senderId);
        if (!peerConnection) return;

        await peerConnection.setRemoteDescription(message.offer);
        
        // 创建 answer
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        // 发送 answer
        this.sendSignalingMessage(senderId, {
            type: 'answer',
            answer: answer
        });

        // 处理待处理的 ICE 候选
        const candidates = this.iceCandidates.get(senderId) || [];
        for (const candidate of candidates) {
            await peerConnection.addIceCandidate(candidate);
        }
        this.iceCandidates.delete(senderId);
    }

    // 处理 answer
    private async handleAnswer(senderId: string, message: any): Promise<void> {
        const peerConnection = this.peerConnections.get(senderId);
        if (!peerConnection) return;

        await peerConnection.setRemoteDescription(message.answer);

        // 处理待处理的 ICE 候选
        const candidates = this.iceCandidates.get(senderId) || [];
        for (const candidate of candidates) {
            await peerConnection.addIceCandidate(candidate);
        }
        this.iceCandidates.delete(senderId);
    }

    // 处理 ICE 候选
    private async handleIceCandidate(senderId: string, message: any): Promise<void> {
        const peerConnection = this.peerConnections.get(senderId);
        
        if (peerConnection && peerConnection.remoteDescription) {
            await peerConnection.addIceCandidate(message.candidate);
        } else {
            // 暂存 ICE 候选，等待 remote description 设置完成
            if (!this.iceCandidates.has(senderId)) {
                this.iceCandidates.set(senderId, []);
            }
            this.iceCandidates.get(senderId)!.push(message.candidate);
        }
    }

    // 设置数据通道
    private setupDataChannel(dataChannel: RTCDataChannel, peerId: string): void {
        dataChannel.binaryType = 'arraybuffer';
        
        let receivedData: ArrayBuffer[] = [];
        let expectedSize = 0;
        let receivedSize = 0;
        let fileName = '';

        dataChannel.onopen = () => {
            console.log(`Data channel opened with ${peerId}`);
        };

        dataChannel.onmessage = (event) => {
            if (typeof event.data === 'string') {
                // 文件元数据
                const metadata = JSON.parse(event.data);
                expectedSize = metadata.size;
                fileName = metadata.name;
                receivedData = [];
                receivedSize = 0;
            } else {
                // 文件数据
                receivedData.push(event.data);
                receivedSize += event.data.byteLength;
                
                // 更新进度
                const progress = (receivedSize / expectedSize) * 100;
                this.onTransferProgress(peerId, progress);

                // 检查是否接收完成
                if (receivedSize >= expectedSize) {
                    const blob = new Blob(receivedData);
                    const file = new File([blob], fileName);
                    this.onFileReceived(peerId, file);
                }
            }
        };

        dataChannel.onerror = (error) => {
            console.error(`Data channel error with ${peerId}:`, error);
        };

        dataChannel.onclose = () => {
            console.log(`Data channel closed with ${peerId}`);
        };
    }

    // 发送文件
    async sendFile(peerId: string, file: File): Promise<void> {
        const dataChannel = this.dataChannels.get(peerId);
        if (!dataChannel || dataChannel.readyState !== 'open') {
            throw new Error('Data channel not ready');
        }

        // 发送文件元数据
        const metadata = {
            name: file.name,
            size: file.size,
            type: file.type
        };
        dataChannel.send(JSON.stringify(metadata));

        // 分块发送文件数据
        const chunkSize = 16384; // 16KB chunks
        const reader = new FileReader();
        let offset = 0;

        const sendNextChunk = () => {
            if (offset >= file.size) {
                return; // 发送完成
            }

            const chunk = file.slice(offset, offset + chunkSize);
            reader.onload = (e) => {
                if (e.target?.result) {
                    dataChannel.send(e.target.result as ArrayBuffer);
                    offset += chunkSize;
                    
                    // 更新进度
                    const progress = (offset / file.size) * 100;
                    this.onTransferProgress(peerId, Math.min(progress, 100));
                    
                    // 继续发送下一块
                    setTimeout(sendNextChunk, 10); // 小延迟避免阻塞
                }
            };
            reader.readAsArrayBuffer(chunk);
        };

        sendNextChunk();
    }

    // 发送信令消息（需要通过 WebSocket 服务器中转）
    private sendSignalingMessage(peerId: string, message: any): void {
        // 这里需要通过现有的 WebSocket 连接发送信令消息
        // 具体实现取决于你的信令服务器设计
        const signalingMessage = {
            type: 'webrtc-signaling',
            targetId: peerId,
            data: message
        };
        
        // 假设有一个全局的 WebSocket 连接
        if ((window as any).chatWebSocket) {
            (window as any).chatWebSocket.send(JSON.stringify(signalingMessage));
        }
    }

    // 关闭与指定用户的连接
    closeConnection(peerId: string): void {
        const dataChannel = this.dataChannels.get(peerId);
        if (dataChannel) {
            dataChannel.close();
            this.dataChannels.delete(peerId);
        }

        const peerConnection = this.peerConnections.get(peerId);
        if (peerConnection) {
            peerConnection.close();
            this.peerConnections.delete(peerId);
        }

        this.iceCandidates.delete(peerId);
    }

    // 清理所有连接
    cleanup(): void {
        for (const peerId of this.peerConnections.keys()) {
            this.closeConnection(peerId);
        }
    }
}