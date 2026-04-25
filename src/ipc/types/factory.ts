import { z } from "zod";
import { defineContract, createClient } from "../contracts/core";

// =============================================================================
// Core Scoring Schema
// =============================================================================

export const IdeaScoresSchema = z.object({
  buyerClarity: z.number().min(1).max(5),
  painUrgency: z.number().min(1).max(5),
  marketExistence: z.number().min(1).max(5),
  differentiation: z.number().min(1).max(5),
  replaceability: z.number().min(1).max(5),
  virality: z.number().min(1).max(5),
  monetisation: z.number().min(1).max(5),
  buildSimplicity: z.number().min(1).max(5),
});

// =============================================================================
// Region Recognition Schema
// =============================================================================

export const IdeaRegionSchema = z.object({
  primary: z.string(),
  secondary: z.array(z.string()),
  whyWorks: z.string(),
  whyFails: z.string(),
});

// =============================================================================
// Novelty Engine Flags
// =============================================================================

export const NoveltyFlagsSchema = z.object({
  domainTwist: z.boolean(),
  perspectiveFlip: z.boolean(),
  outputTransformation: z.boolean(),
  constraintInjection: z.boolean(),
});

// =============================================================================
// Pattern Entry (learned from history — drives Pattern Engine)
// =============================================================================

export const PatternEntrySchema = z.object({
  name: z.string(),
  category: z.string(),
  region: z.string().optional(),
  viralScore: z.number(),
  revenueScore: z.number(),
  status: z.enum(["built", "launched", "killed", "ignored", "unknown"]),
  revenue: z.string().optional(),
  shares: z.string().optional(),
});

// =============================================================================
// Build Queue Status (E2)
// =============================================================================

