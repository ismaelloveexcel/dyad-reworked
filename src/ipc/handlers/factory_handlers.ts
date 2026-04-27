import { createTypedHandler } from "./base";
import {
  factoryContracts,
  LaunchKitSchema,
  type IdeaEvaluationResult,
  type RunStatus,
  type LaunchOutcome,
  type QuantitativeLaunchOutcome,
} from "../types/factory";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { db } from "@/db";
import { factoryRuns, launchOutcomes } from "@/db/schema";
import { desc, eq, isNotNull } from "drizzle-orm";
import log from "electron-log";
import { app, dialog, BrowserWindow } from "electron";
import { writeFile, readFile, stat, rm, mkdir } from "fs/promises";
import path from "node:path";
import { sendTelemetryException } from "@/ipc/utils/telemetry";
import { copyDirectoryRecursive } from "@/ipc/utils/file_utils";
import { runCommand } from "@/ipc/utils/socket_firewall";
import {
  stableHash,
  validateIdeaResult,
  deterministicFallback,
  detectRegulatedDomain,
} from "./factory_validator";
import { buildBrandCss } from "./factory_brand";
import {
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
} from "@/core/factory/embeddings";
import { fetchEmbedding } from "./factory_embeddings";
import { readSettings, writeSettings } from "@/main/settings";
import {
  PROMPT_VERSION,
  CURRENT_PROMPT_HASH,
  EVALUATE_PROMPT,
  GENERATE_PROMPT,
  GENERATE_PORTFOLIO_PROMPT,
  buildPatternContext,
  parsePortfolioResponse,
  enrichResult,
  computeFingerprint,
  factorySlugFromName,
} from "@/core/factory/main";
import { registerFactoryDeployHandlers } from "./factory_deploy";
import {
  buildOutcomeContext,
  type SimilarRunOutcomeData,
} from "@/core/factory/outcome_scoring";

const logger = log.scope("factory_handlers");

// =============================================================================
// Pinned model snapshots (PR #1 / PR #8) — pinning dated snapshots makes runs
// reproducible across model upgrades. Bump deliberately when re-baselining.
// =============================================================================

export const OPENAI_MODEL_VERSION = "gpt-4o-mini-2024-07-18";
export const ANTHROPIC_MODEL_VERSION = "claude-haiku-4-5-20251014";
export const GOOGLE_MODEL_VERSION = "gemini-2.0-flash-001";

/** PR #8 — Return the pinned model snapshot for the active factory provider. */
export function getFactoryModelVersion(
  provider: "openai" | "anthropic" | "google",
): string {
  if (provider === "anthropic") return ANTHROPIC_MODEL_VERSION;
  if (provider === "google") return GOOGLE_MODEL_VERSION;
  return OPENAI_MODEL_VERSION;
}

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
// PR #8 — Anthropic helpers
// =============================================================================

// Allow tests to redirect Anthropic calls to a custom endpoint.
// Normalize by stripping any trailing "/v1" (or "/v1/") before appending our
// own path, so both `http://host` and `http://host/v1` work correctly.
const ANTHROPIC_MESSAGES_URL = (() => {
  const base = process.env.ANTHROPIC_BASE_URL;
  if (!base) return "https://api.anthropic.com/v1/messages";
  const normalized = base.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  return `${normalized}/v1/messages`;
})();

async function callAnthropic(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new DyadError(
      "ANTHROPIC_API_KEY is not set. Add it to your environment.",
      DyadErrorKind.MissingApiKey,
    );
  }

  logger.log(`[factory] callAnthropic model=${ANTHROPIC_MODEL_VERSION}`);

  let response: Response;
  try {
    response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL_VERSION,
        max_tokens: 2000,
        system:
          "You are an expert app idea evaluator. Respond ONLY with valid JSON — no markdown, no code fences, no commentary.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (err) {
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("abort"));
    if (isAbort) {
      throw new DyadError(
        "Anthropic request timed out or was aborted.",
        DyadErrorKind.AnthropicTimeout,
      );
    }
    throw new DyadError(
      `Network error calling Anthropic: ${err instanceof Error ? err.message : String(err)}`,
      DyadErrorKind.External,
    );
  }

  if (response.status === 429) {
    const text = await response.text().catch(() => "");
    throw new DyadError(
      `Anthropic rate limit exceeded (429): ${text.slice(0, 200)}`,
      DyadErrorKind.AnthropicRateLimit,
    );
  }

  if (response.status === 503) {
    const text = await response.text().catch(() => "");
    throw new DyadError(
      `Anthropic service unavailable (503): ${text.slice(0, 200)}`,
      DyadErrorKind.AnthropicRateLimit,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new DyadError(
      `Anthropic error ${response.status}: ${text.slice(0, 200)}`,
      DyadErrorKind.External,
    );
  }

  const data = (await response.json()) as {
    content: { type: string; text: string }[];
  };
  const content = data.content?.find((c) => c.type === "text")?.text;
  if (!content) {
    throw new DyadError(
      "Anthropic returned an empty response.",
      DyadErrorKind.InvalidLlmResponse,
    );
  }
  return content;
}

// =============================================================================
// PR #8 — Google AI helpers
// =============================================================================

// Allow tests to redirect Google calls to a custom endpoint.
const GOOGLE_BASE_URL = (() => {
  const base = process.env.GOOGLE_BASE_URL;
  return base
    ? base.replace(/\/$/, "")
    : "https://generativelanguage.googleapis.com";
})();

