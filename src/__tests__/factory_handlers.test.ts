// @vitest-environment node
/**
 * factory_handlers.test.ts
 *
 * Handler-level unit tests for every factory:* IPC handler in factory_handlers.ts.
 * All Electron, DB, and network dependencies are mocked so this runs without an
 * Electron binary or OpenAI credentials.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

// ---------------------------------------------------------------------------
// Hoisted state — must be created before vi.mock factories run
// ---------------------------------------------------------------------------

const capturedHandlers = vi.hoisted(() => new Map<string, Function>());

const mockDbState = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  insertedId: 1,
}));

// PR #9 — mock fetchEmbedding so saveRun/getSimilarRuns can run without a
// real OpenAI embeddings endpoint.  Defaults to a 3-dim unit-ish vector.
// Tests that need a different vector can call mockFetchEmbedding.mockResolvedValueOnce.
const mockFetchEmbedding = vi.hoisted(() =>
  vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
);

// ---------------------------------------------------------------------------
// Mocks (hoisted by vitest — order matters)
// ---------------------------------------------------------------------------

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    getPath: vi.fn().mockReturnValue("/mock-user-data"),
  },
  dialog: {
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }),
  },
  BrowserWindow: {
    fromWebContents: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock("@/ipc/utils/telemetry", () => ({
  sendTelemetryException: vi.fn(),
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: vi.fn((_col: unknown, _val: unknown) => "eq-predicate"),
    desc: vi.fn((_col: unknown) => "desc-order"),
    and: vi.fn((..._args: unknown[]) => "and-predicate"),
  };
});

vi.mock("@/db/schema", () => ({
  factoryRuns: {
    id: "id",
    fingerprint: "fingerprint",
    status: "status",
    createdAt: "createdAt",
    ideaJson: "ideaJson",
    launchOutcome: "launchOutcome",
    promptVersion: "promptVersion",
    promptHash: "promptHash",
    modelVersion: "modelVersion",
    // PR #9 — embedding column
    embedding: "embedding",
  },
  launchOutcomes: {
    id: "id",
    runId: "runId",
    revenueUsd: "revenueUsd",
    conversions: "conversions",
    views: "views",
    churn30d: "churn30d",
    source: "source",
    capturedAt: "capturedAt",
  },
}));

vi.mock("@/ipc/handlers/base", () => ({
  createTypedHandler: vi.fn(
    (contract: { channel: string }, handler: Function) => {
      capturedHandlers.set(contract.channel, handler);
    },
  ),
}));

vi.mock("@/db", () => {
  /** Creates a Drizzle-like chainable query builder that resolves lazily. */
  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {
      from: (..._: unknown[]) => chain,
      where: (..._: unknown[]) => chain,
      orderBy: (..._: unknown[]) => chain,
      set: (..._: unknown[]) => chain,
      values: (..._: unknown[]) => chain,
      // Terminal: select queries resolved via limit() or direct await
      limit: (..._: unknown[]) => Promise.resolve(mockDbState.rows),
      // Terminal: insert returning
      returning: (..._: unknown[]) =>
        Promise.resolve([{ id: mockDbState.insertedId }]),
      // Make the chain itself thenable (supports direct await)
      // eslint-disable-next-line unicorn/no-thenable
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
      ) => Promise.resolve(mockDbState.rows).then(resolve, reject),
    };
    return chain;
  }

  return {
    db: {
      select: vi.fn().mockImplementation(() => makeChain()),
      insert: vi.fn().mockImplementation(() => makeChain()),
      delete: vi.fn().mockImplementation(() => makeChain()),
      update: vi.fn().mockImplementation(() => makeChain()),
      // PR #12 — transaction mock: executes the callback with a tx proxy that
      // exposes the same chain API so delete+insert inside transaction() work.
      transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
        const txProxy = {
          insert: vi.fn().mockImplementation(() => makeChain()),
          delete: vi.fn().mockImplementation(() => makeChain()),
        };
        return fn(txProxy);
      }),
    },
  };
});

vi.mock("fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(""),
  rm: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  mkdir: vi.fn().mockResolvedValue(undefined),
  // PR #11 — readdir used by factory_deploy.collectFiles
  readdir: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/ipc/utils/file_utils", () => ({
  copyDirectoryRecursive: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/ipc/utils/socket_firewall", () => ({
  runCommand: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
}));

// PR #9 — Mock factory_embeddings so saveRun / getSimilarRuns don't need a
// real OpenAI embeddings endpoint.
vi.mock("@/ipc/handlers/factory_embeddings", () => ({
  fetchEmbedding: mockFetchEmbedding,
}));

// ---------------------------------------------------------------------------
// Mock settings so saveRun can read the quality-gate threshold and provider
// ---------------------------------------------------------------------------

const mockSettingsState = vi.hoisted(() => ({
  factoryScoreThreshold: 20 as number | undefined,
  factoryProvider: "openai" as "openai" | "anthropic" | "google" | undefined,
  // PR #9 — embedding dedup defaults
  factoryEmbeddingDedup: true as boolean | undefined,
  factoryEmbeddingSimilarityThreshold: 0.92 as number | undefined,
  // PR #11 — deploy token state
  vercelAccessToken: undefined as { value: string } | undefined,
  netlifyAccessToken: undefined as { value: string } | undefined,
  // PR #12 — payment provider key state
  lemonSqueezyApiKey: undefined as { value: string } | undefined,
  stripeSecretKey: undefined as { value: string } | undefined,
  // PR #13 — Plausible analytics key + site
  plausibleApiKey: undefined as { value: string } | undefined,
  plausibleSiteId: undefined as string | undefined,
  // PR #13 — nightly job state
  factoryNightlyJobEnabled: true as boolean | undefined,
  factoryNightlyLastRanAt: undefined as number | undefined,
}));

vi.mock("@/main/settings", () => ({
  readSettings: vi.fn(() => ({
    factoryScoreThreshold: mockSettingsState.factoryScoreThreshold,
    factoryProvider: mockSettingsState.factoryProvider,
    factoryEmbeddingDedup: mockSettingsState.factoryEmbeddingDedup,
    factoryEmbeddingSimilarityThreshold:
      mockSettingsState.factoryEmbeddingSimilarityThreshold,
    vercelAccessToken: mockSettingsState.vercelAccessToken,
    netlifyAccessToken: mockSettingsState.netlifyAccessToken,
    lemonSqueezyApiKey: mockSettingsState.lemonSqueezyApiKey,
    stripeSecretKey: mockSettingsState.stripeSecretKey,
    plausibleApiKey: mockSettingsState.plausibleApiKey,
    plausibleSiteId: mockSettingsState.plausibleSiteId,
    factoryNightlyJobEnabled: mockSettingsState.factoryNightlyJobEnabled,
    factoryNightlyLastRanAt: mockSettingsState.factoryNightlyLastRanAt,
  })),
  // PR #11 — writeSettings mock for factory:save-netlify-token
  writeSettings: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import handlers after mocks are wired
// ---------------------------------------------------------------------------

import {
  registerFactoryHandlers,
  OPENAI_MODEL_VERSION,
  ANTHROPIC_MODEL_VERSION,
  GOOGLE_MODEL_VERSION,
  getFactoryModelVersion,
  LAUNCH_KIT_PROMPT,
} from "@/ipc/handlers/factory_handlers";
import { registerFactoryPaymentsHandlers } from "@/ipc/handlers/factory_payments";
import { registerFactoryAnalyticsHandlers } from "@/ipc/handlers/factory_analytics";
import { registerFactoryNightlyHandlers } from "@/ipc/handlers/factory_nightly";
import { DyadErrorKind } from "@/errors/dyad_error";
import { sendTelemetryException } from "@/ipc/utils/telemetry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockEvent = {} as IpcMainInvokeEvent;

/** Minimal valid IdeaEvaluationResult fixture. */
function makeIdea(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    idea: "Invoice automation for Dubai freelancers",
    name: "InvoicePro UAE",
    buyer: "Freelancers in UAE",
    scores: {
      buyerClarity: 4,
      painUrgency: 4,
      marketExistence: 3,
      differentiation: 3,
      replaceability: 3,
      virality: 3,
      monetisation: 4,
      buildSimplicity: 4,
    },
    totalScore: 28,
    decision: "BUILD",
    reason: "Strong scores",
    improvedIdea: "",
    buildPrompt: "Build an invoice SaaS",
    monetisationAngle: "Monthly subscription",
    viralTrigger: "Share your invoice",
    fallbackUsed: false,
    ...overrides,
  };
}

/** Build a fake OpenAI response that contains valid factory JSON. */
function makeFakeOpenAIResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content } }],
      }),
    text: () => Promise.resolve(content),
  };
}

/** Build a fake Anthropic response that contains valid factory JSON. */
function makeFakeAnthropicResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        content: [{ type: "text", text: content }],
      }),
    text: () => Promise.resolve(content),
  };
}

/** Build a fake Google AI response that contains valid factory JSON. */
function makeFakeGoogleResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        candidates: [{ content: { parts: [{ text: content }] } }],
      }),
    text: () => Promise.resolve(content),
  };
}

// ---------------------------------------------------------------------------
// getFactoryModelVersion helper
// ---------------------------------------------------------------------------

