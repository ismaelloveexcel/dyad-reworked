/**
 * Regression tests for `extractPatterns` — specifically the operator-precedence
 * bug at factory.tsx:135 where `??` mis-bound with a ternary, producing a
 * numeric `1` for a `string | undefined` field and corrupting Pattern Engine
 * input.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import {
  extractPatterns,
  type PipelineEntry,
  type TractionEntry,
} from "../pages/factory";
import type { IdeaEvaluationResult } from "@/ipc/types/factory";

function makeIdea(
  overrides: Partial<IdeaEvaluationResult> = {},
): IdeaEvaluationResult {
  return {
    idea: "Salary benchmarking tool for UAE professionals",
    name: "Salary Benchmark",
    buyer: "UAE professionals",
    scores: {
      buyerClarity: 4,
      painUrgency: 4,
      marketExistence: 4,
      differentiation: 3,
      replaceability: 3,
      virality: 4,
      monetisation: 4,
      buildSimplicity: 4,
    },
    totalScore: 30,
    decision: "BUILD",
    reason: "",
    improvedIdea: "",
    buildPrompt: "",
    monetisationAngle: "",
    viralTrigger: "",
    fallbackUsed: false,
    ...overrides,
  };
}

describe("extractPatterns — operator-precedence regression", () => {
  it("does not coerce launchOutcome.revenueGenerated into the wrong type", () => {
    const idea = makeIdea({
      launchOutcome: { launched: true, revenueGenerated: true, notes: "" },
    });
    const [entry] = extractPatterns([idea], [], []);
    // Schema says `revenue: string | undefined`. Before the fix this was the
    // number `1`. After the fix it is the string "1" so it both satisfies the
    // type and remains numerically truthy for downstream `> 0` checks.
    expect(entry.revenue).toBe("1");
    expect(typeof entry.revenue).toBe("string");
  });

  it("prefers manual traction.revenue over launchOutcome", () => {
    const idea = makeIdea({
      launchOutcome: { launched: true, revenueGenerated: true, notes: "" },
    });
    const traction: TractionEntry[] = [
      {
        name: idea.name,
        revenue: "$5,000",
        views: "",
        users: "",
        sales: "",
        shares: "",
        notes: "",
      },
    ];
    const [entry] = extractPatterns([idea], [], traction);
    expect(entry.revenue).toBe("$5,000");
  });

  it("returns undefined revenue when there is no signal", () => {
    const idea = makeIdea();
    const [entry] = extractPatterns([idea], [], []);
    expect(entry.revenue).toBeUndefined();
  });

  it("honours pipeline + runStatus when assigning status", () => {
    const idea = makeIdea({ runStatus: "LAUNCHED" });
    const pipeline: PipelineEntry[] = [
      {
        name: idea.name,
        buyer: idea.buyer,
        decision: "BUILD",
        totalScore: idea.totalScore,
        monetisationAngle: "",
        viralTrigger: "",
        scores: idea.scores,
        status: "Built",
        addedAt: new Date().toISOString(),
      },
    ];
    const [entry] = extractPatterns([idea], pipeline, []);
    // runStatus LAUNCHED wins over pipeline 'Built'
    expect(entry.status).toBe("launched");
  });
});
