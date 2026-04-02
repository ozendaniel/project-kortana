import type { CDPSession, Page } from 'playwright';
import type { WebSocket } from 'ws';
import type { AuthStatus } from '../adapters/types.js';
import type { DoorDashBrowser } from '../adapters/doordash/browser.js';
import type { SeamlessBrowser } from '../adapters/seamless/browser.js';

type PlatformBrowser = DoorDashBrowser | SeamlessBrowser;

interface PlatformState {
  browser: PlatformBrowser;
  status: AuthStatus;
  cdpSession: CDPSession | null;
  activeWs: WebSocket | null;
  loginPollInterval: ReturnType<typeof setInterval> | null;
  onLoginSuccess?: () => Promise<void>;
}

export class AuthManager {
  private platforms = new Map<string, PlatformState>();
  private sessionMonitor: ReturnType<typeof setInterval> | null = null;
  private wsClients = new Set<WebSocket>();

  registerPlatform(
    name: string,
    browser: PlatformBrowser,
    status: AuthStatus,
    onLoginSuccess?: () => Promise<void>,
  ): void {
    this.platforms.set(name, {
      browser,
      status,
      cdpSession: null,
      activeWs: null,
      loginPollInterval: null,
      onLoginSuccess,
    });
  }

  registerWsClient(ws: WebSocket): void {
    this.wsClients.add(ws);
    ws.on('close', () => this.wsClients.delete(ws));
  }

  getStatus(): Record<string, AuthStatus> {
    const result: Record<string, AuthStatus> = {};
    for (const [name, state] of this.platforms) {
      result[name] = state.status;
    }
    // Fill in unconfigured platforms
    for (const name of ['doordash', 'seamless']) {
      if (!result[name]) result[name] = 'not_configured';
    }
    return result;
  }

