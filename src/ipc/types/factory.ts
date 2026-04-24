import { z } from "zod";
import { defineContract, createClient } from "../contracts/core";

// =============================================================================
// Factory Schemas
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
});

export type IdeaEvaluationResult = z.infer<typeof IdeaEvaluationResultSchema>;
export type IdeaScores = z.infer<typeof IdeaScoresSchema>;

// Evaluate Idea

export const EvaluateIdeaParamsSchema = z.object({
  idea: z.string().min(1),
});

export const EvaluateIdeaResponseSchema = IdeaEvaluationResultSchema;

// Generate Ideas

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
} as const;

// =============================================================================
// Factory Client
// =============================================================================

export const factoryClient = createClient(factoryContracts);
