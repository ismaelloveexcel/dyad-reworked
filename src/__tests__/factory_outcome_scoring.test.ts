// @vitest-environment node
/**
 * factory_outcome_scoring.test.ts — PR #14
 * Unit tests for outcome-weighted scoring utilities.
 */

import { describe, it, expect } from "vitest";
import {
  aggregateOutcomes,
  buildOutcomeContext,
  type SimilarRunOutcomeData,
} from "@/core/factory/outcome_scoring";

// =============================================================================
// Helpers
// =============================================================================

function makeRun(
  runId: number,
  similarity: number,
  outcomes: {
    revenueUsd?: number | null;
    conversions?: number | null;
    views?: number | null;
  }[] = [],
): SimilarRunOutcomeData {
  return {
    runId,
    similarity,
    name: `Idea #${runId}`,
    outcomes: outcomes.map((o, i) => ({
      id: i + 1,
      runId,
      revenueUsd: o.revenueUsd ?? null,
      conversions: o.conversions ?? null,
      views: o.views ?? null,
      churn30d: null,
      source: "stripe",
      capturedAt: 1_700_000_000,
    })),
  };
}

// =============================================================================
// aggregateOutcomes
// =============================================================================

describe("aggregateOutcomes", () => {
  it("returns null for empty input", () => {
    expect(aggregateOutcomes([])).toBeNull();
  });

  it("returns null when all runs have no outcome rows", () => {
    const runs = [makeRun(1, 0.9), makeRun(2, 0.85)];
    expect(aggregateOutcomes(runs)).toBeNull();
  });

  it("counts runs with outcomes, runs with known revenue, and runs with revenue", () => {
    const runs = [
      makeRun(1, 0.9, [{ revenueUsd: 500, conversions: 3 }]),
      makeRun(2, 0.85, [{ revenueUsd: 0, conversions: 1 }]),
      makeRun(3, 0.8), // no outcomes
    ];
    const agg = aggregateOutcomes(runs);
    expect(agg).not.toBeNull();
    expect(agg!.totalSimilarRuns).toBe(3);
    expect(agg!.runsWithOutcomes).toBe(2);
    expect(agg!.runsWithKnownRevenue).toBe(2); // both run 1 and run 2 have non-null revenueUsd
    expect(agg!.runsWithRevenue).toBe(1); // only run 1 has revenueUsd > 0
  });

  it("runsWithKnownRevenue excludes runs where revenueUsd is null", () => {
    const runs = [
      makeRun(1, 0.9, [{ revenueUsd: null, conversions: 2 }]),
      makeRun(2, 0.85, [{ revenueUsd: 400 }]),
    ];
    const agg = aggregateOutcomes(runs);
    expect(agg!.runsWithKnownRevenue).toBe(1); // only run 2 has non-null revenueUsd
    expect(agg!.runsWithRevenue).toBe(1);
  });

  it("computes correct avgRevenueUsdCents", () => {
    const runs = [
      makeRun(1, 0.9, [{ revenueUsd: 200 }]),
      makeRun(2, 0.85, [{ revenueUsd: 400 }]),
    ];
    const agg = aggregateOutcomes(runs);
    expect(agg!.avgRevenueUsdCents).toBe(300);
  });

  it("returns null avgRevenueUsdCents when all revenue values are null", () => {
    const runs = [makeRun(1, 0.9, [{ revenueUsd: null, conversions: 2 }])];
    const agg = aggregateOutcomes(runs);
    expect(agg!.avgRevenueUsdCents).toBeNull();
  });

  it("computes correct avgConversions", () => {
    const runs = [
      makeRun(1, 0.9, [{ conversions: 4 }]),
      makeRun(2, 0.85, [{ conversions: 2 }]),
    ];
    const agg = aggregateOutcomes(runs);
    expect(agg!.avgConversions).toBe(3);
  });

  it("computes correct avgViews", () => {
    const runs = [
      makeRun(1, 0.9, [{ views: 1000 }]),
      makeRun(2, 0.85, [{ views: 2000 }]),
    ];
    const agg = aggregateOutcomes(runs);
    expect(agg!.avgViews).toBe(1500);
  });

  it("uses only the first (most recent) outcome row per run", () => {
    // Run has two rows; only the first should be counted
    const runId = 10;
    const run: SimilarRunOutcomeData = {
      runId,
      similarity: 0.9,
      name: "Multi-outcome idea",
      outcomes: [
        {
          id: 1,
          runId,
          revenueUsd: 1000, // most recent — used
          conversions: 5,
          views: null,
          churn30d: null,
          source: "stripe",
          capturedAt: 1_700_100_000,
        },
        {
          id: 2,
          runId,
          revenueUsd: 200, // older — should be ignored
          conversions: 1,
          views: null,
          churn30d: null,
          source: "stripe",
          capturedAt: 1_700_000_000,
        },
      ],
    };
    const agg = aggregateOutcomes([run]);
    // Should use row 0 (revenueUsd=1000, conversions=5)
    expect(agg!.avgRevenueUsdCents).toBe(1000);
    expect(agg!.avgConversions).toBe(5);
  });
});

