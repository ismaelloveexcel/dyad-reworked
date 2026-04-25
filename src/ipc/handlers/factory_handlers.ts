import { createTypedHandler } from "./base";
import {
  factoryContracts,
  type IdeaEvaluationResult,
  type PatternEntry,
  type GeneratePortfolioResponse,
  type RunStatus,
} from "../types/factory";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { db } from "@/db";
import { factoryRuns } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import log from "electron-log";
import { dialog, BrowserWindow } from "electron";
import { writeFile } from "fs/promises";
import { sendTelemetryException } from "@/ipc/utils/telemetry";
import {
  stableHash,
  validateIdeaResult,
  deterministicFallback,
  generateBuildPrompt,
  detectRegulatedDomain,
} from "./factory_validator";
import { readSettings } from "@/main/settings";

const logger = log.scope("factory_handlers");

// =============================================================================
// Pinned model snapshot (PR #1) — pinning the dated snapshot makes runs
// reproducible across model upgrades. Bump deliberately when re-baselining.
// =============================================================================

export const OPENAI_MODEL_VERSION = "gpt-4o-mini-2024-07-18";

// =============================================================================
// Prompt versioning (E4)
// =============================================================================

export const PROMPT_VERSION = "v3.2";
// PROMPT_HASH is computed lazily after prompt functions are defined below

// =============================================================================
// OpenAI helpers
// =============================================================================

// Allow tests (and self-hosted deployments) to redirect OpenAI calls to a
// custom endpoint — e.g. the fake-llm-server used in E2E tests.
// When OPENAI_BASE_URL is unset, the production OpenAI endpoint is used.
//
// We normalise the base URL by stripping any trailing "/v1" (or "/v1/") before
// appending our own path, so both `http://host` and `http://host/v1` work
// correctly with OpenAI-compatible endpoints.
const OPENAI_CHAT_COMPLETIONS_URL = (() => {
  const base = process.env.OPENAI_BASE_URL;
  if (!base) return "https://api.openai.com/v1/chat/completions";
  const normalized = base.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  return `${normalized}/v1/chat/completions`;
})();

async function callOpenAI(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new DyadError(
      "OPENAI_API_KEY is not set. Add it to your environment.",
      DyadErrorKind.MissingApiKey,
    );
  }

  const seed = stableHash(prompt);
  logger.log(`[factory] callOpenAI seed=${seed}`);

  let response: Response;
  try {
    response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL_VERSION,
        temperature: 0,
        seed,
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
  } catch (err) {
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("abort"));
    if (isAbort) {
      throw new DyadError(
        "OpenAI request timed out or was aborted.",
        DyadErrorKind.OpenAiTimeout,
      );
    }
    throw new DyadError(
      `Network error calling OpenAI: ${err instanceof Error ? err.message : String(err)}`,
      DyadErrorKind.External,
    );
  }

  if (response.status === 429) {
    const text = await response.text().catch(() => "");
    throw new DyadError(
      `OpenAI rate limit exceeded (429): ${text.slice(0, 200)}`,
      DyadErrorKind.OpenAiRateLimit,
    );
  }

  if (response.status === 503) {
    const text = await response.text().catch(() => "");
    throw new DyadError(
      `OpenAI service unavailable (503): ${text.slice(0, 200)}`,
      DyadErrorKind.OpenAiRateLimit,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new DyadError(
      `OpenAI error ${response.status}: ${text.slice(0, 200)}`,
      DyadErrorKind.External,
    );
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new DyadError(
      "OpenAI returned an empty response.",
      DyadErrorKind.InvalidLlmResponse,
    );
  }
  return content;
}

// =============================================================================
// Retry wrapper (E5) — retries on 429, 503, and network timeouts
// Delays: 1s → 3s → 9s (exponential). Does NOT retry on 400/401/invalid JSON.
// =============================================================================

async function callWithRetry(prompt: string): Promise<string> {
  const MAX_RETRIES = 3;
  const DELAYS_MS = [1000, 3000, 9000];
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callOpenAI(prompt);
    } catch (err) {
      lastErr = err;
      const retryable =
        err instanceof DyadError &&
        (err.kind === DyadErrorKind.OpenAiRateLimit ||
          err.kind === DyadErrorKind.OpenAiTimeout);
      if (!retryable || attempt === MAX_RETRIES) throw err;
      logger.warn(
        `[factory] OpenAI attempt ${attempt}/${MAX_RETRIES} failed (${err instanceof DyadError ? err.kind : "unknown"}). Retrying in ${DELAYS_MS[attempt - 1]}ms…`,
      );
      await new Promise<void>((resolve) =>
        setTimeout(resolve, DELAYS_MS[attempt - 1]),
      );
    }
  }
  throw lastErr;
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

