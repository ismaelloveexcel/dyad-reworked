import { createTypedHandler } from "./base";
import {
  factoryContracts,
  type IdeaEvaluationResult,
  type RunStatus,
  type LaunchOutcome,
  type QuantitativeLaunchOutcome,
} from "../types/factory";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { db } from "@/db";
import { factoryRuns, launchOutcomes } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import log from "electron-log";
import { app, dialog, BrowserWindow } from "electron";
import { writeFile, readFile, stat, rm } from "fs/promises";
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
import { readSettings } from "@/main/settings";
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
} from "@/core/factory/main";

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

export function registerFactoryHandlers() {
  createTypedHandler(factoryContracts.evaluateIdea, async (_, { idea }) => {
    try {
      const raw = await callWithRetry(EVALUATE_PROMPT(idea));
      return enrichResult(validateIdeaResult(raw, idea));
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
      const enriched: IdeaEvaluationResult = {
        ...idea,
        promptVersion: idea.promptVersion ?? PROMPT_VERSION,
        promptHash: idea.promptHash ?? CURRENT_PROMPT_HASH,
        modelVersion:
          idea.modelVersion ?? getFactoryModelVersion(activeProvider),
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
        const outcomes: QuantitativeLaunchOutcome[] = rows.map((r) => ({
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
        }));
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
      const slug =
        appName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 64) || `factory-app-${runId}`;

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

        // 3. src/pages/Index.tsx — replace placeholder heading and sub-text.
        // Use JSON.stringify to produce safe JS string literals so characters
        // like `{`, `}`, `$`, and `\` cannot break JSX parsing or
        // String.replace special sequences.
        const indexTsxPath = path.join(destDir, "src", "pages", "Index.tsx");
        const indexTsx = await readFile(indexTsxPath, "utf-8");
        // JSON.stringify wraps in quotes — strip them for embedding in JSX text
        const safeAppNameJs = JSON.stringify(appName).slice(1, -1);
        const safeTaglineJs = JSON.stringify(
          tagline ?? "Built with Dyad.",
        ).slice(1, -1);
        const patchedIndexTsx = indexTsx
          .replace(/Welcome to Your Blank App/g, () => safeAppNameJs)
          .replace(
            /Start building your amazing project here!/g,
            () => safeTaglineJs,
          );
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