describe("getFactoryModelVersion", () => {
  it("returns OPENAI_MODEL_VERSION for openai", () => {
    expect(getFactoryModelVersion("openai")).toBe(OPENAI_MODEL_VERSION);
  });

  it("returns ANTHROPIC_MODEL_VERSION for anthropic", () => {
    expect(getFactoryModelVersion("anthropic")).toBe(ANTHROPIC_MODEL_VERSION);
  });

  it("returns GOOGLE_MODEL_VERSION for google", () => {
    expect(getFactoryModelVersion("google")).toBe(GOOGLE_MODEL_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  capturedHandlers.clear();
  mockDbState.rows = [];
  mockDbState.insertedId = 1;
  mockSettingsState.factoryScoreThreshold = 20;
  mockSettingsState.factoryProvider = "openai";
  mockSettingsState.factoryEmbeddingDedup = true;
  mockSettingsState.factoryEmbeddingSimilarityThreshold = 0.92;
  // PR #11 — reset deploy token state
  mockSettingsState.vercelAccessToken = undefined;
  mockSettingsState.netlifyAccessToken = undefined;
  // PR #12 — reset payment key state
  mockSettingsState.lemonSqueezyApiKey = undefined;
  mockSettingsState.stripeSecretKey = undefined;
  // PR #13 — reset analytics + nightly state
  mockSettingsState.plausibleApiKey = undefined;
  mockSettingsState.plausibleSiteId = undefined;
  mockSettingsState.factoryNightlyJobEnabled = true;
  mockSettingsState.factoryNightlyLastRanAt = undefined;
  // Reset fetchEmbedding to its default implementation
  mockFetchEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  vi.clearAllMocks();
  // Re-wire createTypedHandler after clearAllMocks (implementation is preserved,
  // but we clear call history). Calling registerFactoryHandlers() re-populates the map.
  registerFactoryHandlers();
  registerFactoryPaymentsHandlers();
  registerFactoryAnalyticsHandlers();
  registerFactoryNightlyHandlers();
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// factory:get-system-status
// ---------------------------------------------------------------------------

describe("factory:get-system-status", () => {
  it("reports openaiKeyPresent=true when env var is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const handler = capturedHandlers.get("factory:get-system-status")!;
    const result = (await handler(mockEvent, {})) as {
      openaiKeyPresent: boolean;
      modelVersion: string;
      provider: string;
      providerKeyPresent: boolean;
    };
    expect(result.openaiKeyPresent).toBe(true);
    expect(result.modelVersion).toBe(OPENAI_MODEL_VERSION);
    expect(result.provider).toBe("openai");
    expect(result.providerKeyPresent).toBe(true);
  });

  it("reports openaiKeyPresent=false when env var is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const handler = capturedHandlers.get("factory:get-system-status")!;
    const result = (await handler(mockEvent, {})) as {
      openaiKeyPresent: boolean;
      providerKeyPresent: boolean;
    };
    expect(result.openaiKeyPresent).toBe(false);
    expect(result.providerKeyPresent).toBe(false);
  });

  it("reports openaiKeyPresent=false when env var is whitespace", async () => {
    process.env.OPENAI_API_KEY = "   ";
    const handler = capturedHandlers.get("factory:get-system-status")!;
    const result = (await handler(mockEvent, {})) as {
      openaiKeyPresent: boolean;
      providerKeyPresent: boolean;
    };
    expect(result.openaiKeyPresent).toBe(false);
    expect(result.providerKeyPresent).toBe(false);
  });

  it("reports anthropic provider and key status when factoryProvider=anthropic", async () => {
    mockSettingsState.factoryProvider = "anthropic";
    process.env.ANTHROPIC_API_KEY = "ant-test";
    const handler = capturedHandlers.get("factory:get-system-status")!;
    const result = (await handler(mockEvent, {})) as {
      provider: string;
      providerKeyPresent: boolean;
      modelVersion: string;
    };
    expect(result.provider).toBe("anthropic");
    expect(result.providerKeyPresent).toBe(true);
    expect(result.modelVersion).toBe(ANTHROPIC_MODEL_VERSION);
  });

  it("reports google provider and key status when factoryProvider=google", async () => {
    mockSettingsState.factoryProvider = "google";
    process.env.GOOGLE_API_KEY = "goog-test";
    const handler = capturedHandlers.get("factory:get-system-status")!;
    const result = (await handler(mockEvent, {})) as {
      provider: string;
      providerKeyPresent: boolean;
      modelVersion: string;
    };
    expect(result.provider).toBe("google");
    expect(result.providerKeyPresent).toBe(true);
    expect(result.modelVersion).toBe(GOOGLE_MODEL_VERSION);
  });

  it("reports providerKeyPresent=false when anthropic key is missing", async () => {
    mockSettingsState.factoryProvider = "anthropic";
    delete process.env.ANTHROPIC_API_KEY;
    const handler = capturedHandlers.get("factory:get-system-status")!;
    const result = (await handler(mockEvent, {})) as {
      providerKeyPresent: boolean;
    };
    expect(result.providerKeyPresent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// factory:evaluate-idea
// ---------------------------------------------------------------------------

describe("factory:evaluate-idea", () => {
  it("throws DyadError(MissingApiKey) when OPENAI_API_KEY is absent", async () => {
    delete process.env.OPENAI_API_KEY;
    const handler = capturedHandlers.get("factory:evaluate-idea")!;
    await expect(
      handler(mockEvent, { idea: "test idea" }),
    ).rejects.toMatchObject({
      kind: DyadErrorKind.MissingApiKey,
    });
  });

  it("falls back to deterministic scoring when OpenAI returns HTTP 401", async () => {
    process.env.OPENAI_API_KEY = "sk-invalid";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      }),
    );
    const handler = capturedHandlers.get("factory:evaluate-idea")!;
    const result = (await handler(mockEvent, {
      idea: "Invoice automation for Dubai freelancers",
    })) as { fallbackUsed: boolean; idea: string };
    expect(result.fallbackUsed).toBe(true);
    expect(result.idea).toBe("Invoice automation for Dubai freelancers");
  });

  it("returns validated result when OpenAI returns valid JSON", async () => {
    process.env.OPENAI_API_KEY = "sk-valid";
    const validContent = JSON.stringify({
      idea: "Invoice automation for Dubai freelancers",
      name: "InvoicePro UAE",
      buyer: "Freelancers in UAE",
      scores: {
        buyerClarity: 5,
        painUrgency: 4,
        marketExistence: 4,
        differentiation: 3,
        replaceability: 4,
        virality: 3,
        monetisation: 4,
        buildSimplicity: 4,
      },
      totalScore: 31,
      decision: "BUILD",
      reason: "Strong monetisation potential.",
      improvedIdea: "",
      buildPrompt: "Build an invoice SaaS...",
      monetisationAngle: "Monthly subscription",
      viralTrigger: "Share your invoice template",
      fallbackUsed: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFakeOpenAIResponse(validContent)),
    );
    const handler = capturedHandlers.get("factory:evaluate-idea")!;
    const result = (await handler(mockEvent, {
      idea: "Invoice automation for Dubai freelancers",
    })) as { name: string; fallbackUsed: boolean };
    expect(result.name).toBe("InvoicePro UAE");
    expect(result.fallbackUsed).toBe(false);
  });

  it("falls back when OpenAI returns invalid JSON content", async () => {
    process.env.OPENAI_API_KEY = "sk-valid";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFakeOpenAIResponse("not valid json!!!!")),
    );
    const handler = capturedHandlers.get("factory:evaluate-idea")!;
    const result = (await handler(mockEvent, { idea: "some idea" })) as {
      fallbackUsed: boolean;
    };
    expect(result.fallbackUsed).toBe(true);
  });

  it("enriches result with promptVersion and promptHash", async () => {
    process.env.OPENAI_API_KEY = "sk-valid";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeFakeOpenAIResponse("unparseable to trigger fallback"),
        ),
    );
    const handler = capturedHandlers.get("factory:evaluate-idea")!;
    const result = (await handler(mockEvent, { idea: "test idea" })) as {
      promptVersion: string;
      promptHash: string;
    };
    expect(typeof result.promptVersion).toBe("string");
    expect(typeof result.promptHash).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// PR #8 — Multi-provider routing: factory:evaluate-idea
// ---------------------------------------------------------------------------

describe("factory:evaluate-idea — multi-provider routing", () => {
  it("routes to Anthropic when factoryProvider=anthropic and returns valid result", async () => {
    mockSettingsState.factoryProvider = "anthropic";
    process.env.ANTHROPIC_API_KEY = "ant-valid";
    const validContent = JSON.stringify({
      idea: "Invoice automation for Dubai freelancers",
      name: "InvoicePro UAE",
      buyer: "Freelancers in UAE",
      scores: {
        buyerClarity: 5,
        painUrgency: 4,
        marketExistence: 4,
        differentiation: 3,
        replaceability: 4,
        virality: 3,
        monetisation: 4,
        buildSimplicity: 4,
      },
      totalScore: 31,
      decision: "BUILD",
      reason: "Strong scores.",
      improvedIdea: "",
      buildPrompt: "Build an invoice SaaS...",
      monetisationAngle: "Monthly subscription",
      viralTrigger: "Share your invoice template",
      fallbackUsed: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFakeAnthropicResponse(validContent)),
    );
    const handler = capturedHandlers.get("factory:evaluate-idea")!;
    const result = (await handler(mockEvent, {
      idea: "Invoice automation for Dubai freelancers",
    })) as { name: string; fallbackUsed: boolean };
    expect(result.name).toBe("InvoicePro UAE");
    expect(result.fallbackUsed).toBe(false);
  });

  it("throws DyadError(MissingApiKey) when factoryProvider=anthropic and key is absent", async () => {
    mockSettingsState.factoryProvider = "anthropic";
    delete process.env.ANTHROPIC_API_KEY;
    const handler = capturedHandlers.get("factory:evaluate-idea")!;
    await expect(handler(mockEvent, { idea: "test" })).rejects.toMatchObject({
      kind: DyadErrorKind.MissingApiKey,
    });
  });

  it("propagates DyadError(AnthropicRateLimit) when Anthropic returns HTTP 429", async () => {
    mockSettingsState.factoryProvider = "anthropic";
    process.env.ANTHROPIC_API_KEY = "ant-valid";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve("rate limit"),
      }),
    );
    const handler = capturedHandlers.get("factory:evaluate-idea")!;
    await expect(handler(mockEvent, { idea: "test" })).rejects.toMatchObject({
      kind: DyadErrorKind.AnthropicRateLimit,
    });
  });

  it("routes to Google when factoryProvider=google and returns valid result", async () => {
    mockSettingsState.factoryProvider = "google";
    process.env.GOOGLE_API_KEY = "goog-valid";
    const validContent = JSON.stringify({
      idea: "Invoice automation for Dubai freelancers",
      name: "InvoicePro UAE",
      buyer: "Freelancers in UAE",
      scores: {
        buyerClarity: 4,
        painUrgency: 4,
        marketExistence: 3,
        differentiation: 3,
        replaceability: 3,
        virality: 3,
        monetisation: 4,
        buildSimplicity: 4,
      },
      totalScore: 28,
      decision: "BUILD",
      reason: "Good scores.",
      improvedIdea: "",
      buildPrompt: "Build a SaaS...",
      monetisationAngle: "Subscription",
      viralTrigger: "Share",
      fallbackUsed: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFakeGoogleResponse(validContent)),
    );
    const handler = capturedHandlers.get("factory:evaluate-idea")!;
    const result = (await handler(mockEvent, {
      idea: "Invoice automation for Dubai freelancers",
    })) as { name: string; fallbackUsed: boolean };
    expect(result.name).toBe("InvoicePro UAE");
    expect(result.fallbackUsed).toBe(false);
  });

  it("throws DyadError(MissingApiKey) when factoryProvider=google and key is absent", async () => {
    mockSettingsState.factoryProvider = "google";
    delete process.env.GOOGLE_API_KEY;
    const handler = capturedHandlers.get("factory:evaluate-idea")!;
    await expect(handler(mockEvent, { idea: "test" })).rejects.toMatchObject({
      kind: DyadErrorKind.MissingApiKey,
    });
  });

  it("propagates DyadError(GoogleRateLimit) when Google returns HTTP 429", async () => {
    mockSettingsState.factoryProvider = "google";
    process.env.GOOGLE_API_KEY = "goog-valid";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve("rate limit"),
      }),
    );
    const handler = capturedHandlers.get("factory:evaluate-idea")!;
    await expect(handler(mockEvent, { idea: "test" })).rejects.toMatchObject({
      kind: DyadErrorKind.GoogleRateLimit,
    });
  });

  it("falls back to deterministic scoring when Google returns HTTP 401", async () => {
    mockSettingsState.factoryProvider = "google";
    process.env.GOOGLE_API_KEY = "goog-invalid";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      }),
    );
    const handler = capturedHandlers.get("factory:evaluate-idea")!;
    const result = (await handler(mockEvent, {
      idea: "Invoice automation for Dubai freelancers",
    })) as { fallbackUsed: boolean };
    expect(result.fallbackUsed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// factory:generate-ideas
// ---------------------------------------------------------------------------

describe("factory:generate-ideas", () => {
  it("throws DyadError(MissingApiKey) when API key is absent", async () => {
    delete process.env.OPENAI_API_KEY;
    const handler = capturedHandlers.get("factory:generate-ideas")!;
    await expect(
      handler(mockEvent, { mode: "fast-money" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.MissingApiKey });
  });

  it("propagates DyadError(OpenAiRateLimit) when OpenAI returns HTTP 429", async () => {
    process.env.OPENAI_API_KEY = "sk-valid";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve("rate limit exceeded"),
      }),
    );
    const handler = capturedHandlers.get("factory:generate-ideas")!;
    await expect(
      handler(mockEvent, { mode: "fast-money" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.OpenAiRateLimit });
  });

  it("falls back to template ideas when OpenAI returns HTTP 401 (External error)", async () => {
    process.env.OPENAI_API_KEY = "sk-invalid";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      }),
    );
    const handler = capturedHandlers.get("factory:generate-ideas")!;
    const result = (await handler(mockEvent, { mode: "fast-money" })) as {
      ideas: { fallbackUsed: boolean }[];
    };
    expect(result.ideas.length).toBeGreaterThan(0);
    expect(result.ideas.every((i) => i.fallbackUsed)).toBe(true);
  });

  it("returns ideas sorted by totalScore DESC when OpenAI responds with multiple ideas", async () => {
    process.env.OPENAI_API_KEY = "sk-valid";
    const ideaHigh = makeIdea({
      name: "High Score Tool",
      totalScore: 36,
      scores: {
        buyerClarity: 5,
        painUrgency: 5,
        marketExistence: 4,
        differentiation: 4,
        replaceability: 4,
        virality: 4,
        monetisation: 5,
        buildSimplicity: 5,
      },
    });
    const ideaLow = makeIdea({
      name: "Low Score Tool",
      totalScore: 22,
      scores: {
        buyerClarity: 3,
        painUrgency: 3,
        marketExistence: 3,
        differentiation: 2,
        replaceability: 3,
        virality: 3,
        monetisation: 2,
        buildSimplicity: 3,
      },
    });
    const ideaMid = makeIdea({
      name: "Mid Score Tool",
      totalScore: 28,
      scores: {
        buyerClarity: 4,
        painUrgency: 4,
        marketExistence: 3,
        differentiation: 3,
        replaceability: 3,
        virality: 3,
        monetisation: 4,
        buildSimplicity: 4,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeFakeOpenAIResponse(JSON.stringify([ideaLow, ideaHigh, ideaMid])),
        ),
    );
    const handler = capturedHandlers.get("factory:generate-ideas")!;
    const result = (await handler(mockEvent, { mode: "premium" })) as {
      ideas: { name: string; totalScore: number }[];
    };
    expect(result.ideas.length).toBe(3);
    // Scores must be non-increasing
    for (let i = 1; i < result.ideas.length; i++) {
      expect(result.ideas[i].totalScore).toBeLessThanOrEqual(
        result.ideas[i - 1].totalScore,
      );
    }
    expect(result.ideas[0].name).toBe("High Score Tool");
  });
});

// ---------------------------------------------------------------------------
// factory:generate-portfolio
// ---------------------------------------------------------------------------

