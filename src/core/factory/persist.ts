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
