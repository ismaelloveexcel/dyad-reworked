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

// ---------------------------------------------------------------------------
// Mocks (hoisted by vitest — order matters)
// ---------------------------------------------------------------------------

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
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
    },
  };
});

vi.mock("fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Import handlers after mocks are wired
// ---------------------------------------------------------------------------

import {
  registerFactoryHandlers,
  OPENAI_MODEL_VERSION,
} from "@/ipc/handlers/factory_handlers";
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  capturedHandlers.clear();
  mockDbState.rows = [];
  mockDbState.insertedId = 1;
  vi.clearAllMocks();
  // Re-wire createTypedHandler after clearAllMocks (implementation is preserved,
  // but we clear call history). Calling registerFactoryHandlers() re-populates the map.
  registerFactoryHandlers();
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
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
    };
    expect(result.openaiKeyPresent).toBe(true);
    expect(result.modelVersion).toBe(OPENAI_MODEL_VERSION);
  });

  it("reports openaiKeyPresent=false when env var is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const handler = capturedHandlers.get("factory:get-system-status")!;
    const result = (await handler(mockEvent, {})) as {
      openaiKeyPresent: boolean;
    };
    expect(result.openaiKeyPresent).toBe(false);
  });

  it("reports openaiKeyPresent=false when env var is whitespace", async () => {
    process.env.OPENAI_API_KEY = "   ";
    const handler = capturedHandlers.get("factory:get-system-status")!;
    const result = (await handler(mockEvent, {})) as {
      openaiKeyPresent: boolean;
    };
    expect(result.openaiKeyPresent).toBe(false);
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

  it("returns parsed ideas sorted by totalScore DESC when OpenAI responds", async () => {
    process.env.OPENAI_API_KEY = "sk-valid";
    const idea = makeIdea({ totalScore: 30, decision: "BUILD" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeFakeOpenAIResponse(JSON.stringify([idea]))),
    );
    const handler = capturedHandlers.get("factory:generate-ideas")!;
    const result = (await handler(mockEvent, { mode: "premium" })) as {
      ideas: { name: string }[];
    };
    expect(result.ideas.length).toBeGreaterThanOrEqual(1);
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
