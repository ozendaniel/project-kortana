import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import os from 'os';

const PROFILE_DIR = path.join(os.homedir(), '.kortana', 'seamless-profile');
const SEAMLESS_URL = 'https://www.seamless.com';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9223;

export class SeamlessBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private chromeProcess: ChildProcess | null = null;

  async launch(): Promise<void> {
    // Launch Chrome as a normal process (no automation flags) with CDP debugging
    this.chromeProcess = spawn(CHROME_PATH, [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=1280,720`,
    ], { stdio: 'ignore' });

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
   *  On Windows, Chrome's parent process exits quickly (code 0) while child
   *  processes keep running. So we check Playwright connection + CDP port,
   *  not the process handle. */
  async ensureConnected(): Promise<void> {
    // Check if Playwright connection is still valid
    if (this.browser) {
      try {
        this.browser.contexts();
        return; // Connection alive
      } catch {
        console.log('[Seamless] Playwright connection lost');
      }
    }

    // Check if CDP port is still responding
    let cdpAlive = false;
    try {
      const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
      cdpAlive = resp.ok;
    } catch {
      cdpAlive = false;
    }

    if (cdpAlive) {
      console.log('[Seamless] Reconnecting Playwright to existing Chrome on CDP port...');
      this.browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
      this.context = this.browser.contexts()[0] || await this.browser.newContext();
      this.page = this.context.pages()[0] || await this.context.newPage();
      return;
    }

    // Chrome is truly dead — full relaunch
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

  async close(): Promise<void> {
    if (this.browser) await this.browser.close();
    if (this.chromeProcess) this.chromeProcess.kill();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.chromeProcess = null;
  }
}