describe("factory:generate-portfolio", () => {
  it("throws DyadError(MissingApiKey) when API key is absent", async () => {
    delete process.env.OPENAI_API_KEY;
    const handler = capturedHandlers.get("factory:generate-portfolio")!;
    await expect(handler(mockEvent, {})).rejects.toMatchObject({
      kind: DyadErrorKind.MissingApiKey,
    });
  });

  it("returns three engine ideas when OpenAI returns valid portfolio JSON", async () => {
    process.env.OPENAI_API_KEY = "sk-valid";
    const ideaTemplate = {
      idea: "Test tool idea",
      name: "Test Tool",
      buyer: "Test buyers",
      engineType: "revenue",
      scores: {
        buyerClarity: 4,
        painUrgency: 4,
        marketExistence: 3,
        differentiation: 3,
        replaceability: 3,
        virality: 3,
        monetisation: 4,
        buildSimplicity: 4,
      },
      totalScore: 28,
      decision: "BUILD",
      reason: "Good scores",
      improvedIdea: "",
      buildPrompt: "Build it",
      monetisationAngle: "Subscription",
      viralTrigger: "Share",
      fallbackUsed: false,
    };
    const portfolioJson = JSON.stringify({
      revenueIdea: { ...ideaTemplate, engineType: "revenue" },
      viralIdea: { ...ideaTemplate, engineType: "viral", decision: "BUILD" },
      experimentalIdea: {
        ...ideaTemplate,
        engineType: "experimental",
        decision: "REWORK",
      },
      portfolioLink: "Viral idea drives traffic to revenue idea.",
      fallbackUsed: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFakeOpenAIResponse(portfolioJson)),
    );
    const handler = capturedHandlers.get("factory:generate-portfolio")!;
    const result = (await handler(mockEvent, {})) as {
      revenueIdea: { name: string };
      viralIdea: unknown;
      experimentalIdea: { decision: string };
    };
    expect(result.revenueIdea.name).toBe("Test Tool");
    expect(result.experimentalIdea.decision).toBe("REWORK");
  });
});

// ---------------------------------------------------------------------------
// factory:save-run
// ---------------------------------------------------------------------------

describe("factory:save-run", () => {
  it("inserts a new run and returns its id when there is no fingerprint collision", async () => {
    // select returns [] → no collision
    mockDbState.rows = [];
    mockDbState.insertedId = 42;
    const handler = capturedHandlers.get("factory:save-run")!;
    const result = (await handler(mockEvent, { idea: makeIdea() })) as {
      id: number;
      duplicate: null;
    };
    expect(result.id).toBe(42);
    expect(result.duplicate).toBeNull();
  });

  it("returns existing run as duplicate when fingerprint collides", async () => {
    const existing = makeIdea({ name: "Existing Run" });
    mockDbState.rows = [
      { id: 7, ideaJson: JSON.stringify(existing), status: "DECIDED" },
    ];
    const handler = capturedHandlers.get("factory:save-run")!;
    const result = (await handler(mockEvent, { idea: existing })) as {
      id: number;
      duplicate: { name: string };
    };
    expect(result.id).toBe(7);
    expect(result.duplicate).not.toBeNull();
    expect(result.duplicate!.name).toBe("Existing Run");
  });

  it("throws DyadError(Conflict) when collision row has corrupt JSON", async () => {
    mockDbState.rows = [
      {
        id: 99,
        ideaJson: "{{corrupt json}}",
        fingerprint: "fp",
        status: "DECIDED",
      },
    ];
    const handler = capturedHandlers.get("factory:save-run")!;
    await expect(
      handler(mockEvent, { idea: makeIdea() }),
    ).rejects.toMatchObject({
      kind: DyadErrorKind.Conflict,
    });
  });

  it("enriches saved run with modelVersion", async () => {
    mockDbState.rows = [];
    mockDbState.insertedId = 1;
    const handler = capturedHandlers.get("factory:save-run")!;
    // No throw → success; modelVersion enrichment happens before DB insert
    const result = (await handler(mockEvent, { idea: makeIdea() })) as {
      id: number;
    };
    expect(result.id).toBe(1);
  });

  // PR #3 — Quality gate
  it("throws DyadError(QualityGateRejection) when idea score is below threshold", async () => {
    mockSettingsState.factoryScoreThreshold = 20;
    registerFactoryHandlers();
    const handler = capturedHandlers.get("factory:save-run")!;
    const lowScoreIdea = makeIdea({ totalScore: 15 });
    await expect(
      handler(mockEvent, { idea: lowScoreIdea }),
    ).rejects.toMatchObject({
      kind: DyadErrorKind.QualityGateRejection,
    });
  });

  it("persists idea when score equals the threshold (boundary)", async () => {
    mockSettingsState.factoryScoreThreshold = 20;
    registerFactoryHandlers();
    mockDbState.rows = [];
    mockDbState.insertedId = 5;
    const handler = capturedHandlers.get("factory:save-run")!;
    const exactIdea = makeIdea({ totalScore: 20 });
    const result = (await handler(mockEvent, { idea: exactIdea })) as {
      id: number;
    };
    expect(result.id).toBe(5);
  });

  it("persists idea when threshold is 0 (quality gate off)", async () => {
    mockSettingsState.factoryScoreThreshold = 0;
    registerFactoryHandlers();
    mockDbState.rows = [];
    mockDbState.insertedId = 3;
    const handler = capturedHandlers.get("factory:save-run")!;
    const lowIdea = makeIdea({ totalScore: 5 });
    const result = (await handler(mockEvent, { idea: lowIdea })) as {
      id: number;
    };
    expect(result.id).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// factory:list-runs
// ---------------------------------------------------------------------------

describe("factory:list-runs", () => {
  it("returns an empty array when there are no runs", async () => {
    mockDbState.rows = [];
    const handler = capturedHandlers.get("factory:list-runs")!;
    const result = (await handler(mockEvent, {})) as {
      runs: unknown[];
    };
    expect(result.runs).toEqual([]);
  });

  it("returns parsed runs with runId and runStatus injected", async () => {
    const idea = makeIdea();
    mockDbState.rows = [
      {
        id: 3,
        ideaJson: JSON.stringify(idea),
        status: "QUEUED",
        createdAt: new Date("2024-01-15"),
      },
    ];
    const handler = capturedHandlers.get("factory:list-runs")!;
    const result = (await handler(mockEvent, {})) as {
      runs: { runId: number; runStatus: string; evaluatedAt: number }[];
    };
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].runId).toBe(3);
    expect(result.runs[0].runStatus).toBe("QUEUED");
    expect(typeof result.runs[0].evaluatedAt).toBe("number");
  });

  it("skips corrupt rows and reports a telemetry exception for each", async () => {
    const goodIdea = makeIdea();
    mockDbState.rows = [
      {
        id: 1,
        ideaJson: JSON.stringify(goodIdea),
        status: "DECIDED",
        createdAt: new Date(),
      },
      {
        id: 2,
        ideaJson: "{{broken json}}",
        status: "DECIDED",
        createdAt: new Date(),
      },
    ];
    const handler = capturedHandlers.get("factory:list-runs")!;
    const result = (await handler(mockEvent, {})) as {
      runs: { runId: number }[];
    };
    // Only the good row is returned
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].runId).toBe(1);
    // Telemetry called once for the corrupt row
    expect(vi.mocked(sendTelemetryException)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTelemetryException)).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: DyadErrorKind.FactoryPersistenceFailure,
      }),
      expect.objectContaining({ ipc_channel: "factory:list-runs", run_id: 2 }),
    );
  });
});

// ---------------------------------------------------------------------------
// factory:delete-run
// ---------------------------------------------------------------------------

