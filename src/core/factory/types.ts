/**
 * types.ts
 *
 * Shared domain types for the Factory pipeline that live outside the IPC
 * boundary (renderer-only state: pipeline tracker and traction metrics).
 */

import type { IdeaEvaluationResult } from "@/ipc/types/factory";

// =============================================================================
// Pipeline tracker
// =============================================================================

export type PipelineStatus =
  | "Idea Generated"
  | "Prompt Copied"
  | "Building"
  | "Built"
  | "Launched"
  | "Testing"
  | "Killed";

export interface PipelineEntry {
  name: string;
  buyer: string;
  decision: "BUILD" | "REWORK" | "KILL";
  totalScore: number;
  monetisationAngle: string;
  viralTrigger: string;
  scores: IdeaEvaluationResult["scores"];
  status: PipelineStatus;
  addedAt: string;
}

// =============================================================================
// Traction metrics
// =============================================================================

export interface TractionEntry {
  name: string;
  revenue: string;
  views: string;
  users: string;
  sales: string;
  shares: string;
  notes: string;
}
