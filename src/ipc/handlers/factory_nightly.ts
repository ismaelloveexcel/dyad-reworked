/**
 * factory_nightly.ts — PR #13: Nightly outcome ingest job
 *
 * Schedules a background job that runs once every 24 hours (and once at
 * startup if the last run was more than 24 hours ago or has never run).
 * For every LAUNCHED factory run it polls all configured providers
 * (Stripe, LemonSqueezy, Plausible) and upserts the latest outcome data.
 *
 * Handlers registered:
 *   factory:get-nightly-status  — return lastRanAt, nextRunAt, enabled
 *   factory:run-nightly-now     — trigger a full ingest cycle immediately
 *   factory:toggle-nightly-job  — enable or disable the scheduler
 */

import { createTypedHandler } from "./base";
import { factoryContracts } from "../types/factory";
import { db } from "@/db";
import { factoryRuns } from "@/db/schema";
import { eq } from "drizzle-orm";
import log from "electron-log";
import { readSettings, writeSettings } from "@/main/settings";
import {
  ingestLemonSqueezyPayments,
  ingestStripePayments,
} from "./factory_payments";
import { ingestPlausibleAnalytics } from "./factory_analytics";

const logger = log.scope("factory_nightly");

const NIGHTLY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Timer handle so we can clear/reschedule when the enabled flag changes.
let nightlyTimer: ReturnType<typeof setInterval> | null = null;
// Approximate unix seconds when the next scheduled run will fire.
let nextRunAt: number | null = null;

// =============================================================================
// Core ingest logic
// =============================================================================

/**
 * Run a full ingest cycle: query all LAUNCHED runs and call every configured
 * provider for each.  Errors per-run are logged but never propagate so the
 * whole batch is not aborted by a single failure.
 */
export async function runNightlyIngest(): Promise<{
  ranAt: number;
  runsChecked: number;
}> {
  logger.log("Nightly ingest: starting cycle");

  const settings = readSettings();
  const stripeKey = settings.stripeSecretKey?.value;
  const lsKey = settings.lemonSqueezyApiKey?.value;
  const plausibleKey = settings.plausibleApiKey?.value;
  const plausibleSiteId = settings.plausibleSiteId;

  // Query LAUNCHED runs
  const launchedRuns = await db
    .select({ id: factoryRuns.id })
    .from(factoryRuns)
    .where(eq(factoryRuns.status, "LAUNCHED"));

  logger.log(
    `Nightly ingest: found ${launchedRuns.length} LAUNCHED run(s) to check`,
  );

  for (const run of launchedRuns) {
    if (stripeKey) {
      try {
        const result = await ingestStripePayments(run.id, stripeKey);
        logger.log(
          `Nightly: Stripe → runId=${run.id} inserted=${result.inserted} conversions=${result.conversions}`,
        );
      } catch (err) {
        logger.warn(`Nightly: Stripe ingest failed for runId=${run.id}`, err);
      }
    }

    if (lsKey) {
      try {
        const result = await ingestLemonSqueezyPayments(run.id, lsKey);
        logger.log(
          `Nightly: LemonSqueezy → runId=${run.id} inserted=${result.inserted} conversions=${result.conversions}`,
        );
      } catch (err) {
        logger.warn(
          `Nightly: LemonSqueezy ingest failed for runId=${run.id}`,
          err,
        );
      }
    }

    if (plausibleKey && plausibleSiteId) {
      try {
        const result = await ingestPlausibleAnalytics(
          run.id,
          plausibleKey,
          plausibleSiteId,
        );
        logger.log(
          `Nightly: Plausible → runId=${run.id} inserted=${result.inserted} views=${result.views}`,
        );
      } catch (err) {
        logger.warn(
          `Nightly: Plausible ingest failed for runId=${run.id}`,
          err,
        );
      }
    }
  }

  const ranAt = Math.floor(Date.now() / 1000);
  writeSettings({ factoryNightlyLastRanAt: ranAt });
  logger.log(
    `Nightly ingest: cycle complete. ${launchedRuns.length} run(s) checked.`,
  );
  return { ranAt, runsChecked: launchedRuns.length };
}