// Prompt hash — computed once after all prompt templates are defined (E4)
const CURRENT_PROMPT_HASH = String(
  stableHash(EVALUATE_PROMPT("") + GENERATE_PROMPT(undefined, "premium")),
);

// Enrich an idea result with prompt version metadata (E4)
function enrichResult<T extends IdeaEvaluationResult>(result: T): T {
  return {
    ...result,
    promptVersion: PROMPT_VERSION,
    promptHash: CURRENT_PROMPT_HASH,
  };
}

// Compute fingerprint for deduplication (E1)
function computeFingerprint(idea: IdeaEvaluationResult): string {
  return String(
    stableHash(
      idea.name.toLowerCase().trim() +
        "||" +
        idea.buyer.toLowerCase().trim().slice(0, 80) +
        "||" +
        idea.idea.toLowerCase().trim().slice(0, 200),
    ),
  );
}

// =============================================================================
// Handler registration
// =============================================================================

// PR #1 — Re-throw classified errors that the renderer must surface to the user
// (missing API key, rate limits, validation, conflict). Other transient OpenAI
// failures continue to fall back to the deterministic scorer for resilience.
function isUserVisibleFactoryError(err: unknown): boolean {
  if (!(err instanceof DyadError)) return false;
  return (
    err.kind === DyadErrorKind.MissingApiKey ||
    err.kind === DyadErrorKind.OpenAiRateLimit ||
    err.kind === DyadErrorKind.Validation ||
    err.kind === DyadErrorKind.Conflict
  );
}