async function callGoogle(prompt: string): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new DyadError(
      "GOOGLE_API_KEY is not set. Add it to your environment.",
      DyadErrorKind.MissingApiKey,
    );
  }

  const url = `${GOOGLE_BASE_URL}/v1beta/models/${GOOGLE_MODEL_VERSION}:generateContent`;
  logger.log(`[factory] callGoogle model=${GOOGLE_MODEL_VERSION}`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: "You are an expert app idea evaluator. Respond ONLY with valid JSON — no markdown, no code fences, no commentary.",
            },
          ],
        },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 2000 },
      }),
    });
  } catch (err) {
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("abort"));
    if (isAbort) {
      throw new DyadError(
        "Google AI request timed out or was aborted.",
        DyadErrorKind.GoogleTimeout,
      );
    }
    throw new DyadError(
      `Network error calling Google AI: ${err instanceof Error ? err.message : String(err)}`,
      DyadErrorKind.External,
    );
  }

  if (response.status === 429) {
    const text = await response.text().catch(() => "");
    throw new DyadError(
      `Google AI rate limit exceeded (429): ${text.slice(0, 200)}`,
      DyadErrorKind.GoogleRateLimit,
    );
  }

  if (response.status === 503) {
    const text = await response.text().catch(() => "");
    throw new DyadError(
      `Google AI service unavailable (503): ${text.slice(0, 200)}`,
      DyadErrorKind.GoogleRateLimit,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new DyadError(
      `Google AI error ${response.status}: ${text.slice(0, 200)}`,
      DyadErrorKind.External,
    );
  }

  const data = (await response.json()) as {
    candidates: { content: { parts: { text: string }[] } }[];
  };
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) {
    throw new DyadError(
      "Google AI returned an empty response.",
      DyadErrorKind.InvalidLlmResponse,
    );
  }
  return content;
}

// =============================================================================
// PR #8 — Provider router
// Dispatches a prompt to the configured factory provider.
// =============================================================================

function callProvider(
  provider: "openai" | "anthropic" | "google",
  prompt: string,
): Promise<string> {
  if (provider === "anthropic") return callAnthropic(prompt);
  if (provider === "google") return callGoogle(prompt);
  return callOpenAI(prompt);
}

/** Returns true for rate-limit or timeout errors that are retryable. */
function isRetryableError(err: unknown): boolean {
  if (!(err instanceof DyadError)) return false;
  return (
    err.kind === DyadErrorKind.OpenAiRateLimit ||
    err.kind === DyadErrorKind.OpenAiTimeout ||
    err.kind === DyadErrorKind.AnthropicRateLimit ||
    err.kind === DyadErrorKind.AnthropicTimeout ||
    err.kind === DyadErrorKind.GoogleRateLimit ||
    err.kind === DyadErrorKind.GoogleTimeout
  );
}

// =============================================================================
// Retry wrapper (E5) — retries on 429, 503, and network timeouts
// Delays: 1s → 3s → 9s (exponential). Does NOT retry on 400/401/invalid JSON.
// PR #8 — provider is read from settings once before the retry loop and reused
// across all attempts to keep a single run consistent.
// =============================================================================

async function callWithRetry(prompt: string): Promise<string> {
  const MAX_RETRIES = 3;
  const DELAYS_MS = [1000, 3000, 9000];
  let lastErr: unknown;
  const provider =
    (readSettings().factoryProvider as "openai" | "anthropic" | "google") ??
    "openai";
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callProvider(provider, prompt);
    } catch (err) {
      lastErr = err;
      const retryable = isRetryableError(err);
      if (!retryable || attempt === MAX_RETRIES) throw err;
      logger.warn(
        `[factory] ${provider} attempt ${attempt}/${MAX_RETRIES} failed (${err instanceof DyadError ? err.kind : "unknown"}). Retrying in ${DELAYS_MS[attempt - 1]}ms…`,
      );
      await new Promise<void>((resolve) =>
        setTimeout(resolve, DELAYS_MS[attempt - 1]),
      );
    }
  }
  throw lastErr;
}

// =============================================================================
// PR #10 — Launch-kit prompt
// =============================================================================

/** Build the prompt for generating a launch kit from an evaluated idea. */
// Max chars of buildPrompt included in the launch-kit prompt. 400 is enough
// context for marketing copy; keeping it short avoids inflating token cost.
const LAUNCH_KIT_BUILD_PROMPT_MAX = 400;

export function LAUNCH_KIT_PROMPT(idea: IdeaEvaluationResult): string {
  return `You are a world-class startup marketer. Given the app idea below, produce launch copywriting and a deployment guide.

App name: ${idea.name}
Buyer: ${idea.buyer}
Idea: ${idea.idea}
Monetisation angle: ${idea.monetisationAngle ?? ""}
Viral trigger: ${idea.viralTrigger ?? ""}
Build prompt: ${(idea.buildPrompt ?? "").slice(0, LAUNCH_KIT_BUILD_PROMPT_MAX)}

Respond ONLY with valid JSON — no markdown, no code fences, no commentary — matching this exact schema:
{
  "elevatorPitch":   "<≤20-word one-sentence verbal pitch>",
  "twitterPost":     "<≤280-char X post with hook and 1-2 hashtags>",
  "linkedinPost":    "<2-3 paragraph LinkedIn announcement>",
  "heroHeadline":    "<≤10-word landing-page H1>",
  "heroSubtext":     "<1-2 sentence sub-headline below the H1>",
  "emailSubject":    "<≤60-char cold-email subject line>",
  "emailBody":       "<5-sentence cold-email body — leave [Name] / [Company] placeholders>",
  "deployChecklist": ["step 1", "step 2", "…"]
}

The deployChecklist should guide a non-technical founder through deploying the scaffolded Vite + React app. Cover: pushing code to GitHub, connecting to Vercel (or Netlify), setting any required environment variables, running the first production build, and verifying the live URL.`;
}

// =============================================================================
// Handler registration
// =============================================================================

// PR #1 — Re-throw classified errors that the renderer must surface to the user
// (missing API key, rate limits, validation, conflict). Other transient provider
// failures continue to fall back to the deterministic scorer for resilience.
// PR #8 — Extended to cover Anthropic and Google rate-limit kinds.
function isUserVisibleFactoryError(err: unknown): boolean {
  if (!(err instanceof DyadError)) return false;
  return (
    err.kind === DyadErrorKind.MissingApiKey ||
    err.kind === DyadErrorKind.OpenAiRateLimit ||
    err.kind === DyadErrorKind.AnthropicRateLimit ||
    err.kind === DyadErrorKind.GoogleRateLimit ||
    err.kind === DyadErrorKind.Validation ||
    err.kind === DyadErrorKind.Conflict
  );
}