describe("factory:delete-run", () => {
  it("returns success:true on a successful delete", async () => {
    const handler = capturedHandlers.get("factory:delete-run")!;
    const result = (await handler(mockEvent, { id: 5 })) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// factory:clear-runs
// ---------------------------------------------------------------------------

describe("factory:clear-runs", () => {
  it("returns the count of deleted rows", async () => {
    mockDbState.rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const handler = capturedHandlers.get("factory:clear-runs")!;
    const result = (await handler(mockEvent, {})) as { count: number };
    expect(result.count).toBe(3);
  });

  it("returns count:0 when there are no rows", async () => {
    mockDbState.rows = [];
    const handler = capturedHandlers.get("factory:clear-runs")!;
    const result = (await handler(mockEvent, {})) as { count: number };
    expect(result.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// factory:update-run-status
// ---------------------------------------------------------------------------

describe("factory:update-run-status", () => {
  it("returns success:true on a successful status update", async () => {
    const handler = capturedHandlers.get("factory:update-run-status")!;
    const result = (await handler(mockEvent, {
      id: 1,
      status: "QUEUED",
    })) as { success: boolean };
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// factory:update-launch-outcome
// ---------------------------------------------------------------------------

describe("factory:update-launch-outcome", () => {
  it("returns success:false when run is not found", async () => {
    mockDbState.rows = []; // select returns empty → not found
    const handler = capturedHandlers.get("factory:update-launch-outcome")!;
    const result = (await handler(mockEvent, {
      id: 99,
      outcome: { launched: true, revenueGenerated: false, notes: "" },
    })) as { success: boolean };
    expect(result.success).toBe(false);
  });

  it("returns success:true when run exists and update succeeds", async () => {
    const idea = makeIdea();
    mockDbState.rows = [{ id: 10, ideaJson: JSON.stringify(idea) }];
    const handler = capturedHandlers.get("factory:update-launch-outcome")!;
    const result = (await handler(mockEvent, {
      id: 10,
      outcome: { launched: true, revenueGenerated: true, notes: "First sale!" },
    })) as { success: boolean };
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// factory:export-runs
// ---------------------------------------------------------------------------

describe("factory:export-runs", () => {
  it("returns success:false when the user cancels the save dialog", async () => {
    // Dialog mock already returns { canceled: true } by default
    const handler = capturedHandlers.get("factory:export-runs")!;
    const result = (await handler(mockEvent, {})) as {
      success: boolean;
    };
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// factory:list-outcomes (PR #5)
// ---------------------------------------------------------------------------

describe("factory:list-outcomes", () => {
  it("returns quantitative rows from launch_outcomes when they exist", async () => {
    // The mock DB chain returns mockDbState.rows on first select call (launch_outcomes).
    mockDbState.rows = [
      {
        id: 1,
        runId: 42,
        revenueUsd: 5000,
        conversions: 3,
        views: 200,
        churn30d: null,
        source: "manual",
        capturedAt: 1700000000,
      },
    ];
    const handler = capturedHandlers.get("factory:list-outcomes")!;
    const result = (await handler(mockEvent, { runId: 42 })) as {
      outcomes: {
        id: number;
        runId: number;
        revenueUsd: number | null;
        conversions: number | null;
        views: number | null;
        source: string | null;
        capturedAt: number;
      }[];
    };
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].revenueUsd).toBe(5000);
    expect(result.outcomes[0].conversions).toBe(3);
    expect(result.outcomes[0].source).toBe("manual");
    expect(result.outcomes[0].capturedAt).toBe(1700000000);
  });

  it("falls back to legacy mapping when launch_outcomes is empty and run has a launchOutcome blob", async () => {
    // First select (launch_outcomes table) returns [] — no quantitative rows.
    // Second select (factory_runs fallback) returns a run with a legacy blob.
    let callCount = 0;
    const { db } = await import("@/db");
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      function makeChain(
        rows: Record<string, unknown>[],
      ): Record<string, unknown> {
        const chain: Record<string, unknown> = {
          from: (..._: unknown[]) => chain,
          where: (..._: unknown[]) => chain,
          orderBy: (..._: unknown[]) => chain,
          set: (..._: unknown[]) => chain,
          values: (..._: unknown[]) => chain,
          limit: (..._: unknown[]) => Promise.resolve(rows),
          returning: (..._: unknown[]) => Promise.resolve([{ id: 1 }]),
          // eslint-disable-next-line unicorn/no-thenable
          then: (
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) => Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      }
      if (callCount === 1) {
        // launch_outcomes query → empty
        return makeChain([]) as any;
      }
      // factory_runs fallback query
      return makeChain([
        {
          id: 42,
          launchOutcome: JSON.stringify({
            launched: true,
            revenueGenerated: true,
            notes: "First sale!",
          }),
          createdAt: 1700000000,
        },
      ]) as any;
    });

    const handler = capturedHandlers.get("factory:list-outcomes")!;
    const result = (await handler(mockEvent, { runId: 42 })) as {
      outcomes: {
        id: number;
        source: string | null;
        revenueUsd: number | null;
        conversions: number | null;
      }[];
    };
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].source).toBe("legacy");
    expect(result.outcomes[0].revenueUsd).toBe(1);
    expect(result.outcomes[0].conversions).toBe(1);
    expect(result.outcomes[0].id).toBe(-1);
  });

  it("returns empty outcomes when run has no launchOutcome blob", async () => {
    let callCount = 0;
    const { db } = await import("@/db");
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      function makeChain(
        rows: Record<string, unknown>[],
      ): Record<string, unknown> {
        const chain: Record<string, unknown> = {
          from: (..._: unknown[]) => chain,
          where: (..._: unknown[]) => chain,
          orderBy: (..._: unknown[]) => chain,
          set: (..._: unknown[]) => chain,
          values: (..._: unknown[]) => chain,
          limit: (..._: unknown[]) => Promise.resolve(rows),
          returning: (..._: unknown[]) => Promise.resolve([{ id: 1 }]),
          // eslint-disable-next-line unicorn/no-thenable
          then: (
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) => Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      }
      if (callCount === 1) return makeChain([]) as any;
      return makeChain([
        { id: 7, launchOutcome: null, createdAt: 1700000000 },
      ]) as any;
    });

    const handler = capturedHandlers.get("factory:list-outcomes")!;
    const result = (await handler(mockEvent, { runId: 7 })) as {
      outcomes: unknown[];
    };
    expect(result.outcomes).toHaveLength(0);
  });

  it("returns empty outcomes when the legacy blob is corrupt JSON", async () => {
    let callCount = 0;
    const { db } = await import("@/db");
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      function makeChain(
        rows: Record<string, unknown>[],
      ): Record<string, unknown> {
        const chain: Record<string, unknown> = {
          from: (..._: unknown[]) => chain,
          where: (..._: unknown[]) => chain,
          orderBy: (..._: unknown[]) => chain,
          set: (..._: unknown[]) => chain,
          values: (..._: unknown[]) => chain,
          limit: (..._: unknown[]) => Promise.resolve(rows),
          returning: (..._: unknown[]) => Promise.resolve([{ id: 1 }]),
          // eslint-disable-next-line unicorn/no-thenable
          then: (
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) => Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      }
      if (callCount === 1) return makeChain([]) as any;
      return makeChain([
        { id: 8, launchOutcome: "{{not json}}", createdAt: 1700000000 },
      ]) as any;
    });

    const handler = capturedHandlers.get("factory:list-outcomes")!;
    const result = (await handler(mockEvent, { runId: 8 })) as {
      outcomes: unknown[];
    };
    expect(result.outcomes).toHaveLength(0);
  });

  it("returns empty outcomes when the legacy blob parses to null (corrupt value)", async () => {
    let callCount = 0;
    const { db } = await import("@/db");
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      function makeChain(
        rows: Record<string, unknown>[],
      ): Record<string, unknown> {
        const chain: Record<string, unknown> = {
          from: (..._: unknown[]) => chain,
          where: (..._: unknown[]) => chain,
          orderBy: (..._: unknown[]) => chain,
          set: (..._: unknown[]) => chain,
          values: (..._: unknown[]) => chain,
          limit: (..._: unknown[]) => Promise.resolve(rows),
          returning: (..._: unknown[]) => Promise.resolve([{ id: 1 }]),
          // eslint-disable-next-line unicorn/no-thenable
          then: (
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) => Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      }
      if (callCount === 1) return makeChain([]) as any;
      // "null" is valid JSON but fails the type guard (not an object)
      return makeChain([
        { id: 9, launchOutcome: "null", createdAt: 1700000000 },
      ]) as any;
    });

    const handler = capturedHandlers.get("factory:list-outcomes")!;
    const result = (await handler(mockEvent, { runId: 9 })) as {
      outcomes: unknown[];
    };
    expect(result.outcomes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// factory:scaffold-app (PR #6)
// ---------------------------------------------------------------------------

describe("factory:scaffold-app", () => {
  // Reset fs/socket mocks before each test in this suite
  beforeEach(async () => {
    const fsp = await import("fs/promises");
    const fileUtils = await import("@/ipc/utils/file_utils");
    const socketFirewall = await import("@/ipc/utils/socket_firewall");
    vi.mocked(fsp.rm).mockResolvedValue(undefined);
    vi.mocked(fsp.readFile).mockResolvedValue("" as any);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.stat).mockResolvedValue({ isDirectory: () => true } as any);
    vi.mocked(fileUtils.copyDirectoryRecursive).mockResolvedValue(undefined);
    vi.mocked(socketFirewall.runCommand).mockResolvedValue({
      stdout: "",
      stderr: "",
    });
  });

  it("returns previewPath and logs on a successful scaffold", async () => {
    const handler = capturedHandlers.get("factory:scaffold-app")!;
    const result = (await handler(mockEvent, {
      runId: 1,
      appName: "Invoice Pro UAE",
      tagline: "Fast invoices for UAE freelancers",
    })) as { previewPath: string; logs: string[] };

    expect(result.previewPath).toContain("dist");
    expect(Array.isArray(result.logs)).toBe(true);
    expect(result.logs.some((l) => l.includes("npm install completed"))).toBe(
      true,
    );
    expect(result.logs.some((l) => l.includes("npm run build completed"))).toBe(
      true,
    );
  });

  it("calls copyDirectoryRecursive and runCommand with correct arguments", async () => {
    const fileUtils = await import("@/ipc/utils/file_utils");
    const socketFirewall = await import("@/ipc/utils/socket_firewall");
    const handler = capturedHandlers.get("factory:scaffold-app")!;
    await handler(mockEvent, {
      runId: 2,
      appName: "Test App",
    });

    expect(vi.mocked(fileUtils.copyDirectoryRecursive)).toHaveBeenCalledOnce();
    // npm install call
    expect(vi.mocked(socketFirewall.runCommand)).toHaveBeenCalledWith(
      "npm",
      ["install", "--legacy-peer-deps"],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    // npm run build call
    expect(vi.mocked(socketFirewall.runCommand)).toHaveBeenCalledWith(
      "npm",
      ["run", "build"],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("clears the existing destDir before copying (rm called)", async () => {
    const fsp = await import("fs/promises");
    const handler = capturedHandlers.get("factory:scaffold-app")!;
    await handler(mockEvent, { runId: 3, appName: "Clean Slate App" });
    expect(vi.mocked(fsp.rm)).toHaveBeenCalledWith(
      expect.stringContaining("clean-slate-app"),
      { recursive: true, force: true },
    );
  });

  it("throws DyadError(ScaffoldFailure) when npm install fails", async () => {
    const socketFirewall = await import("@/ipc/utils/socket_firewall");
    vi.mocked(socketFirewall.runCommand).mockRejectedValueOnce(
      new Error("ENOENT: npm not found"),
    );
    const handler = capturedHandlers.get("factory:scaffold-app")!;
    await expect(
      handler(mockEvent, { runId: 4, appName: "Failing App" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.ScaffoldFailure });
  });

  it("throws DyadError(ScaffoldFailure) when npm run build fails", async () => {
    const socketFirewall = await import("@/ipc/utils/socket_firewall");
    // First call (npm install) succeeds; second call (npm run build) fails
    vi.mocked(socketFirewall.runCommand)
      .mockResolvedValueOnce({ stdout: "added 100 packages", stderr: "" })
      .mockRejectedValueOnce(new Error("TypeScript error TS2345"));
    const handler = capturedHandlers.get("factory:scaffold-app")!;
    await expect(
      handler(mockEvent, { runId: 5, appName: "Build Fail App" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.ScaffoldFailure });
  });

  it("throws DyadError(ScaffoldFailure) when dist/ is missing after build", async () => {
    const fsp = await import("fs/promises");
    vi.mocked(fsp.stat).mockRejectedValueOnce(
      Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      }),
    );
    const handler = capturedHandlers.get("factory:scaffold-app")!;
    await expect(
      handler(mockEvent, { runId: 6, appName: "No Dist App" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.ScaffoldFailure });
  });

  it("throws DyadError(ScaffoldFailure) when dist/ exists but is not a directory", async () => {
    const fsp = await import("fs/promises");
    vi.mocked(fsp.stat).mockResolvedValueOnce({
      isDirectory: () => false,
    } as any);
    const handler = capturedHandlers.get("factory:scaffold-app")!;
    await expect(
      handler(mockEvent, { runId: 7, appName: "File Not Dir" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.ScaffoldFailure });
  });

  it("patches index.html with the app name", async () => {
    const fsp = await import("fs/promises");
    vi.mocked(fsp.readFile).mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith("index.html")) {
        return Promise.resolve(
          "<title>dyad-generated-app</title>",
        ) as Promise<any>;
      }
      return Promise.resolve("") as Promise<any>;
    });
    const handler = capturedHandlers.get("factory:scaffold-app")!;
    await handler(mockEvent, {
      runId: 8,
      appName: "Salary<&>Tool",
      tagline: "Fast",
    });
    // writeFile should have been called with an escaped title
    const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
    const htmlWrite = writeCalls.find((c) =>
      String(c[0]).endsWith("index.html"),
    );
    expect(htmlWrite).toBeDefined();
    expect(String(htmlWrite![1])).toContain("&lt;");
    expect(String(htmlWrite![1])).toContain("&amp;");
  });

  it("uses JSON.stringify-safe substitution for JSX codemod", async () => {
    const fsp = await import("fs/promises");
    vi.mocked(fsp.readFile).mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith("Index.tsx")) {
        return Promise.resolve(
          "Welcome to Your Blank App\nStart building your amazing project here!",
        ) as Promise<any>;
      }
      return Promise.resolve("") as Promise<any>;
    });
    const handler = capturedHandlers.get("factory:scaffold-app")!;
    await handler(mockEvent, {
      runId: 9,
      appName: 'App with "quotes" and $pecial chars',
      tagline: "Tag with {braces} & more",
    });
    const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
    const tsxWrite = writeCalls.find((c) => String(c[0]).endsWith("Index.tsx"));
    expect(tsxWrite).toBeDefined();
    const output = String(tsxWrite![1]);
    // The $ and { characters should appear literally (escaped via JSON.stringify)
    expect(output).toContain("$pecial");
    expect(output).toContain("{braces}");
    // Should not contain the original placeholders
    expect(output).not.toContain("Welcome to Your Blank App");
    expect(output).not.toContain("Start building your amazing project here!");
  });

  // -------------------------------------------------------------------------
  // PR #7 — brand.css codemod
  // -------------------------------------------------------------------------

  it("writes brand.css with generated CSS when primaryColor is provided", async () => {
    const fsp = await import("fs/promises");
    const handler = capturedHandlers.get("factory:scaffold-app")!;
    await handler(mockEvent, {
      runId: 10,
      appName: "Brand App",
      primaryColor: "#4F46E5",
    });
    const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
    const brandWrite = writeCalls.find((c) =>
      String(c[0]).endsWith("brand.css"),
    );
    expect(brandWrite).toBeDefined();
    const css = String(brandWrite![1]);
    expect(css).toContain("DYAD:BRAND_CSS");
    expect(css).toContain("--primary:");
    expect(css).toContain("--ring:");
  });

  it("does not throw and logs a warning when primaryColor is invalid", async () => {
    const fsp = await import("fs/promises");
    const handler = capturedHandlers.get("factory:scaffold-app")!;
    const result = (await handler(mockEvent, {
      runId: 11,
      appName: "Bad Color App",
      primaryColor: "not-a-hex",
    })) as { previewPath: string; logs: string[] };

    // Should complete successfully (no throw)
    expect(result.previewPath).toContain("dist");
    // Warning should appear in the logs
    expect(result.logs.some((l) => l.includes("Warning"))).toBe(true);
    // brand.css should NOT have been written (writeFile not called for brand.css)
    const brandWrite = vi
      .mocked(fsp.writeFile)
      .mock.calls.find((c) => String(c[0]).endsWith("brand.css"));
    expect(brandWrite).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// factory:generate-launch-kit
// ---------------------------------------------------------------------------

/** Minimal valid LaunchKit JSON string the mock LLM returns. */
function makeLaunchKitJson(): string {
  return JSON.stringify({
    elevatorPitch: "Automate invoices for UAE freelancers in one click.",
    twitterPost:
      "Tired of chasing payments? InvoicePro UAE automates it. #freelance #UAE",
    linkedinPost:
      "Excited to announce InvoicePro UAE — the fastest invoice tool for UAE freelancers.\n\nNo more chasing late payments. Try it free.",
    heroHeadline: "Invoices that pay themselves",
    heroSubtext: "Built for UAE freelancers. Set up in 5 minutes.",
    emailSubject: "Your invoices just got smarter",
    emailBody:
      "Hi [Name],\n\nI wanted to reach out because InvoicePro UAE solves the payment-chasing problem that costs UAE freelancers hours every month.\n\nHere's how it works: you send an invoice, we handle the follow-up.\n\nWould you be open to a quick 15-minute call?\n\nBest, [Founder]",
    deployChecklist: [
      "Push the scaffolded app to a new GitHub repository.",
      "Connect the repository to Vercel via vercel.com/new.",
      "Set any required environment variables in the Vercel project settings.",
      "Trigger a production deployment and verify the live URL.",
      "Share the Vercel URL and collect your first 3 signups.",
    ],
  });
}

/**
 * Restores db.select to the standard mockDbState-based chain.
 *
 * Some earlier tests (factory:list-outcomes) override db.select with a
 * callCount-based implementation. vi.clearAllMocks() only clears call
 * history, not the implementation. Call this in a beforeEach for any
 * describe block that needs the standard mockDbState behaviour.
 */
async function restoreDbSelectToMockChain(): Promise<void> {
  const { db: dbModule } = await import("@/db");
  vi.mocked(dbModule.select).mockImplementation(() => {
    const chain: Record<string, unknown> = {
      from: (..._: unknown[]) => chain,
      where: (..._: unknown[]) => chain,
      orderBy: (..._: unknown[]) => chain,
      set: (..._: unknown[]) => chain,
      values: (..._: unknown[]) => chain,
      limit: (..._: unknown[]) => Promise.resolve(mockDbState.rows),
      returning: (..._: unknown[]) =>
        Promise.resolve([{ id: mockDbState.insertedId }]),
      // eslint-disable-next-line unicorn/no-thenable
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
      ) => Promise.resolve(mockDbState.rows).then(resolve, reject),
    };
    return chain as unknown as ReturnType<typeof dbModule.select>;
  });
}

describe("factory:generate-launch-kit", () => {
  beforeEach(restoreDbSelectToMockChain);
  it("returns a valid LaunchKit from a successful LLM response", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    mockDbState.rows = [
      {
        id: 1,
        ideaJson: JSON.stringify({
          idea: "Invoice automation for Dubai freelancers",
          name: "InvoicePro UAE",
          buyer: "Freelancers in UAE",
          scores: {
            buyerClarity: 4,
            painUrgency: 4,
            marketExistence: 3,
            differentiation: 3,
            replaceability: 3,
            virality: 3,
            monetisation: 4,
            buildSimplicity: 4,
          },
          totalScore: 28,
          decision: "BUILD",
          reason: "Strong",
          improvedIdea: "",
          buildPrompt: "Build an invoice SaaS",
          monetisationAngle: "Monthly subscription",
          viralTrigger: "Share your invoice",
          fallbackUsed: false,
        }),
        status: "DECIDED",
        fingerprint: "fp1",
        createdAt: 1_700_000_000,
        launchOutcome: null,
        promptVersion: "v3.2",
        promptHash: "hash1",
        modelVersion: "gpt-4o-mini-2024-07-18",
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFakeOpenAIResponse(makeLaunchKitJson())),
    );

    const handler = capturedHandlers.get("factory:generate-launch-kit")!;
    const result = (await handler(mockEvent, { runId: 1 })) as {
      elevatorPitch: string;
      twitterPost: string;
      deployChecklist: string[];
    };

    expect(result.elevatorPitch).toBeTruthy();
    expect(result.twitterPost.length).toBeLessThanOrEqual(280);
    expect(Array.isArray(result.deployChecklist)).toBe(true);
    expect(result.deployChecklist.length).toBeGreaterThan(0);
  });

  it("throws DyadError(NotFound) when the run does not exist", async () => {
    mockDbState.rows = [];
    process.env.OPENAI_API_KEY = "sk-test";
    const handler = capturedHandlers.get("factory:generate-launch-kit")!;
    await expect(handler(mockEvent, { runId: 999 })).rejects.toMatchObject({
      kind: DyadErrorKind.NotFound,
    });
  });

  it("throws DyadError(InvalidLlmResponse) when LLM returns invalid JSON", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    mockDbState.rows = [
      {
        id: 2,
        ideaJson: JSON.stringify({
          idea: "test",
          name: "Test App",
          buyer: "Buyers",
          scores: {
            buyerClarity: 4,
            painUrgency: 4,
            marketExistence: 3,
            differentiation: 3,
            replaceability: 3,
            virality: 3,
            monetisation: 4,
            buildSimplicity: 4,
          },
          totalScore: 28,
          decision: "BUILD",
          reason: "ok",
          improvedIdea: "",
          buildPrompt: "Build it",
          monetisationAngle: "sub",
          viralTrigger: "share",
          fallbackUsed: false,
        }),
        status: "DECIDED",
        fingerprint: "fp2",
        createdAt: 1_700_000_001,
        launchOutcome: null,
        promptVersion: "v3.2",
        promptHash: "hash2",
        modelVersion: "gpt-4o-mini-2024-07-18",
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFakeOpenAIResponse("not valid json")),
    );

    const handler = capturedHandlers.get("factory:generate-launch-kit")!;
    await expect(handler(mockEvent, { runId: 2 })).rejects.toMatchObject({
      kind: DyadErrorKind.InvalidLlmResponse,
    });
  });

  it("strips markdown fences before parsing", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    mockDbState.rows = [
      {
        id: 3,
        ideaJson: JSON.stringify({
          idea: "test",
          name: "Test App",
          buyer: "Buyers",
          scores: {
            buyerClarity: 4,
            painUrgency: 4,
            marketExistence: 3,
            differentiation: 3,
            replaceability: 3,
            virality: 3,
            monetisation: 4,
            buildSimplicity: 4,
          },
          totalScore: 28,
          decision: "BUILD",
          reason: "ok",
          improvedIdea: "",
          buildPrompt: "Build it",
          monetisationAngle: "sub",
          viralTrigger: "share",
          fallbackUsed: false,
        }),
        status: "DECIDED",
        fingerprint: "fp3",
        createdAt: 1_700_000_002,
        launchOutcome: null,
        promptVersion: "v3.2",
        promptHash: "hash3",
        modelVersion: "gpt-4o-mini-2024-07-18",
      },
    ];

    const fencedResponse = "```json\n" + makeLaunchKitJson() + "\n```";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFakeOpenAIResponse(fencedResponse)),
    );

    const handler = capturedHandlers.get("factory:generate-launch-kit")!;
    const result = (await handler(mockEvent, { runId: 3 })) as {
      elevatorPitch: string;
    };
    expect(result.elevatorPitch).toBeTruthy();
  });

  it("throws DyadError(LaunchKitFailure) wrapping MissingApiKey when no API key is set", async () => {
    delete process.env.OPENAI_API_KEY;
    mockDbState.rows = [
      {
        id: 4,
        ideaJson: JSON.stringify({
          idea: "test",
          name: "Test App",
          buyer: "Buyers",
          scores: {
            buyerClarity: 4,
            painUrgency: 4,
            marketExistence: 3,
            differentiation: 3,
            replaceability: 3,
            virality: 3,
            monetisation: 4,
            buildSimplicity: 4,
          },
          totalScore: 28,
          decision: "BUILD",
          reason: "ok",
          improvedIdea: "",
          buildPrompt: "Build it",
          monetisationAngle: "sub",
          viralTrigger: "share",
          fallbackUsed: false,
        }),
        status: "DECIDED",
        fingerprint: "fp4",
        createdAt: 1_700_000_003,
        launchOutcome: null,
        promptVersion: "v3.2",
        promptHash: "hash4",
        modelVersion: "gpt-4o-mini-2024-07-18",
      },
    ];

    const handler = capturedHandlers.get("factory:generate-launch-kit")!;
    await expect(handler(mockEvent, { runId: 4 })).rejects.toMatchObject({
      kind: DyadErrorKind.LaunchKitFailure,
    });
  });
});

// ---------------------------------------------------------------------------
// factory:export-launch-kit
// ---------------------------------------------------------------------------

describe("factory:export-launch-kit", () => {
  beforeEach(restoreDbSelectToMockChain);
  const validKit = {
    elevatorPitch: "Automate invoices for UAE freelancers.",
    twitterPost: "Invoice automation for UAE freelancers! #freelance",
    linkedinPost: "Excited to announce InvoicePro UAE.",
    heroHeadline: "Invoices that pay themselves",
    heroSubtext: "Built for UAE freelancers.",
    emailSubject: "Your invoices just got smarter",
    emailBody: "Hi [Name], check out InvoicePro UAE.",
    deployChecklist: ["Push to GitHub.", "Connect to Vercel.", "Deploy."],
  };

  it("writes launch-kit files and returns the directory path", async () => {
    const fsp = await import("fs/promises");
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined as any);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    mockDbState.rows = [
      {
        id: 5,
        ideaJson: JSON.stringify({ name: "InvoicePro UAE" }),
        status: "DECIDED",
        fingerprint: "fp5",
        createdAt: 1_700_000_004,
        launchOutcome: null,
        promptVersion: "v3.2",
        promptHash: "hash5",
        modelVersion: "gpt-4o-mini-2024-07-18",
      },
    ];

    const handler = capturedHandlers.get("factory:export-launch-kit")!;
    const result = (await handler(mockEvent, { runId: 5, kit: validKit })) as {
      path: string;
    };

    // Path should be under factory-apps/<slug>/launch-kit
    expect(result.path).toContain("launch-kit");
    expect(result.path).toContain("invoicepro-uae");

    // mkdir should have been called once (recursive)
    expect(vi.mocked(fsp.mkdir)).toHaveBeenCalled();

    // writeFile should have been called 6 times (one per kit file)
    const kitWrites = vi
      .mocked(fsp.writeFile)
      .mock.calls.filter((c) => String(c[0]).includes("launch-kit"));
    expect(kitWrites.length).toBe(6);

    // elevator-pitch.md should contain the pitch text
    const pitchWrite = kitWrites.find((c) =>
      String(c[0]).endsWith("elevator-pitch.md"),
    );
    expect(pitchWrite).toBeDefined();
    expect(String(pitchWrite![1])).toContain(validKit.elevatorPitch);

    // deploy-checklist.md should contain numbered steps
    const checklistWrite = kitWrites.find((c) =>
      String(c[0]).endsWith("deploy-checklist.md"),
    );
    expect(checklistWrite).toBeDefined();
    expect(String(checklistWrite![1])).toContain("1. Push to GitHub.");
  });

  it("throws DyadError(NotFound) when the run does not exist", async () => {
    mockDbState.rows = [];
    const handler = capturedHandlers.get("factory:export-launch-kit")!;
    await expect(
      handler(mockEvent, { runId: 999, kit: validKit }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.NotFound });
  });

  it("uses a fallback slug when idea name is missing", async () => {
    const fsp = await import("fs/promises");
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined as any);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    mockDbState.rows = [
      {
        id: 6,
        ideaJson: JSON.stringify({}), // no "name" field
        status: "DECIDED",
        fingerprint: "fp6",
        createdAt: 1_700_000_005,
        launchOutcome: null,
        promptVersion: "v3.2",
        promptHash: "hash6",
        modelVersion: "gpt-4o-mini-2024-07-18",
      },
    ];

    const handler = capturedHandlers.get("factory:export-launch-kit")!;
    const result = (await handler(mockEvent, { runId: 6, kit: validKit })) as {
      path: string;
    };
    // Fallback slug should include the runId
    expect(result.path).toContain("run-6");
  });
});

// ---------------------------------------------------------------------------
// LAUNCH_KIT_PROMPT helper
// ---------------------------------------------------------------------------

describe("LAUNCH_KIT_PROMPT", () => {
  it("includes the idea name and buyer in the prompt", () => {
    const idea = {
      idea: "Invoice automation for Dubai freelancers",
      name: "InvoicePro UAE",
      buyer: "Freelancers in UAE",
      scores: {
        buyerClarity: 4,
        painUrgency: 4,
        marketExistence: 3,
        differentiation: 3,
        replaceability: 3,
        virality: 3,
        monetisation: 4,
        buildSimplicity: 4,
      },
      totalScore: 28,
      decision: "BUILD" as const,
      reason: "ok",
      improvedIdea: "",
      buildPrompt: "Build an invoice SaaS",
      monetisationAngle: "Monthly subscription",
      viralTrigger: "Share invoice",
      fallbackUsed: false,
    };
    const prompt = LAUNCH_KIT_PROMPT(idea);
    expect(prompt).toContain("InvoicePro UAE");
    expect(prompt).toContain("Freelancers in UAE");
    expect(prompt).toContain("deployChecklist");
  });
});

// ---------------------------------------------------------------------------
// PR #9 — Embedding-based novelty / dedup in factory:save-run
// ---------------------------------------------------------------------------

/** Helper to build a two-call select mock (fingerprint check, then all rows). */
async function makeTwoSelectMock(
  fingerprintRows: Record<string, unknown>[],
  allRows: Record<string, unknown>[],
) {
  const { db } = await import("@/db");
  let callCount = 0;
  vi.mocked(db.select).mockReset(); // clear any leftover impl from previous test
  vi.mocked(db.select).mockImplementation(() => {
    callCount++;
    function makeChain(
      rows: Record<string, unknown>[],
    ): Record<string, unknown> {
      const chain: Record<string, unknown> = {
        from: (..._: unknown[]) => chain,
        where: (..._: unknown[]) => chain,
        orderBy: (..._: unknown[]) => chain,
        set: (..._: unknown[]) => chain,
        values: (..._: unknown[]) => chain,
        limit: (..._: unknown[]) => Promise.resolve(rows),
        returning: (..._: unknown[]) =>
          Promise.resolve([{ id: mockDbState.insertedId }]),
        // eslint-disable-next-line unicorn/no-thenable
        then: (
          resolve: (v: unknown) => unknown,
          reject?: (e: unknown) => unknown,
        ) => Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    }
    if (callCount === 1) return makeChain(fingerprintRows) as any;
    return makeChain(allRows) as any;
  });
}

/** Resets db.select to the default (mockDbState.rows) implementation. */
async function resetDbSelect() {
  const { db } = await import("@/db");
  vi.mocked(db.select).mockReset();
  vi.mocked(db.select).mockImplementation((() => {
    const chain: Record<string, unknown> = {
      from: (..._: unknown[]) => chain,
      where: (..._: unknown[]) => chain,
      orderBy: (..._: unknown[]) => chain,
      set: (..._: unknown[]) => chain,
      values: (..._: unknown[]) => chain,
      limit: (..._: unknown[]) => Promise.resolve(mockDbState.rows),
      returning: (..._: unknown[]) =>
        Promise.resolve([{ id: mockDbState.insertedId }]),
      // eslint-disable-next-line unicorn/no-thenable
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
      ) => Promise.resolve(mockDbState.rows).then(resolve, reject),
    };
    return chain;
  }) as any);
}

describe("factory:save-run — PR #9 embedding-based dedup", () => {
  // Reset db.select between tests so leftover `mockImplementation` closures from
  // makeTwoSelectMock don't bleed into subsequent tests.
  beforeEach(async () => {
    await resetDbSelect();
  });

  it("attaches noveltyScore=1 when no stored embeddings exist", async () => {
    // Two selects: fingerprint → [], all rows → []
    await makeTwoSelectMock([], []);
    mockDbState.insertedId = 20;

    const handler = capturedHandlers.get("factory:save-run")!;
    const result = (await handler(mockEvent, { idea: makeIdea() })) as {
      id: number;
      duplicate: null;
    };
    expect(result.id).toBe(20);
    expect(result.duplicate).toBeNull();
  });

  it("returns semantic duplicate when a stored embedding has similarity ≥ threshold", async () => {
    const existingIdea = makeIdea({ name: "Semantically Similar Idea" });
    const sharedVec = [0.1, 0.2, 0.3]; // same vector → cosine similarity = 1.0 ≥ 0.92

    // First select (fingerprint check) → empty
    // Second select (stored embeddings) → row with the matching vector
    await makeTwoSelectMock(
      [],
      [
        {
          id: 77,
          ideaJson: JSON.stringify(existingIdea),
          status: "DECIDED",
          embedding: JSON.stringify(sharedVec),
        },
      ],
    );

    // fetchEmbedding returns the same vector → similarity 1.0
    mockFetchEmbedding.mockResolvedValueOnce(sharedVec);

    const handler = capturedHandlers.get("factory:save-run")!;
    const result = (await handler(mockEvent, { idea: makeIdea() })) as {
      id: number;
      duplicate: { name: string } | null;
    };
    expect(result.id).toBe(77);
    expect(result.duplicate).not.toBeNull();
    expect(result.duplicate!.name).toBe("Semantically Similar Idea");
  });

  it("does not flag as semantic duplicate when similarity is below threshold", async () => {
    const existingIdea = makeIdea({ name: "Different Idea" });
    // Orthogonal vector → cosine similarity = 0 < 0.92
    const storedVec = [0, 1, 0];
    const newVec = [1, 0, 0];

    await makeTwoSelectMock(
      [],
      [
        {
          id: 10,
          ideaJson: JSON.stringify(existingIdea),
          status: "DECIDED",
          embedding: JSON.stringify(storedVec),
        },
      ],
    );
    mockDbState.insertedId = 99;
    mockFetchEmbedding.mockResolvedValueOnce(newVec);

    const handler = capturedHandlers.get("factory:save-run")!;
    const result = (await handler(mockEvent, { idea: makeIdea() })) as {
      id: number;
      duplicate: null;
    };
    expect(result.id).toBe(99);
    expect(result.duplicate).toBeNull();
  });

  it("skips embedding check and inserts normally when factoryEmbeddingDedup=false", async () => {
    mockSettingsState.factoryEmbeddingDedup = false;
    mockDbState.rows = [];
    mockDbState.insertedId = 55;

    const handler = capturedHandlers.get("factory:save-run")!;
    const result = (await handler(mockEvent, { idea: makeIdea() })) as {
      id: number;
      duplicate: null;
    };
    expect(result.id).toBe(55);
    expect(result.duplicate).toBeNull();
    // fetchEmbedding should NOT have been called
    expect(mockFetchEmbedding).not.toHaveBeenCalled();
  });

  it("falls through to insert when fetchEmbedding throws (non-fatal)", async () => {
    // fetchEmbedding fails (e.g. network error) → embedding is skipped, insert proceeds
    mockFetchEmbedding.mockRejectedValueOnce(new Error("network failure"));
    // Both selects return empty (fingerprint check + all rows)
    await makeTwoSelectMock([], []);
    mockDbState.insertedId = 33;

    const handler = capturedHandlers.get("factory:save-run")!;
    const result = (await handler(mockEvent, { idea: makeIdea() })) as {
      id: number;
      duplicate: null;
    };
    expect(result.id).toBe(33);
    expect(result.duplicate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PR #9 — factory:get-similar-runs
// ---------------------------------------------------------------------------

describe("factory:get-similar-runs", () => {
  beforeEach(async () => {
    await resetDbSelect();
  });

  it("returns runs sorted by cosine similarity descending", async () => {
    const queryVec = [1, 0, 0];
    const closerVec = [0.9, 0.1, 0]; // higher similarity to queryVec
    const fartherVec = [0, 0, 1]; // orthogonal → similarity ≈ 0

    const ideaClose = makeIdea({ name: "Close Idea" });
    const ideaFar = makeIdea({ name: "Far Idea" });

    const { db } = await import("@/db");
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select).mockImplementationOnce(() => {
      function makeChain(
        rows: Record<string, unknown>[],
      ): Record<string, unknown> {
        const chain: Record<string, unknown> = {
          from: (..._: unknown[]) => chain,
          where: (..._: unknown[]) => chain,
          orderBy: (..._: unknown[]) => chain,
          set: (..._: unknown[]) => chain,
          values: (..._: unknown[]) => chain,
          limit: (..._: unknown[]) => Promise.resolve(rows),
          returning: (..._: unknown[]) => Promise.resolve([{ id: 1 }]),
          // eslint-disable-next-line unicorn/no-thenable
          then: (
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) => Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      }
      return makeChain([
        {
          id: 1,
          ideaJson: JSON.stringify(ideaFar),
          status: "DECIDED",
          embedding: JSON.stringify(fartherVec),
        },
        {
          id: 2,
          ideaJson: JSON.stringify(ideaClose),
          status: "DECIDED",
          embedding: JSON.stringify(closerVec),
        },
      ]) as any;
    });

    mockFetchEmbedding.mockResolvedValueOnce(queryVec);
    process.env.OPENAI_API_KEY = "sk-test";

    const handler = capturedHandlers.get("factory:get-similar-runs")!;
    const result = (await handler(mockEvent, {
      ideaText: "test idea",
    })) as {
      runs: { name: string; similarity: number }[];
    };

    // Should be sorted by similarity DESC → close idea first
    expect(result.runs.length).toBe(2);
    expect(result.runs[0].name).toBe("Close Idea");
    expect(result.runs[0].similarity).toBeGreaterThan(
      result.runs[1].similarity,
    );
  });

  it("excludes the run matching excludeRunId", async () => {
    const idea = makeIdea({ name: "Target Idea" });
    const otherIdea = makeIdea({ name: "Other Idea" });

    const { db } = await import("@/db");
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select).mockImplementationOnce(() => {
      function makeChain(
        rows: Record<string, unknown>[],
      ): Record<string, unknown> {
        const chain: Record<string, unknown> = {
          from: (..._: unknown[]) => chain,
          where: (..._: unknown[]) => chain,
          orderBy: (..._: unknown[]) => chain,
          set: (..._: unknown[]) => chain,
          values: (..._: unknown[]) => chain,
          limit: (..._: unknown[]) => Promise.resolve(rows),
          returning: (..._: unknown[]) => Promise.resolve([{ id: 1 }]),
          // eslint-disable-next-line unicorn/no-thenable
          then: (
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) => Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      }
      return makeChain([
        {
          id: 5,
          ideaJson: JSON.stringify(idea),
          status: "DECIDED",
          embedding: JSON.stringify([0.1, 0.2, 0.3]),
        },
        {
          id: 6,
          ideaJson: JSON.stringify(otherIdea),
          status: "DECIDED",
          embedding: JSON.stringify([0.1, 0.2, 0.3]),
        },
      ]) as any;
    });

    mockFetchEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);
    process.env.OPENAI_API_KEY = "sk-test";

    const handler = capturedHandlers.get("factory:get-similar-runs")!;
    const result = (await handler(mockEvent, {
      ideaText: "test idea",
      excludeRunId: 5,
    })) as { runs: { name: string }[] };

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].name).toBe("Other Idea");
  });

  it("returns empty array when no runs have embeddings", async () => {
    const { db } = await import("@/db");
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select).mockImplementationOnce(() => {
      function makeChain(
        rows: Record<string, unknown>[],
      ): Record<string, unknown> {
        const chain: Record<string, unknown> = {
          from: (..._: unknown[]) => chain,
          where: (..._: unknown[]) => chain,
          set: (..._: unknown[]) => chain,
          values: (..._: unknown[]) => chain,
          limit: (..._: unknown[]) => Promise.resolve(rows),
          returning: (..._: unknown[]) => Promise.resolve([{ id: 1 }]),
          // eslint-disable-next-line unicorn/no-thenable
          then: (
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) => Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      }
      return makeChain([
        {
          id: 3,
          ideaJson: JSON.stringify(makeIdea()),
          status: "DECIDED",
          embedding: null, // no embedding stored
        },
      ]) as any;
    });

    mockFetchEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);
    process.env.OPENAI_API_KEY = "sk-test";

    const handler = capturedHandlers.get("factory:get-similar-runs")!;
    const result = (await handler(mockEvent, {
      ideaText: "test idea",
    })) as { runs: unknown[] };

    expect(result.runs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PR #11 — factory:deploy-app
// ---------------------------------------------------------------------------

describe("factory:deploy-app", () => {
  beforeEach(restoreDbSelectToMockChain);

  it("throws NotFound when the run does not exist in DB", async () => {
    mockDbState.rows = [];
    const handler = capturedHandlers.get("factory:deploy-app")!;
    await expect(
      handler(mockEvent, { runId: 999, provider: "vercel" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.NotFound });
  });

  it("throws Auth when Vercel token is not configured", async () => {
    mockDbState.rows = [{ id: 1, ideaJson: JSON.stringify(makeIdea()) }];
    mockSettingsState.vercelAccessToken = undefined;
    const handler = capturedHandlers.get("factory:deploy-app")!;
    await expect(
      handler(mockEvent, { runId: 1, provider: "vercel" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Auth });
  });

  it("throws Auth when Netlify token is not configured", async () => {
    mockDbState.rows = [{ id: 1, ideaJson: JSON.stringify(makeIdea()) }];
    mockSettingsState.netlifyAccessToken = undefined;
    const handler = capturedHandlers.get("factory:deploy-app")!;
    await expect(
      handler(mockEvent, { runId: 1, provider: "netlify" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Auth });
  });

  it("deploys to Vercel and returns url when token is present and API succeeds", async () => {
    const {
      readdir: mockReaddir,
      readFile: mockReadFile,
      stat: mockStat,
    } = await import("fs/promises");

    // Simulate dist/ with a single file: index.html
    vi.mocked(mockReaddir).mockResolvedValueOnce(["index.html"] as any);
    vi.mocked(mockStat).mockResolvedValueOnce({
      isDirectory: () => true, // dist/ exists
    } as any);
    vi.mocked(mockStat).mockResolvedValueOnce({
      isDirectory: () => false, // index.html is a file
    } as any);
    vi.mocked(mockReadFile).mockResolvedValueOnce(
      Buffer.from("<!doctype html><html/>") as any,
    );

    mockDbState.rows = [{ id: 1, ideaJson: JSON.stringify(makeIdea()) }];
    mockSettingsState.vercelAccessToken = { value: "test-vercel-token" };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ url: "my-app-abc123.vercel.app", id: "dpl_xxx" }),
        text: () => Promise.resolve(""),
      }),
    );

    const handler = capturedHandlers.get("factory:deploy-app")!;
    const result = (await handler(mockEvent, {
      runId: 1,
      provider: "vercel",
    })) as { url: string; provider: string };

    expect(result.url).toBe("https://my-app-abc123.vercel.app");
    expect(result.provider).toBe("vercel");
  });

  it("throws DeployFailure when Vercel API returns non-ok response", async () => {
    const {
      readdir: mockReaddir,
      readFile: mockReadFile,
      stat: mockStat,
    } = await import("fs/promises");

    vi.mocked(mockReaddir).mockResolvedValueOnce(["index.html"] as any);
    vi.mocked(mockStat).mockResolvedValueOnce({
      isDirectory: () => true,
    } as any);
    vi.mocked(mockStat).mockResolvedValueOnce({
      isDirectory: () => false,
    } as any);
    vi.mocked(mockReadFile).mockResolvedValueOnce(
      Buffer.from("<html/>") as any,
    );

    mockDbState.rows = [{ id: 1, ideaJson: JSON.stringify(makeIdea()) }];
    mockSettingsState.vercelAccessToken = { value: "bad-token" };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      }),
    );

    const handler = capturedHandlers.get("factory:deploy-app")!;
    await expect(
      handler(mockEvent, { runId: 1, provider: "vercel" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.DeployFailure });
  });

  it("deploys to Netlify and returns url when token is present and API succeeds", async () => {
    const {
      readdir: mockReaddir,
      readFile: mockReadFile,
      stat: mockStat,
    } = await import("fs/promises");

    // Simulate dist/ with a single file: index.html
    vi.mocked(mockReaddir).mockResolvedValueOnce(["index.html"] as any);
    vi.mocked(mockStat).mockResolvedValueOnce({
      isDirectory: () => true, // dist/ directory check
    } as any);
    vi.mocked(mockStat).mockResolvedValueOnce({
      isDirectory: () => false, // index.html is a file
    } as any);
    vi.mocked(mockReadFile).mockResolvedValueOnce(
      Buffer.from("<!doctype html><html/>") as any,
    );

    mockDbState.rows = [{ id: 1, ideaJson: JSON.stringify(makeIdea()) }];
    mockSettingsState.netlifyAccessToken = { value: "test-netlify-token" };

    // Mock Netlify API: create site → create deploy (no required files) → done
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        // POST /sites
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: () =>
            Promise.resolve({
              id: "site-abc",
              ssl_url: "https://test-site.netlify.app",
            }),
          text: () => Promise.resolve(""),
        })
        // POST /sites/:id/deploys
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              id: "deploy-xyz",
              required: [], // no files to upload
              ssl_url: "https://test-site.netlify.app",
            }),
          text: () => Promise.resolve(""),
        }),
    );

    const handler = capturedHandlers.get("factory:deploy-app")!;
    const result = (await handler(mockEvent, {
      runId: 1,
      provider: "netlify",
    })) as { url: string; provider: string };

    expect(result.url).toBe("https://test-site.netlify.app");
    expect(result.provider).toBe("netlify");
  });

  it("throws DeployFailure when Netlify site creation fails", async () => {
    const {
      readdir: mockReaddir,
      readFile: mockReadFile,
      stat: mockStat,
    } = await import("fs/promises");

    vi.mocked(mockReaddir).mockResolvedValueOnce(["index.html"] as any);
    vi.mocked(mockStat).mockResolvedValueOnce({
      isDirectory: () => true,
    } as any);
    vi.mocked(mockStat).mockResolvedValueOnce({
      isDirectory: () => false,
    } as any);
    vi.mocked(mockReadFile).mockResolvedValueOnce(
      Buffer.from("<html/>") as any,
    );

    mockDbState.rows = [{ id: 1, ideaJson: JSON.stringify(makeIdea()) }];
    mockSettingsState.netlifyAccessToken = { value: "bad-token" };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      }),
    );

    const handler = capturedHandlers.get("factory:deploy-app")!;
    await expect(
      handler(mockEvent, { runId: 1, provider: "netlify" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.DeployFailure });
  });
});

// ---------------------------------------------------------------------------
// PR #11 — factory:save-netlify-token
// ---------------------------------------------------------------------------

describe("factory:save-netlify-token", () => {
  it("throws Auth when token is empty", async () => {
    const handler = capturedHandlers.get("factory:save-netlify-token")!;
    await expect(handler(mockEvent, { token: "" })).rejects.toMatchObject({
      kind: DyadErrorKind.Auth,
    });
  });

  it("throws Auth when Netlify API rejects the token (401)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    const handler = capturedHandlers.get("factory:save-netlify-token")!;
    await expect(
      handler(mockEvent, { token: "bad-token" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Auth });
  });

  it("throws Auth when Netlify API rejects the token (403)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403 }),
    );
    const handler = capturedHandlers.get("factory:save-netlify-token")!;
    await expect(
      handler(mockEvent, { token: "bad-token" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Auth });
  });

  it("throws DeployFailure when Netlify API returns unexpected non-auth error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    const handler = capturedHandlers.get("factory:save-netlify-token")!;
    await expect(
      handler(mockEvent, { token: "some-token" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.DeployFailure });
  });

  it("throws DeployFailure when network call throws (e.g. offline)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error")),
    );
    const handler = capturedHandlers.get("factory:save-netlify-token")!;
    await expect(
      handler(mockEvent, { token: "some-token" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.DeployFailure });
  });

  it("saves token to settings when Netlify API accepts the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );

    const { writeSettings } = await import("@/main/settings");

    const handler = capturedHandlers.get("factory:save-netlify-token")!;
    await handler(mockEvent, { token: "  netlify_pat_abc123  " });

    expect(vi.mocked(writeSettings)).toHaveBeenCalledWith({
      netlifyAccessToken: { value: "netlify_pat_abc123" },
    });
  });
});

// ---------------------------------------------------------------------------
// PR #12 — factory:save-lemonsqueezy-key
// ---------------------------------------------------------------------------

describe("factory:save-lemonsqueezy-key", () => {
  it("throws Auth when key is empty", async () => {
    const handler = capturedHandlers.get("factory:save-lemonsqueezy-key")!;
    await expect(handler(mockEvent, { key: "" })).rejects.toMatchObject({
      kind: DyadErrorKind.Auth,
    });
  });

  it("throws Auth when LemonSqueezy API rejects the key (401)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    const handler = capturedHandlers.get("factory:save-lemonsqueezy-key")!;
    await expect(handler(mockEvent, { key: "bad-key" })).rejects.toMatchObject({
      kind: DyadErrorKind.Auth,
    });
  });

  it("throws Auth when LemonSqueezy API rejects the key (403)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403 }),
    );
    const handler = capturedHandlers.get("factory:save-lemonsqueezy-key")!;
    await expect(handler(mockEvent, { key: "bad-key" })).rejects.toMatchObject({
      kind: DyadErrorKind.Auth,
    });
  });

  it("throws PaymentIngestFailure when LemonSqueezy API returns unexpected error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    const handler = capturedHandlers.get("factory:save-lemonsqueezy-key")!;
    await expect(handler(mockEvent, { key: "some-key" })).rejects.toMatchObject(
      { kind: DyadErrorKind.PaymentIngestFailure },
    );
  });

  it("throws PaymentIngestFailure when network call throws (offline)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error")),
    );
    const handler = capturedHandlers.get("factory:save-lemonsqueezy-key")!;
    await expect(handler(mockEvent, { key: "some-key" })).rejects.toMatchObject(
      { kind: DyadErrorKind.PaymentIngestFailure },
    );
  });

  it("saves key to settings when LemonSqueezy API accepts the key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { id: "user_123" } }),
      }),
    );

    const { writeSettings } = await import("@/main/settings");

    const handler = capturedHandlers.get("factory:save-lemonsqueezy-key")!;
    await handler(mockEvent, { key: "  eyJ0eXAiOiJKV1QiLC_test  " });

    expect(vi.mocked(writeSettings)).toHaveBeenCalledWith({
      lemonSqueezyApiKey: { value: "eyJ0eXAiOiJKV1QiLC_test" },
    });
  });
});