// =============================================================================
// Scheduler lifecycle
// =============================================================================

/** Schedule the next fixed-interval run, recording nextRunAt. */
function scheduleNextRun(): void {
  if (nightlyTimer !== null) {
    clearInterval(nightlyTimer);
    nightlyTimer = null;
  }

  nextRunAt = Math.floor((Date.now() + NIGHTLY_INTERVAL_MS) / 1000);

  nightlyTimer = setInterval(() => {
    const settings = readSettings();
    if (settings.factoryNightlyJobEnabled === false) {
      logger.log("Nightly: job disabled; skipping this tick.");
      return;
    }
    runNightlyIngest().catch((err) => {
      logger.error("Nightly: unhandled error in ingest cycle", err);
    });
    nextRunAt = Math.floor((Date.now() + NIGHTLY_INTERVAL_MS) / 1000);
  }, NIGHTLY_INTERVAL_MS);
}

/**
 * Start the nightly scheduler.  Call this once from `onReady()` in main.ts
 * after the database has been initialized.
 *
 * If the job has never run, or last ran more than 24 hours ago, it fires
 * immediately (async, errors are swallowed).  Then sets a 24-hour interval
 * for subsequent runs.
 */
export function startNightlyScheduler(): void {
  const settings = readSettings();

  if (settings.factoryNightlyJobEnabled === false) {
    logger.log("Nightly scheduler: disabled by settings, not starting.");
    return;
  }

  const lastRanAt = settings.factoryNightlyLastRanAt ?? 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const secondsSinceLast = nowSec - lastRanAt;

  if (secondsSinceLast >= 24 * 60 * 60) {
    logger.log(
      `Nightly scheduler: last ran ${secondsSinceLast}s ago — running immediately.`,
    );
    runNightlyIngest().catch((err) => {
      logger.error("Nightly: unhandled error in startup ingest", err);
    });
  } else {
    logger.log(
      `Nightly scheduler: last ran ${secondsSinceLast}s ago — next run in ${24 * 3600 - secondsSinceLast}s.`,
    );
  }

  scheduleNextRun();
  logger.log("Nightly scheduler: started (24-hour interval).");
}

/**
 * Stop the nightly scheduler (clears the interval).
 * Called from app `before-quit` or when the job is disabled.
 */
export function stopNightlyScheduler(): void {
  if (nightlyTimer !== null) {
    clearInterval(nightlyTimer);
    nightlyTimer = null;
    nextRunAt = null;
  }
}

// =============================================================================
// Handler registration
// =============================================================================

export function registerFactoryNightlyHandlers(): void {
  // ---------------------------------------------------------------------------
  // factory:get-nightly-status
  // ---------------------------------------------------------------------------
  createTypedHandler(factoryContracts.getNightlyStatus, async () => {
    const settings = readSettings();
    const enabled = settings.factoryNightlyJobEnabled !== false;
    const lastRanAt = settings.factoryNightlyLastRanAt ?? null;
    return {
      lastRanAt,
      nextRunAt: enabled ? nextRunAt : null,
      enabled,
    };
  });

  // ---------------------------------------------------------------------------
  // factory:run-nightly-now
  // ---------------------------------------------------------------------------
  createTypedHandler(factoryContracts.runNightlyNow, async () => {
    return runNightlyIngest();
  });

  // ---------------------------------------------------------------------------
  // factory:toggle-nightly-job
  // ---------------------------------------------------------------------------
  createTypedHandler(
    factoryContracts.toggleNightlyJob,
    async (_, { enabled }) => {
      writeSettings({ factoryNightlyJobEnabled: enabled });
      if (enabled) {
        // Re-arm the scheduler if it was stopped
        if (nightlyTimer === null) {
          scheduleNextRun();
          logger.log("Nightly scheduler: re-enabled and rescheduled.");
        }
      } else {
        stopNightlyScheduler();
        logger.log("Nightly scheduler: disabled by user.");
      }
    },
  );

  logger.log("Registered factory nightly IPC handlers");
}
