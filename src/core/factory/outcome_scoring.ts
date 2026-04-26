/**
 * outcome_scoring.ts — PR #14
 *
 * Pure, Electron-free module for outcome-weighted scoring.
 *
 * Aggregates quantitative launch-outcome signals from semantically similar
 * past runs (retrieved via embedding cosine similarity from PR #9) and
 * produces a concise context string that is injected into the LLM evaluation
 * prompt so scores for new ideas are calibrated against real-world results.
 *
 * Importable from unit tests without Electron shims.
 */

import type { QuantitativeLaunchOutcome } from "@/ipc/types/factory";

// =============================================================================
// Types
// =============================================================================

/** A past run with its aggregated outcomes, as returned by the DB query. */
export interface SimilarRunOutcomeData {
  runId: number;
  /** cosine similarity to the idea being evaluated (0-1) */
  similarity: number;
  /** idea name for human-readable context */
  name: string;
  /** aggregated outcomes for this run */
  outcomes: QuantitativeLaunchOutcome[];
}

/** Aggregated outcome stats across a set of similar past runs. */
export interface OutcomeAggregate {
  /** number of past runs that had at least one outcome row */
  runsWithOutcomes: number;
  /** number of past runs with a non-null revenueUsd value (known revenue data) */
  runsWithKnownRevenue: number;
  /** number of past runs with revenueUsd > 0 (actually generated revenue) */
  runsWithRevenue: number;
  /** average USD cents across runs that had non-null revenueUsd */
  avgRevenueUsdCents: number | null;
  /** average conversions across runs that had non-null conversions */
  avgConversions: number | null;
  /** average views across runs that had non-null views */
  avgViews: number | null;
  /** total number of similar past runs considered */
  totalSimilarRuns: number;
}

// =============================================================================
// Aggregation helper (pure)
// =============================================================================

/**
 * Aggregate quantitative outcome signals from a set of similar past runs.
 * Returns `null` when no runs have any outcome data (caller should skip
 * injecting context rather than inject empty/misleading numbers).
 */
export function aggregateOutcomes(
  runs: SimilarRunOutcomeData[],
): OutcomeAggregate | null {
  if (runs.length === 0) return null;

  let runsWithOutcomes = 0;
  let runsWithKnownRevenue = 0;
  let runsWithRevenue = 0;
  let totalRevenueCents = 0;
  let revenueCount = 0;
  let totalConversions = 0;
  let conversionCount = 0;
  let totalViews = 0;
  let viewCount = 0;

  for (const run of runs) {
    if (run.outcomes.length === 0) continue;
    runsWithOutcomes++;

    // Take the most recent outcome row per run for the aggregate (latest row
    // is first because listOutcomes orders DESC by capturedAt).
    const latest = run.outcomes[0];

    if (latest.revenueUsd !== null) {
      runsWithKnownRevenue++;
      totalRevenueCents += latest.revenueUsd;
      revenueCount++;
      if (latest.revenueUsd > 0) runsWithRevenue++;
    }
    if (latest.conversions !== null) {
      totalConversions += latest.conversions;
      conversionCount++;
    }
    if (latest.views !== null) {
      totalViews += latest.views;
      viewCount++;
    }
  }

  if (runsWithOutcomes === 0) return null;

  return {
    runsWithOutcomes,
    runsWithKnownRevenue,
    runsWithRevenue,
    avgRevenueUsdCents:
      revenueCount > 0 ? totalRevenueCents / revenueCount : null,
    avgConversions:
      conversionCount > 0 ? totalConversions / conversionCount : null,
    avgViews: viewCount > 0 ? totalViews / viewCount : null,
    totalSimilarRuns: runs.length,
  };
}

// =============================================================================
// Outcome context builder (pure) — injects into the LLM prompt
// =============================================================================

/**
 * Build a concise plain-text block describing real-world outcome signals from
 * semantically similar past ideas.  Returns `""` when there is nothing useful
 * to say (no outcome data, or aggregate is null).
 *
 * The block is intentionally brief (<120 chars per signal) so it does not
 * dominate the token budget.
 */
export function buildOutcomeContext(runs: SimilarRunOutcomeData[]): string {
  const agg = aggregateOutcomes(runs);
  if (!agg) return "";

  const lines: string[] = [
    `OUTCOME DATA FROM ${agg.runsWithOutcomes} SIMILAR PAST IDEAS WITH RECORDED OUTCOMES (use to calibrate monetisation / market scores):`,
  ];

  // Revenue ratio — only report against runs with known (non-null) revenue values
  // to avoid misrepresenting null as "no revenue".
  if (agg.runsWithKnownRevenue > 0) {
    lines.push(
      `- ${agg.runsWithRevenue} of ${agg.runsWithKnownRevenue} similar ideas with known revenue data generated revenue.`,
    );
  } else {
    lines.push(
      "- Revenue data is unknown for these similar ideas; avoid treating missing revenue as zero.",
    );
  }

  if (agg.avgRevenueUsdCents !== null) {
    const usd = (agg.avgRevenueUsdCents / 100).toFixed(2);
    lines.push(`- Avg revenue: $${usd} across ideas with revenue data.`);
  }

  if (agg.avgConversions !== null) {
    lines.push(
      `- Avg paying customers: ${agg.avgConversions.toFixed(1)} per launched idea.`,
    );
  }

  if (agg.avgViews !== null) {
    lines.push(
      `- Avg page views: ${agg.avgViews.toFixed(0)} per launched idea.`,
    );
  }

  // Heuristic signals — only when we have enough known revenue data to reason about
  if (agg.runsWithKnownRevenue > 0) {
    if (agg.runsWithRevenue === 0) {
      lines.push(
        "- Caution: similar ideas launched but generated no recorded revenue — weight monetisation score conservatively.",
      );
    } else if (
      agg.runsWithRevenue >= Math.ceil(agg.runsWithKnownRevenue * 0.6)
    ) {
      lines.push(
        "- Strong revenue signal: majority of similar ideas generated revenue — weight monetisation score favourably.",
      );
    }
  }

  return lines.join("\n");
}
