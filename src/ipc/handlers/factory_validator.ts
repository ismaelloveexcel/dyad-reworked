/**
 * factory_validator.ts
 *
 * Pure, Electron-free module containing:
 *  - Deterministic scoring / fallback logic
 *  - LLM output validators (using the canonical Zod schemas from factory.ts)
 *  - stableHash for seeding OpenAI calls deterministically
 *
 * Importable from unit tests without Electron shims.
 */

import {
  IdeaEvaluationResultSchema,
  GeneratePortfolioResponseSchema,
  GenerateIdeasResponseSchema,
  type IdeaEvaluationResult,
  type IdeaScores,
  type IdeaRegion,
  type NoveltyFlags,
  type GeneratePortfolioResponse,
  type GenerateIdeasResponse,
} from "../types/factory";

// ============================================================================
// Utility
// ============================================================================

export function clamp(n: number, min = 1, max = 5): number {
  return Math.min(max, Math.max(min, n));
}

// ============================================================================
// djb2 stable hash — used as OpenAI seed for determinism
// ============================================================================

export function stableHash(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  return hash >>> 0; // unsigned 32-bit integer
}

// ============================================================================
// Deterministic scoring (pure — no randomness, same input → same output)
// ============================================================================

export const SCORE_KEYS = [
  "buyerClarity",
  "painUrgency",
  "marketExistence",
  "differentiation",
  "replaceability",
  "virality",
  "monetisation",
  "buildSimplicity",
] as const;

export function deterministicScore(idea: string): IdeaScores {
  const t = idea.toLowerCase();

  let buyerClarity = 3;
  if (
    /\b(hr|lawyers?|founders?|solopreneurs?|freelancers?|job seekers?|uae employees?|small businesses?|recruiters?|students?|parents?|finance teams?)\b/.test(
      t,
    )
  )
    buyerClarity += 2;

  let painUrgency = 3;
  if (
    /\b(urgent|money|legal|hr|job|salary|client|sales|deadline|compliance|visa|termination|contract|payroll|debt|tax)\b/.test(
      t,
    )
  )
    painUrgency += 2;

  let marketExistence = 3;
  if (
    /\b(template|calculator|generator|report|proposal|resume|audit|checklist|invoice|contract|salary|compliance)\b/.test(
      t,
    )
  )
    marketExistence += 2;

  let differentiation = 3;
  if (
    /\b(ai generator|chatbot|dashboard|productivity tool|all[- ]in[- ]one|assistant)\b/.test(
      t,
    )
  )
    differentiation -= 2;
  if (
    /\b(niche|personalised|scorecard|region[- ]specific|legal[- ]specific|salary[- ]specific|viral|premium)\b/.test(
      t,
    )
  )
    differentiation += 1;

  let replaceability = 3;
  if (/\b(text[- ]only|generate content)\b/.test(t)) replaceability -= 2;
  if (
    /\b(calculator|visual|interactive|export|image|comparison|score|pdf|report)\b/.test(
      t,
    )
  )
    replaceability += 1;

  let virality = 3;
  if (
    /\b(share|image|certificate|scorecard|comparison|before[/-]after|social|screenshot|viral|reel|card)\b/.test(
      t,
    )
  )
    virality += 2;

  let monetisation = 3;
  if (
    /\b(business|sales|client|salary|visa|legal|compliance|finance|proposal|hr|recruitment|contract)\b/.test(
      t,
    )
  )
    monetisation += 2;
  if (
    /\b(entertainment|fun|hobby)\b/.test(t) &&
    !/\b(business|sales)\b/.test(t)
  )
    monetisation -= 1;

  let buildSimplicity = 3;
  if (
    /\b(auth|database|marketplace|platform|workflow|team management|crm|social network)\b/.test(
      t,
    )
  )
    buildSimplicity -= 2;
  if (/\b(single page|calculator|generator|template|static|export)\b/.test(t))
    buildSimplicity += 1;

  return {
    buyerClarity: clamp(buyerClarity),
    painUrgency: clamp(painUrgency),
    marketExistence: clamp(marketExistence),
    differentiation: clamp(differentiation),
    replaceability: clamp(replaceability),
    virality: clamp(virality),
    monetisation: clamp(monetisation),
    buildSimplicity: clamp(buildSimplicity),
  };
}

