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
  // New enrichment fields — optional for backwards compat with stored data
  revenueProbability: z.number().min(1).max(5).optional(),
  timeToFirstRevenue: z.enum(["Fast", "Medium", "Slow"]).optional(),
  engineType: z.enum(["revenue", "viral", "experimental"]).optional(),
  region: IdeaRegionSchema.optional(),
  portfolioLink: z.string().optional(),
  noveltyFlags: NoveltyFlagsSchema.optional(),
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

export type GeneratePortfolioParams = z.infer<typeof GeneratePortfolioParamsSchema>;
export type GeneratePortfolioResponse = z.infer<typeof GeneratePortfolioResponseSchema>;

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
} as const;

// =============================================================================
// Factory Client (renderer-side)
// =============================================================================

export const factoryClient = createClient(factoryContracts);
