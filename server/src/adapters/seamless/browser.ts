import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import path from 'path';
import os from 'os';

const PROFILE_DIR = path.join(os.homedir(), '.kortana', 'seamless-profile');
const SEAMLESS_URL = 'https://www.seamless.com';

export class SeamlessBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async launch(): Promise<void> {
    this.browser = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true, // Seamless may work headless — test early
      viewport: { width: 1280, height: 720 },
    }).then((ctx) => {
      this.context = ctx;
      return null;
    });

    this.page = this.context!.pages()[0] || (await this.context!.newPage());
  }

  async ensurePage(): Promise<Page> {
    if (!this.page || this.page.isClosed()) {
      if (!this.context) throw new Error('Browser not launched');
      this.page = await this.context.newPage();
    }
    return this.page;
  }

  /** Extract session cookies for direct HTTP calls (if Seamless doesn't need browser context) */
  async getSessionCookies(): Promise<string> {
    if (!this.context) throw new Error('Browser not launched');
    const cookies = await this.context.cookies(SEAMLESS_URL);
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  async isLoggedIn(): Promise<boolean> {
    const page = await this.ensurePage();
    try {
      await page.goto(SEAMLESS_URL, { waitUntil: 'networkidle', timeout: 15000 });
      // Check for logged-in state — look for account/profile element
      const accountLink = await page.$('[data-testid="account-link"], .accountLink, a[href*="account"]');
      return accountLink !== null;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.context) await this.context.close();
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}