export function applyDecision(
  scores: IdeaScores,
  idea: string,
): "BUILD" | "REWORK" | "KILL" {
  const text = idea.toLowerCase();

  if (
    /replac(e|ed|ing) by one chatgpt prompt|generic ai wrapper|ai generator|chatbot/.test(
      text,
    )
  ) {
    return "KILL";
  }

  const critical: (keyof IdeaScores)[] = [
    "buyerClarity",
    "differentiation",
    "replaceability",
    "monetisation",
    "buildSimplicity",
  ];
  if (critical.some((k) => scores[k] <= 2)) return "KILL";

  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  if (total >= 32) return "BUILD";
  if (total >= 24) return "REWORK";
  return "KILL";
}

// ============================================================================
// Region Recognition Engine
// ============================================================================

export function detectRegion(idea: string): IdeaRegion {
  const t = idea.toLowerCase();

  const isUAE =
    /\b(uae|dubai|abu dhabi|sharjah|gcc|gulf|emirates|emirati|dirhams?|dhs|mena)\b/.test(
      t,
    );
  const isMauritius =
    /\b(mauritius|mauritians?|port louis|rupees?|mur|africa|sub[- ]saharan)\b/.test(
      t,
    );
  const isUS =
    /\b(us|usa|american|dollar|\$|us market|silicon valley|saas)\b/.test(t);
  const isEU =
    /\b(europe|eu|european|gdpr|pounds?|euros?|uk|british|german|french)\b/.test(
      t,
    );

  let primary = "Global";
  let secondary: string[] = [];
  let whyWorks =
    "Solves a universal professional pain point with clear visual output.";
  let whyFails =
    "May need localisation for specific tax/legal/currency context.";

  if (isUAE && isMauritius) {
    primary = "UAE/GCC";
    secondary = ["Mauritius/Africa"];
    whyWorks =
      "High-income UAE professionals + growing African tech diaspora. Both markets under-served by English SaaS.";
    whyFails = "India/US markets too price-sensitive for $20+ one-time tools.";
  } else if (isUAE) {
    primary = "UAE/GCC";
    secondary = ["Global", "Mauritius/Africa"];
    whyWorks =
      "UAE has high disposable income, English-speaking professionals, minimal SaaS competition, strong B2B spend.";
    whyFails =
      "Saudi Arabia has cultural barriers; Iran/Iraq excluded; product needs Hijri calendar for some use cases.";
  } else if (isMauritius) {
    primary = "Mauritius/Africa";
    secondary = ["UAE/GCC", "Global"];
    whyWorks =
      "Mauritius is a bilingual (English/French) financial hub with real B2B pain around compliance and reporting.";
    whyFails =
      "Small addressable market — must work for any English-speaking market to scale.";
  } else if (isUS || isEU) {
    primary = "US/EU";
    secondary = ["Global"];
    whyWorks =
      "Large market, high willingness to pay, established SaaS culture.";
    whyFails =
      "Competitive — differentiation must be very sharp. GDPR compliance needed for EU.";
  } else {
    if (
      /\b(salary|payroll|hr|labour law|employment|visa|work permit|compliance)\b/.test(
        t,
      )
    ) {
      primary = "UAE/GCC";
      secondary = ["Global", "Mauritius/Africa"];
      whyWorks =
        "HR/compliance tools are in high demand across GCC where expat workforce dominates.";
      whyFails =
        "Must avoid jurisdiction-specific legal advice; keep to calculations and benchmarks.";
    } else if (/\b(tax|vat|invoice|finance|accounting|payroll)\b/.test(t)) {
      primary = "Global";
      secondary = ["UAE/GCC", "US/EU"];
      whyWorks =
        "Financial tools have universal demand; UAE VAT tools especially under-served.";
      whyFails =
        "Tax laws vary by country — must be clearly positioned as estimates, not legal advice.";
    } else {
      primary = "Global";
      secondary = ["UAE/GCC", "US/EU"];
    }
  }

  return { primary, secondary, whyWorks, whyFails };
}

// ============================================================================
// Novelty Engine
// ============================================================================

export function checkNovelty(idea: string): NoveltyFlags {
  const t = idea.toLowerCase();

  const domainPairs: [RegExp, RegExp][] = [
    [/(salary|payroll|compensation)/, /(legal|compliance|visa)/],
    [/(hr|recruitment)/, /(ai|machine learning|data)/],
    [/(finance|accounting)/, /(social|viral|share)/],
    [/(legal|contract)/, /(calculator|score|benchmark)/],
    [/(career|resume)/, /(analytics|insight|reveal)/],
    [/(business|solopreneur)/, /(personal|identity|psychology)/],
    [/(regional|local|uae|mauritius)/, /(benchmark|comparison|global)/],
  ];
  const domainTwist = domainPairs.some(([a, b]) => a.test(t) && b.test(t));

  const perspectiveFlip =
    /\b(reveal|insight|expose|benchmark|compare|scorecard|audit|analyse|diagnose|discover)\b/.test(
      t,
    );

  const outputTransformation =
    /\b(score|report|card|comparison|result|output|export|download|pdf|image|certificate|grade|rating|badge)\b/.test(
      t,
    );

  const constraintInjection =
    /\b(in \d+|seconds?|minutes?|uae|mauritius|gcc|region|your |compare|vs\.?|against|peer|industry|rank|percentile|seniority|level|year)\b/.test(
      t,
    );

  return {
    domainTwist,
    perspectiveFlip,
    outputTransformation,
    constraintInjection,
  };
}

