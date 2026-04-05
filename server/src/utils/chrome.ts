import fs from 'fs';
import path from 'path';
import os from 'os';

const CHROME_PATHS: Record<string, string[]> = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ],
};

export function findChromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const candidates = CHROME_PATHS[process.platform] || [];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Chrome not found. Set CHROME_PATH env var. Checked: ${candidates.join(', ')}`);
}

export function getProfileDir(platform: string): string {
  const base = process.env.PROFILE_STORAGE_DIR || path.join(os.homedir(), '.kortana');
  return path.join(base, `${platform}-profile`);
}

/** Remove Chrome profile lock files left behind by killed containers (Railway redeploys). */
export function cleanProfileLocks(profileDir: string): void {
  const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
  for (const name of lockFiles) {
    const lockPath = path.join(profileDir, name);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // File doesn't exist or already removed — fine
    }
  }
}

export function getChromeArgs(opts: {
  cdpPort: number;
  profileDir: string;
  headless?: boolean;
}): string[] {
  const { cdpPort, profileDir, headless = true } = opts;
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,720',
  ];

  if (headless) {
    // Google blocks headless Chrome OAuth with "browser not secure" error.
    // On Linux with Xvfb (DISPLAY set), run headful on the virtual display.
    // On Windows/macOS, run headful — Chrome window is visible but user interacts via portal.
    // Only add --headless=new on Linux without a display (non-interactive CI/scripts).
    if (process.platform === 'linux' && !process.env.DISPLAY) {
      args.push('--headless=new');
    }
  }

  if (process.platform === 'linux') {
    args.push(
      '--no-sandbox',            // Required: Docker runs as root
      '--disable-dev-shm-usage', // Required: Docker has 64MB /dev/shm
      '--disable-gpu',           // No GPU in Docker container
    );
  }

  return args;
}
