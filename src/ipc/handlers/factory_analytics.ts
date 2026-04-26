/**
 * factory_analytics.ts — PR #13: Plausible analytics ingest
 *
 * Connects Plausible Analytics to the Factory pipeline by polling the
 * Plausible REST API and inserting pageview data into the launch_outcomes
 * table.  No webhook server is required — this runs entirely inside Electron.
 *
 * Handlers registered:
 *   factory:save-plausible-config  — validate + persist Plausible API key + site ID
 *   factory:ingest-analytics       — poll Plausible, upsert views into launch_outcomes
 */

import { createTypedHandler } from "./base";
import { factoryContracts } from "../types/factory";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { db } from "@/db";
import { launchOutcomes } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import log from "electron-log";
import { readSettings, writeSettings } from "@/main/settings";

const logger = log.scope("factory_analytics");

// =============================================================================
// Shared helpers
// =============================================================================

const ANALYTICS_TIMEOUT_MS = 30_000; // 30 s per request
const PLAUSIBLE_API_BASE = "https://plausible.io/api/v1";

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// =============================================================================
// Plausible REST helpers
// =============================================================================

interface PlausibleSitesResponse {
  sites?: unknown[];
  error?: string;
}

interface PlausibleAggregateResult {
  value: number;
}

interface PlausibleAggregateResponse {
  results?: {
    pageviews?: PlausibleAggregateResult;
    visitors?: PlausibleAggregateResult;
  };
  error?: string;
}

/**
 * Validate a Plausible API key by calling /api/v1/sites.
 * Returns false on 401/403; throws AnalyticsIngestFailure for any other error.
 * Accepts both a plain array response and a `{ sites: [...] }` object shape.
 */
async function validatePlausibleKey(key: string): Promise<boolean> {
  const { signal, clear } = withTimeout(ANALYTICS_TIMEOUT_MS);
  try {
    const response = await fetch(`${PLAUSIBLE_API_BASE}/sites`, {
      headers: { Authorization: `Bearer ${key}` },
      signal,
    });
    if (response.status === 401 || response.status === 403) return false;
    if (response.ok) {
      const body = (await response.json()) as
        | PlausibleSitesResponse
        | unknown[];
      // Plausible v1 returns an object with a `sites` array; v2 may return
      // a plain array directly.  Accept either shape as a valid key.
      if (Array.isArray(body)) return true;
      if (typeof body === "object" && body !== null && "sites" in body) {
        return Array.isArray((body as PlausibleSitesResponse).sites);
      }
      // Any other non-error JSON response is also considered valid
      return true;
    }
    throw new DyadError(
      `Plausible API returned ${response.status} while validating key.`,
      DyadErrorKind.AnalyticsIngestFailure,
    );
  } catch (err) {
    if (err instanceof DyadError) throw err;
    throw new DyadError(
      `Unable to reach Plausible to validate the key. Check your connection.`,
      DyadErrorKind.AnalyticsIngestFailure,
    );
  } finally {
    clear();
  }
}

/**
 * Fetch aggregate analytics (pageviews, visitors) from Plausible for a site.
 * Returns pageviews count, or throws AnalyticsIngestFailure on API error.
 */
async function fetchPlausibleStats(
  apiKey: string,
  siteId: string,
  period: string,
): Promise<{ pageviews: number; visitors: number }> {
  const params = new URLSearchParams({
    site_id: siteId,
    period,
    metrics: "pageviews,visitors",
  });
  const url = `${PLAUSIBLE_API_BASE}/stats/aggregate?${params.toString()}`;

  const { signal, clear } = withTimeout(ANALYTICS_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });

    if (!response.ok) {
      let text = "";
      try {
        text = await response.text();
      } catch {
        // ignore text-read failure; status code is sufficient
      }
      throw new DyadError(
        `Plausible stats API error ${response.status}: ${text.slice(0, 200)}`,
        DyadErrorKind.AnalyticsIngestFailure,
      );
    }

    const body = (await response.json()) as PlausibleAggregateResponse;
    return {
      pageviews: body.results?.pageviews?.value ?? 0,
      visitors: body.results?.visitors?.value ?? 0,
    };
  } catch (err) {
    if (err instanceof DyadError) throw err;
    throw new DyadError(
      `Failed to fetch Plausible stats: ${err instanceof Error ? err.message : String(err)}`,
      DyadErrorKind.AnalyticsIngestFailure,
    );
  } finally {
    clear();
  }
}

