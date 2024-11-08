import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import pkg from 'https-proxy-agent';
const { HttpsProxyAgent } = pkg;
import { logger } from './logger.js';

export class GrassClient {
  constructor(userId, proxy = null) {
    this.userId = userId;
    this.proxy = proxy;
    this.ws = null;
    this.browserId = uuidv4();
    this.heartbeatInterval = null;
    this.reconnectDelay = 10000;
    this.connectionTimeout = 30000;
    this.lastHeartbeat = Date.now();
  }

  async start() {
    while (true) {
      try {
        await this.connect();
        await this.authenticate();
        this.startHeartbeat();
        
        await new Promise((resolve) => {
          this.ws.once('close', () => {
            logger.warn(`Connection closed for proxy: ${this.proxy}`);
            resolve();
          });

          // 添加心跳检查
          this.ws.on('pong', () => {
            this.lastHeartbeat = Date.now();
          });
        });
        
        this.cleanup();
        await new Promise(resolve => setTimeout(resolve, this.reconnectDelay));
      } catch (error) {
        logger.error(`Connection error: ${error.message}`);
        this.cleanup();
        await new Promise(resolve => setTimeout(resolve, this.reconnectDelay));
      }
    }
  }

  async connect() {
    const options = {
      headers: {
        'Host': 'proxy2.wynd.network:4650',
        'Connection': 'Upgrade',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
        'Upgrade': 'websocket',
        'Origin': 'https://app.getgrass.io',
        'Sec-WebSocket-Version': '13',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      handshakeTimeout: this.connectionTimeout,
      followRedirects: true,
      maxPayload: 1024 * 1024, // 1MB
      perMessageDeflate: false
    };

    if (this.proxy) {
      try {
        const proxyUrl = new URL(this.proxy);
        options.agent = new HttpsProxyAgent({
          protocol: proxyUrl.protocol,
          host: proxyUrl.hostname,
          port: proxyUrl.port,
          auth: proxyUrl.username && proxyUrl.password ? 
            `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}` : 
            undefined,
          rejectUnauthorized: false,
          timeout: this.connectionTimeout,
          keepAlive: true,
          keepAliveMsecs: 30000
        });
      } catch (error) {
        throw new Error(`Invalid proxy URL: ${error.message}`);
      }
    }

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket('wss://proxy2.wynd.network:4650', options);

      const timeout = setTimeout(() => {
        if (this.ws) {
          this.ws.terminate();
        }
        reject(new Error('Connection timeout'));
      }, this.connectionTimeout);

      this.ws.once('open', () => {
        clearTimeout(timeout);
        logger.info(`Connected via proxy: ${this.proxy}`);
        resolve();
      });

      this.ws.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async authenticate() {
    return new Promise((resolve, reject) => {
      const authTimeout = setTimeout(() => {
        reject(new Error('Authentication timeout'));
      }, this.connectionTimeout);

      this.ws.once('message', async (data) => {
        clearTimeout(authTimeout);
        try {
          const response = JSON.parse(data.toString());
          await this.sendAuthPayload(response.id);
          logger.info('Authentication successful');
          resolve();
        } catch (error) {
          reject(new Error(`Authentication failed: ${error.message}`));
        }
      });
    });
  }

  async sendAuthPayload(authId) {
    const payload = {
      id: authId,
      origin_action: 'AUTH',
      result: {
        browser_id: this.browserId,
        user_id: this.userId,
        user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
        timestamp: Math.floor(Date.now() / 1000),
        device_type: 'desktop',
        version: '4.28.1'
      }
    };
    await this.sendMessage(payload);
  }

  startHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(async () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          // 检查上次心跳时间
          const now = Date.now();
          if (now - this.lastHeartbeat > 45000) { // 45秒无心跳则重连
            logger.warn('Heartbeat timeout, reconnecting...');
            this.ws?.terminate();
            return;
          }

          await this.sendMessage({
            id: uuidv4(),
            action: 'PING',
            data: {}
          });

          await this.sendMessage({
            id: 'F3X',
            origin_action: 'PONG'
          });
          
          this.lastHeartbeat = now;
        } catch (error) {
          logger.error(`Heartbeat failed: ${error.message}`);
          this.ws?.terminate();
        }
      }
    }, 30000);
  }

  async sendMessage(payload) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket not connected'));
      }

      const timeout = setTimeout(() => {
        reject(new Error('Send message timeout'));
      }, 10000);

      this.ws.send(JSON.stringify(payload), (error) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  cleanup() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = null;
    }
  }
}
