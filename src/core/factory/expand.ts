/**
 * expand.ts
 *
 * Prompt templates, pattern-context builder, portfolio response parser, and
 * prompt-version metadata — pure module with no Electron/DB dependencies.
 *
 * These functions are shared between the main-process handlers (which call
 * OpenAI) and can be unit-tested without Electron.
 */

import {
  stableHash,
  validateIdeaResult,
  generateBuildPrompt,
} from "@/ipc/handlers/factory_validator";
import type {
  IdeaEvaluationResult,
  GeneratePortfolioResponse,
  PatternEntry,
} from "@/ipc/types/factory";

// =============================================================================
// Prompt versioning
// =============================================================================

export const PROMPT_VERSION = "v3.2";

// =============================================================================
// Prompt templates
// =============================================================================

export const EVALUATE_PROMPT = (idea: string) => `
Evaluate this app idea for a solo developer: "${idea}"

Respond with ONLY this JSON object (no markdown, no code blocks):

{
  "name": "Short product name (max 5 words)",
  "buyer": "Specific target buyer",
  "scores": {
    "buyerClarity": <1-5>,
    "painUrgency": <1-5>,
    "marketExistence": <1-5>,
    "differentiation": <1-5>,
    "replaceability": <1-5>,
    "virality": <1-5>,
    "monetisation": <1-5>,
    "buildSimplicity": <1-5>
  },
  "reason": "One sentence summary of why this scored this way",
  "improvedIdea": "Improved version if REWORK or KILL, else empty string",
  "monetisationAngle": "How to charge money for this",
  "viralTrigger": "What makes users share this"
}

Scoring rubric:
- buyerClarity: 5 = hyper-specific buyer, 1 = everyone/no one
- painUrgency: 5 = urgent costly pain, 1 = nice-to-have
- marketExistence: 5 = proven paid category, 1 = nobody pays
- differentiation: 5 = unique insight/mechanic, 1 = clone
- replaceability: 5 = hard to replace, 1 = one ChatGPT prompt does it
- virality: 5 = screenshot-worthy + share creates new users, 1 = not shareable
- monetisation: 5 = easy $20+ sale, 1 = hard to charge
- buildSimplicity: 5 = one-day build, 1 = requires backend/auth/database

Hard KILL conditions (score differentiation or replaceability at 1): generic AI wrapper, replaceable by one ChatGPT prompt.
`;

export const GENERATE_PROMPT = (niche: string | undefined, mode: string) => `
Generate exactly 10 monetisable app ideas for a solo developer.

Mode: ${mode}
${niche ? `Niche/context: ${niche}` : ""}

Bias toward:
- premium AI tools, viral mini-apps, business tools, career tools, legal/compliance tools
- HR/salary/visa tools, solopreneurs, small businesses, UAE/GCC + Mauritius opportunities
- products that sell for ≥ $20, fast-build apps with visual/export/share output
- calculators, scorecards, visual generators, audit tools, comparison tools, premium reports, compliance helpers, professional document helpers

Avoid:
- generic content generators, generic dashboards, broad SaaS clones
- productivity tools, marketplaces, social networks, apps requiring complex auth/database/backend

Each idea must explain why it is NOT a GPT wrapper.

Respond with ONLY this JSON array (no markdown, no code blocks):

[
  {
    "idea": "Full description of the app concept",
    "name": "Short product name (max 5 words)",
    "buyer": "Specific target buyer",
    "scores": {
      "buyerClarity": <1-5>,
      "painUrgency": <1-5>,
      "marketExistence": <1-5>,
      "differentiation": <1-5>,
      "replaceability": <1-5>,
      "virality": <1-5>,
      "monetisation": <1-5>,
      "buildSimplicity": <1-5>
    },
    "reason": "One sentence explanation of potential",
    "improvedIdea": "",
    "monetisationAngle": "How to charge money",
    "viralTrigger": "What makes users share it"
  }
]
`;

// Prompt hash — computed once after all prompt templates are defined (E4)
export const CURRENT_PROMPT_HASH = String(
  stableHash(EVALUATE_PROMPT("") + GENERATE_PROMPT(undefined, "premium")),
);

// =============================================================================
// Enrich a result with prompt version metadata (E4)
// =============================================================================

export function enrichResult<T extends IdeaEvaluationResult>(result: T): T {
  return {
    ...result,
    promptVersion: PROMPT_VERSION,
    promptHash: CURRENT_PROMPT_HASH,
  };
}

// =============================================================================
// Pattern Engine context builder
// =============================================================================

