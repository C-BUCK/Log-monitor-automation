import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { acquireLock, releaseLock } from "../../src/utils/lock.js";

describe("lock manager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("acquires lock when no lock exists", () => {
    const result = acquireLock(tmpDir, 30);
    expect(result.acquired).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "run.lock"))).toBe(true);
  });

  it("refuses lock when a recent lock exists", () => {
    acquireLock(tmpDir, 30);
    const result = acquireLock(tmpDir, 30);
    expect(result.acquired).toBe(false);
    expect(result.reason).toContain("already running");
  });

  it("overrides a stale lock older than timeout", () => {
    const lockPath = path.join(tmpDir, "run.lock");
    const staleTime = Date.now() - 35 * 60 * 1000;
    fs.writeFileSync(lockPath, JSON.stringify({ timestamp: staleTime }));

    const result = acquireLock(tmpDir, 30);
    expect(result.acquired).toBe(true);
  });

  it("releases lock by deleting the file", () => {
    acquireLock(tmpDir, 30);
    releaseLock(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, "run.lock"))).toBe(false);
  });
});