// =============================================================================
// Exported core ingest helper — used by factory_nightly.ts
// =============================================================================

/**
 * Fetch Plausible pageviews and upsert a launch_outcomes row with source="plausible"
 * for the given run.  Period defaults to "30d".
 */
export async function ingestPlausibleAnalytics(
  runId: number,
  apiKey: string,
  siteId: string,
  period: string = "30d",
): Promise<{ inserted: number; views: number }> {
  const stats = await fetchPlausibleStats(apiKey, siteId, period);
  const views = stats.pageviews;

  logger.log(
    `[factory:ingest-analytics] Plausible: ${views} pageviews for site="${siteId}", runId=${runId}`,
  );

  if (views === 0) {
    logger.log(
      `[factory:ingest-analytics] Plausible returned 0 pageviews for runId=${runId}. No row inserted.`,
    );
    return { inserted: 0, views: 0 };
  }

  // Upsert: delete existing plausible row for this run then insert fresh.
  await db.transaction(async (tx) => {
    await tx
      .delete(launchOutcomes)
      .where(
        and(
          eq(launchOutcomes.runId, runId),
          eq(launchOutcomes.source, "plausible"),
        ),
      );
    await tx.insert(launchOutcomes).values({
      runId,
      views,
      source: "plausible",
    });
  });

  logger.log(
    `[factory:ingest-analytics] Inserted 1 outcome row for runId=${runId} (plausible).`,
  );
  return { inserted: 1, views };
}

// =============================================================================
// Handler registration
// =============================================================================

export function registerFactoryAnalyticsHandlers(): void {
  // ---------------------------------------------------------------------------
  // factory:save-plausible-config
  // ---------------------------------------------------------------------------
  createTypedHandler(
    factoryContracts.savePlausibleConfig,
    async (_, { key, siteId }) => {
      if (!key || key.trim() === "") {
        throw new DyadError(
          "Plausible API key is required.",
          DyadErrorKind.Auth,
        );
      }
      if (!siteId || siteId.trim() === "") {
        throw new DyadError(
          "Plausible site ID (domain) is required.",
          DyadErrorKind.Auth,
        );
      }

      const trimmedKey = key.trim();
      const trimmedSite = siteId.trim();

      const valid = await validatePlausibleKey(trimmedKey);
      if (!valid) {
        throw new DyadError(
          "Invalid Plausible API key. Please check the key and try again.",
          DyadErrorKind.Auth,
        );
      }

      writeSettings({
        plausibleApiKey: { value: trimmedKey },
        plausibleSiteId: trimmedSite,
      });
      logger.log("Saved Plausible API key and site ID.");
    },
  );

  // ---------------------------------------------------------------------------
  // factory:ingest-analytics
  // ---------------------------------------------------------------------------
  createTypedHandler(
    factoryContracts.ingestAnalytics,
    async (_, { runId, period = "30d" }) => {
      const settings = readSettings();

      const apiKey = settings.plausibleApiKey?.value;
      if (!apiKey) {
        throw new DyadError(
          "No Plausible API key configured. Save your key first.",
          DyadErrorKind.Auth,
        );
      }

      const siteId = settings.plausibleSiteId;
      if (!siteId) {
        throw new DyadError(
          "No Plausible site ID configured. Save your site domain first.",
          DyadErrorKind.Auth,
        );
      }

      return ingestPlausibleAnalytics(runId, apiKey, siteId, period);
    },
  );

  logger.log("Registered factory analytics IPC handlers");
}