export function buildPatternContext(patterns: PatternEntry[]): string {
  if (patterns.length === 0) return "";

  const launched = patterns.filter((p) => p.status === "launched");
  const killed = patterns.filter((p) => p.status === "killed");
  const highRevenue = patterns.filter((p) => p.revenueScore >= 4);
  const highViral = patterns.filter((p) => p.viralScore >= 4);

  const lines: string[] = ["PATTERN ENGINE DATA (use to bias generation):"];

  if (launched.length > 0) {
    lines.push(
      `Launched (prioritise similar): ${launched.map((p) => `${p.name} [cat:${p.category}]`).join(", ")}`,
    );
  }
  if (killed.length > 0) {
    lines.push(
      `Killed/ignored (avoid similar patterns): ${killed.map((p) => p.name).join(", ")}`,
    );
  }
  if (highRevenue.length > 0) {
    lines.push(
      `High revenue potential patterns: ${[...new Set(highRevenue.map((p) => p.category))].join(", ")}`,
    );
  }
  if (highViral.length > 0) {
    lines.push(
      `High viral patterns: ${[...new Set(highViral.map((p) => p.category))].join(", ")}`,
    );
  }

  // Category distribution — avoid repetition
  const categories = patterns.reduce<Record<string, number>>((acc, p) => {
    acc[p.category] = (acc[p.category] ?? 0) + 1;
    return acc;
  }, {});
  const overused = Object.entries(categories)
    .filter(([, count]) => count >= 3)
    .map(([cat]) => cat);
  if (overused.length > 0) {
    lines.push(
      `Over-represented categories (diversify away from): ${overused.join(", ")}`,
    );
  }

  return lines.join("\n");
}

// =============================================================================
// Generate Portfolio prompt template
// =============================================================================

export const GENERATE_PORTFOLIO_PROMPT = (
  niche: string | undefined,
  patternContext: string,
) => `
You are an expert app idea strategist for solo developers building micro-SaaS products.

Generate EXACTLY 3 app ideas using the Dual Engine method:

1. BUILD IDEA #1 — REVENUE ENGINE
   - RevenueProbability ≥ 4/5
   - TimeToFirstRevenue = Fast
   - Focus: immediate monetisation, clear buyer, urgent pain
   - Must NOT be a generic AI/GPT wrapper

2. BUILD IDEA #2 — VIRAL ENGINE
   - virality ≥ 4/5
   - Interaction < 30 seconds to get value
   - Output must be shareable (score, card, comparison, image, certificate)
   - Focus: social spread, link back to revenue idea

3. REWORK IDEA — EXPERIMENTAL
   - An interesting concept that needs refinement
   - decision = "REWORK"
   - Shows creative direction, different audience/use case from ideas 1 and 2

NOVELTY ENGINE (mandatory for each idea):
- DOMAIN TWIST: Must combine 2 unrelated domains (e.g., salary + psychology, compliance + gamification)
- PERSPECTIVE FLIP: Must reveal/expose/compare something (not just "a tool")
- OUTPUT TRANSFORMATION: Output must be a score/report/card/comparison/certificate (not text-only)
- CONSTRAINT INJECTION: Must include time/identity/region/social comparison dimension

REGION RECOGNITION (for each idea):
- Assign Primary Region: Global | UAE/GCC | Mauritius/Africa | US/EU
- Explain why it works there
- Explain where/why it fails

${patternContext}
${niche ? `Target niche/context: ${niche}` : ""}

DIVERSITY REQUIREMENT:
- Ideas 1, 2, 3 must have different target audiences, use cases, and monetisation models
- At least one must target UAE/GCC or Mauritius/Africa market

PORTFOLIO LINK:
- Explain how the Viral Engine idea drives traffic/users to the Revenue Engine idea

Respond with ONLY this JSON (no markdown, no code blocks):
{
  "revenueIdea": {
    "idea": "Full description",
    "name": "Product name (max 5 words)",
    "buyer": "Specific buyer persona",
    "engineType": "revenue",
    "revenueProbability": <4 or 5>,
    "timeToFirstRevenue": "Fast",
    "scores": {
      "buyerClarity": <1-5>,
      "painUrgency": <1-5>,
      "marketExistence": <1-5>,
      "differentiation": <1-5>,
      "replaceability": <1-5>,
      "virality": <1-5>,
      "monetisation": <1-5>,
      "buildSimplicity": <1-5>
    },
    "reason": "One sentence",
    "improvedIdea": "",
    "monetisationAngle": "How to charge",
    "viralTrigger": "What makes people share it",
    "region": {
      "primary": "UAE/GCC",
      "secondary": ["Global"],
      "whyWorks": "Why this region is ideal",
      "whyFails": "Where it doesn't translate"
    },
    "noveltyFlags": {
      "domainTwist": true,
      "perspectiveFlip": true,
      "outputTransformation": true,
      "constraintInjection": true
    }
  },
  "viralIdea": {
    "idea": "Full description",
    "name": "Product name (max 5 words)",
    "buyer": "Specific buyer persona",
    "engineType": "viral",
    "revenueProbability": <1-5>,
    "timeToFirstRevenue": "Fast",
    "scores": { ... },
    "reason": "One sentence",
    "improvedIdea": "",
    "monetisationAngle": "How to charge",
    "viralTrigger": "The core share mechanic",
    "region": { "primary": "...", "secondary": [], "whyWorks": "...", "whyFails": "..." },
    "noveltyFlags": { "domainTwist": true, "perspectiveFlip": true, "outputTransformation": true, "constraintInjection": true }
  },
  "experimentalIdea": {
    "idea": "Full description",
    "name": "Product name (max 5 words)",
    "buyer": "Specific buyer persona",
    "engineType": "experimental",
    "revenueProbability": <1-5>,
    "timeToFirstRevenue": "Medium",
    "scores": { ... },
    "reason": "One sentence",
    "improvedIdea": "What needs to change to make it BUILD",
    "monetisationAngle": "Potential monetisation",
    "viralTrigger": "Potential share mechanic",
    "region": { "primary": "...", "secondary": [], "whyWorks": "...", "whyFails": "..." },
    "noveltyFlags": { "domainTwist": true, "perspectiveFlip": false, "outputTransformation": true, "constraintInjection": false }
  },
  "portfolioLink": "One sentence explaining how the viral idea drives users to the revenue idea — the conversion funnel."
}
`;

