import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from 'playwright';
import { spawn, type ChildProcess } from 'child_process';
import { findChromePath, getProfileDir, getChromeArgs, cleanProfileLocks } from '../../utils/chrome.js';

const PROFILE_DIR = getProfileDir('doordash');
const DOORDASH_URL = 'https://www.doordash.com';
const GRAPHQL_URL = 'https://www.doordash.com/graphql';
const CDP_PORT = 9224; // Seamless uses 9223

export class DoorDashBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;       // Main page (for login/navigation)
  private apiPage: Page | null = null;    // Dedicated API page (stable context for fetch calls)
  private chromeProcess: ChildProcess | null = null;

  async launch(): Promise<void> {
    cleanProfileLocks(PROFILE_DIR);
    const chromePath = findChromePath();
    const args = getChromeArgs({ cdpPort: CDP_PORT, profileDir: PROFILE_DIR, headless: true });
    this.chromeProcess = spawn(chromePath, args, { stdio: 'ignore' });

    this.chromeProcess.on('exit', (code) => {
      // On Windows, Chrome's parent launcher process exits quickly (code 0)
      // while child processes keep running. Don't null state here — ensureConnected handles it.
      console.warn(`[DoorDash] Chrome launcher process exited with code ${code}`);
    });

    // Wait for Chrome CDP port to be ready (headless takes longer on Windows)
    await this.waitForCDP();

    // Connect Playwright via CDP — no automation banners, real TLS fingerprint
    this.browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
    this.context = this.browser.contexts()[0] || await this.browser.newContext();
    this.page = this.context.pages()[0] || await this.context.newPage();
  }

  /** Poll until Chrome CDP port is accepting connections */
  private async waitForCDP(timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
        if (resp.ok) return;
      } catch { /* not ready yet */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Chrome CDP not ready on port ${CDP_PORT} after ${timeoutMs}ms`);
  }

  /** Check if Chrome + CDP connection is alive, reconnect if not.
   *  Tests the actual context with an async operation — browser.contexts()
   *  alone returns stale objects even when the context is dead. */
  async ensureConnected(): Promise<void> {
    // Deep health check: try an actual async operation on the context
    if (this.browser && this.context) {
      try {
        // pages() is sync but newPage()/title() would throw on dead context.
        // Check if existing page is usable with a lightweight async call.
        const pages = this.context.pages();
        const livePage = pages.find(p => !p.isClosed());
        if (livePage) {
          await livePage.title(); // throws if context is dead
          return;
        }
        // No live pages but context might still work — try creating one
        this.page = await this.context.newPage(); // throws if context is dead
        this.apiPage = null;
        return;
      } catch {
        console.log('[DoorDash] Browser context is dead, reconnecting...');
        this.context = null;
        this.page = null;
        this.apiPage = null;
      }
    }

    // Try reconnecting Playwright to Chrome via CDP
    let cdpAlive = false;
    try {
      const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
      cdpAlive = resp.ok;
    } catch {
      cdpAlive = false;
    }

    if (cdpAlive) {
      console.log('[DoorDash] Reconnecting Playwright to Chrome CDP...');
      if (this.browser) {
        try { await this.browser.close(); } catch { /* stale */ }
      }
      try {
        this.browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`, { timeout: 10000 });
        this.context = this.browser.contexts()[0] || await this.browser.newContext();
        this.page = this.context.pages()[0] || await this.context.newPage();
        this.apiPage = null;
        return;
      } catch (err) {
        console.log(`[DoorDash] CDP reconnect failed (${err instanceof Error ? err.message.substring(0, 60) : err}), full relaunch...`);
      }
    } else {
      console.log('[DoorDash] Chrome CDP not responding...');
    }

    console.log('[DoorDash] Relaunching Chrome...');
    if (this.browser) {
      try { await this.browser.close(); } catch { /* already dead */ }
    }
    if (this.chromeProcess && !this.chromeProcess.killed) {
      this.chromeProcess.kill();
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.apiPage = null;
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

  /**
   * Get or create a dedicated API tab for GraphQL calls.
   * Navigates to DoorDash to establish origin/cookies, then stops the SPA.
   */
  private async ensureApiPage(): Promise<Page> {
    if (this.apiPage && !this.apiPage.isClosed()) {
      return this.apiPage;
    }
    if (!this.context) throw new Error('Browser not launched');

    this.apiPage = await this.context.newPage();

    // Use route interception to block everything except our fetch calls —
    // this prevents DoorDash SPA JS from loading and interfering
    await this.apiPage.route('**/*', (route) => {
      const url = route.request().url();
      // Allow the initial navigation and our GraphQL calls
      if (url.includes('/graphql') || route.request().resourceType() === 'document') {
        route.continue();
      } else {
        route.abort();
      }
    });

    await this.apiPage.goto(DOORDASH_URL, {
      waitUntil: 'commit',
      timeout: 15000,
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log('[DoorDash] API tab ready on doordash.com origin');
    return this.apiPage;
  }

  /** Execute a GraphQL query via the dedicated API tab's fetch.
   *  Uses a separate tab to avoid SPA navigation destroying the execution context.
   *  Retries on 429 with exponential backoff. */
  async graphqlQuery<T = unknown>(
    operationName: string,
    query: string,
    variables: Record<string, unknown> = {},
    maxRetries = 3
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const apiPage = await this.ensureApiPage();

      let result: any;
      try {
        result = await apiPage.evaluate(
          async ({ url, operationName, query, variables }) => {
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ operationName, query, variables }),
            });
            if (!response.ok) {
              const text = await response.text().catch(() => '');
              return { __error: true, status: response.status, statusText: response.statusText, body: text.substring(0, 500) };
            }
            return response.json();
          },
          { url: GRAPHQL_URL, operationName, query, variables }
        );
      } catch (err: any) {
        // If page context was destroyed or closed, recreate the API page and retry
        const isRecoverable = err.message?.includes('Execution context was destroyed')
          || err.message?.includes('navigation')
          || err.message?.includes('has been closed')
          || err.message?.includes('Target closed');
        if (isRecoverable && attempt < maxRetries) {
          console.log(`[DoorDash] API page lost on ${operationName} (${err.message?.substring(0, 60)}), recreating...`);
          this.apiPage = null;
          await new Promise(resolve => setTimeout(resolve, 3000));
          continue;
        }
        throw err;
      }

      // Check for rate limiting
      if (result && typeof result === 'object' && '__error' in result) {
        const err = result as { status: number; statusText: string; body: string };
        if (err.status === 429 && attempt < maxRetries) {
          const delay = (attempt + 1) * 4000 + Math.random() * 3000; // 4-7s, 8-11s, 12-15s
          console.log(`[DoorDash] 429 rate limited on ${operationName}, retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(`GraphQL ${err.status}: ${err.statusText} ${err.body}`);
      }

      return result as T;
    }

    throw new Error(`GraphQL query ${operationName} failed after ${maxRetries} retries`);
  }

  /**
   * Navigate the main tab to a store page and wait for full load.
   * This gives the main tab full DoorDash JS context (CSRF, session state)
   * needed for cart mutations.
   */
  async navigateToStore(storeId: string): Promise<void> {
    const page = await this.ensurePage();
    const currentUrl = page.url();
    // Only navigate if not already on this store's page
    if (!currentUrl.includes(`/store/${storeId}`)) {
      await page.goto(`${DOORDASH_URL}/store/${storeId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      // Let DoorDash's JS initialize (CSRF tokens, session context)
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  /**
   * Execute a GraphQL query from the MAIN tab (not the API tab).
   * Use this for cart mutations that require full DoorDash JS context.
   * Handles page navigation retries.
   */
  async mainTabGraphqlQuery<T = unknown>(
    operationName: string,
    query: string,
    variables: Record<string, unknown> = {},
    maxRetries = 3
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const page = await this.ensurePage();

      let result: any;
      try {
        result = await page.evaluate(
          async ({ url, operationName, query, variables }) => {
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ operationName, query, variables }),
            });
            if (!response.ok) {
              const text = await response.text().catch(() => '');
              return { __error: true, status: response.status, statusText: response.statusText, body: text.substring(0, 500) };
            }
            return response.json();
          },
          { url: GRAPHQL_URL, operationName, query, variables }
        );
      } catch (err: any) {
        const isRecoverable = err.message?.includes('Execution context was destroyed')
          || err.message?.includes('navigation')
          || err.message?.includes('has been closed')
          || err.message?.includes('Target closed');
        if (isRecoverable && attempt < maxRetries) {
          console.log(`[DoorDash] Main tab context lost on ${operationName}, waiting for settle...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
          // Page may have navigated — wait for it to stabilize
          try {
            const p = await this.ensurePage();
            await p.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
          } catch { /* page may still be navigating */ }
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        throw err;
      }

      // Check for rate limiting
      if (result && typeof result === 'object' && '__error' in result) {
        const err = result as { status: number; statusText: string; body: string };
        if (err.status === 429 && attempt < maxRetries) {
          const delay = (attempt + 1) * 4000 + Math.random() * 3000;
          console.log(`[DoorDash] 429 rate limited on ${operationName} (main tab), retrying in ${(delay / 1000).toFixed(1)}s`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(`GraphQL ${err.status}: ${err.statusText} ${err.body}`);
      }

      return result as T;
    }

    throw new Error(`Main tab GraphQL ${operationName} failed after ${maxRetries} retries`);
  }

  /** Navigate to DoorDash homepage to trigger login / verify session */
  async navigateHome(): Promise<void> {
    const page = await this.ensurePage();
    await page.goto(DOORDASH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  /** Check if we have a valid session by looking for logged-in indicators */
  async isLoggedIn(): Promise<boolean> {
    const page = await this.ensurePage();
    try {
      await page.goto(DOORDASH_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      // Wait a moment for page to settle
      await new Promise(resolve => setTimeout(resolve, 2000));
      // Check for sign-in button absence as a proxy for logged-in state
      const signInButton = await page.$('a[href="/consumer/login"]');
      return signInButton === null;
    } catch {
      return false;
    }
  }

  /** Wait for user to complete manual OTP login. Polls for logged-in state. */
  async waitForLogin(timeoutMs = 180000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const page = await this.ensurePage();
        const signInButton = await page.$('a[href="/consumer/login"]');
        const loginForm = await page.$('input[name="email"]');
        if (signInButton === null && loginForm === null) {
          const url = page.url();
          if (!url.includes('/consumer/login') && !url.includes('/identity')) {
            return true;
          }
        }
      } catch {
        // Page might be navigating, just wait
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
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
    return DOORDASH_URL;
  }

  async close(): Promise<void> {
    if (this.apiPage && !this.apiPage.isClosed()) await this.apiPage.close().catch(() => {});
    if (this.browser) await this.browser.close();
    if (this.chromeProcess) this.chromeProcess.kill();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.apiPage = null;
    this.chromeProcess = null;
  }
}
