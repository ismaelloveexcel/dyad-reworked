/**
 * factory_payments.ts — PR #12: Payments module (LemonSqueezy first, Stripe second)
 *
 * Connects LemonSqueezy and Stripe to the Factory pipeline by polling their REST
 * APIs and inserting aggregated revenue / conversion data into the launch_outcomes
 * table.  No webhook server is required — this runs entirely inside Electron.
 *
 * Handlers registered:
 *   factory:save-lemonsqueezy-key  — validate + persist LemonSqueezy API key
 *   factory:save-stripe-key        — validate + persist Stripe secret key
 *   factory:ingest-payments        — poll provider, aggregate, upsert outcome row
 */

import { createTypedHandler } from "./base";
import { factoryContracts } from "../types/factory";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { db } from "@/db";
import { launchOutcomes } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import log from "electron-log";
import { readSettings, writeSettings } from "@/main/settings";

const logger = log.scope("factory_payments");

// =============================================================================
// Shared helpers
// =============================================================================

const PAYMENT_TIMEOUT_MS = 30_000; // 30 s per request

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// =============================================================================
// LemonSqueezy REST helpers
// =============================================================================

const LS_API_BASE = "https://api.lemonsqueezy.com/v1";

interface LSUserResponse {
  data?: { id?: string };
  errors?: { detail?: string }[];
}

interface LSOrder {
  id: string;
  attributes: {
    status: string;
    total: number; // USD cents
    first_order_item?: {
      product_name?: string;
    };
    created_at: string; // ISO-8601
  };
}

interface LSOrdersPage {
  data: LSOrder[];
  links?: {
    next?: string | null;
  };
}

/**
 * Validate a LemonSqueezy API key by calling /v1/users/me.
 * Returns false on 401/403; throws PaymentIngestFailure for any other error.
 */
async function validateLemonSqueezyKey(key: string): Promise<boolean> {
  const { signal, clear } = withTimeout(PAYMENT_TIMEOUT_MS);
  try {
    const response = await fetch(`${LS_API_BASE}/users/me`, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/vnd.api+json",
      },
      signal,
    });
    if (response.status === 401 || response.status === 403) return false;
    if (response.ok) {
      const body = (await response.json()) as LSUserResponse;
      return !!body.data?.id;
    }
    throw new DyadError(
      `LemonSqueezy API returned ${response.status} while validating key.`,
      DyadErrorKind.PaymentIngestFailure,
    );
  } catch (err) {
    if (err instanceof DyadError) throw err;
    throw new DyadError(
      `Unable to reach LemonSqueezy to validate the key. Check your connection.`,
      DyadErrorKind.PaymentIngestFailure,
    );
  } finally {
    clear();
  }
}

/**
 * Fetch all paid LemonSqueezy orders (handles cursor pagination).
 * Returns raw LSOrder array; caller applies product-name and date filters.
 */
async function fetchAllLemonSqueezyOrders(key: string): Promise<LSOrder[]> {
  const allOrders: LSOrder[] = [];
  let nextUrl: string | null =
    `${LS_API_BASE}/orders?filter[status]=paid&page[size]=100`;

  while (nextUrl) {
    const { signal, clear } = withTimeout(PAYMENT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(nextUrl, {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/vnd.api+json",
        },
        signal,
      });
    } finally {
      clear();
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DyadError(
        `LemonSqueezy orders API error ${response.status}: ${text.slice(0, 200)}`,
        DyadErrorKind.PaymentIngestFailure,
      );
    }

    const page = (await response.json()) as LSOrdersPage;
    allOrders.push(...page.data);
    nextUrl = page.links?.next ?? null;
  }

  return allOrders;
}

// =============================================================================
// Stripe REST helpers
// =============================================================================

const STRIPE_API_BASE = "https://api.stripe.com/v1";

interface StripeBalance {
  object: string;
}

interface StripeCharge {
  id: string;
  amount: number; // smallest currency unit (cents for USD)
  currency: string;
  status: "succeeded" | "pending" | "failed";
  description?: string | null;
  created: number; // unix seconds
  metadata?: Record<string, string>;
}