// ---------------------------------------------------------------------------
// PR #12 — factory:save-stripe-key
// ---------------------------------------------------------------------------

describe("factory:save-stripe-key", () => {
  it("throws Auth when key is empty", async () => {
    const handler = capturedHandlers.get("factory:save-stripe-key")!;
    await expect(handler(mockEvent, { key: "" })).rejects.toMatchObject({
      kind: DyadErrorKind.Auth,
    });
  });

  it("throws Auth when Stripe API rejects the key (401)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    const handler = capturedHandlers.get("factory:save-stripe-key")!;
    await expect(handler(mockEvent, { key: "bad-key" })).rejects.toMatchObject({
      kind: DyadErrorKind.Auth,
    });
  });

  it("throws PaymentIngestFailure when Stripe API returns unexpected error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    const handler = capturedHandlers.get("factory:save-stripe-key")!;
    await expect(handler(mockEvent, { key: "some-key" })).rejects.toMatchObject(
      { kind: DyadErrorKind.PaymentIngestFailure },
    );
  });

  it("throws PaymentIngestFailure when network call throws (offline)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error")),
    );
    const handler = capturedHandlers.get("factory:save-stripe-key")!;
    await expect(handler(mockEvent, { key: "some-key" })).rejects.toMatchObject(
      { kind: DyadErrorKind.PaymentIngestFailure },
    );
  });

  it("saves key to settings when Stripe API accepts the key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ object: "balance" }),
      }),
    );

    const { writeSettings } = await import("@/main/settings");

    const handler = capturedHandlers.get("factory:save-stripe-key")!;
    await handler(mockEvent, { key: "  sk_test_abc123  " });

    expect(vi.mocked(writeSettings)).toHaveBeenCalledWith({
      stripeSecretKey: { value: "sk_test_abc123" },
    });
  });
});

