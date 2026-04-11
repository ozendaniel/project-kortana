/**
 * Lightweight file-based process lock with PID liveness checks.
 *
 * Populate scripts acquire a lock so the dev server knows to skip adapter
 * initialization for that platform (avoids two Playwright instances fighting
 * over one Chrome). Locks self-heal: if the owning process has died, the
 * stale file is cleaned up on read.
 *
 * Locks live in ~/.kortana/{name}.lock as JSON: {pid, startedAt, script?}.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const LOCK_DIR = path.join(os.homedir(), '.kortana');

export interface LockData {
  pid: number;
  startedAt: string;
  script?: string;
}

function lockPath(name: string): string {
  return path.join(LOCK_DIR, `${name}.lock`);
}

/** Check if a process is alive. Cross-platform (uses signal 0). */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    // Signal 0 is a health check — doesn't actually send a signal.
    // Throws ESRCH if process doesn't exist, EPERM if it exists but we can't signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't send it signals — still "alive"
    if (code === 'EPERM') return true;
    return false;
  }
}

function readLock(name: string): LockData | null {
  const file = lockPath(name);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (typeof data?.pid === 'number') return data as LockData;
    return null;
  } catch {
    return null;
  }
}

/**
 * Check whether a lock is currently held by an alive process.
 * If the lockfile exists but its PID is dead, cleans up the stale file and returns null.
 */
export function getActiveLock(name: string): LockData | null {
  const lock = readLock(name);
  if (!lock) return null;
  if (isPidAlive(lock.pid)) return lock;

  // Stale lock — PID is dead. Remove the file so the next check is clean.
  try {
    fs.unlinkSync(lockPath(name));
    console.log(`[ProcessLock] Cleaned up stale lock "${name}" (pid ${lock.pid} is dead)`);
  } catch {
    /* Another process may be doing the same cleanup — not our problem */
  }
  return null;
}

/**
 * Acquire a named lock. Writes PID + metadata and registers cleanup handlers
 * so the lock is released on any exit path (graceful, Ctrl+C, crash).
 * Throws if another alive process already holds the lock.
 */
export function acquireLock(name: string, metadata: { script?: string } = {}): void {
  if (!fs.existsSync(LOCK_DIR)) {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
  }

  const existing = getActiveLock(name);
  if (existing) {
    throw new Error(
      `[ProcessLock] Lock "${name}" already held by pid ${existing.pid} (started ${existing.startedAt}). ` +
      `Stop the other process first or wait for it to finish.`
    );
  }

  const data: LockData = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    script: metadata.script,
  };
  fs.writeFileSync(lockPath(name), JSON.stringify(data, null, 2));
  console.log(`[ProcessLock] Acquired lock "${name}" (pid ${process.pid})`);

  // Register cleanup handlers. Guard with a flag so repeated signals don't double-free.
  let released = false;
  const cleanup = () => {
    if (released) return;
    released = true;
    releaseLock(name);
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  process.on('uncaughtException', (err) => {
    console.error('[ProcessLock] uncaughtException:', err);
    cleanup();
    process.exit(1);
  });
}

/** Release a lock owned by the current process. Idempotent and safe. */
export function releaseLock(name: string): void {
  const lock = readLock(name);
  if (!lock) return;
  if (lock.pid !== process.pid) {
    // Not our lock — don't touch it
    return;
  }
  try {
    fs.unlinkSync(lockPath(name));
    console.log(`[ProcessLock] Released lock "${name}"`);
  } catch {
    /* Already removed — fine */
  }
}