interface StripeChargesPage {
  object: string;
  data: StripeCharge[];
  has_more: boolean;
  url: string;
}

/**
 * Validate a Stripe secret key by calling /v1/balance.
 * Returns false on 401; throws PaymentIngestFailure for any other error.
 */
async function validateStripeKey(key: string): Promise<boolean> {
  const { signal, clear } = withTimeout(PAYMENT_TIMEOUT_MS);
  try {
    const response = await fetch(`${STRIPE_API_BASE}/balance`, {
      headers: {
        Authorization: `Bearer ${key}`,
      },
      signal,
    });
    if (response.status === 401 || response.status === 403) return false;
    if (response.ok) {
      const body = (await response.json()) as StripeBalance;
      return body.object === "balance";
    }
    throw new DyadError(
      `Stripe API returned ${response.status} while validating key.`,
      DyadErrorKind.PaymentIngestFailure,
    );
  } catch (err) {
    if (err instanceof DyadError) throw err;
    throw new DyadError(
      `Unable to reach Stripe to validate the key. Check your connection.`,
      DyadErrorKind.PaymentIngestFailure,
    );
  } finally {
    clear();
  }
}

/**
 * Fetch all succeeded Stripe charges (handles cursor pagination).
 * Stripe uses starting_after cursor pagination.
 */
async function fetchAllStripeCharges(key: string): Promise<StripeCharge[]> {
  const allCharges: StripeCharge[] = [];
  let startingAfter: string | null = null;

  // Encode params as query string for Stripe form-encoded API
  function buildUrl(): string {
    const params = new URLSearchParams({
      limit: "100",
    });
    if (startingAfter) params.set("starting_after", startingAfter);
    return `${STRIPE_API_BASE}/charges?${params.toString()}`;
  }

  for (;;) {
    const { signal, clear } = withTimeout(PAYMENT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(buildUrl(), {
        headers: {
          Authorization: `Bearer ${key}`,
        },
        signal,
      });
    } finally {
      clear();
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DyadError(
        `Stripe charges API error ${response.status}: ${text.slice(0, 200)}`,
        DyadErrorKind.PaymentIngestFailure,
      );
    }

    const page = (await response.json()) as StripeChargesPage;
    allCharges.push(...page.data);

    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }

  return allCharges;
}

// =============================================================================
// Handler registration
// =============================================================================

