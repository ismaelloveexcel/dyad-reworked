/**
 * smoke_factory.ts — Entry point documentation for the Factory smoke suite.
 *
 * The actual tests live at: src/__tests__/smoke_factory.test.ts
 * Run via: npm run smoke
 *
 * The test file is placed under src/__tests__/ because vitest's include
 * pattern is "src/**\/*.{test,spec}.{ts,tsx}" and scripts/ is outside it.
 */

// ─── clamp ───────────────────────────────────────────────────────────────────
describe("clamp", () => {
  it("clamp(3,1,5) = 3", () => expect(clamp(3, 1, 5)).toBe(3));
  it("clamp(0,1,5) = 1", () => expect(clamp(0, 1, 5)).toBe(1));
  it("clamp(9,1,5) = 5", () => expect(clamp(9, 1, 5)).toBe(5));
});

// ─── stableHash ──────────────────────────────────────────────────────────────
describe("stableHash", () => {
  it("is deterministic", () =>
    expect(stableHash("hello")).toBe(stableHash("hello")));
  it("differs for different inputs", () =>
    expect(stableHash("hello")).not.toBe(stableHash("world")));
  it("returns a number", () =>
    expect(typeof stableHash("test")).toBe("number"));
});

// ─── deterministicScore ──────────────────────────────────────────────────────
describe("deterministicScore", () => {
  it("returns 1-5", () => {
    const s = deterministicScore("test idea for lawyers");
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s).toBeLessThanOrEqual(5);
  });
});

// ─── applyDecision ───────────────────────────────────────────────────────────
describe("applyDecision", () => {
  it("score 36 → BUILD", () => expect(applyDecision(36)).toBe("BUILD"));
  it("score 24 → REWORK", () => expect(applyDecision(24)).toBe("REWORK"));
  it("score 16 → KILL", () => expect(applyDecision(16)).toBe("KILL"));
});

// ─── deterministicFallback ───────────────────────────────────────────────────
describe("deterministicFallback", () => {
  it("returns a valid IdeaEvaluationResult", () => {
    const r = deterministicFallback(
      "Invoice automation tool for freelancers in Dubai",
    );
    expect(typeof r.name).toBe("string");
    expect(r.totalScore).toBeGreaterThanOrEqual(8);
    expect(r.totalScore).toBeLessThanOrEqual(40);
    expect(["BUILD", "REWORK", "KILL"]).toContain(r.decision);
    expect(r.fallbackUsed).toBe(true);
  });
  it("scores are in range 1-5", () => {
    const r = deterministicFallback("Payroll compliance tool");
    for (const v of Object.values(r.scores)) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(5);
    }
  });
  it("is deterministic", () => {
    const idea = "Visa eligibility checker";
    const a = deterministicFallback(idea);
    const b = deterministicFallback(idea);
    expect(a.totalScore).toBe(b.totalScore);
    expect(a.decision).toBe(b.decision);
  });
});

// ─── safeParseLlmJson ─────────────────────────────────────────────────────────
describe("safeParseLlmJson", () => {
  it("parses plain JSON", () => {
    const r = safeParseLlmJson('{"foo":"bar"}') as { foo: string } | null;
    expect(r).not.toBeNull();
    expect(r?.foo).toBe("bar");
  });
  it("strips markdown fences", () => {
    const r = safeParseLlmJson('```json\n{"foo":"bar"}\n```') as {
      foo: string;
    } | null;
    expect(r).not.toBeNull();
    expect(r?.foo).toBe("bar");
  });
  it("returns null for invalid JSON", () => {
    expect(safeParseLlmJson("not json at all {{{")).toBeNull();
  });
  it("returns null for empty string", () => {
    expect(safeParseLlmJson("")).toBeNull();
  });
});

// ─── validateIdeaResult ───────────────────────────────────────────────────────
const validJson = JSON.stringify({
  idea: "Invoice automation tool for Dubai freelancers",
  name: "InvoicePro UAE",
  buyer: "Freelancers in UAE",
  scores: {
    monetisation: 4,
    virality: 3,
    buyerClarity: 5,
    differentiation: 3,
    buildSimplicity: 4,
    marketSize: 4,
    replaceability: 3,
    urgency: 4,
  },
  totalScore: 30,
  decision: "BUILD",
  reason: "Strong monetisation potential for a clear buyer segment.",
  improvedIdea: "Add multi-currency support.",
  buildPrompt: "Build an invoice automation SaaS...",
  monetisationAngle: "Monthly subscription",
  viralTrigger: "Share your invoice template",
  fallbackUsed: false,
});

describe("validateIdeaResult", () => {
  it("validates well-formed JSON result", () => {
    const r = validateIdeaResult(validJson, "Invoice automation tool");
    expect(r.name).toBe("InvoicePro UAE");
    expect(r.totalScore).toBeGreaterThanOrEqual(8);
  });
  it("falls back gracefully on junk input", () => {
    const r = validateIdeaResult(
      "this is not json at all!!!",
      "some idea text",
    );
    expect(r.fallbackUsed).toBe(true);
    expect(r.decision).toBeDefined();
  });
  it("falls back on empty string", () => {
    const r = validateIdeaResult("", "fallback test");
    expect(r.fallbackUsed).toBe(true);
  });
  it("clamps totalScore to 8-40", () => {
    const tweaked = JSON.stringify({
      ...JSON.parse(validJson),
      totalScore: 999,
    });
    const r = validateIdeaResult(tweaked, "test");
    expect(r.totalScore).toBeLessThanOrEqual(40);
  });
});