// ---------------------------------------------------------------------------
// PR #12 — factory:ingest-payments
// ---------------------------------------------------------------------------

describe("factory:ingest-payments", () => {
  beforeEach(restoreDbSelectToMockChain);

  it("throws Auth when LemonSqueezy key is not configured", async () => {
    mockSettingsState.lemonSqueezyApiKey = undefined;
    const handler = capturedHandlers.get("factory:ingest-payments")!;
    await expect(
      handler(mockEvent, { runId: 1, provider: "lemonsqueezy" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Auth });
  });

  it("throws Auth when Stripe key is not configured", async () => {
    mockSettingsState.stripeSecretKey = undefined;
    const handler = capturedHandlers.get("factory:ingest-payments")!;
    await expect(
      handler(mockEvent, { runId: 1, provider: "stripe" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Auth });
  });

  it("returns inserted=0 when LemonSqueezy returns no paid orders", async () => {
    mockSettingsState.lemonSqueezyApiKey = { value: "ls_test_key" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [], links: { next: null } }),
      }),
    );

    const handler = capturedHandlers.get("factory:ingest-payments")!;
    const result = await handler(mockEvent, {
      runId: 1,
      provider: "lemonsqueezy",
    });

    expect(result).toMatchObject({
      inserted: 0,
      revenueUsdCents: 0,
      conversions: 0,
    });
  });

  it("inserts 1 outcome row from LemonSqueezy paid orders", async () => {
    mockSettingsState.lemonSqueezyApiKey = { value: "ls_test_key" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "ord_1",
                attributes: {
                  status: "paid",
                  total: 2999,
                  currency: "USD",
                  first_order_item: { product_name: "InvoicePro Pro" },
                  created_at: "2025-01-15T10:00:00Z",
                },
              },
              {
                id: "ord_2",
                attributes: {
                  status: "paid",
                  total: 2999,
                  currency: "USD",
                  first_order_item: { product_name: "InvoicePro Pro" },
                  created_at: "2025-01-16T10:00:00Z",
                },
              },
            ],
            links: { next: null },
          }),
      }),
    );

    const { db: dbModule } = await import("@/db");

    const handler = capturedHandlers.get("factory:ingest-payments")!;
    const result = await handler(mockEvent, {
      runId: 1,
      provider: "lemonsqueezy",
    });

    expect(result).toMatchObject({
      inserted: 1,
      revenueUsdCents: 5998,
      conversions: 2,
    });
    expect(vi.mocked(dbModule.transaction)).toHaveBeenCalledTimes(1);
  });

  it("filters LemonSqueezy orders by fromTimestamp", async () => {
    mockSettingsState.lemonSqueezyApiKey = { value: "ls_test_key" };
    const futureTs = Math.floor(Date.now() / 1000) + 86400; // tomorrow
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "ord_old",
                attributes: {
                  status: "paid",
                  total: 2999,
                  currency: "USD",
                  first_order_item: { product_name: "Test Product" },
                  created_at: "2020-01-01T00:00:00Z",
                },
              },
            ],
            links: { next: null },
          }),
      }),
    );

    const handler = capturedHandlers.get("factory:ingest-payments")!;
    const result = await handler(mockEvent, {
      runId: 1,
      provider: "lemonsqueezy",
      fromTimestamp: futureTs,
    });

    expect(result).toMatchObject({
      inserted: 0,
      revenueUsdCents: 0,
      conversions: 0,
    });
  });

  it("returns inserted=0 when Stripe returns no charges", async () => {
    mockSettingsState.stripeSecretKey = { value: "sk_test_key" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            object: "list",
            data: [],
            has_more: false,
            url: "/v1/charges",
          }),
      }),
    );

    const handler = capturedHandlers.get("factory:ingest-payments")!;
    const result = await handler(mockEvent, { runId: 1, provider: "stripe" });

    expect(result).toMatchObject({
      inserted: 0,
      revenueUsdCents: 0,
      conversions: 0,
    });
  });

  it("inserts 1 outcome row from Stripe succeeded USD charges", async () => {
    mockSettingsState.stripeSecretKey = { value: "sk_test_key" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            object: "list",
            data: [
              {
                id: "ch_1",
                amount: 4999,
                currency: "usd",
                status: "succeeded",
                description: "InvoicePro UAE subscription",
                created: 1_700_000_000,
                metadata: {},
              },
            ],
            has_more: false,
            url: "/v1/charges",
          }),
      }),
    );

    const { db: dbModule } = await import("@/db");

    const handler = capturedHandlers.get("factory:ingest-payments")!;
    const result = await handler(mockEvent, { runId: 1, provider: "stripe" });

    expect(result).toMatchObject({
      inserted: 1,
      revenueUsdCents: 4999,
      conversions: 1,
    });
    expect(vi.mocked(dbModule.transaction)).toHaveBeenCalledTimes(1);
  });

  it("filters Stripe charges by productName in description", async () => {
    mockSettingsState.stripeSecretKey = { value: "sk_test_key" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            object: "list",
            data: [
              {
                id: "ch_match",
                amount: 2999,
                currency: "usd",
                status: "succeeded",
                description: "InvoicePro Pro plan",
                created: 1_700_000_000,
                metadata: {},
              },
              {
                id: "ch_no_match",
                amount: 9999,
                currency: "usd",
                status: "succeeded",
                description: "Unrelated product",
                created: 1_700_000_001,
                metadata: {},
              },
            ],
            has_more: false,
            url: "/v1/charges",
          }),
      }),
    );

    const handler = capturedHandlers.get("factory:ingest-payments")!;
    const result = await handler(mockEvent, {
      runId: 1,
      provider: "stripe",
      productName: "invoicepro",
    });

    expect(result).toMatchObject({
      inserted: 1,
      revenueUsdCents: 2999,
      conversions: 1,
    });
  });

  it("throws PaymentIngestFailure when LemonSqueezy orders API returns error", async () => {
    mockSettingsState.lemonSqueezyApiKey = { value: "ls_test_key" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal server error"),
      }),
    );

    const handler = capturedHandlers.get("factory:ingest-payments")!;
    await expect(
      handler(mockEvent, { runId: 1, provider: "lemonsqueezy" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.PaymentIngestFailure });
  });

  it("throws PaymentIngestFailure when Stripe charges API returns error", async () => {
    mockSettingsState.stripeSecretKey = { value: "sk_test_key" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 402,
        text: () => Promise.resolve("Payment Required"),
      }),
    );

    const handler = capturedHandlers.get("factory:ingest-payments")!;
    await expect(
      handler(mockEvent, { runId: 1, provider: "stripe" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.PaymentIngestFailure });
  });
});

