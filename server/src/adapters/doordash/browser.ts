import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import path from 'path';
import os from 'os';

const PROFILE_DIR = path.join(os.homedir(), '.kortana', 'doordash-profile');
const DOORDASH_URL = 'https://www.doordash.com';
const GRAPHQL_URL = 'https://www.doordash.com/graphql';

export class DoorDashBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async launch(): Promise<void> {
    this.browser = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false, // DoorDash Cloudflare detection requires headed mode initially
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
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

  /** Execute a GraphQL query via the browser's fetch (inherits TLS fingerprint + cookies) */
  async graphqlQuery<T = unknown>(
    operationName: string,
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<T> {
    const page = await this.ensurePage();
    return page.evaluate(
      async ({ url, operationName, query, variables }) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operationName, query, variables }),
        });
        if (!response.ok) throw new Error(`GraphQL ${response.status}: ${response.statusText}`);
        return response.json();
      },
      { url: GRAPHQL_URL, operationName, query, variables }
    );
  }

  /** Navigate to DoorDash homepage to trigger login / verify session */
  async navigateHome(): Promise<void> {
    const page = await this.ensurePage();
    await page.goto(DOORDASH_URL, { waitUntil: 'networkidle' });
  }

  /** Check if we have a valid session by looking for logged-in indicators */
  async isLoggedIn(): Promise<boolean> {
    const page = await this.ensurePage();
    try {
      await page.goto(DOORDASH_URL, { waitUntil: 'networkidle', timeout: 15000 });
      // Check for sign-in button absence as a proxy for logged-in state
      const signInButton = await page.$('a[href="/consumer/login"]');
      return signInButton === null;
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