export function registerFactoryPaymentsHandlers(): void {
  // ---------------------------------------------------------------------------
  // factory:save-lemonsqueezy-key
  // ---------------------------------------------------------------------------
  createTypedHandler(
    factoryContracts.saveLemonSqueezyKey,
    async (_, { key }) => {
      if (!key || key.trim() === "") {
        throw new DyadError(
          "LemonSqueezy API key is required.",
          DyadErrorKind.Auth,
        );
      }

      const trimmed = key.trim();
      const valid = await validateLemonSqueezyKey(trimmed);
      if (!valid) {
        throw new DyadError(
          "Invalid LemonSqueezy API key. Please check the key and try again.",
          DyadErrorKind.Auth,
        );
      }

      writeSettings({ lemonSqueezyApiKey: { value: trimmed } });
      logger.log("Saved LemonSqueezy API key.");
    },
  );

  // ---------------------------------------------------------------------------
  // factory:save-stripe-key
  // ---------------------------------------------------------------------------
  createTypedHandler(factoryContracts.saveStripeKey, async (_, { key }) => {
    if (!key || key.trim() === "") {
      throw new DyadError("Stripe secret key is required.", DyadErrorKind.Auth);
    }

    const trimmed = key.trim();
    const valid = await validateStripeKey(trimmed);
    if (!valid) {
      throw new DyadError(
        "Invalid Stripe secret key. Please check the key and try again.",
        DyadErrorKind.Auth,
      );
    }

    writeSettings({ stripeSecretKey: { value: trimmed } });
    logger.log("Saved Stripe secret key.");
  });

  // ---------------------------------------------------------------------------
  // factory:ingest-payments
  // ---------------------------------------------------------------------------
  createTypedHandler(
    factoryContracts.ingestPayments,
    async (_, { runId, provider, productName, fromTimestamp }) => {
      const settings = readSettings();

      let revenueUsdCents = 0;
      let conversions = 0;

      if (provider === "lemonsqueezy") {
        const apiKey = settings.lemonSqueezyApiKey?.value;
        if (!apiKey) {
          throw new DyadError(
            "No LemonSqueezy API key configured. Save your key first.",
            DyadErrorKind.Auth,
          );
        }

        let orders = await fetchAllLemonSqueezyOrders(apiKey);

        // Filter by fromTimestamp if provided
        if (fromTimestamp != null) {
          orders = orders.filter((o) => {
            const ts = Math.floor(
              new Date(o.attributes.created_at).getTime() / 1000,
            );
            return ts >= fromTimestamp;
          });
        }

        // Filter by productName substring (case-insensitive) if provided
        if (productName) {
          const needle = productName.toLowerCase();
          orders = orders.filter((o) => {
            const name = (
              o.attributes.first_order_item?.product_name ?? ""
            ).toLowerCase();
            return name.includes(needle);
          });
        }

        for (const o of orders) {
          const total = o.attributes.total;
          if (total == null) {
            logger.warn(
              `[factory:ingest-payments] LemonSqueezy order ${o.id} has no total; skipping amount.`,
            );
          }
          revenueUsdCents += total ?? 0;
          conversions += 1;
        }

        logger.log(
          `[factory:ingest-payments] LemonSqueezy: ${conversions} orders, $${revenueUsdCents / 100} USD for runId=${runId}`,
        );
      } else {
        // provider === "stripe"
        const secretKey = settings.stripeSecretKey?.value;
        if (!secretKey) {
          throw new DyadError(
            "No Stripe secret key configured. Save your key first.",
            DyadErrorKind.Auth,
          );
        }

        let charges = await fetchAllStripeCharges(secretKey);

        // Only count succeeded USD charges
        charges = charges.filter(
          (c) => c.status === "succeeded" && c.currency === "usd",
        );

        // Filter by fromTimestamp if provided
        if (fromTimestamp != null) {
          charges = charges.filter((c) => c.created >= fromTimestamp);
        }

        // Filter by description / metadata substring if productName provided
        if (productName) {
          const needle = productName.toLowerCase();
          charges = charges.filter((c) => {
            const desc = (c.description ?? "").toLowerCase();
            const metaValues = Object.values(c.metadata ?? {})
              .join(" ")
              .toLowerCase();
            return desc.includes(needle) || metaValues.includes(needle);
          });
        }

        for (const c of charges) {
          revenueUsdCents += c.amount;
          conversions += 1;
        }

        logger.log(
          `[factory:ingest-payments] Stripe: ${conversions} charges, $${revenueUsdCents / 100} USD for runId=${runId}`,
        );
      }

      if (conversions === 0) {
        logger.log(
          `[factory:ingest-payments] No matching ${provider} data found for runId=${runId}. No row inserted.`,
        );
        return { inserted: 0, revenueUsdCents: 0, conversions: 0 };
      }

      // Upsert: delete any existing row for this run+provider, then insert fresh.
      // Filtering by both runId and source ensures syncing one provider does not
      // remove outcome rows from the other provider.
      await db
        .delete(launchOutcomes)
        .where(
          and(
            eq(launchOutcomes.runId, runId),
            eq(launchOutcomes.source, provider),
          ),
        );

      await db.insert(launchOutcomes).values({
        runId,
        // revenueUsd column stores USD cents (matches Stripe/LemonSqueezy native unit)
        revenueUsd: revenueUsdCents,
        conversions,
        source: provider,
      });

      logger.log(
        `[factory:ingest-payments] Inserted 1 outcome row for runId=${runId} (${provider}).`,
      );
      return { inserted: 1, revenueUsdCents, conversions };
    },
  );

  logger.log("Registered factory payments IPC handlers");
}