// ============================================================================
// Revenue probability / time-to-revenue estimators
// ============================================================================

export function estimateRevenueProbability(scores: IdeaScores): number {
  const raw =
    scores.monetisation * 0.4 +
    scores.buyerClarity * 0.35 +
    scores.marketExistence * 0.25;
  return clamp(Math.round(raw));
}

export function estimateTimeToFirstRevenue(
  scores: IdeaScores,
): "Fast" | "Medium" | "Slow" {
  const fastScore =
    scores.buildSimplicity + scores.monetisation + scores.buyerClarity;
  if (fastScore >= 13) return "Fast";
  if (fastScore >= 10) return "Medium";
  return "Slow";
}

// ============================================================================
// Build prompt generator
// ============================================================================

export function generateBuildPrompt(result: {
  name: string;
  buyer: string;
  idea: string;
  monetisationAngle: string;
  viralTrigger: string;
}): string {
  const slug = result.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return `You are a Senior Full-Stack Engineer.

Work inside the CURRENT VS Code workspace only.
Do NOT create a new repo.
Do NOT modify the core Electron Factory unless required.

Create the customer app as a standalone web-exportable app under:

/apps/${slug}/

Shared reusable logic goes under:

/core/

Use:
- Vite + React + TypeScript
- Tailwind if available
- existing repo scaffold if available

Do NOT use:
- auth
- database
- dashboards
- webhooks
- complex backend
- marketplaces
- social network features

## App: ${result.name}

**Target Buyer:** ${result.buyer}

**Core Mechanism:** ${result.idea}

**Emotional Hook:** Deliver a screenshot-worthy, premium result the user can share or export immediately.

**Viral Trigger:** ${result.viralTrigger}

**Monetisation Model:** ${result.monetisationAngle}

## App must include:
- premium UI with visible result immediately
- screenshot-worthy output
- copy / export / download / share action
- Lemon Squeezy hosted checkout placeholder (price ≥ $20)
- route or local entry point
- local dev command
- build command
- static/web export instructions
- deployment notes for Vercel/Netlify
- testing commands

## First Revenue Plan:
**Platforms:** Twitter/X, LinkedIn, IndieHackers
**Post copy:** "I built [${result.name}] for ${result.buyer}. Try it free: [link]"
**First 10 users strategy:** Post in 3 niche communities where ${result.buyer} hangs out. DM 10 people with the problem. Offer free access for a testimonial.

## Failure Risks:
1. Idea is too broad — scope down to one specific use case for one buyer
2. Output is not shareable — make sure result is visual/exportable
3. Price resistance — lead with free tier, upsell the export/advanced version

## Files to create:
- /apps/${slug}/index.html
- /apps/${slug}/src/main.tsx
- /apps/${slug}/src/App.tsx
- /apps/${slug}/src/components/
- /apps/${slug}/vite.config.ts
- /apps/${slug}/package.json
- /apps/${slug}/tailwind.config.ts (if applicable)

## Required env:
NEXT_PUBLIC_LEMON_SQUEEZY_CHECKOUT_URL=

## Commands:
- Dev: \`cd apps/${slug} && npm install && npm run dev\`
- Build: \`cd apps/${slug} && npm run build\`
- Preview: \`cd apps/${slug} && npm run preview\`
- Test: \`cd apps/${slug} && npm test\`

## Payment:
Use Lemon Squeezy hosted checkout only — redirect to NEXT_PUBLIC_LEMON_SQUEEZY_CHECKOUT_URL on purchase click.`;
}

// ============================================================================
// Deterministic fallback evaluation (pure — no LLM, same input → same output)
// ============================================================================