export function registerFactoryHandlers() {
  createTypedHandler(factoryContracts.evaluateIdea, async (_, { idea }) => {
    try {
      const raw = await callWithRetry(EVALUATE_PROMPT(idea));
      return enrichResult(validateIdeaResult(raw, idea));
    } catch (err) {
      if (isUserVisibleFactoryError(err)) throw err;
      logger.warn("OpenAI unavailable, using fallback scoring:", err);
      return enrichResult(deterministicFallback(idea));
    }
  });

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
        return templates.map((t) => deterministicFallback(t));
      };

      try {
        const raw = await callWithRetry(GENERATE_PROMPT(niche, mode));
        const parsed = JSON.parse(raw) as unknown[];

        if (!Array.isArray(parsed)) throw new Error("Expected array");

        const ideas: IdeaEvaluationResult[] = parsed
          .slice(0, 10)
          .map((item) => {
            const obj = item as Record<string, unknown>;
            const idea = String(obj.idea ?? "");
            return enrichResult(validateIdeaResult(JSON.stringify(obj), idea));
          });

        // Stable sort: totalScore DESC, then title ASC
        ideas.sort((a, b) =>
          b.totalScore !== a.totalScore
            ? b.totalScore - a.totalScore
            : a.name.localeCompare(b.name),
        );

        return { ideas };
      } catch (err) {
        if (isUserVisibleFactoryError(err)) throw err;
        logger.warn("OpenAI unavailable, using fallback ideas:", err);
        const ideas = fallbackIdeas().sort((a, b) =>
          b.totalScore !== a.totalScore
            ? b.totalScore - a.totalScore
            : a.name.localeCompare(b.name),
        );
        return { ideas };
      }
    },
  );

  // ===========================================================================
  // Generate Portfolio — Dual Engine + Novelty + Pattern Engine
  // PR #1 — Hard-coded UAE/Salary-Reveal fallback portfolio removed.
  // Failures now propagate to the renderer instead of silently shipping a
  // misleading fixed-content portfolio that confused users into thinking
  // the AI had produced regional advice.
  // ===========================================================================

  createTypedHandler(
    factoryContracts.generatePortfolio,
    async (_, { niche, patterns }) => {
      const patternContext = buildPatternContext(patterns ?? []);
      const raw = await callWithRetry(
        GENERATE_PORTFOLIO_PROMPT(niche, patternContext),
      );
      return parsePortfolioResponse(raw);
    },
  );

  // ===========================================================================
  // Persistence handlers (SQLite)
  // ===========================================================================

  createTypedHandler(factoryContracts.saveRun, async (_, { idea }) => {
    // PR #3 — Quality gate: refuse to persist DECIDED items below the
    // configured score threshold. Default is 20/40 (set in settings.ts).
    const settings = readSettings();
    const threshold = settings.factoryScoreThreshold ?? 20;
    if (idea.totalScore < threshold) {
      throw new DyadError(
        `Idea "${idea.name}" scored ${idea.totalScore}/40 which is below the quality-gate threshold of ${threshold}. Increase the score or lower the threshold in Settings → Factory.`,
        DyadErrorKind.QualityGateRejection,
      );
    }

    // E1 — Deduplication: compute fingerprint, check for collision
    const fp = computeFingerprint(idea);
    try {
      const existing = await db
        .select()
        .from(factoryRuns)
        .where(eq(factoryRuns.fingerprint, fp))
        .limit(1);
      if (existing.length > 0) {
        // PR #1 — Slug/fingerprint collision guard. Previously we silently fell
        // through to insert when the existing JSON was unparseable, which
        // overwrote (or duplicated) the running row. We now fail fast: the
        // caller decides whether to overwrite by deleting the existing row.
        let dup: IdeaEvaluationResult;
        try {
          dup = JSON.parse(existing[0].ideaJson) as IdeaEvaluationResult;
        } catch (parseErr) {
          throw new DyadError(
            `Fingerprint collision with run #${existing[0].id} but its stored JSON is corrupt: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
            DyadErrorKind.Conflict,
          );
        }
        return {
          id: existing[0].id,
          duplicate: {
            ...dup,
            runId: existing[0].id,
            runStatus: (existing[0].status as RunStatus) ?? "DECIDED",
          },
        };
      }

      // E4 — prompt version/hash stored in ideaJson.
      // PR #1 — also persist the pinned model snapshot so we can later
      // diff how scoring drifted across model upgrades.
      // PR #3 — also persist regulatedDomain; detect if not already present.
      const enriched: IdeaEvaluationResult = {
        ...idea,
        promptVersion: idea.promptVersion ?? PROMPT_VERSION,
        promptHash: idea.promptHash ?? CURRENT_PROMPT_HASH,
        modelVersion: idea.modelVersion ?? OPENAI_MODEL_VERSION,
        regulatedDomain:
          idea.regulatedDomain ?? detectRegulatedDomain(idea.idea),
      };
      const result = await db
        .insert(factoryRuns)
        .values({
          ideaJson: JSON.stringify(enriched),
          status: "DECIDED",
          fingerprint: fp,
          promptVersion: enriched.promptVersion,
          promptHash: enriched.promptHash,
          modelVersion: enriched.modelVersion,
        })
        .returning({ id: factoryRuns.id });
      return { id: result[0].id, duplicate: null };
    } catch (err) {
      if (err instanceof DyadError) throw err;
      throw new DyadError(
        `Failed to save factory run: ${err instanceof Error ? err.message : String(err)}`,
        DyadErrorKind.FactoryPersistenceFailure,
      );
    }
  });

  createTypedHandler(factoryContracts.listRuns, async (_, { limit }) => {
    try {
      const rows = await db
        .select()
        .from(factoryRuns)
        .orderBy(desc(factoryRuns.createdAt))
        .limit(limit ?? 200);
      const runs: IdeaEvaluationResult[] = [];
      for (const row of rows) {
        try {
          const idea = JSON.parse(row.ideaJson) as IdeaEvaluationResult;
          // Inject DB metadata: runId, runStatus, evaluatedAt
          runs.push({
            ...idea,
            runId: row.id,
            runStatus: (row.status as RunStatus) ?? "DECIDED",
            evaluatedAt:
              row.createdAt instanceof Date
                ? row.createdAt.getTime()
                : (row.createdAt as number) * 1000,
          });
        } catch (parseErr) {
          // PR #1 — Stop silently dropping unparseable rows. Report each
          // parse failure as a classified DyadError so PostHog sees real
          // corruption events instead of an empty list. We continue past
          // the bad row so one corrupt entry can't break the whole UI.
          const wrapped = new DyadError(
            `factory_runs row #${row.id} has corrupt ideaJson and was skipped: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
            DyadErrorKind.FactoryPersistenceFailure,
          );
          logger.warn(wrapped.message);
          sendTelemetryException(wrapped, {
            ipc_channel: "factory:list-runs",
            run_id: row.id,
          });
        }
      }
      return { runs };
    } catch (err) {
      throw new DyadError(
        `Failed to list factory runs: ${err instanceof Error ? err.message : String(err)}`,
        DyadErrorKind.FactoryPersistenceFailure,
      );
    }
  });

  createTypedHandler(factoryContracts.deleteRun, async (_, { id }) => {
    try {
      await db.delete(factoryRuns).where(eq(factoryRuns.id, id));
      return { success: true };
    } catch (err) {
      throw new DyadError(
        `Failed to delete factory run ${id}: ${err instanceof Error ? err.message : String(err)}`,
        DyadErrorKind.FactoryPersistenceFailure,
      );
    }
  });

  createTypedHandler(factoryContracts.clearRuns, async () => {
    try {
      const rows = await db.select({ id: factoryRuns.id }).from(factoryRuns);
      await db.delete(factoryRuns);
      return { count: rows.length };
    } catch (err) {
      throw new DyadError(
        `Failed to clear factory runs: ${err instanceof Error ? err.message : String(err)}`,
        DyadErrorKind.FactoryPersistenceFailure,
      );
    }
  });

  // ===========================================================================
  // E2 — Build Queue Status
  // ===========================================================================

  createTypedHandler(
    factoryContracts.updateRunStatus,
    async (_, { id, status }) => {
      try {
        await db
          .update(factoryRuns)
          .set({ status })
          .where(eq(factoryRuns.id, id));
        return { success: true };
      } catch (err) {
        throw new DyadError(
          `Failed to update run status: ${err instanceof Error ? err.message : String(err)}`,
          DyadErrorKind.FactoryPersistenceFailure,
        );
      }
    },
  );

  // ===========================================================================
  // E6 — Export Pipeline (save to file via Electron dialog)
  // ===========================================================================

  createTypedHandler(factoryContracts.exportRuns, async (event, { filter }) => {
    try {
      const rows = await db
        .select()
        .from(factoryRuns)
        .orderBy(desc(factoryRuns.createdAt));
      const ideas = rows
        .map((row) => {
          try {
            return JSON.parse(row.ideaJson) as IdeaEvaluationResult;
          } catch {
            return null;
          }
        })
        .filter((r): r is IdeaEvaluationResult => r !== null);

      const toExport =
        filter === "BUILD"
          ? ideas.filter((i) => i.decision === "BUILD")
          : ideas;

      const win = BrowserWindow.fromWebContents(event.sender);
      const dlg = await dialog.showSaveDialog(win ?? undefined!, {
        title: "Export Factory Runs",
        defaultPath: `factory-export-${filter ?? "all"}-${Date.now()}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });

      if (dlg.canceled || !dlg.filePath) {
        return { success: false };
      }

      await writeFile(dlg.filePath, JSON.stringify(toExport, null, 2), "utf-8");
      return { success: true, path: dlg.filePath };
    } catch (err) {
      throw new DyadError(
        `Failed to export runs: ${err instanceof Error ? err.message : String(err)}`,
        DyadErrorKind.FactoryPersistenceFailure,
      );
    }
  });

  // ===========================================================================
  // E3 — Pattern Learning: update launch outcome
  // ===========================================================================

  createTypedHandler(
    factoryContracts.updateLaunchOutcome,
    async (_, { id, outcome }) => {
      try {
        // Update both the ideaJson blob and the launch_outcome column
        const rows = await db
          .select()
          .from(factoryRuns)
          .where(eq(factoryRuns.id, id))
          .limit(1);
        if (rows.length === 0) return { success: false };
        const idea = JSON.parse(rows[0].ideaJson) as IdeaEvaluationResult;
        const updated = { ...idea, launchOutcome: outcome };
        await db
          .update(factoryRuns)
          .set({
            ideaJson: JSON.stringify(updated),
            launchOutcome: JSON.stringify(outcome),
          })
          .where(eq(factoryRuns.id, id));
        return { success: true };
      } catch (err) {
        throw new DyadError(
          `Failed to update launch outcome: ${err instanceof Error ? err.message : String(err)}`,
          DyadErrorKind.FactoryPersistenceFailure,
        );
      }
    },
  );

  // PR #1 — System status: lets the renderer show a banner when the
  // OpenAI key is missing instead of every Factory call failing in isolation.
  // Reads `process.env.OPENAI_API_KEY` which is populated by `dotenv.config()`
  // at startup (see src/main.ts).
  createTypedHandler(factoryContracts.getSystemStatus, async () => {
    const key = process.env.OPENAI_API_KEY;
    return {
      openaiKeyPresent: typeof key === "string" && key.trim().length > 0,
      modelVersion: OPENAI_MODEL_VERSION,
    };
  });
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

const GENERATE_PORTFOLIO_PROMPT = (
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

function parsePortfolioIdea(
  obj: Record<string, unknown>,
  engineType: "revenue" | "viral" | "experimental",
): IdeaEvaluationResult {
  const idea = String(obj.idea ?? "");
  const result = validateIdeaResult(JSON.stringify(obj), idea);
  result.engineType = engineType;
  return result;
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
