import { createTypedHandler } from "./base";
import {
  factoryContracts,
  type IdeaEvaluationResult,
  type IdeaScores,
  type IdeaRegion,
  type NoveltyFlags,
  type PatternEntry,
  type GeneratePortfolioResponse,
} from "../types/factory";
import log from "electron-log";

const logger = log.scope("factory_handlers");

// =============================================================================
// Scoring helpers
// =============================================================================

function clamp(n: number, min = 1, max = 5): number {
  return Math.min(max, Math.max(min, n));
}

function applyDecision(
  scores: IdeaScores,
  idea: string,
): "BUILD" | "REWORK" | "KILL" {
  const text = idea.toLowerCase();

  // Hard KILL rules
  if (
    /replac(e|ed|ing) by one chatgpt prompt|generic ai wrapper|ai generator|chatbot/.test(
      text,
    )
  ) {
    return "KILL";
  }

  // KILL if any critical metric ≤ 2
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

function deterministicScore(idea: string): IdeaScores {
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
    /\b(share|image|certificate|scorecard|comparison|before[\/\-]after|social|screenshot|viral|reel|card)\b/.test(
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
  if (/\b(entertainment|fun|hobby)\b/.test(t) && !/\b(business|sales)\b/.test(t))
    monetisation -= 1;

  let buildSimplicity = 3;
  if (
    /\b(auth|database|marketplace|platform|workflow|team management|crm|social network)\b/.test(
      t,
    )
  )
    buildSimplicity -= 2;
  if (
    /\b(single page|calculator|generator|template|static|export)\b/.test(t)
  )
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

// =============================================================================
// Region Recognition Engine
// =============================================================================

function detectRegion(idea: string): IdeaRegion {
  const t = idea.toLowerCase();

  const isUAE = /\b(uae|dubai|abu dhabi|sharjah|gcc|gulf|emirates|emirati|dirhams?|dhs|mena)\b/.test(t);
  const isMauritius = /\b(mauritius|mauritians?|port louis|rupees?|mur|africa|sub[- ]saharan)\b/.test(t);
  const isUS = /\b(us|usa|american|dollar|\$|us market|silicon valley|saas)\b/.test(t);
  const isEU = /\b(europe|eu|european|gdpr|pounds?|euros?|uk|british|german|french)\b/.test(t);

  let primary = "Global";
  let secondary: string[] = [];
  let whyWorks = "Solves a universal professional pain point with clear visual output.";
  let whyFails = "May need localisation for specific tax/legal/currency context.";

  if (isUAE && isMauritius) {
    primary = "UAE/GCC";
    secondary = ["Mauritius/Africa"];
    whyWorks = "High-income UAE professionals + growing African tech diaspora. Both markets under-served by English SaaS.";
    whyFails = "India/US markets too price-sensitive for $20+ one-time tools.";
  } else if (isUAE) {
    primary = "UAE/GCC";
    secondary = ["Global", "Mauritius/Africa"];
    whyWorks = "UAE has high disposable income, English-speaking professionals, minimal SaaS competition, strong B2B spend.";
    whyFails = "Saudi Arabia has cultural barriers; Iran/Iraq excluded; product needs Hijri calendar for some use cases.";
  } else if (isMauritius) {
    primary = "Mauritius/Africa";
    secondary = ["UAE/GCC", "Global"];
    whyWorks = "Mauritius is a bilingual (English/French) financial hub with real B2B pain around compliance and reporting.";
    whyFails = "Small addressable market — must work for any English-speaking market to scale.";
  } else if (isUS || isEU) {
    primary = "US/EU";
    secondary = ["Global"];
    whyWorks = "Large market, high willingness to pay, established SaaS culture.";
    whyFails = "Competitive — differentiation must be very sharp. GDPR compliance needed for EU.";
  } else {
    // infer from content domains
    if (/\b(salary|payroll|hr|labour law|employment|visa|work permit|compliance)\b/.test(t)) {
      primary = "UAE/GCC";
      secondary = ["Global", "Mauritius/Africa"];
      whyWorks = "HR/compliance tools are in high demand across GCC where expat workforce dominates.";
      whyFails = "Must avoid jurisdiction-specific legal advice; keep to calculations and benchmarks.";
    } else if (/\b(tax|vat|invoice|finance|accounting|payroll)\b/.test(t)) {
      primary = "Global";
      secondary = ["UAE/GCC", "US/EU"];
      whyWorks = "Financial tools have universal demand; UAE VAT tools especially under-served.";
      whyFails = "Tax laws vary by country — must be clearly positioned as estimates, not legal advice.";
    } else {
      primary = "Global";
      secondary = ["UAE/GCC", "US/EU"];
    }
  }

  return { primary, secondary, whyWorks, whyFails };
}

// =============================================================================
// Novelty Engine
// =============================================================================

function checkNovelty(idea: string): NoveltyFlags {
  const t = idea.toLowerCase();

  // 1. Domain Twist — combines 2 unrelated domains
  const domainPairs = [
    [/(salary|payroll|compensation)/, /(legal|compliance|visa)/],
    [/(hr|recruitment)/, /(ai|machine learning|data)/],
    [/(finance|accounting)/, /(social|viral|share)/],
    [/(legal|contract)/, /(calculator|score|benchmark)/],
    [/(career|resume)/, /(analytics|insight|reveal)/],
    [/(business|solopreneur)/, /(personal|identity|psychology)/],
    [/(regional|local|uae|mauritius)/, /(benchmark|comparison|global)/],
  ];
  const domainTwist = domainPairs.some(([a, b]) => a.test(t) && b.test(t));

  // 2. Perspective Flip — insight/reveal vs. just a tool
  const perspectiveFlip = /\b(reveal|insight|expose|benchmark|compare|scorecard|audit|analyse|diagnose|discover)\b/.test(t);

  // 3. Output Transformation — score/compare/report/reveal/card
  const outputTransformation = /\b(score|report|card|comparison|result|output|export|download|pdf|image|certificate|grade|rating|badge)\b/.test(t);

  // 4. Constraint Injection — time/identity/region/social
  const constraintInjection = /\b(in \d+|seconds?|minutes?|uae|mauritius|gcc|region|your |compare|vs\.?|against|peer|industry|rank|percentile|seniority|level|year)\b/.test(t);

  return { domainTwist, perspectiveFlip, outputTransformation, constraintInjection };
}

// =============================================================================
// Revenue Probability + Time To First Revenue
// =============================================================================

function estimateRevenueProbability(scores: IdeaScores): number {
  // Weighted: monetisation, buyer clarity, market existence
  const raw = scores.monetisation * 0.4 + scores.buyerClarity * 0.35 + scores.marketExistence * 0.25;
  return clamp(Math.round(raw));
}

function estimateTimeToFirstRevenue(scores: IdeaScores): "Fast" | "Medium" | "Slow" {
  // Fast = high build simplicity + high monetisation + high buyer clarity
  const fastScore = scores.buildSimplicity + scores.monetisation + scores.buyerClarity;
  if (fastScore >= 13) return "Fast";
  if (fastScore >= 10) return "Medium";
  return "Slow";
}

function generateBuildPrompt(result: {
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

function fallbackEvaluate(idea: string): IdeaEvaluationResult {
  const scores = deterministicScore(idea);
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
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

// =============================================================================
// OpenAI helpers
// =============================================================================

async function callOpenAI(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.7,
      max_tokens: 2000,
      messages: [
        {
          role: "system",
          content:
            "You are an expert app idea evaluator. Respond ONLY with valid JSON — no markdown, no code fences, no commentary.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
  };
  return data.choices[0].message.content;
}

const SCORE_KEYS = [
  "buyerClarity",
  "painUrgency",
  "marketExistence",
  "differentiation",
  "replaceability",
  "virality",
  "monetisation",
  "buildSimplicity",
] as const;

function parseAIEvaluationResult(
  raw: string,
  idea: string,
): IdeaEvaluationResult {
  const parsed = JSON.parse(raw);

  const scores: IdeaScores = {
    buyerClarity: clamp(Number(parsed.scores?.buyerClarity ?? 3)),
    painUrgency: clamp(Number(parsed.scores?.painUrgency ?? 3)),
    marketExistence: clamp(Number(parsed.scores?.marketExistence ?? 3)),
    differentiation: clamp(Number(parsed.scores?.differentiation ?? 3)),
    replaceability: clamp(Number(parsed.scores?.replaceability ?? 3)),
    virality: clamp(Number(parsed.scores?.virality ?? 3)),
    monetisation: clamp(Number(parsed.scores?.monetisation ?? 3)),
    buildSimplicity: clamp(Number(parsed.scores?.buildSimplicity ?? 3)),
  };

  const total = SCORE_KEYS.reduce((sum, k) => sum + scores[k], 0);
  const decision = applyDecision(scores, idea);

  const name = String(parsed.name ?? idea.split(" ").slice(0, 4).join(" "));
  const buyer = String(parsed.buyer ?? "Professionals");
  const monetisationAngle = String(
    parsed.monetisationAngle ?? "One-time premium purchase",
  );
  const viralTrigger = String(
    parsed.viralTrigger ?? "Shareable screenshot output",
  );

  const result: IdeaEvaluationResult = {
    idea,
    name,
    buyer,
    scores,
    totalScore: total,
    decision,
    reason: String(parsed.reason ?? ""),
    improvedIdea: String(parsed.improvedIdea ?? ""),
    monetisationAngle,
    viralTrigger,
    buildPrompt: "",
    fallbackUsed: false,
    revenueProbability: clamp(Number(parsed.revenueProbability ?? estimateRevenueProbability(scores))),
    timeToFirstRevenue: (["Fast", "Medium", "Slow"].includes(String(parsed.timeToFirstRevenue))
      ? String(parsed.timeToFirstRevenue)
      : estimateTimeToFirstRevenue(scores)) as "Fast" | "Medium" | "Slow",
    engineType: (["revenue", "viral", "experimental"].includes(String(parsed.engineType))
      ? String(parsed.engineType)
      : undefined) as "revenue" | "viral" | "experimental" | undefined,
    region: parsed.region
      ? {
          primary: String(parsed.region.primary ?? "Global"),
          secondary: Array.isArray(parsed.region.secondary) ? parsed.region.secondary.map(String) : [],
          whyWorks: String(parsed.region.whyWorks ?? ""),
          whyFails: String(parsed.region.whyFails ?? ""),
        }
      : detectRegion(idea),
    noveltyFlags: parsed.noveltyFlags
      ? {
          domainTwist: Boolean(parsed.noveltyFlags.domainTwist),
          perspectiveFlip: Boolean(parsed.noveltyFlags.perspectiveFlip),
          outputTransformation: Boolean(parsed.noveltyFlags.outputTransformation),
          constraintInjection: Boolean(parsed.noveltyFlags.constraintInjection),
        }
      : checkNovelty(idea),
  };

  if (decision === "BUILD") {
    result.buildPrompt = generateBuildPrompt({
      name,
      buyer,
      idea,
      monetisationAngle,
      viralTrigger,
    });
  }

  return result;
}

const EVALUATE_PROMPT = (idea: string) => `
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

const GENERATE_PROMPT = (niche: string | undefined, mode: string) => `
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

// =============================================================================
// Handler registration
// =============================================================================

export function registerFactoryHandlers() {
  createTypedHandler(
    factoryContracts.evaluateIdea,
    async (_, { idea }) => {
      try {
        const raw = await callOpenAI(EVALUATE_PROMPT(idea));
        return parseAIEvaluationResult(raw, idea);
      } catch (err) {
        logger.warn("OpenAI unavailable, using fallback scoring:", err);
        return fallbackEvaluate(idea);
      }
    },
  );

  createTypedHandler(
    factoryContracts.generateIdeas,
    async (_, { niche, mode }) => {
      const fallbackIdeas = () => {
        const templates = [
          "UAE Labour Law Termination Risk Scorecard for HR managers",
          "Freelance Visa Eligibility Calculator for UAE professionals",
          "Salary Benchmark Comparison Tool for GCC job seekers",
          "Mauritius Work Permit Requirements Checker for expat employers",
          "AI Resume Score Card for job applicants in tech",
          "Client Proposal ROI Calculator for freelance designers",
          "Contract Red Flag Detector for solopreneurs",
          "Payroll Compliance Audit Tool for small UAE businesses",
          "Invoice Late Fee Calculator for freelancers",
          "Business Registration Requirements Comparison for GCC markets",
        ];
        return templates.map((t) => fallbackEvaluate(t));
      };

      try {
        const raw = await callOpenAI(GENERATE_PROMPT(niche, mode));
        const parsed = JSON.parse(raw) as unknown[];

        if (!Array.isArray(parsed)) throw new Error("Expected array");

        const ideas: IdeaEvaluationResult[] = parsed
          .slice(0, 10)
          .map((item) => {
            const obj = item as Record<string, unknown>;
            const idea = String(obj.idea ?? "");
            try {
              return parseAIEvaluationResult(JSON.stringify(obj), idea);
            } catch {
              return fallbackEvaluate(idea);
            }
          });

        // Sort by totalScore descending
        ideas.sort((a, b) => b.totalScore - a.totalScore);

        return { ideas };
      } catch (err) {
        logger.warn("OpenAI unavailable, using fallback ideas:", err);
        const ideas = fallbackIdeas().sort(
          (a, b) => b.totalScore - a.totalScore,
        );
        return { ideas };
      }
    },
  );

  // ===========================================================================
  // Generate Portfolio — Dual Engine + Novelty + Pattern Engine
  // ===========================================================================

  createTypedHandler(
    factoryContracts.generatePortfolio,
    async (_, { niche, patterns }) => {
      const patternContext = buildPatternContext(patterns ?? []);

      try {
        const raw = await callOpenAI(GENERATE_PORTFOLIO_PROMPT(niche, patternContext));
        const portfolio = parsePortfolioResponse(raw);
        return portfolio;
      } catch (err) {
        logger.warn("OpenAI unavailable, using fallback portfolio:", err);
        return buildFallbackPortfolio(niche);
      }
    },
  );
}

// =============================================================================
// Pattern Engine helpers
// =============================================================================

function buildPatternContext(patterns: PatternEntry[]): string {
  if (patterns.length === 0) return "";

  const launched = patterns.filter((p) => p.status === "launched");
  const killed = patterns.filter((p) => p.status === "killed");
  const highRevenue = patterns.filter((p) => p.revenueScore >= 4);
  const highViral = patterns.filter((p) => p.viralScore >= 4);

  const lines: string[] = ["PATTERN ENGINE DATA (use to bias generation):"];

  if (launched.length > 0) {
    lines.push(`Launched (prioritise similar): ${launched.map((p) => `${p.name} [cat:${p.category}]`).join(", ")}`);
  }
  if (killed.length > 0) {
    lines.push(`Killed/ignored (avoid similar patterns): ${killed.map((p) => p.name).join(", ")}`);
  }
  if (highRevenue.length > 0) {
    lines.push(`High revenue potential patterns: ${[...new Set(highRevenue.map((p) => p.category))].join(", ")}`);
  }
  if (highViral.length > 0) {
    lines.push(`High viral patterns: ${[...new Set(highViral.map((p) => p.category))].join(", ")}`);
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
    lines.push(`Over-represented categories (diversify away from): ${overused.join(", ")}`);
  }

  return lines.join("\n");
}

const GENERATE_PORTFOLIO_PROMPT = (niche: string | undefined, patternContext: string) => `
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

function parsePortfolioIdea(
  obj: Record<string, unknown>,
  engineType: "revenue" | "viral" | "experimental",
): IdeaEvaluationResult {
  const idea = String(obj.idea ?? "");
  try {
    const result = parseAIEvaluationResult(JSON.stringify(obj), idea);
    result.engineType = engineType;
    return result;
  } catch {
    const r = fallbackEvaluate(idea);
    r.engineType = engineType;
    return r;
  }
}

function parsePortfolioResponse(raw: string): GeneratePortfolioResponse {
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
  if (experimentalIdea.decision === "BUILD") experimentalIdea.decision = "REWORK";

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

  return { revenueIdea, viralIdea, experimentalIdea, portfolioLink, fallbackUsed: false };
}

// =============================================================================
// Fallback portfolio (no OpenAI)
// =============================================================================

function buildFallbackPortfolio(niche: string | undefined): GeneratePortfolioResponse {
  const suffix = niche ? ` for ${niche}` : "";

  const revenueIdea = fallbackEvaluate(
    `UAE Labour Law Termination Risk Scorecard${suffix} — calculates redundancy risk and payout for HR managers based on job grade, emirate, and contract type. Outputs branded PDF report.`,
  );
  revenueIdea.engineType = "revenue";
  revenueIdea.decision = "BUILD";
  revenueIdea.scores.virality = 3;
  revenueIdea.scores.monetisation = 5;
  revenueIdea.scores.buyerClarity = 5;
  revenueIdea.timeToFirstRevenue = "Fast";
  revenueIdea.revenueProbability = 5;
  revenueIdea.buildPrompt = generateBuildPrompt({
    name: revenueIdea.name,
    buyer: "UAE HR managers and employment lawyers",
    idea: revenueIdea.idea,
    monetisationAngle: "One-time $29 PDF report unlock. Bulk pricing for HR teams.",
    viralTrigger: "HR managers share the report in LinkedIn HR groups.",
  });

  const viralIdea = fallbackEvaluate(
    `Salary Reveal Card${suffix} — enter your UAE job title, years of experience, and emirate to get an instant peer-comparison card showing if you are underpaid vs. market. Share your card on LinkedIn.`,
  );
  viralIdea.engineType = "viral";
  viralIdea.decision = "BUILD";
  viralIdea.scores.virality = 5;
  viralIdea.scores.monetisation = 3;
  viralIdea.timeToFirstRevenue = "Fast";
  viralIdea.revenueProbability = 3;
  viralIdea.buildPrompt = generateBuildPrompt({
    name: viralIdea.name,
    buyer: "UAE/GCC professionals seeking salary transparency",
    idea: viralIdea.idea,
    monetisationAngle: "Free card, $9 for detailed breakdown report. Upsell to Termination Risk Scorecard.",
    viralTrigger: "User shares their salary card on LinkedIn — peers click, enter their own data.",
  });

  const experimentalIdea = fallbackEvaluate(
    `GCC Startup Visa Readiness Checker${suffix} — founder answers 10 questions about their business stage, nationality, and target emirate to get a readiness score and roadmap.`,
  );
  experimentalIdea.engineType = "experimental";
  experimentalIdea.decision = "REWORK";
  experimentalIdea.improvedIdea =
    "Narrow to UAE specifically (DIFC/ADGM vs mainland). Add regional consultancy upsell. Partner with a visa agency for lead-gen revenue.";

  const portfolioLink =
    `"${viralIdea.name}" drives viral awareness via LinkedIn sharing → users who share are clearly job-hunting → convert them to "${revenueIdea.name}" which solves the follow-up fear: "What am I owed if I leave?"`;

  revenueIdea.portfolioLink = portfolioLink;
  viralIdea.portfolioLink = portfolioLink;

  return {
    revenueIdea,
    viralIdea,
    experimentalIdea,
    portfolioLink,
    fallbackUsed: true,
  };
}
