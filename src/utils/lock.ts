import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

interface LockResult {
  acquired: boolean;
  reason?: string;
}

export function acquireLock(stateDir: string, timeoutMinutes: number): LockResult {
  const lockPath = path.join(stateDir, "run.lock");

  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  // Atomic lock: O_CREAT | O_EXCL — fails if file already exists
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, JSON.stringify({ timestamp: Date.now() }));
    fs.closeSync(fd);
    return { acquired: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err; // Unexpected error
    }
  }

  // Lock file exists — check if it's stale
  try {
    const content = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    const lockAge = Date.now() - content.timestamp;
    const timeoutMs = timeoutMinutes * 60 * 1000;

    if (lockAge < timeoutMs) {
      const ageMinutes = Math.round(lockAge / 60000);
      return {
        acquired: false,
        reason: `Pipeline already running (lock age: ${ageMinutes}m, timeout: ${timeoutMinutes}m)`,
      };
    }
    logger.warn("Overriding stale lock", { lockAgeMinutes: Math.round(lockAge / 60000) });
  } catch {
    logger.warn("Corrupted lock file, overriding");
  }

  // Override stale/corrupt lock
  fs.writeFileSync(lockPath, JSON.stringify({ timestamp: Date.now() }));
  return { acquired: true };
}

export function releaseLock(stateDir: string): void {
  const lockPath = path.join(stateDir, "run.lock");
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath);
  }
}
