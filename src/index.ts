import "dotenv/config";
import express from "express";
import cron from "node-cron";
import { loadConfig } from "./config.js";
import { StateManager } from "./state/manager.js";
import { runPipeline } from "./pipeline/runner.js";
import { releaseLock } from "./utils/lock.js";
import { logger } from "./utils/logger.js";

const config = loadConfig();

// Clear any stale lock from a previous container that was killed mid-run
releaseLock(config.stateDir);
const stateManager = new StateManager(config.stateDir);

const app = express();

app.get("/health", (_req, res) => {
  const lastRun = stateManager.getLastCompletedRun();
  const consecutiveFailures = stateManager.getConsecutiveFailures();
  const errorState = stateManager.loadErrors();

  let openPrs = 0;
  let needsHuman = 0;
  for (const entry of Object.values(errorState.patterns)) {
    if (entry.prStatus === "open") openPrs++;
    if (entry.ciStatus === "needs-human") needsHuman++;
  }

  res.json({
    status: "ok",
    lastRun,
    openPrs,
    needsHuman,
    consecutiveFailures,
  });
});

app.post("/reset-state", (req, res) => {
  const token = req.headers["x-admin-token"];
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret || !token || token !== adminSecret) {
    res.status(401).json({ error: "Unauthorized — set x-admin-token header" });
    return;
  }
  stateManager.saveErrors({ schemaVersion: 1, patterns: {} });
  releaseLock(config.stateDir);
  logger.info("State reset via /reset-state endpoint");
  res.json({ status: "ok", message: "Error state cleared. Next run will reprocess all errors." });
});

app.listen(config.port, () => {
  logger.info("Health server started", { port: config.port });
});

cron.schedule(config.pipeline.runSchedule, () => {
  logger.info("Cron triggered pipeline run");
  runPipeline(config).catch((err: unknown) => {
    logger.error("Pipeline run failed", { error: String(err) });
  });
});

logger.info("Log monitor pipeline initialized", {
  port: config.port,
  schedule: config.pipeline.runSchedule,
});
