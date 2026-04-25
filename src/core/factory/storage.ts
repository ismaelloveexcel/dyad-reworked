/**
 * storage.ts
 *
 * localStorage persistence helpers for renderer-only Factory state
 * (pipeline tracker + traction metrics).
 *
 * History (IdeaEvaluationResult[]) is stored in SQLite via the IPC layer;
 * these helpers cover only the lightweight local-state that does not need
 * to round-trip through the main process.
 */

import { SafeLocalStorage } from "@/lib/safe_local_storage";
import type { PipelineEntry, TractionEntry } from "./types";

// =============================================================================
// Storage keys
// =============================================================================

/** Legacy localStorage key for history — used only during the one-time DB migration. */
export const LEGACY_HISTORY_KEY = "factory-v3-history";
export const PIPELINE_KEY = "factory-v3-pipeline";
export const TRACTION_KEY = "factory-v3-traction";

// =============================================================================
// Pipeline
// =============================================================================

export function loadPipeline(): PipelineEntry[] {
  return (
    SafeLocalStorage.get<PipelineEntry[]>(
      PIPELINE_KEY,
      (v): v is PipelineEntry[] => Array.isArray(v),
    ) ?? []
  );
}

export function savePipeline(items: PipelineEntry[]): void {
  SafeLocalStorage.set(PIPELINE_KEY, items);
}

// =============================================================================
// Traction
// =============================================================================

export function loadTraction(): TractionEntry[] {
  return (
    SafeLocalStorage.get<TractionEntry[]>(
      TRACTION_KEY,
      (v): v is TractionEntry[] => Array.isArray(v),
    ) ?? []
  );
}

export function saveTraction(items: TractionEntry[]): void {
  SafeLocalStorage.set(TRACTION_KEY, items);
}