export const RunStatusSchema = z.enum([
  "DECIDED",
  "QUEUED",
  "IN_PROGRESS",
  "LAUNCHED",
  "KILLED",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

// =============================================================================
// Launch Outcome (E3 — pattern learning)
// =============================================================================

export const LaunchOutcomeSchema = z.object({
  launched: z.boolean(),
  revenueGenerated: z.boolean(),
  notes: z.string(),
});
export type LaunchOutcome = z.infer<typeof LaunchOutcomeSchema>;

// =============================================================================
// Full Idea Evaluation Result
// =============================================================================

export const IdeaEvaluationResultSchema = z.object({
  idea: z.string(),
  name: z.string(),
  buyer: z.string(),
  scores: IdeaScoresSchema,
  totalScore: z.number(),
  decision: z.enum(["BUILD", "REWORK", "KILL"]),
  reason: z.string(),
  improvedIdea: z.string(),
  buildPrompt: z.string(),
  monetisationAngle: z.string(),
  viralTrigger: z.string(),
  fallbackUsed: z.boolean(),
  // Enrichment fields — optional for backwards compat with stored data
  revenueProbability: z.number().min(1).max(5).optional(),
  timeToFirstRevenue: z.enum(["Fast", "Medium", "Slow"]).optional(),
  engineType: z.enum(["revenue", "viral", "experimental"]).optional(),
  region: IdeaRegionSchema.optional(),
  portfolioLink: z.string().optional(),
  noveltyFlags: NoveltyFlagsSchema.optional(),
  // Run metadata — injected by listRuns from DB columns (E2, E4, E9)
  runId: z.number().optional(),
  runStatus: RunStatusSchema.optional(),
  launchOutcome: LaunchOutcomeSchema.optional(),
  promptVersion: z.string().optional(),
  promptHash: z.string().optional(),
  modelVersion: z.string().optional(), // PR #1 — pinned OpenAI model snapshot used for this run
  evaluatedAt: z.number().optional(), // unix ms — injected from createdAt DB column
  // PR #3 — regulated-domain flag (legal/HR/visa/medical/financial content)
  regulatedDomain: z.boolean().optional(),
});

export type IdeaEvaluationResult = z.infer<typeof IdeaEvaluationResultSchema>;
export type IdeaScores = z.infer<typeof IdeaScoresSchema>;
export type IdeaRegion = z.infer<typeof IdeaRegionSchema>;
export type NoveltyFlags = z.infer<typeof NoveltyFlagsSchema>;
export type PatternEntry = z.infer<typeof PatternEntrySchema>;

// =============================================================================
// Evaluate Idea Contract
// =============================================================================

export const EvaluateIdeaParamsSchema = z.object({
  idea: z.string().min(1),
});
export const EvaluateIdeaResponseSchema = IdeaEvaluationResultSchema;

// =============================================================================
// Generate Ideas Contract (explorer/batch mode)
// =============================================================================

export const GenerateIdeasParamsSchema = z.object({
  niche: z.string().optional(),
  mode: z.enum(["fast-money", "premium", "viral"]),
});
export const GenerateIdeasResponseSchema = z.object({
  ideas: z.array(IdeaEvaluationResultSchema),
});

export type GenerateIdeasParams = z.infer<typeof GenerateIdeasParamsSchema>;
export type GenerateIdeasResponse = z.infer<typeof GenerateIdeasResponseSchema>;

// =============================================================================
// Generate Portfolio Contract (Dual Engine — the ONE BUTTON)
// =============================================================================

export const GeneratePortfolioParamsSchema = z.object({
  niche: z.string().optional(),
  patterns: z.array(PatternEntrySchema).optional(),
});

export const GeneratePortfolioResponseSchema = z.object({
  revenueIdea: IdeaEvaluationResultSchema,
  viralIdea: IdeaEvaluationResultSchema,
  experimentalIdea: IdeaEvaluationResultSchema,
  portfolioLink: z.string(),
  fallbackUsed: z.boolean(),
});

export type GeneratePortfolioParams = z.infer<
  typeof GeneratePortfolioParamsSchema
>;
export type GeneratePortfolioResponse = z.infer<
  typeof GeneratePortfolioResponseSchema
>;

// =============================================================================
// Factory Contracts
// =============================================================================

export const factoryContracts = {
  evaluateIdea: defineContract({
    channel: "factory:evaluate-idea",
    input: EvaluateIdeaParamsSchema,
    output: EvaluateIdeaResponseSchema,
  }),
  generateIdeas: defineContract({
    channel: "factory:generate-ideas",
    input: GenerateIdeasParamsSchema,
    output: GenerateIdeasResponseSchema,
  }),
  generatePortfolio: defineContract({
    channel: "factory:generate-portfolio",
    input: GeneratePortfolioParamsSchema,
    output: GeneratePortfolioResponseSchema,
  }),
  // Persistence handlers (PATH A — SQLite)
  saveRun: defineContract({
    channel: "factory:save-run",
    // Returns id + duplicate (E1): duplicate is the existing run if fingerprint collides
    input: z.object({ idea: IdeaEvaluationResultSchema }),
    output: z.object({
      id: z.number(),
      duplicate: IdeaEvaluationResultSchema.nullable(),
    }),
  }),
  listRuns: defineContract({
    channel: "factory:list-runs",
    input: z.object({ limit: z.number().optional() }),
    output: z.object({ runs: z.array(IdeaEvaluationResultSchema) }),
  }),
  deleteRun: defineContract({
    channel: "factory:delete-run",
    input: z.object({ id: z.number() }),
    output: z.object({ success: z.boolean() }),
  }),
  clearRuns: defineContract({
    channel: "factory:clear-runs",
    input: z.object({}),
    output: z.object({ count: z.number() }),
  }),
  // E2 — Build Queue Status
  updateRunStatus: defineContract({
    channel: "factory:update-run-status",
    input: z.object({ id: z.number(), status: RunStatusSchema }),
    output: z.object({ success: z.boolean() }),
  }),
  // E6 — Export Pipeline
  exportRuns: defineContract({
    channel: "factory:export-runs",
    input: z.object({ filter: z.enum(["BUILD", "all"]).optional() }),
    output: z.object({ success: z.boolean(), path: z.string().optional() }),
  }),
  // E3 — Pattern Learning: store launch outcome per run
  updateLaunchOutcome: defineContract({
    channel: "factory:update-launch-outcome",
    input: z.object({ id: z.number(), outcome: LaunchOutcomeSchema }),
    output: z.object({ success: z.boolean() }),
  }),
  // PR #1 — Surface missing OpenAI key to renderer for the global banner
  getSystemStatus: defineContract({
    channel: "factory:get-system-status",
    input: z.object({}),
    output: z.object({
      openaiKeyPresent: z.boolean(),
      modelVersion: z.string(),
    }),
  }),
} as const;

// =============================================================================
// Factory Client (renderer-side)
// =============================================================================

export const factoryClient = createClient(factoryContracts);