// ---------------------------------------------------------------------------
// PR #13 — factory:save-plausible-config
// ---------------------------------------------------------------------------

describe("factory:save-plausible-config", () => {
  it("throws Auth when key is empty", async () => {
    const handler = capturedHandlers.get("factory:save-plausible-config")!;
    await expect(
      handler(mockEvent, { key: "", siteId: "example.com" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Auth });
  });

  it("throws Auth when siteId is empty", async () => {
    const handler = capturedHandlers.get("factory:save-plausible-config")!;
    await expect(
      handler(mockEvent, { key: "some-key", siteId: "" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Auth });
  });

  it("throws Auth when Plausible returns 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    const handler = capturedHandlers.get("factory:save-plausible-config")!;
    await expect(
      handler(mockEvent, { key: "bad-key", siteId: "example.com" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Auth });
  });

  it("throws AnalyticsIngestFailure when Plausible returns 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      }),
    );
    const handler = capturedHandlers.get("factory:save-plausible-config")!;
    await expect(
      handler(mockEvent, { key: "some-key", siteId: "example.com" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.AnalyticsIngestFailure });
  });

  it("throws AnalyticsIngestFailure when network call throws (offline)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error")),
    );
    const handler = capturedHandlers.get("factory:save-plausible-config")!;
    await expect(
      handler(mockEvent, { key: "some-key", siteId: "example.com" }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.AnalyticsIngestFailure });
  });

  it("saves key and siteId when Plausible API returns valid sites list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ sites: [] }),
      }),
    );

    const { writeSettings } = await import("@/main/settings");
    const handler = capturedHandlers.get("factory:save-plausible-config")!;
    await handler(mockEvent, {
      key: "  plausible_api_xyz  ",
      siteId: "  myapp.com  ",
    });

    expect(vi.mocked(writeSettings)).toHaveBeenCalledWith({
      plausibleApiKey: { value: "plausible_api_xyz" },
      plausibleSiteId: "myapp.com",
    });
  });

  it("saves key when Plausible API returns a plain array (v2 shape)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ domain: "myapp.com" }]),
      }),
    );

    const { writeSettings } = await import("@/main/settings");
    const handler = capturedHandlers.get("factory:save-plausible-config")!;
    await handler(mockEvent, { key: "pl_v2_key", siteId: "myapp.com" });

    expect(vi.mocked(writeSettings)).toHaveBeenCalledWith({
      plausibleApiKey: { value: "pl_v2_key" },
      plausibleSiteId: "myapp.com",
    });
  });
});