// =============================================================================
// Portfolio response parsing
// =============================================================================

export function parsePortfolioIdea(
  obj: Record<string, unknown>,
  engineType: "revenue" | "viral" | "experimental",
): IdeaEvaluationResult {
  const idea = String(obj.idea ?? "");
  const result = validateIdeaResult(JSON.stringify(obj), idea);
  result.engineType = engineType;
  return result;
}

export function parsePortfolioResponse(raw: string): GeneratePortfolioResponse {
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const revenueIdea = parsePortfolioIdea(
    (parsed.revenueIdea ?? {}) as Record<string, unknown>,
    "revenue",
  );
  const viralIdea = parsePortfolioIdea(
    (parsed.viralIdea ?? {}) as Record<string, unknown>,
    "viral",
  );
  const experimentalIdea = parsePortfolioIdea(
    (parsed.experimentalIdea ?? {}) as Record<string, unknown>,
    "experimental",
  );

  // Force correct decisions
  if (revenueIdea.decision !== "BUILD") revenueIdea.decision = "BUILD";
  if (viralIdea.decision !== "BUILD") viralIdea.decision = "BUILD";
  if (experimentalIdea.decision === "BUILD")
    experimentalIdea.decision = "REWORK";

  // Generate build prompts where missing
  if (revenueIdea.decision === "BUILD" && !revenueIdea.buildPrompt) {
    revenueIdea.buildPrompt = generateBuildPrompt({
      name: revenueIdea.name,
      buyer: revenueIdea.buyer,
      idea: revenueIdea.idea,
      monetisationAngle: revenueIdea.monetisationAngle,
      viralTrigger: revenueIdea.viralTrigger,
    });
  }
  if (viralIdea.decision === "BUILD" && !viralIdea.buildPrompt) {
    viralIdea.buildPrompt = generateBuildPrompt({
      name: viralIdea.name,
      buyer: viralIdea.buyer,
      idea: viralIdea.idea,
      monetisationAngle: viralIdea.monetisationAngle,
      viralTrigger: viralIdea.viralTrigger,
    });
  }

  // Portfolio linking: attach link to both BUILD ideas
  const portfolioLink = String(
    parsed.portfolioLink ??
      `"${viralIdea.name}" creates viral awareness → users convert to "${revenueIdea.name}" for the paid premium output.`,
  );
  revenueIdea.portfolioLink = portfolioLink;
  viralIdea.portfolioLink = portfolioLink;

  return {
    revenueIdea,
    viralIdea,
    experimentalIdea,
    portfolioLink,
    fallbackUsed: false,
  };
}
