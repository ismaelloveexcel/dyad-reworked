import { createTypedHandler } from "./base";
import { factoryContracts, type IdeaEvaluationResult, type IdeaScores } from "../types/factory";
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
}