// ---------------------------------------------------------------------------
// PR #13 — factory:ingest-analytics
// ---------------------------------------------------------------------------

describe("factory:ingest-analytics", () => {
  beforeEach(restoreDbSelectToMockChain);

  it("throws Auth when Plausible API key is not configured", async () => {
    mockSettingsState.plausibleApiKey = undefined;
    const handler = capturedHandlers.get("factory:ingest-analytics")!;
    await expect(
      handler(mockEvent, { runId: 1 }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Auth });
  });

  it("throws Auth when Plausible site ID is not configured", async () => {
    mockSettingsState.plausibleApiKey = { value: "pl_test_key" };
    mockSettingsState.plausibleSiteId = undefined;
    const handler = capturedHandlers.get("factory:ingest-analytics")!;
    await expect(
      handler(mockEvent, { runId: 1 }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Auth });
  });

  it("returns inserted=0 when Plausible returns 0 pageviews", async () => {
    mockSettingsState.plausibleApiKey = { value: "pl_test_key" };
    mockSettingsState.plausibleSiteId = "example.com";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            results: {
              pageviews: { value: 0 },
              visitors: { value: 0 },
            },
          }),
      }),
    );

    const handler = capturedHandlers.get("factory:ingest-analytics")!;
    const result = await handler(mockEvent, { runId: 1 });

    expect(result).toMatchObject({ inserted: 0, views: 0 });
  });

  it("inserts 1 outcome row when Plausible returns pageviews > 0", async () => {
    mockSettingsState.plausibleApiKey = { value: "pl_test_key" };
    mockSettingsState.plausibleSiteId = "example.com";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            results: {
              pageviews: { value: 12345 },
              visitors: { value: 3000 },
            },
          }),
      }),
    );

    const { db: dbModule } = await import("@/db");

    const handler = capturedHandlers.get("factory:ingest-analytics")!;
    const result = await handler(mockEvent, { runId: 1 });

    expect(result).toMatchObject({ inserted: 1, views: 12345 });
    expect(vi.mocked(dbModule.transaction)).toHaveBeenCalledTimes(1);
  });

  it("throws AnalyticsIngestFailure when Plausible stats API returns error", async () => {
    mockSettingsState.plausibleApiKey = { value: "pl_test_key" };
    mockSettingsState.plausibleSiteId = "example.com";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Site not found"),
      }),
    );

    const handler = capturedHandlers.get("factory:ingest-analytics")!;
    await expect(
      handler(mockEvent, { runId: 1 }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.AnalyticsIngestFailure });
  });

  it("uses custom period when provided", async () => {
    mockSettingsState.plausibleApiKey = { value: "pl_test_key" };
    mockSettingsState.plausibleSiteId = "example.com";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          results: { pageviews: { value: 500 }, visitors: { value: 100 } },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = capturedHandlers.get("factory:ingest-analytics")!;
    await handler(mockEvent, { runId: 1, period: "7d" });

    // Check the fetch was called with period=7d in the URL
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("period=7d"),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// PR #13 — factory:get-nightly-status
// ---------------------------------------------------------------------------

describe("factory:get-nightly-status", () => {
  it("returns enabled=true and lastRanAt=null when job has never run", () => {
    mockSettingsState.factoryNightlyJobEnabled = true;
    mockSettingsState.factoryNightlyLastRanAt = undefined;

    const handler = capturedHandlers.get("factory:get-nightly-status")!;
    const result = handler(mockEvent, {}) as Promise<{
      enabled: boolean;
      lastRanAt: number | null;
    }>;
    return result.then((r) => {
      expect(r.enabled).toBe(true);
      expect(r.lastRanAt).toBeNull();
    });
  });

  it("returns enabled=false when job is disabled in settings", () => {
    mockSettingsState.factoryNightlyJobEnabled = false;
    mockSettingsState.factoryNightlyLastRanAt = 1700000000;

    const handler = capturedHandlers.get("factory:get-nightly-status")!;
    const result = handler(mockEvent, {}) as Promise<{
      enabled: boolean;
      lastRanAt: number;
      nextRunAt: number | null;
    }>;
    return result.then((r) => {
      expect(r.enabled).toBe(false);
      expect(r.lastRanAt).toBe(1700000000);
      expect(r.nextRunAt).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// PR #13 — factory:run-nightly-now
// ---------------------------------------------------------------------------

describe("factory:run-nightly-now", () => {
  beforeEach(restoreDbSelectToMockChain);

  it("returns ranAt and runsChecked=0 when there are no LAUNCHED runs", async () => {
    mockDbState.rows = [];

    const handler = capturedHandlers.get("factory:run-nightly-now")!;
    const result = (await handler(mockEvent, {})) as {
      ranAt: number;
      runsChecked: number;
    };

    expect(result.runsChecked).toBe(0);
    expect(typeof result.ranAt).toBe("number");
    expect(result.ranAt).toBeGreaterThan(0);
  });

  it("persists factoryNightlyLastRanAt after running", async () => {
    mockDbState.rows = [];
    const { writeSettings } = await import("@/main/settings");

    const handler = capturedHandlers.get("factory:run-nightly-now")!;
    await handler(mockEvent, {});

    expect(vi.mocked(writeSettings)).toHaveBeenCalledWith(
      expect.objectContaining({ factoryNightlyLastRanAt: expect.any(Number) }),
    );
  });

  it("calls ingest for each LAUNCHED run that has Stripe key configured", async () => {
    mockSettingsState.stripeSecretKey = { value: "sk_test_key" };
    mockDbState.rows = [{ id: 10 }, { id: 11 }];

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          object: "list",
          data: [],
          has_more: false,
          url: "/v1/charges",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = capturedHandlers.get("factory:run-nightly-now")!;
    const result = (await handler(mockEvent, {})) as { runsChecked: number };

    // 2 LAUNCHED runs → 2 Stripe calls
    expect(result.runsChecked).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns runsChecked=0 immediately when a cycle is already in progress", async () => {
    // Simulate an in-progress cycle by firing two concurrent invocations.
    // The second one must return quickly with runsChecked=0 rather than
    // starting a parallel ingest.
    mockDbState.rows = [];

    const handler = capturedHandlers.get("factory:run-nightly-now")!;

    // Fire both without awaiting either yet; first acquires the lock.
    const [first, second] = await Promise.all([
      handler(mockEvent, {}) as Promise<{ runsChecked: number }>,
      handler(mockEvent, {}) as Promise<{ runsChecked: number }>,
    ]);

    // At least one result must be runsChecked=0 (the one that was skipped).
    const skipped = [first, second].find((r) => r.runsChecked === 0);
    expect(skipped).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// PR #13 — factory:toggle-nightly-job
// ---------------------------------------------------------------------------

describe("factory:toggle-nightly-job", () => {
  it("writes factoryNightlyJobEnabled=true to settings", async () => {
    const { writeSettings } = await import("@/main/settings");

    const handler = capturedHandlers.get("factory:toggle-nightly-job")!;
    await handler(mockEvent, { enabled: true });

    expect(vi.mocked(writeSettings)).toHaveBeenCalledWith({
      factoryNightlyJobEnabled: true,
    });
  });

  it("writes factoryNightlyJobEnabled=false to settings", async () => {
    const { writeSettings } = await import("@/main/settings");

    const handler = capturedHandlers.get("factory:toggle-nightly-job")!;
    await handler(mockEvent, { enabled: false });

    expect(vi.mocked(writeSettings)).toHaveBeenCalledWith({
      factoryNightlyJobEnabled: false,
    });
  });
});
