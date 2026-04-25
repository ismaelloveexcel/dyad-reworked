/**
 * patterns.ts
 *
 * Pattern Engine — extracts learned patterns from history + pipeline + traction
 * so that the Generate Portfolio prompt can be biased toward winning signals.
 *
 * Pure module: no Electron, no network, no DB.
 */

import type { IdeaEvaluationResult, PatternEntry } from "@/ipc/types/factory";
import type { PipelineEntry, TractionEntry } from "./types";

// =============================================================================
// Revenue signal detection
// =============================================================================

// `revenue` on PatternEntry is a free-text string ("$5,000", "1", "yes", …).
// We treat any value containing a non-zero digit (1-9), or the literal "yes",
// as a positive revenue signal for the pattern-weighting boost. Bare "0",
// "no", and empty strings are explicitly excluded.
export function hasRevenueSignal(revenue: string | undefined): boolean {
  if (!revenue) return false;
  const trimmed = revenue.trim().toLowerCase();
  if (trimmed === "" || trimmed === "0" || trimmed === "no") return false;
  if (trimmed === "yes") return true;
  return /[1-9]/.test(trimmed);
}

// =============================================================================
// Pattern extraction
// =============================================================================

export function extractPatterns(
  history: IdeaEvaluationResult[],
  pipeline: PipelineEntry[],
  traction: TractionEntry[],
): PatternEntry[] {
  const entries: PatternEntry[] = history.slice(0, 30).map((item) => {
    const pe = pipeline.find((p) => p.name === item.name);
    const te = traction.find((t) => t.name === item.name);

    const t = item.idea.toLowerCase();
    let category = "general";
    if (/salary|payroll|compensation|hr/.test(t)) category = "hr-finance";
    else if (/legal|compliance|contract|visa|permit/.test(t))
      category = "legal-compliance";
    else if (/marketing|social|viral|share/.test(t)) category = "marketing";
    else if (/resume|cv|career|job/.test(t)) category = "career";
    else if (/invoice|proposal|freelance|client/.test(t))
      category = "freelance";
    else if (/tax|vat|accounting|finance/.test(t)) category = "finance";

    let status: PatternEntry["status"] = "unknown";
    if (pe) {
      if (pe.status === "Launched") status = "launched";
      else if (pe.status === "Killed") status = "killed";
      else if (pe.status === "Built") status = "built";
      else status = "ignored";
    }
    // E3: honour runStatus from DB for items saved via saveRun
    if (item.runStatus === "LAUNCHED") status = "launched";
    else if (item.runStatus === "KILLED") status = "killed";

    const entry: PatternEntry = {
      name: item.name,
      category,
      region: item.region?.primary,
      viralScore: item.scores.virality,
      revenueScore: item.scores.monetisation,
      status,
      revenue: te?.revenue?.trim()
        ? te.revenue
        : item.launchOutcome?.revenueGenerated
          ? "1"
          : undefined,
      shares: te?.shares,
    };
    return entry;
  });

  // E3/E7 — weight launched+revenue entries 3x to reinforce winning patterns
  const boosted: PatternEntry[] = [];
  for (const e of entries) {
    boosted.push(e);
    if (e.status === "launched" && hasRevenueSignal(e.revenue)) {
      boosted.push(e, e); // 2 extra copies = 3x total weight
    }
  }
  return boosted;
}
