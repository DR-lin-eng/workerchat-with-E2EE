export { ChatRoom } from "./ChatRoom";

export interface Env {
    CHAT_ROOMS: DurableObjectNamespace;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        
        // 处理 CORS 预检请求
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                }
            });
        }

        // 创建房间 API
        if (url.pathname === '/api/room' && request.method === 'POST') {
            try {
                // 生成64字符的随机房间ID
                const roomId = generateRoomId();
                
                return new Response(roomId, {
                    status: 200,
                    headers: {
                        'Content-Type': 'text/plain',
                        'Access-Control-Allow-Origin': '*',
                    }
                });
            } catch (error) {
                return new Response('Internal Server Error', {
                    status: 500,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                    }
                });
            }
        }

        // WebSocket 连接处理
        const match = url.pathname.match(/^\/api\/room\/([a-zA-Z0-9]{64})\/websocket$/);
        if (match && request.headers.get('Upgrade') === 'websocket') {
            const roomId = match[1];

            // 获取或创建 Durable Object 实例
            const durableObjectId = env.CHAT_ROOMS.idFromName(roomId);
            const durableObject = env.CHAT_ROOMS.get(durableObjectId);
            
            // 转发 WebSocket 请求到 Durable Object
            return durableObject.fetch(request);
        }

        // 静态文件服务
        if (url.pathname === '/webrtc' || url.pathname === '/webrtc.html') {
            // 重定向到 WebRTC 版本
            return new Response(null, {
                status: 302,
                headers: {
                    'Location': '/webrtc.html',
                    'Access-Control-Allow-Origin': '*',
                }
            });
        }

        if (url.pathname === '/realtime' || url.pathname === '/realtime.html') {
            // 重定向到实时传输版本
            return new Response(null, {
                status: 302,
                headers: {
                    'Location': '/realtime.html',
                    'Access-Control-Allow-Origin': '*',
                }
            });
        }

        // 根路径重定向到首页
        if (url.pathname === '/') {
            return new Response(null, {
                status: 302,
                headers: {
                    'Location': '/index.html',
                    'Access-Control-Allow-Origin': '*',
                }
            });
        }

        // 404 处理
        return new Response('Not Found', { status: 404 });
    }
};

// 生成64字符的随机房间ID
function generateRoomId(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 64; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}