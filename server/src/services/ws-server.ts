import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'http';
import type { AuthManager } from './auth-manager.js';

export function setupWebSocket(server: Server, authManager: AuthManager): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    console.log('[WS] Client connected');
    let authenticated = true; // Localhost dev: no auth needed

    // In production, require WS_AUTH_SECRET
    if (process.env.WS_AUTH_SECRET) {
      authenticated = false;
    }

    authManager.registerWsClient(ws);

    // Send current auth status on connect
    if (authenticated) {
      ws.send(JSON.stringify({ type: 'auth_status', ...authManager.getStatus() }));
    }

    ws.on('message', async (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Handle auth for production
      if (!authenticated) {
        if (msg.type === 'auth' && msg.secret === process.env.WS_AUTH_SECRET) {
          authenticated = true;
          ws.send(JSON.stringify({ type: 'auth_status', ...authManager.getStatus() }));
        } else {
          ws.close(4001, 'Unauthorized');
        }
        return;
      }

      switch (msg.type) {
        case 'start_login':
          if (msg.platform) {
            await authManager.startLogin(msg.platform, ws);
          }
          break;

        case 'stop_login':
          if (msg.platform) {
            await authManager.stopLogin(msg.platform);
          }
          break;

        case 'mouse_click':
        case 'mouse_move':
        case 'key_press':
        case 'key_type':
        case 'scroll':
          if (msg.platform) {
            await authManager.handleInput(msg.platform, msg);
          }
          break;

        case 'get_status':
          ws.send(JSON.stringify({ type: 'auth_status', ...authManager.getStatus() }));
          break;
      }
    });

    ws.on('close', () => {
      console.log('[WS] Client disconnected');
    });
  });

  console.log('[WS] WebSocket server attached at /ws');
}