// PR #14 / PR #5 — Map a raw launch_outcomes DB row to the typed
// QuantitativeLaunchOutcome shape. Used by both listOutcomes and the
// outcome-weighted scoring path so null-handling and capturedAt
// normalisation stay consistent across the codebase.
function mapLaunchOutcomeRow(r: {
  id: number;
  runId: number;
  revenueUsd: number | null | undefined;
  conversions: number | null | undefined;
  views: number | null | undefined;
  churn30d: number | null | undefined;
  source: string | null | undefined;
  capturedAt: Date | number;
}): QuantitativeLaunchOutcome {
  return {
    id: r.id,
    runId: r.runId,
    revenueUsd: r.revenueUsd ?? null,
    conversions: r.conversions ?? null,
    views: r.views ?? null,
    churn30d: r.churn30d ?? null,
    source: r.source ?? null,
    capturedAt:
      r.capturedAt instanceof Date
        ? Math.floor(r.capturedAt.getTime() / 1000)
        : (r.capturedAt as number),
  };
}

export function registerFactoryHandlers() {
  createTypedHandler(factoryContracts.evaluateIdea, async (_, { idea }) => {
    // PR #14 — Outcome-weighted scoring: when the feature flag is enabled and
    // OPENAI_API_KEY is present, fetch similar past runs, load their outcome
    // data, and inject a context block into the LLM scoring prompt.
    const settings = readSettings();
    const outcomeWeightingEnabled =
      settings.factoryOutcomeWeightedScoring === true;
    let outcomeContext = "";
    let outcomeWeightedUsed = false;

    if (outcomeWeightingEnabled) {
      try {
        const ideaText = idea.trim();
        const queryVec = await fetchEmbedding(ideaText);

        // Load all rows with embeddings — same scan pattern as saveRun / getSimilarRuns
        const storedRows = await db
          .select({
            id: factoryRuns.id,
            ideaJson: factoryRuns.ideaJson,
            embedding: factoryRuns.embedding,
          })
          .from(factoryRuns)
          .where(isNotNull(factoryRuns.embedding));

        // Top-5 most similar past runs. Skip near-identical matches (sim >= 0.9999)
        // to avoid circular reasoning if the exact same idea was previously saved.
        const OUTCOME_SIMILAR_LIMIT = 5;
        const SELF_MATCH_THRESHOLD = 0.9999;
        type ScoredRow = { id: number; ideaJson: string; similarity: number };
        const topK: ScoredRow[] = [];
        let minSim = -Infinity;

        for (const row of storedRows) {
          const vec = deserializeEmbedding(row.embedding!);
          if (vec.length === 0) continue;
          const sim = cosineSimilarity(queryVec, vec);
          if (sim >= SELF_MATCH_THRESHOLD) continue; // skip exact / near-identical matches
          if (topK.length < OUTCOME_SIMILAR_LIMIT || sim > minSim) {
            topK.push({ id: row.id, ideaJson: row.ideaJson, similarity: sim });
            topK.sort((a, b) => b.similarity - a.similarity);
            if (topK.length > OUTCOME_SIMILAR_LIMIT) topK.pop();
            minSim =
              topK.length > 0 ? topK[topK.length - 1].similarity : -Infinity;
          }
        }

        if (topK.length > 0) {
          // Load outcomes for each top-K run in parallel
          const outcomeRows = await Promise.all(
            topK.map(async (row) => {
              const outcomes = await db
                .select()
                .from(launchOutcomes)
                .where(eq(launchOutcomes.runId, row.id))
                .orderBy(desc(launchOutcomes.capturedAt));

              let name = "Unknown";
              try {
                const parsed = JSON.parse(row.ideaJson) as { name?: string };
                if (parsed.name) name = parsed.name;
              } catch {
                // ignore parse errors
              }

              const outcomesTyped = outcomes.map(mapLaunchOutcomeRow);

              return {
                runId: row.id,
                similarity: row.similarity,
                name,
                outcomes: outcomesTyped,
              } satisfies SimilarRunOutcomeData;
            }),
          );

          outcomeContext = buildOutcomeContext(outcomeRows);
          if (outcomeContext) {
            outcomeWeightedUsed = true;
          }
        }
      } catch (outcomeErr) {
        // Outcome-weighted scoring is non-fatal — fall through to standard prompt
        // MissingApiKey is an expected state when OPENAI_API_KEY is absent
        if (
          !(
            outcomeErr instanceof DyadError &&
            outcomeErr.kind === DyadErrorKind.MissingApiKey
          )
        ) {
          logger.warn(
            "[factory] outcome-weighted scoring fetch failed, falling back to standard prompt:",
            outcomeErr,
          );
        }
      }
    }

    try {
      const raw = await callWithRetry(EVALUATE_PROMPT(idea, outcomeContext));
      const result = enrichResult(validateIdeaResult(raw, idea));
      return outcomeWeightedUsed
        ? { ...result, outcomeWeightedUsed: true }
        : result;
    } catch (err) {
      if (isUserVisibleFactoryError(err)) throw err;
      logger.warn("LLM provider unavailable, using fallback scoring:", err);
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
        logger.warn("LLM provider unavailable, using fallback ideas:", err);
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
        `Idea "${idea.name}" scored ${idea.totalScore}/40 which is strictly below the quality-gate threshold of ${threshold}. Increase the score or lower the threshold in Settings → Workflow.`,
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
      // PR #8 — modelVersion now reflects the active provider's pinned snapshot.
      // Reuse the `settings` object already read above (quality-gate check).
      const activeProvider =
        (settings.factoryProvider as
          | "openai"
          | "anthropic"
          | "google"
          | undefined) ?? "openai";

      // PR #9 — Embedding-based novelty / dedup
      // When factoryEmbeddingDedup is enabled (default: true), fetch an
      // embedding vector for this idea and:
      //   1. Compute noveltyScore = 1 - max cosine similarity vs stored rows
      //   2. Check if any stored embedding has similarity ≥ threshold → soft dup
      //   3. Persist the embedding in the DB column for future comparisons
      const embeddingEnabled = settings.factoryEmbeddingDedup !== false;
      const similarityThreshold =
        settings.factoryEmbeddingSimilarityThreshold ?? 0.92;

      let embeddingVec: number[] | null = null;
      let noveltyScore: number | undefined;

      if (embeddingEnabled) {
        try {
          const ideaText = `${idea.name} — ${idea.buyer} — ${idea.idea}`;
          embeddingVec = await fetchEmbedding(ideaText);

          // Load only rows that already have an embedding (skip empty columns).
          const storedRows = await db
            .select({
              id: factoryRuns.id,
              embedding: factoryRuns.embedding,
              ideaJson: factoryRuns.ideaJson,
              status: factoryRuns.status,
            })
            .from(factoryRuns)
            .where(isNotNull(factoryRuns.embedding));

          let maxSimilarity = 0;
          let semanticDuplicate: {
            id: number;
            idea: IdeaEvaluationResult;
            similarity: number;
            // DB status column — authoritative for runStatus
            dbStatus: string | null;
          } | null = null;

          for (const row of storedRows) {
            // embedding is guaranteed non-null by SQL filter, but be defensive
            const vec = deserializeEmbedding(row.embedding!);
            if (vec.length === 0) continue;

            const sim = cosineSimilarity(embeddingVec, vec);
            // Track the global maximum similarity to compute noveltyScore
            if (sim > maxSimilarity) maxSimilarity = sim;
            if (
              sim >= similarityThreshold &&
              (semanticDuplicate === null || sim > semanticDuplicate.similarity)
            ) {
              try {
                const parsedIdea = JSON.parse(
                  row.ideaJson,
                ) as IdeaEvaluationResult;
                semanticDuplicate = {
                  id: row.id,
                  idea: parsedIdea,
                  similarity: sim,
                  dbStatus: row.status,
                };
              } catch {
                // ignore corrupt rows
              }
            }
          }

          // noveltyScore = 1 - max cosine similarity (no second pass needed)
          noveltyScore = Math.max(0, 1 - maxSimilarity);

          if (semanticDuplicate !== null) {
            // Soft duplicate found via semantic similarity — return without inserting
            logger.log(
              `[factory] semantic dedup: similarity=${semanticDuplicate.similarity.toFixed(3)} with run #${semanticDuplicate.id}`,
            );
            return {
              id: semanticDuplicate.id,
              duplicate: {
                ...semanticDuplicate.idea,
                runId: semanticDuplicate.id,
                // Use the DB status column — ideaJson may not contain runStatus
                runStatus:
                  (semanticDuplicate.dbStatus as RunStatus) ?? "DECIDED",
              },
            };
          }
        } catch (embErr) {
          // Embedding failures are non-fatal — fall through without novelty score
          // or semantic dedup so ideas can still be saved.
          // MissingApiKey is an expected configuration state when the user hasn't
          // set OPENAI_API_KEY; suppress the warning to avoid log noise.
          if (
            embErr instanceof DyadError &&
            embErr.kind === DyadErrorKind.MissingApiKey
          ) {
            // silently skip embedding — user opted out of OpenAI
          } else {
            logger.warn(
              "[factory] embedding fetch failed, skipping novelty/dedup:",
              embErr,
            );
          }
        }
      }

      const enriched: IdeaEvaluationResult = {
        ...idea,
        promptVersion: idea.promptVersion ?? PROMPT_VERSION,
        promptHash: idea.promptHash ?? CURRENT_PROMPT_HASH,
        modelVersion:
          idea.modelVersion ?? getFactoryModelVersion(activeProvider),
        regulatedDomain:
          idea.regulatedDomain ?? detectRegulatedDomain(idea.idea),
        ...(noveltyScore !== undefined ? { noveltyScore } : {}),
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
          embedding:
            embeddingVec !== null ? serializeEmbedding(embeddingVec) : null,
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
  // active provider's key is missing instead of every Factory call failing.
  // PR #8 — Extended to include the active provider and whether its key is set.
  createTypedHandler(factoryContracts.getSystemStatus, async () => {
    const provider =
      (readSettings().factoryProvider as
        | "openai"
        | "anthropic"
        | "google"
        | undefined) ?? "openai";

    const ENV_KEY_MAP: Record<"openai" | "anthropic" | "google", string> = {
      openai: process.env.OPENAI_API_KEY ?? "",
      anthropic: process.env.ANTHROPIC_API_KEY ?? "",
      google: process.env.GOOGLE_API_KEY ?? "",
    };

    const providerKey = ENV_KEY_MAP[provider];
    const providerKeyPresent =
      typeof providerKey === "string" && providerKey.trim().length > 0;

    // Retain openaiKeyPresent for backwards compat with existing renderer code.
    const openaiKey = process.env.OPENAI_API_KEY ?? "";
    return {
      openaiKeyPresent:
        typeof openaiKey === "string" && openaiKey.trim().length > 0,
      modelVersion: getFactoryModelVersion(provider),
      provider,
      providerKeyPresent,
    };
  });

  // ===========================================================================
  // PR #5 — outcomes:list — read quantitative outcomes for a run.
  // Falls back to mapping the legacy boolean launchOutcome blob when the new
  // table has no rows yet (backwards-compat).
  // ===========================================================================

  createTypedHandler(factoryContracts.listOutcomes, async (_, { runId }) => {
    try {
      const rows = await db
        .select()
        .from(launchOutcomes)
        .where(eq(launchOutcomes.runId, runId))
        .orderBy(desc(launchOutcomes.capturedAt));

      if (rows.length > 0) {
        const outcomes: QuantitativeLaunchOutcome[] =
          rows.map(mapLaunchOutcomeRow);
        return { outcomes };
      }

      // Backwards-compat: map legacy boolean row from factory_runs.launch_outcome
      const runRows = await db
        .select({
          id: factoryRuns.id,
          launchOutcome: factoryRuns.launchOutcome,
          createdAt: factoryRuns.createdAt,
        })
        .from(factoryRuns)
        .where(eq(factoryRuns.id, runId))
        .limit(1);

      if (runRows.length === 0) return { outcomes: [] };

      const raw = runRows[0].launchOutcome;
      if (!raw) return { outcomes: [] };

      const legacy = mapLegacyLaunchOutcome(runId, raw, runRows[0].createdAt);
      return { outcomes: legacy ? [legacy] : [] };
    } catch (err) {
      throw new DyadError(
        `Failed to list outcomes for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
        DyadErrorKind.FactoryPersistenceFailure,
      );
    }
  });

  // ===========================================================================
  // PR #9 — Embedding-based similarity search
  // Returns up to `limit` stored runs sorted by cosine similarity to the
  // given idea text (most similar first). Requires OPENAI_API_KEY (embedding
  // is fetched via text-embedding-3-small).
  // ===========================================================================

  createTypedHandler(
    factoryContracts.getSimilarRuns,
    async (_, { ideaText, limit = 5, excludeRunId }) => {
      try {
        const queryVec = await fetchEmbedding(ideaText);

        // Filter to rows that have an embedding stored — avoids loading rows
        // that can never contribute to similarity results.
        const rows = await db
          .select({
            id: factoryRuns.id,
            ideaJson: factoryRuns.ideaJson,
            status: factoryRuns.status,
            embedding: factoryRuns.embedding,
          })
          .from(factoryRuns)
          .where(isNotNull(factoryRuns.embedding));

        type ScoredRun = IdeaEvaluationResult & { similarity: number };
        // Maintain a top-K list during the scan — O(n × log limit) instead
        // of O(n log n) for the full sort.  Since limit ≤ 20 the sort cost
        // per insertion is negligible even for large libraries.
        const topK: ScoredRun[] = [];
        let minSimilarityInTopK = -Infinity;

        for (const row of rows) {
          if (excludeRunId !== undefined && row.id === excludeRunId) continue;
          // embedding is guaranteed non-null by SQL filter, but be defensive
          const vec = deserializeEmbedding(row.embedding!);
          if (vec.length === 0) continue;
          const similarity = cosineSimilarity(queryVec, vec);

          if (topK.length < limit || similarity > minSimilarityInTopK) {
            try {
              const idea = JSON.parse(row.ideaJson) as IdeaEvaluationResult;
              topK.push({
                ...idea,
                runId: row.id,
                runStatus: (row.status as RunStatus) ?? "DECIDED",
                similarity,
              });
              // Keep sorted DESC and cap at limit
              topK.sort((a, b) => b.similarity - a.similarity);
              if (topK.length > limit) topK.pop();
              minSimilarityInTopK =
                topK.length > 0 ? topK[topK.length - 1].similarity : -Infinity;
            } catch {
              // skip corrupt rows
            }
          }
        }

        return { runs: topK };
      } catch (err) {
        if (err instanceof DyadError) throw err;
        throw new DyadError(
          `Failed to find similar runs: ${err instanceof Error ? err.message : String(err)}`,
          DyadErrorKind.FactoryPersistenceFailure,
        );
      }
    },
  );

  // ===========================================================================
  // PR #6 — Deterministic scaffolder
  // Copies scaffold/ template → userData/factory-apps/<slug>/
  // Runs codemods (app name, tagline), npm install, npm run build.
  // Returns the absolute path to the built dist/ directory and captured logs.
  // Sandbox writes are confined to userData/factory-apps/ — never the user's
  // project or home directory.
  // ===========================================================================

  createTypedHandler(
    factoryContracts.scaffoldApp,
    async (_, { runId, appName, tagline, primaryColor }) => {
      // -----------------------------------------------------------------------
      // Bounded log buffer — cap at 500 lines / 256 KB to avoid memory bloat
      // from verbose npm output.
      // -----------------------------------------------------------------------
      const MAX_SCAFFOLD_LOG_LINES = 500;
      const MAX_SCAFFOLD_LOG_BYTES = 256 * 1024;
      const MAX_SCAFFOLD_LOG_ENTRY_CHARS = 2000;

      const logs: string[] = [];
      let retainedLogBytes = 0;
      const pushLog = (msg: string) => {
        const normalized = msg.trim();
        if (!normalized) return;
        const entry =
          normalized.length > MAX_SCAFFOLD_LOG_ENTRY_CHARS
            ? `${normalized.slice(0, MAX_SCAFFOLD_LOG_ENTRY_CHARS)}… [truncated]`
            : normalized;
        const entryBytes = Buffer.byteLength(entry, "utf8");
        logs.push(entry);
        retainedLogBytes += entryBytes;
        while (
          logs.length > MAX_SCAFFOLD_LOG_LINES ||
          retainedLogBytes > MAX_SCAFFOLD_LOG_BYTES
        ) {
          const removed = logs.shift();
          if (removed !== undefined) {
            retainedLogBytes -= Buffer.byteLength(removed, "utf8");
          }
        }
        logger.log(`[scaffoldApp] ${entry}`);
      };

      // Escape HTML special characters for use in HTML attributes and text content
      const escapeHtml = (str: string): string =>
        str.replace(/[<>&"]/g, (c) =>
          c === "<"
            ? "&lt;"
            : c === ">"
              ? "&gt;"
              : c === "&"
                ? "&amp;"
                : "&quot;",
        );

      // Derive a filesystem-safe slug from the app name
      const slug = factorySlugFromName(appName, runId);

      const sandboxRoot = path.join(app.getPath("userData"), "factory-apps");
      const destDir = path.join(sandboxRoot, slug);

      // Resolve scaffold source — same path createFromTemplate.ts uses
      const scaffoldSrc = path.join(__dirname, "..", "..", "scaffold");
      pushLog(`Scaffold source: ${scaffoldSrc}`);
      pushLog(`Destination: ${destDir}`);

      try {
        // Remove any previous scaffold at this path so re-scaffolding is clean
        try {
          await rm(destDir, { recursive: true, force: true });
        } catch {
          // ignore — directory may not exist yet
        }

        // Copy scaffold template (skip node_modules — copyDirectoryRecursive already does this)
        pushLog("Copying scaffold template…");
        await copyDirectoryRecursive(scaffoldSrc, destDir);
        pushLog("Template copied.");

        // -----------------------------------------------------------------------
        // Codemods — patch app name and tagline into key files
        // -----------------------------------------------------------------------

        // 1. package.json — replace the placeholder package name with the slug
        const pkgJsonPath = path.join(destDir, "package.json");
        const pkgJson = await readFile(pkgJsonPath, "utf-8");
        const updatedPkgJson = pkgJson.replace(
          /"name":\s*"[^"]*"/,
          `"name": "${slug}"`,
        );
        await writeFile(pkgJsonPath, updatedPkgJson, "utf-8");
        pushLog("Patched package.json name.");

        // 2. index.html — replace the default <title>
        const htmlPath = path.join(destDir, "index.html");
        const htmlContent = await readFile(htmlPath, "utf-8");
        const updatedHtml = htmlContent.replace(
          /<title>[^<]*<\/title>/,
          `<title>${escapeHtml(appName)}</title>`,
        );
        await writeFile(htmlPath, updatedHtml, "utf-8");
        pushLog("Patched index.html title.");

        // 3. src/pages/Index.tsx — replace __DYAD_*__ placeholder strings with
        // app-specific content from the stored IdeaEvaluationResult.
        // Use JSON.stringify to produce safe JS string literals so characters
        // like `{`, `}`, `$`, and `\` cannot break JSX parsing or
        // String.replace special sequences.
        const indexTsxPath = path.join(destDir, "src", "pages", "Index.tsx");
        const indexTsx = await readFile(indexTsxPath, "utf-8");

        // Load the full idea from DB so we can inject buyer/problem/monetisation
        // details into the template. Non-fatal: falls back to empty strings.
        let buyer = "";
        let problem = "";
        let monetisationAngle = "";
        let viralTrigger = "";
        try {
          const ideaRows = await db
            .select({ ideaJson: factoryRuns.ideaJson })
            .from(factoryRuns)
            .where(eq(factoryRuns.id, runId))
            .limit(1);
          if (ideaRows.length > 0) {
            const idea = JSON.parse(
              ideaRows[0].ideaJson,
            ) as IdeaEvaluationResult;
            buyer = idea.buyer ?? "";
            problem = idea.idea ?? "";
            monetisationAngle = idea.monetisationAngle ?? "";
            viralTrigger = idea.viralTrigger ?? "";
          }
        } catch (err) {
          pushLog(
            `Warning: could not load idea details from DB — buyer/problem fields will be empty. Error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        // JSON.stringify wraps in quotes — strip them for embedding in JSX text
        const safeAppNameJs = JSON.stringify(appName).slice(1, -1);
        const safeTaglineJs = JSON.stringify(
          tagline ?? "Built with Dyad.",
        ).slice(1, -1);
        const safeBuyerJs = JSON.stringify(buyer).slice(1, -1);
        const safeProblemJs = JSON.stringify(problem).slice(1, -1);
        const safeMonetisationJs = JSON.stringify(monetisationAngle).slice(
          1,
          -1,
        );
        const safeViralTriggerJs = JSON.stringify(viralTrigger).slice(1, -1);

        const patchedIndexTsx = indexTsx
          .replace(/__DYAD_APP_NAME__/g, () => safeAppNameJs)
          .replace(/__DYAD_TAGLINE__/g, () => safeTaglineJs)
          .replace(/__DYAD_BUYER__/g, () => safeBuyerJs)
          .replace(/__DYAD_PROBLEM__/g, () => safeProblemJs)
          .replace(/__DYAD_MONETISATION__/g, () => safeMonetisationJs)
          .replace(/__DYAD_VIRAL_TRIGGER__/g, () => safeViralTriggerJs);
        await writeFile(indexTsxPath, patchedIndexTsx, "utf-8");
        pushLog("Patched src/pages/Index.tsx content.");

        // -----------------------------------------------------------------------
        // PR #7 — Brand codemod: write brand.css with the chosen primary color.
        // Falls back non-fatally to the scaffold default and logs a warning if the hex is invalid.
        // -----------------------------------------------------------------------
        if (primaryColor) {
          const brandCssPath = path.join(destDir, "src", "brand.css");
          try {
            const brandCss = buildBrandCss(primaryColor);
            await writeFile(brandCssPath, brandCss, "utf-8");
            pushLog(
              `Injected brand palette (${primaryColor}) into src/brand.css.`,
            );
          } catch (brandErr) {
            // Non-fatal: log the warning but continue with the default brand.css
            pushLog(
              `Warning: could not inject brand color "${primaryColor}": ${brandErr instanceof Error ? brandErr.message : String(brandErr)}. Using default palette.`,
            );
          }
        }

        // -----------------------------------------------------------------------
        // npm install
        // -----------------------------------------------------------------------
        pushLog("Running npm install --legacy-peer-deps…");
        const SCAFFOLD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
        try {
          const installResult = await runCommand(
            "npm",
            ["install", "--legacy-peer-deps"],
            { cwd: destDir, timeoutMs: SCAFFOLD_TIMEOUT_MS },
          );
          if (installResult.stdout) {
            for (const line of installResult.stdout.split("\n")) {
              pushLog(line);
            }
          }
          pushLog("npm install completed.");
        } catch (installErr) {
          throw new DyadError(
            `npm install failed: ${installErr instanceof Error ? installErr.message : String(installErr)}`,
            DyadErrorKind.ScaffoldFailure,
          );
        }

        // -----------------------------------------------------------------------
        // npm run build
        // -----------------------------------------------------------------------
        pushLog("Running npm run build…");
        try {
          const buildResult = await runCommand("npm", ["run", "build"], {
            cwd: destDir,
            timeoutMs: SCAFFOLD_TIMEOUT_MS,
          });
          if (buildResult.stdout) {
            for (const line of buildResult.stdout.split("\n")) {
              pushLog(line);
            }
          }
          pushLog("npm run build completed.");
        } catch (buildErr) {
          throw new DyadError(
            `npm run build failed: ${buildErr instanceof Error ? buildErr.message : String(buildErr)}`,
            DyadErrorKind.ScaffoldFailure,
          );
        }

        // -----------------------------------------------------------------------
        // Verify dist/ was produced
        // -----------------------------------------------------------------------
        const previewPath = path.join(destDir, "dist");
        try {
          const distStat = await stat(previewPath);
          if (!distStat.isDirectory()) {
            throw new DyadError(
              `Build output at "${previewPath}" is not a directory`,
              DyadErrorKind.ScaffoldFailure,
            );
          }
        } catch (statErr) {
          if (statErr instanceof DyadError) throw statErr;
          throw new DyadError(
            `Build did not produce dist/ at "${previewPath}": ${statErr instanceof Error ? statErr.message : String(statErr)}`,
            DyadErrorKind.ScaffoldFailure,
          );
        }

        pushLog(`Preview available at: ${previewPath}`);

        // -----------------------------------------------------------------------
        // PR #15 — Smoke-test gate: validate the generated artifact before
        // declaring scaffold successful.
        // Fail immediately with a clear message if any of the following are true:
        //   1. dist/index.html is missing
        //   2. Unreplaced __DYAD_*__ placeholders survive in the HTML
        //   3. The hero/app-name section is absent
        //   4. The pricing/paywall section is absent
        //   5. The checkout button marker is absent
        // -----------------------------------------------------------------------
        const distIndexHtmlPath = path.join(previewPath, "index.html");
        let distHtml: string;
        try {
          distHtml = await readFile(distIndexHtmlPath, "utf-8");
        } catch {
          throw new DyadError(
            `Scaffold validation failed: dist/index.html not found at "${distIndexHtmlPath}".`,
            DyadErrorKind.ScaffoldFailure,
          );
        }

        // 1. Unreplaced __DYAD_*__ placeholders
        const remainingPlaceholders = [
          "__DYAD_APP_NAME__",
          "__DYAD_TAGLINE__",
          "__DYAD_BUYER__",
          "__DYAD_PROBLEM__",
          "__DYAD_MONETISATION__",
          "__DYAD_VIRAL_TRIGGER__",
        ].filter((p) => distHtml.includes(p));
        if (remainingPlaceholders.length > 0) {
          throw new DyadError(
            `Scaffold validation failed: generated dist/index.html still contains unreplaced placeholders: ${remainingPlaceholders.join(", ")}.`,
            DyadErrorKind.ScaffoldFailure,
          );
        }

        // 2. Hero / app-name section — the codemod writes the app name into the
        //    <title> tag and into the page content. Check that the <title> is
        //    not the scaffold template's placeholder value — but only when the
        //    user's actual app name is different from the placeholder (otherwise
        //    having "dyad-generated-app" in the title is the correct result).
        const scaffoldPlaceholderTitle = "dyad-generated-app";
        if (
          appName !== scaffoldPlaceholderTitle &&
          (distHtml.includes(`<title>${scaffoldPlaceholderTitle}</title>`) ||
            distHtml.includes(`<title>${scaffoldPlaceholderTitle} </title>`))
        ) {
          throw new DyadError(
            `Scaffold validation failed: dist/index.html still has the default scaffold title ("${scaffoldPlaceholderTitle}"). App name codemod may have failed.`,
            DyadErrorKind.ScaffoldFailure,
          );
        }

        // 3. Pricing/paywall section marker — the template uses the fixed
        //    text "Unlock full access" as the pricing heading.
        if (!distHtml.includes("Unlock full access")) {
          throw new DyadError(
            `Scaffold validation failed: pricing/paywall section not found in dist/index.html. Expected "Unlock full access" heading.`,
            DyadErrorKind.ScaffoldFailure,
          );
        }

        // 4. Checkout button marker — CheckoutButton renders either "Buy Now"
        //    (configured) or "Checkout not configured" (missing env var).
        const hasCheckout =
          distHtml.includes("Buy Now") ||
          distHtml.includes("Checkout not configured");
        if (!hasCheckout) {
          throw new DyadError(
            `Scaffold validation failed: checkout button not found in dist/index.html. CheckoutButton component may be missing.`,
            DyadErrorKind.ScaffoldFailure,
          );
        }

        pushLog("Scaffold validation passed.");
        return { previewPath, logs };
      } catch (err) {
        if (err instanceof DyadError) throw err;
        throw new DyadError(
          `Scaffold failed for "${appName}": ${err instanceof Error ? err.message : String(err)}`,
          DyadErrorKind.ScaffoldFailure,
        );
      }
    },
  );

  // ===========================================================================
  // PR #10 — Launch-kit generator
  // Reads the stored run from DB, calls the active LLM provider with a
  // copywriting + deployment prompt, and returns a validated LaunchKit object.
  // ===========================================================================

  createTypedHandler(
    factoryContracts.generateLaunchKit,
    async (_, { runId }) => {
      // Load the run from DB
      let idea: IdeaEvaluationResult;
      try {
        const rows = await db
          .select()
          .from(factoryRuns)
          .where(eq(factoryRuns.id, runId))
          .limit(1);
        if (rows.length === 0) {
          throw new DyadError(
            `No factory run found with id ${runId}.`,
            DyadErrorKind.NotFound,
          );
        }
        idea = JSON.parse(rows[0].ideaJson) as IdeaEvaluationResult;
      } catch (err) {
        if (err instanceof DyadError) throw err;
        throw new DyadError(
          `Failed to read factory run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
          DyadErrorKind.FactoryPersistenceFailure,
        );
      }

      // Call LLM with the launch-kit prompt
      let raw: string;
      try {
        raw = await callWithRetry(LAUNCH_KIT_PROMPT(idea));
      } catch (err) {
        throw new DyadError(
          `LLM call failed for launch kit (run ${runId}): ${err instanceof Error ? err.message : String(err)}`,
          DyadErrorKind.LaunchKitFailure,
        );
      }

      // Parse and validate the JSON response
      let parsed: unknown;
      try {
        // Strip markdown fences if the model wraps the output
        const stripped = raw
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```\s*$/, "")
          .trim();
        parsed = JSON.parse(stripped);
      } catch {
        throw new DyadError(
          `Launch-kit LLM response was not valid JSON for run ${runId}.`,
          DyadErrorKind.InvalidLlmResponse,
        );
      }

      // Validate against the LaunchKitSchema
      const result = LaunchKitSchema.safeParse(parsed);
      if (!result.success) {
        throw new DyadError(
          `Launch-kit response failed schema validation for run ${runId}: ${result.error.message}`,
          DyadErrorKind.InvalidLlmResponse,
        );
      }
      return result.data;
    },
  );

  // ===========================================================================
  // PR #10 — Export launch kit to disk
  // Writes individual .md / .txt files to
  //   userData/factory-apps/<slug>/launch-kit/
  // and returns the directory path so the renderer can surface it.
  // ===========================================================================

  createTypedHandler(
    factoryContracts.exportLaunchKit,
    async (_, { runId, kit }) => {
      // Load the run to derive the slug from the idea name
      let ideaName: string;
      try {
        const rows = await db
          .select({ ideaJson: factoryRuns.ideaJson })
          .from(factoryRuns)
          .where(eq(factoryRuns.id, runId))
          .limit(1);
        if (rows.length === 0) {
          throw new DyadError(
            `No factory run found with id ${runId}.`,
            DyadErrorKind.NotFound,
          );
        }
        const idea = JSON.parse(rows[0].ideaJson) as { name?: string };
        ideaName = idea.name ?? `run-${runId}`;
      } catch (err) {
        if (err instanceof DyadError) throw err;
        throw new DyadError(
          `Failed to read factory run ${runId} for export: ${err instanceof Error ? err.message : String(err)}`,
          DyadErrorKind.LaunchKitFailure,
        );
      }

      const slug = factorySlugFromName(ideaName, runId);

      const kitDir = path.join(
        app.getPath("userData"),
        "factory-apps",
        slug,
        "launch-kit",
      );

      try {
        await mkdir(kitDir, { recursive: true });

        const files: Array<[string, string]> = [
          ["elevator-pitch.md", `# Elevator Pitch\n\n${kit.elevatorPitch}\n`],
          ["twitter-post.md", `# X / Twitter Post\n\n${kit.twitterPost}\n`],
          ["linkedin-post.md", `# LinkedIn Post\n\n${kit.linkedinPost}\n`],
          [
            "landing-page-copy.md",
            `# Landing Page Copy\n\n## Headline\n\n${kit.heroHeadline}\n\n## Subtext\n\n${kit.heroSubtext}\n`,
          ],
          [
            "cold-email.md",
            `# Cold Email\n\n**Subject:** ${kit.emailSubject}\n\n${kit.emailBody}\n`,
          ],
          [
            "deploy-checklist.md",
            `# Deployment Checklist\n\n${kit.deployChecklist.map((step, i) => `${i + 1}. ${step}`).join("\n")}\n`,
          ],
        ];

        await Promise.all(
          files.map(([filename, content]) =>
            writeFile(path.join(kitDir, filename), content, "utf-8"),
          ),
        );

        logger.log(`[exportLaunchKit] Written to ${kitDir}`);
        return { path: kitDir };
      } catch (err) {
        if (err instanceof DyadError) throw err;
        throw new DyadError(
          `Failed to export launch kit for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
          DyadErrorKind.LaunchKitFailure,
        );
      }
    },
  );

  // PR #11 — One-click deploy handlers (Vercel + Netlify)
  registerFactoryDeployHandlers();

  // ===========================================================================
  // PR #14 — Outcome-weighted scoring toggle
  // Persists the factoryOutcomeWeightedScoring feature flag via writeSettings.
  // ===========================================================================

  createTypedHandler(
    factoryContracts.toggleOutcomeWeightedScoring,
    async (_, { enabled }) => {
      writeSettings({ factoryOutcomeWeightedScoring: enabled });
      logger.log(
        `[factory] outcome-weighted scoring ${enabled ? "enabled" : "disabled"} by user.`,
      );
    },
  );
}

// =============================================================================
// PR #5 — Backwards-compat reader
// Maps a legacy { launched, revenueGenerated, notes } blob to a synthetic
// QuantitativeLaunchOutcome with id=-1 (not persisted) so the renderer can
// render it uniformly.
// =============================================================================

function isLegacyLaunchOutcome(value: unknown): value is LaunchOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.launched === "boolean" &&
    typeof candidate.revenueGenerated === "boolean"
  );
}

function mapLegacyLaunchOutcome(
  runId: number,
  raw: string,
  createdAt: Date | number | null,
): QuantitativeLaunchOutcome | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isLegacyLaunchOutcome(parsed)) {
    return null;
  }
  // Treat revenueGenerated=true as a non-zero revenue signal (value=1 cent is a
  // placeholder signal only — exact amount is unknown for legacy rows) and
  // launched=true as conversions >= 1.
  const capturedAtSec =
    createdAt instanceof Date
      ? Math.floor(createdAt.getTime() / 1000)
      : typeof createdAt === "number"
        ? createdAt
        : Math.floor(Date.now() / 1000);
  return {
    id: -1,
    runId,
    revenueUsd: parsed.revenueGenerated ? 1 : null,
    conversions: parsed.launched ? 1 : null,
    views: null,
    churn30d: null,
    source: "legacy",
    capturedAt: capturedAtSec,
  };
}
