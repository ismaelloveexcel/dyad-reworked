/**
 * persist.ts
 *
 * DB-layer pure helpers for the Factory pipeline.
 * These functions are free of Electron / DB imports and can be unit-tested
 * in isolation. The actual DB operations live in factory_handlers.ts.
 */

import type { IdeaEvaluationResult } from "@/ipc/types/factory";
import { stableHash } from "@/ipc/handlers/factory_validator";

// =============================================================================
// Fingerprint — deduplication key for saveRun (E1)
// =============================================================================

export function computeFingerprint(idea: IdeaEvaluationResult): string {
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
// Slug — filesystem-safe directory name for factory-apps/<slug>/
// Shared by scaffoldApp, exportLaunchKit, and deployApp so all three handlers
// always resolve the same directory for a given run.
// =============================================================================

/**
 * Derive a filesystem-safe slug from an idea name and its run id.
 * The result is used as the subdirectory name inside `userData/factory-apps/`.
 *
 * Algorithm (identical across scaffoldApp / exportLaunchKit / deployApp):
 *   1. Lowercase
 *   2. Collapse any non-alphanumeric sequence to a single hyphen
 *   3. Strip leading/trailing hyphens
 *   4. Truncate to 64 chars
 *   5. Fall back to `factory-app-<runId>` when the name is blank
 */
export function factorySlugFromName(name: string, runId: number): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || `factory-app-${runId}`
  );
}