// =============================================================================
// buildOutcomeContext
// =============================================================================

describe("buildOutcomeContext", () => {
  it("returns empty string for empty input", () => {
    expect(buildOutcomeContext([])).toBe("");
  });

  it("returns empty string when all runs have no outcomes", () => {
    const runs = [makeRun(1, 0.9), makeRun(2, 0.8)];
    expect(buildOutcomeContext(runs)).toBe("");
  });

  it("includes OUTCOME DATA header when outcomes exist", () => {
    const runs = [makeRun(1, 0.9, [{ revenueUsd: 500 }])];
    const ctx = buildOutcomeContext(runs);
    expect(ctx).toContain("OUTCOME DATA FROM");
    // Header uses runsWithOutcomes (1), not totalSimilarRuns
    expect(ctx).toContain("1 SIMILAR PAST IDEAS WITH RECORDED OUTCOMES");
  });

  it("emits 'revenue data is unknown' when all runs have null revenueUsd", () => {
    const runs = [
      makeRun(1, 0.9, [{ revenueUsd: null, conversions: 3 }]),
      makeRun(2, 0.85, [{ revenueUsd: null, views: 500 }]),
    ];
    const ctx = buildOutcomeContext(runs);
    expect(ctx).toContain("unknown");
    // Should NOT emit caution or strong signal when revenue is all null
    expect(ctx).not.toContain("Caution");
    expect(ctx).not.toContain("Strong revenue signal");
  });

  it("includes revenue signal when avgRevenueUsdCents is available", () => {
    const runs = [makeRun(1, 0.9, [{ revenueUsd: 1000 }])];
    const ctx = buildOutcomeContext(runs);
    // 1000 cents = $10.00
    expect(ctx).toContain("$10.00");
  });

  it("includes strong revenue signal line when majority of runs generated revenue", () => {
    const runs = [
      makeRun(1, 0.9, [{ revenueUsd: 500 }]),
      makeRun(2, 0.85, [{ revenueUsd: 300 }]),
      makeRun(3, 0.8, [{ revenueUsd: 0 }]),
    ];
    const ctx = buildOutcomeContext(runs);
    expect(ctx).toContain("Strong revenue signal");
  });

  it("includes caution line when no runs generated revenue", () => {
    const runs = [
      makeRun(1, 0.9, [{ revenueUsd: 0, conversions: 1 }]),
      makeRun(2, 0.85, [{ revenueUsd: 0, conversions: 0 }]),
    ];
    const ctx = buildOutcomeContext(runs);
    expect(ctx).toContain("Caution");
  });

  it("includes avg conversions when available", () => {
    const runs = [makeRun(1, 0.9, [{ conversions: 7 }])];
    const ctx = buildOutcomeContext(runs);
    expect(ctx).toContain("7.0");
  });

  it("includes avg views when available", () => {
    const runs = [makeRun(1, 0.9, [{ views: 2500 }])];
    const ctx = buildOutcomeContext(runs);
    expect(ctx).toContain("2500");
  });

  it("is deterministic — same input produces same output", () => {
    const runs = [
      makeRun(1, 0.9, [{ revenueUsd: 200, conversions: 2, views: 500 }]),
    ];
    expect(buildOutcomeContext(runs)).toBe(buildOutcomeContext(runs));
  });
});