  async startLogin(platform: string, ws: WebSocket): Promise<void> {
    const state = this.platforms.get(platform);
    if (!state) {
      ws.send(JSON.stringify({ type: 'login_failed', platform, reason: 'Platform not configured' }));
      return;
    }

    if (state.status === 'logging_in') {
      ws.send(JSON.stringify({ type: 'login_failed', platform, reason: 'Login already in progress' }));
      return;
    }

    state.status = 'logging_in';
    state.activeWs = ws;

    try {
      console.log(`[AuthManager] ${platform}: ensuring browser connection...`);
      await state.browser.ensureConnected();
      console.log(`[AuthManager] ${platform}: browser connected, getting page...`);
      const page = await state.browser.ensurePage();

      // Navigate to login page
      const loginUrl = state.browser.getLoginUrl();
      console.log(`[AuthManager] ${platform}: navigating to ${loginUrl}...`);
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log(`[AuthManager] ${platform}: page loaded, starting screencast...`);

      // Start CDP screencast
      const cdp = await state.browser.createCDPSession(page);
      state.cdpSession = cdp;

      let frameCount = 0;
      cdp.on('Page.screencastFrame', async (params: any) => {
        frameCount++;
        if (frameCount <= 3 || frameCount % 50 === 0) {
          console.log(`[AuthManager] ${platform}: screencast frame #${frameCount} (${params.metadata.deviceWidth}x${params.metadata.deviceHeight})`);
        }
        if (state.activeWs?.readyState === 1) {
          state.activeWs.send(JSON.stringify({
            type: 'frame',
            platform,
            data: params.data,
            width: params.metadata.deviceWidth,
            height: params.metadata.deviceHeight,
          }));
        }
        // Acknowledge frame to keep receiving them
        try {
          await cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId });
        } catch {
          // CDP session may be detached
        }
      });

      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        maxWidth: 1280,
        maxHeight: 720,
      });
      console.log(`[AuthManager] ${platform}: screencast started, waiting for frames...`);

      // Poll for login completion
      state.loginPollInterval = setInterval(async () => {
        try {
          const loggedIn = await state.browser.isLoggedIn();
          if (loggedIn) {
            await this.finishLogin(platform, true);
          }
        } catch {
          // Browser might be navigating during login
        }
      }, 3000);

      // Timeout after 5 minutes
      setTimeout(() => {
        if (state.status === 'logging_in') {
          this.finishLogin(platform, false, 'Login timed out after 5 minutes');
        }
      }, 300000);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[AuthManager] startLogin(${platform}) failed:`, msg);
      state.status = 'expired';
      ws.send(JSON.stringify({ type: 'login_failed', platform, reason: msg }));
    }
  }

  private async finishLogin(platform: string, success: boolean, reason?: string): Promise<void> {
    const state = this.platforms.get(platform);
    if (!state) return;

    // Stop screencast
    if (state.cdpSession) {
      try {
        await state.cdpSession.send('Page.stopScreencast');
        await state.cdpSession.detach();
      } catch { /* already detached */ }
      state.cdpSession = null;
    }

    // Stop login polling
    if (state.loginPollInterval) {
      clearInterval(state.loginPollInterval);
      state.loginPollInterval = null;
    }

    state.status = success ? 'authenticated' : 'expired';

    // Notify adapter of successful login (e.g., refresh tokens)
    if (success && state.onLoginSuccess) {
      try { await state.onLoginSuccess(); } catch (err) {
        console.error(`[AuthManager] onLoginSuccess callback failed for ${platform}:`, err);
      }
    }

    if (state.activeWs?.readyState === 1) {
      if (success) {
        state.activeWs.send(JSON.stringify({ type: 'login_complete', platform }));
      } else {
        state.activeWs.send(JSON.stringify({ type: 'login_failed', platform, reason: reason || 'Login failed' }));
      }
    }
    state.activeWs = null;

    console.log(`[AuthManager] ${platform} login ${success ? 'succeeded' : 'failed'}`);
  }

  async stopLogin(platform: string): Promise<void> {
    await this.finishLogin(platform, false, 'Login cancelled by user');
  }

  /** Forward mouse/keyboard events from the portal to the browser */
  async handleInput(platform: string, event: any): Promise<void> {
    const state = this.platforms.get(platform);
    if (!state || state.status !== 'logging_in') return;

    const page = state.browser.getPage();
    if (!page) return;

    try {
      switch (event.type) {
        case 'mouse_click':
          console.log(`[AuthManager] ${platform}: click at (${event.x}, ${event.y})`);
          await page.mouse.click(event.x, event.y);
          // Log URL after click in case of navigation
          setTimeout(async () => {
            try { console.log(`[AuthManager] ${platform}: page URL after click: ${page.url()}`); } catch {}
          }, 1500);
          break;
        case 'mouse_move':
          await page.mouse.move(event.x, event.y);
          break;
        case 'key_press':
          console.log(`[AuthManager] ${platform}: key_press ${event.key}`);
          await page.keyboard.press(event.key);
          break;
        case 'key_type':
          await page.keyboard.type(event.text);
          break;
        case 'scroll':
          await page.mouse.wheel(event.deltaX || 0, event.deltaY || 0);
          break;
      }
    } catch (err) {
      console.log(`[AuthManager] ${platform}: input error: ${err instanceof Error ? err.message.substring(0, 80) : err}`);
    }
  }

  /** Start background session monitoring */
  startSessionMonitor(): void {
    if (this.sessionMonitor) return;
    this.sessionMonitor = setInterval(async () => {
      for (const [name, state] of this.platforms) {
        if (state.status === 'logging_in') continue; // Don't check during login
        try {
          const loggedIn = await state.browser.isLoggedIn();
          const newStatus: AuthStatus = loggedIn ? 'authenticated' : 'expired';
          if (state.status === 'authenticated' && newStatus === 'expired') {
            console.log(`[AuthManager] ${name} session expired`);
            state.status = 'expired';
            this.broadcast({ type: 'session_expired', platform: name });
          } else if (state.status === 'expired' && newStatus === 'authenticated') {
            state.status = 'authenticated';
          }
        } catch {
          // Browser might be busy, skip this check
        }
      }
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  stopSessionMonitor(): void {
    if (this.sessionMonitor) {
      clearInterval(this.sessionMonitor);
      this.sessionMonitor = null;
    }
  }

  private broadcast(message: object): void {
    const data = JSON.stringify(message);
    for (const ws of this.wsClients) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  }
}
