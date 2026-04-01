import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from 'playwright';
import { spawn, type ChildProcess } from 'child_process';
import { findChromePath, getProfileDir, getChromeArgs } from '../../utils/chrome.js';

const PROFILE_DIR = getProfileDir('seamless');
const SEAMLESS_URL = 'https://www.seamless.com';
const CDP_PORT = 9223;

export class SeamlessBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private chromeProcess: ChildProcess | null = null;

  async launch(): Promise<void> {
    const chromePath = findChromePath();
    const args = getChromeArgs({ cdpPort: CDP_PORT, profileDir: PROFILE_DIR, headless: true });
    this.chromeProcess = spawn(chromePath, args, { stdio: 'ignore' });

    this.chromeProcess.on('exit', (code) => {
      // On Windows, Chrome's parent launcher process exits quickly (code 0)
      // while child processes keep running. Don't null state here — ensureConnected handles it.
      console.warn(`[Seamless] Chrome launcher process exited with code ${code}`);
    });

    // Give Chrome a moment to start and open the debug port
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Connect Playwright via CDP — no automation banners
    this.browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
    this.context = this.browser.contexts()[0] || await this.browser.newContext();
    this.page = this.context.pages()[0] || await this.context.newPage();
  }

  /** Check if Chrome + CDP connection is alive, reconnect if not.
   *  Tests the actual context with an async operation — browser.contexts()
   *  alone returns stale objects even when the context is dead. */
  async ensureConnected(): Promise<void> {
    if (this.browser && this.context) {
      try {
        const pages = this.context.pages();
        const livePage = pages.find(p => !p.isClosed());
        if (livePage) {
          await livePage.title();
          return;
        }
        this.page = await this.context.newPage();
        return;
      } catch {
        console.log('[Seamless] Browser context is dead, reconnecting...');
        this.context = null;
        this.page = null;
      }
    }

    let cdpAlive = false;
    try {
      const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
      cdpAlive = resp.ok;
    } catch {
      cdpAlive = false;
    }

    if (cdpAlive) {
      console.log('[Seamless] Reconnecting Playwright to Chrome CDP...');
      if (this.browser) {
        try { await this.browser.close(); } catch { /* stale */ }
      }
      this.browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
      this.context = this.browser.contexts()[0] || await this.browser.newContext();
      this.page = this.context.pages()[0] || await this.context.newPage();
      return;
    }

    console.log('[Seamless] Chrome is down, relaunching...');
    if (this.browser) {
      try { await this.browser.close(); } catch { /* already dead */ }
    }
    if (this.chromeProcess && !this.chromeProcess.killed) {
      this.chromeProcess.kill();
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.chromeProcess = null;

    await this.launch();
  }

  async ensurePage(): Promise<Page> {
    if (!this.page || this.page.isClosed()) {
      if (!this.context) throw new Error('Browser not launched');
      this.page = await this.context.newPage();
    }
    return this.page;
  }

  /** Extract session cookies for direct HTTP calls */
  async getSessionCookies(): Promise<string> {
    if (!this.context) throw new Error('Browser not launched');
    const cookies = await this.context.cookies(SEAMLESS_URL);
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /** Extract Grubhub auth token from localStorage */
  async getAuthToken(): Promise<string> {
    try {
      const page = await this.ensurePage();
      const token = await page.evaluate(() => {
        const session = localStorage.getItem('grub-api:authenticatedSession');
        if (!session) return '';
        try {
          const parsed = JSON.parse(session);
          return parsed.sessionHandle?.accessToken || '';
        } catch {
          return '';
        }
      });
      return token || '';
    } catch {
      return '';
    }
  }

  /** Extract PerimeterX token from page context */
  async getPerimeterXToken(): Promise<string> {
    try {
      const page = await this.ensurePage();
      const token = await page.evaluate(() => {
        return (window as any)._pxUuid || (window as any)._pxVid || '';
      });
      return token || '';
    } catch {
      return '';
    }
  }

  async navigateHome(): Promise<void> {
    const page = await this.ensurePage();
    await page.goto(SEAMLESS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  async isLoggedIn(): Promise<boolean> {
    const page = await this.ensurePage();
    try {
      await page.goto(SEAMLESS_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      return this.hasAuthSession();
    } catch {
      return false;
    }
  }

  /** Check if Grubhub authenticated session exists in localStorage */
  private async hasAuthSession(): Promise<boolean> {
    try {
      const page = await this.ensurePage();
      return page.evaluate(() => {
        const session = localStorage.getItem('grub-api:authenticatedSession');
        return session !== null && session.includes('credential');
      });
    } catch {
      return false;
    }
  }

  /** Wait for user to complete manual login. Polls for auth session in localStorage. */
  async waitForLogin(timeoutMs = 120000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.hasAuthSession()) return true;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return false;
  }

  /** Get the main page for external use (auth manager screencast) */
  getPage(): Page | null {
    return this.page;
  }

  /** Get context for external use */
  getContext(): BrowserContext | null {
    return this.context;
  }

  /** Create a CDP session for the given page (used for screencast) */
  async createCDPSession(page?: Page): Promise<CDPSession> {
    const target = page || this.page;
    if (!target) throw new Error('No page available for CDP session');
    return await target.context().newCDPSession(target);
  }

  /** Get the login URL for this platform */
  getLoginUrl(): string {
    return SEAMLESS_URL;
  }

  async close(): Promise<void> {
    if (this.browser) await this.browser.close();
    if (this.chromeProcess) this.chromeProcess.kill();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.chromeProcess = null;
  }
}
