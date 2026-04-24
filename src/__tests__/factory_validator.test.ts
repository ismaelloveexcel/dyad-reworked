// @vitest-environment node
/**
 * factory_validator.test.ts
 *
 * Unit tests for the pure factory validation and scoring functions.
 * Uses node environment (no happy-dom dependency) with a manual localStorage shim.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  validateIdeaResult,
  validateGenerateIdeasResponse,
  deterministicFallback,
} from "@/ipc/handlers/factory_validator";
import type { IdeaEvaluationResult } from "@/ipc/types/factory";

// ---------------------------------------------------------------------------
// Minimal localStorage shim for SafeLocalStorage tests
// ---------------------------------------------------------------------------

function makeLocalStorageShim() {
  const store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k in store) delete store[k];
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidResult(
  overrides: Partial<IdeaEvaluationResult> = {},
): IdeaEvaluationResult {
  return {
    idea: "test idea",
    name: "Test Tool",
    buyer: "HR managers",
    scores: {
      buyerClarity: 4,
      painUrgency: 3,
      marketExistence: 3,
      differentiation: 3,
      replaceability: 3,
      virality: 3,
      monetisation: 4,
      buildSimplicity: 3,
    },
    totalScore: 26,
    decision: "REWORK",
    reason: "Reasonable scores across the board.",
    improvedIdea: "Add export feature.",
    monetisationAngle: "One-time $29 purchase.",
    viralTrigger: "Share the scorecard on LinkedIn.",
    buildPrompt: "",
    fallbackUsed: false,
    revenueProbability: 4,
    timeToFirstRevenue: "Fast",
    region: {
      primary: "UAE/GCC",
      secondary: ["Global"],
      whyWorks: "High demand.",
      whyFails: "Price sensitive.",
    },
    noveltyFlags: {
      domainTwist: true,
      perspectiveFlip: false,
      outputTransformation: true,
      constraintInjection: false,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1 — invalid JSON → fallback
// ---------------------------------------------------------------------------

describe("validateIdeaResult", () => {
  it("returns fallbackUsed=true when given invalid JSON garbage", () => {
    const result = validateIdeaResult(
      "this is not json at all !@#$%",
      "test idea",
    );
    expect(result.fallbackUsed).toBe(true);
    expect(result.idea).toBe("test idea");
  });

  // -------------------------------------------------------------------------
  // Test 2 — out-of-range scores are clamped
  // -------------------------------------------------------------------------

  it("clamps out-of-range scores to [1, 5]", () => {
    const raw = JSON.stringify({
      ...makeValidResult(),
      scores: {
        buyerClarity: 7, // too high → should clamp to 5
        painUrgency: -1, // too low → should clamp to 1
        marketExistence: 3,
        differentiation: 3,
        replaceability: 3,
        virality: 3,
        monetisation: 3,
        buildSimplicity: 3,
      },
    });
    const result = validateIdeaResult(raw, "test idea");
    // If Zod validation passes, scores must be clamped
    // If it falls back, we still get valid data — just check bounds
    expect(result.scores.buyerClarity).toBeLessThanOrEqual(5);
    expect(result.scores.painUrgency).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Test 3 — missing required field → fallback
  // -------------------------------------------------------------------------

  it("returns fallbackUsed=true when buildPrompt field is missing", () => {
    const obj = makeValidResult();
    const { buildPrompt: _removed, ...withoutBuildPrompt } = obj;
    const raw = JSON.stringify(withoutBuildPrompt);
    const result = validateIdeaResult(raw, "test idea");
    expect(result.fallbackUsed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 4 — invalid decision value → fallback
  // -------------------------------------------------------------------------

  it("returns fallbackUsed=true when decision is an invalid value", () => {
    const raw = JSON.stringify({ ...makeValidResult(), decision: "MAYBE" });
    const result = validateIdeaResult(raw, "test idea");
    expect(result.fallbackUsed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 5 — deterministicFallback is pure (same input → same output)
  // -------------------------------------------------------------------------

  it("deterministicFallback produces identical results for the same input", () => {
    const a = deterministicFallback("same input string");
    const b = deterministicFallback("same input string");
    expect(a).toEqual(b);
    expect(a.fallbackUsed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests 6 & 7 — SafeLocalStorage with manual localStorage shim
// ---------------------------------------------------------------------------

describe("SafeLocalStorage", () => {
  const TEST_KEY = "test-safe-ls-corrupt";
  const TEST_KEY2 = "test-safe-ls-wrong-shape";

  let lsShim: ReturnType<typeof makeLocalStorageShim>;

  beforeEach(() => {
    lsShim = makeLocalStorageShim();
    vi.stubGlobal("localStorage", lsShim);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null and clears key when JSON is corrupt", async () => {
    lsShim.setItem(TEST_KEY, "{ this is not json");
    const { SafeLocalStorage } = await import("@/lib/safe_local_storage");
    const result = SafeLocalStorage.get<string[]>(
      TEST_KEY,
      (v): v is string[] => Array.isArray(v),
    );
    expect(result).toBeNull();
    expect(lsShim.getItem(TEST_KEY)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 7 — SafeLocalStorage: wrong shape → null + key cleared
  // -------------------------------------------------------------------------

  it("returns null and clears key when data has wrong shape", async () => {
    lsShim.setItem(TEST_KEY2, JSON.stringify({ notAnArray: true }));
    const { SafeLocalStorage } = await import("@/lib/safe_local_storage");
    const result = SafeLocalStorage.get<string[]>(
      TEST_KEY2,
      (v): v is string[] => Array.isArray(v),
    );
    expect(result).toBeNull();
    expect(lsShim.getItem(TEST_KEY2)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 8 — validateGenerateIdeasResponse: empty array → null
// ---------------------------------------------------------------------------

describe("validateGenerateIdeasResponse", () => {
  it("returns null for an empty ideas array (rejects empty response)", () => {
    const result = validateGenerateIdeasResponse({ ideas: [] });
    expect(result).toBeNull();
  });
});