export function deterministicFallback(idea: string): IdeaEvaluationResult {
  const scores = deterministicScore(idea);
  const total = SCORE_KEYS.reduce((sum, k) => sum + scores[k], 0);
  const decision = applyDecision(scores, idea);

  const name =
    idea
      .split(" ")
      .slice(0, 4)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") + " Tool";

  const monetisationAngle =
    "One-time payment for premium export/report. Upsell on volume.";
  const viralTrigger =
    "Screenshot-worthy result users share on LinkedIn/Twitter.";

  const result: IdeaEvaluationResult = {
    idea,
    name,
    buyer: "Professionals and small business owners",
    scores,
    totalScore: total,
    decision,
    reason:
      decision === "BUILD"
        ? "Strong scores across key metrics. Clear buyer, urgent pain, good differentiation."
        : decision === "REWORK"
          ? "Promising idea but needs sharper buyer focus or stronger differentiation."
          : "Fails key scoring criteria or is too generic to command a premium price.",
    improvedIdea:
      decision !== "BUILD"
        ? `Consider narrowing to a specific niche buyer (e.g., UAE HR managers) and adding a visual, exportable output (PDF scorecard, branded image).`
        : "",
    monetisationAngle,
    viralTrigger,
    buildPrompt: "",
    fallbackUsed: true,
    revenueProbability: estimateRevenueProbability(scores),
    timeToFirstRevenue: estimateTimeToFirstRevenue(scores),
    region: detectRegion(idea),
    noveltyFlags: checkNovelty(idea),
  };

  if (decision === "BUILD") {
    result.buildPrompt = generateBuildPrompt({
      name: result.name,
      buyer: result.buyer,
      idea,
      monetisationAngle,
      viralTrigger,
    });
  }

  return result;
}

// ============================================================================
// LLM output validators (use canonical Zod schemas from factory.ts)
// ============================================================================

/**
 * Safely parse a raw JSON string.
 * Returns { ok: true, value } or { ok: false, error }.
 */
export function safeParseLlmJson(
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const value: unknown = JSON.parse(raw);
    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Pre-clamp all numeric score fields on a raw parsed object (in-place).
 * This allows the Zod schema to accept slightly-out-of-range LLM outputs
 * rather than failing validation outright.
 */
function clampScoresInPlace(parsed: Record<string, unknown>): void {
  const scores = parsed.scores;
  if (scores !== null && typeof scores === "object") {
    const s = scores as Record<string, unknown>;
    for (const key of SCORE_KEYS) {
      if (typeof s[key] === "number") {
        s[key] = clamp(s[key] as number);
      }
    }
  }
}

/**
 * Recalculate totalScore from (already-clamped) scores.
 */
function recalcTotalScore(parsed: Record<string, unknown>): void {
  const scores = parsed.scores;
  if (scores !== null && typeof scores === "object") {
    const s = scores as Record<string, unknown>;
    const total = SCORE_KEYS.reduce((sum, k) => {
      return sum + (typeof s[k] === "number" ? (s[k] as number) : 0);
    }, 0);
    parsed.totalScore = total;
  }
}

/**
 * Validate a raw JSON string as an IdeaEvaluationResult.
 *
 * - Clamps scores to 1–5 before Zod validation.
 * - On any parse or validation failure: returns deterministicFallback(ideaText)
 *   with fallbackUsed: true.
 * - On success: returns the validated result with fallbackUsed: false.
 */
export function validateIdeaResult(
  raw: string,
  ideaText: string,
): IdeaEvaluationResult {
  const parsed = safeParseLlmJson(raw);
  if (!parsed.ok) {
    return { ...deterministicFallback(ideaText), fallbackUsed: true };
  }

  const value = parsed.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ...deterministicFallback(ideaText), fallbackUsed: true };
  }

  const mutable = { ...(value as Record<string, unknown>) };
  clampScoresInPlace(mutable);
  recalcTotalScore(mutable);

  const result = IdeaEvaluationResultSchema.safeParse(mutable);
  if (!result.success) {
    return { ...deterministicFallback(ideaText), fallbackUsed: true };
  }

  return result.data;
}

/**
 * Validate a raw unknown value as a GeneratePortfolioResponse.
 * Returns null if validation fails.
 */
export function validateGeneratePortfolioResponse(
  raw: unknown,
): GeneratePortfolioResponse | null {
  if (raw === null || raw === undefined) return null;
  const result = GeneratePortfolioResponseSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data;
}

/**
 * Validate a raw unknown value as a GenerateIdeasResponse.
 * Returns null if validation fails or ideas array is empty.
 */
export function validateGenerateIdeasResponse(
  raw: unknown,
): GenerateIdeasResponse | null {
  if (raw === null || raw === undefined) return null;
  const result = GenerateIdeasResponseSchema.safeParse(raw);
  if (!result.success) return null;
  if (result.data.ideas.length === 0) return null;
  return result.data;
}
