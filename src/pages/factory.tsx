import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  type IdeaEvaluationResult,
  type PatternEntry,
  type GeneratePortfolioResponse,
  type RunStatus,
  factoryClient,
} from "@/ipc/types/factory";
import {
  type PipelineStatus,
  type PipelineEntry,
  type TractionEntry,
} from "@/core/factory/types";
import {
  loadPipeline,
  savePipeline,
  loadTraction,
  saveTraction,
} from "@/core/factory/storage";
import { extractPatterns } from "@/core/factory/patterns";
import { useFactoryRun } from "@/hooks/useFactoryRun";
import { queryKeys } from "@/lib/queryKeys";

// Re-export types used by external test files so imports from this module
// continue to work after the business logic was extracted to @/core/factory.
export type { PipelineStatus, PipelineEntry, TractionEntry };
export { extractPatterns };

// =============================================================================
// Utility
// =============================================================================

function decisionColor(d: "BUILD" | "REWORK" | "KILL") {
  if (d === "BUILD") return "text-emerald-400 bg-emerald-950/60 border-emerald-800";
  if (d === "REWORK") return "text-amber-400 bg-amber-950/60 border-amber-800";
  return "text-red-400 bg-red-950/60 border-red-800";
}

function scoreColor(n: number) {
  if (n >= 4) return "text-emerald-400";
  if (n >= 3) return "text-amber-400";
  return "text-red-400";
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Score bar
// =============================================================================

function ScoreBar({ label, value }: { label: string; value: number }) {
  const pct = (value / 5) * 100;
  return (
    <div className="flex items-center gap-3">
      <span className="w-36 text-xs text-zinc-400 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${value >= 4 ? "bg-emerald-500" : value >= 3 ? "bg-amber-500" : "bg-red-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-xs font-mono w-4 text-right ${scoreColor(value)}`}>
        {value}
      </span>
    </div>
  );
}

// =============================================================================
// PR #5 — Outcomes section (read-only) — shown inside IdeaCard when the run
// has been persisted and quantitative (or legacy) outcome data exists.
// =============================================================================

function OutcomesSection({ runId }: { runId: number }) {
  const query = useQuery({
    queryKey: queryKeys.factory.outcomes(runId),
    queryFn: () => factoryClient.listOutcomes({ runId }),
    enabled: runId > 0,
  });

  if (query.isLoading) {
    return (
      <div className="text-xs text-zinc-600 italic">Loading outcomes…</div>
    );
  }

  if (query.isError) {
    return (
      <div className="text-xs text-red-400 italic">
        Failed to load outcomes.
      </div>
    );
  }

  const outcomes = query.data?.outcomes ?? [];
  if (outcomes.length === 0) return null;

  const fmt = (n: number | null) =>
    n == null ? <span className="text-zinc-600">—</span> : n.toLocaleString();

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-800/30 p-4 space-y-3">
      <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
        Launch Outcomes
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-zinc-700">
              <th className="text-left py-1.5 pr-4 text-zinc-500 font-medium">Revenue (USD¢)</th>
              <th className="text-left py-1.5 pr-4 text-zinc-500 font-medium">Conversions</th>
              <th className="text-left py-1.5 pr-4 text-zinc-500 font-medium">Views</th>
              <th className="text-left py-1.5 pr-4 text-zinc-500 font-medium">Churn 30d</th>
              <th className="text-left py-1.5 pr-4 text-zinc-500 font-medium">Source</th>
              <th className="text-left py-1.5 text-zinc-500 font-medium">Captured</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {outcomes.map((o) => (
              <tr key={o.id}>
                <td className="py-1.5 pr-4 text-zinc-200">{fmt(o.revenueUsd)}</td>
                <td className="py-1.5 pr-4 text-zinc-200">{fmt(o.conversions)}</td>
                <td className="py-1.5 pr-4 text-zinc-200">{fmt(o.views)}</td>
                <td className="py-1.5 pr-4 text-zinc-200">{fmt(o.churn30d)}</td>
                <td className="py-1.5 pr-4 text-zinc-400">
                  {o.source ?? <span className="text-zinc-600">—</span>}
                </td>
                <td className="py-1.5 text-zinc-500">
                  {new Date(o.capturedAt * 1000).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {outcomes.some((o) => o.source === "legacy") && (
        <p className="text-xs text-zinc-600 italic">
          ✦ Row migrated from legacy boolean outcome — exact values unknown.
        </p>
      )}
    </div>
  );
}

// =============================================================================
// PR #7 — Brand palette presets for the scaffold codemod.
// Shown as color swatches in ScaffoldSection so the user can pick a brand
// color before scaffolding.  The chosen hex is forwarded to factory:scaffold-app
// which writes it into brand.css via buildBrandCss().
// =============================================================================

const BRAND_PALETTES = [
  { id: "slate", label: "Slate", primary: "#475569" },
  { id: "indigo", label: "Indigo", primary: "#4F46E5" },
  { id: "emerald", label: "Emerald", primary: "#059669" },
  { id: "violet", label: "Violet", primary: "#7C3AED" },
  { id: "rose", label: "Rose", primary: "#E11D48" },
  { id: "amber", label: "Amber", primary: "#D97706" },
] as const;

type BrandPaletteId = (typeof BRAND_PALETTES)[number]["id"];

// =============================================================================
// PR #6 — Scaffold App section — shown inside IdeaCard for BUILD ideas that
// have been persisted (runId present).  Triggers factory:scaffold-app which
// copies the scaffold/ template, runs codemods, npm install, and npm run build.
// PR #7 — Extended with brand palette picker.
// =============================================================================

function ScaffoldSection({
  result,
}: {
  result: IdeaEvaluationResult;
}) {
  const runId = result.runId;

  // PR #7 — selected brand palette; defaults to indigo
  const [selectedPaletteId, setSelectedPaletteId] =
    useState<BrandPaletteId>("indigo");

  const selectedPalette =
    BRAND_PALETTES.find((p) => p.id === selectedPaletteId) ?? BRAND_PALETTES[1];

  const scaffoldMutation = useMutation({
    mutationKey: queryKeys.factory.scaffold(runId ?? 0),
    mutationFn: ({ primaryColor }: { primaryColor: string }) =>
      factoryClient.scaffoldApp({
        runId: runId!,
        appName: result.name,
        tagline: result.monetisationAngle ?? undefined,
        primaryColor,
      }),
    // No query invalidation needed — scaffold result is ephemeral
  });

  if (runId == null || runId <= 0) return null;

  const { data, isPending, isError, error } = scaffoldMutation;

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-800/30 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
          Scaffold App
        </p>
        {data && (
          <span className="text-xs text-emerald-400">✓ Built</span>
        )}
      </div>

      {/* PR #7 — Brand palette picker (hidden once scaffold is complete) */}
      {!data && (
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="text-xs text-zinc-500 shrink-0">Brand color:</span>
          {BRAND_PALETTES.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedPaletteId(p.id)}
              title={p.label}
              disabled={isPending}
              className={`w-5 h-5 rounded-full border-2 transition-all ${
                selectedPaletteId === p.id
                  ? "border-white scale-110"
                  : "border-transparent opacity-60 hover:opacity-100"
              } disabled:cursor-not-allowed`}
              style={{ backgroundColor: p.primary }}
            />
          ))}
          <span
            className="text-xs text-zinc-400 italic"
          >
            {selectedPalette.label}
          </span>
        </div>
      )}

      {!data && (
        <button
          onClick={() =>
            scaffoldMutation.mutate({ primaryColor: selectedPalette.primary })
          }
          disabled={isPending}
          className="text-xs px-3 py-1.5 rounded-lg bg-indigo-900/50 text-indigo-300 hover:bg-indigo-800/60 disabled:bg-zinc-800 disabled:text-zinc-500 border border-indigo-800 transition-colors"
        >
          {isPending ? (
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full border-2 border-indigo-300/30 border-t-indigo-300 animate-spin" />
              Scaffolding…
            </span>
          ) : (
            "▶ Scaffold Runnable App"
          )}
        </button>
      )}

      {isError && (
        <p className="text-xs text-red-400 leading-relaxed">
          {error instanceof Error ? error.message : "Scaffold failed."}
        </p>
      )}

      {data && (
        <div className="space-y-2">
          <div className="rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2">
            <p className="text-xs text-zinc-500 mb-0.5">Preview path</p>
            <p className="text-xs font-mono text-zinc-200 break-all">
              {data.previewPath}
            </p>
          </div>
          {data.logs.length > 0 && (
            <details className="group">
              <summary className="text-xs text-zinc-600 cursor-pointer hover:text-zinc-400 transition-colors select-none">
                Build logs ({data.logs.length} lines)
              </summary>
              <pre className="mt-2 text-xs text-zinc-500 bg-zinc-950 rounded-md p-3 overflow-auto max-h-40 leading-relaxed whitespace-pre-wrap">
                {data.logs.join("\n")}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Idea card
// =============================================================================

const ENGINE_LABELS: Record<string, { label: string; color: string }> = {
  revenue: { label: "Revenue Engine", color: "text-emerald-300 bg-emerald-950/60 border-emerald-800" },
  viral: { label: "Viral Engine", color: "text-violet-300 bg-violet-950/60 border-violet-800" },
  experimental: { label: "Experimental", color: "text-amber-300 bg-amber-950/60 border-amber-800" },
};

function IdeaCard({
  result,
  onClose,
  portfolioLink,
  onRunStatusChange,
}: {
  result: IdeaEvaluationResult;
  onClose?: () => void;
  portfolioLink?: string;
  onRunStatusChange?: (runId: number, status: RunStatus) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const ok = await copyToClipboard(result.buildPrompt);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const engineMeta = result.engineType ? ENGINE_LABELS[result.engineType] : null;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-white">{result.name}</h3>
          <p className="text-sm text-zinc-400">{result.buyer}</p>
          {result.idea && (
            <p className="text-xs text-zinc-600 leading-relaxed max-w-xl">{result.idea}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <div className="flex items-center gap-2">
            {engineMeta && (
              <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${engineMeta.color}`}>
                {engineMeta.label}
              </span>
            )}
            {result.regulatedDomain && (
              <span
                className="text-xs font-semibold px-2.5 py-1 rounded-full border text-yellow-300 bg-yellow-950/60 border-yellow-700"
                title="This idea touches a regulated domain (legal/HR/visa/medical/financial). A mandatory disclaimer has been added to the build prompt."
              >
                ⚠ Regulated
              </span>
            )}
            <span
              className={`text-xs font-bold px-3 py-1 rounded-full border ${decisionColor(result.decision)}`}
            >
              {result.decision}
            </span>
            {onClose && (
              <button
                onClick={onClose}
                className="text-zinc-500 hover:text-white transition-colors text-lg leading-none"
                aria-label="Close"
              >
                ×
              </button>
            )}
          </div>
          {/* Revenue Probability + Time to Revenue */}
          {(result.revenueProbability !== undefined || result.timeToFirstRevenue !== undefined) && (
            <div className="flex items-center gap-2">
              {result.revenueProbability !== undefined && (
                <span className={`text-xs px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 ${scoreColor(result.revenueProbability)}`}>
                  Rev prob {result.revenueProbability}/5
                </span>
              )}
              {result.timeToFirstRevenue && (
                <span className={`text-xs px-2 py-0.5 rounded border ${result.timeToFirstRevenue === "Fast" ? "text-emerald-400 bg-emerald-950/40 border-emerald-800" : result.timeToFirstRevenue === "Medium" ? "text-amber-400 bg-amber-950/40 border-amber-800" : "text-red-400 bg-red-950/40 border-red-800"}`}>
                  {result.timeToFirstRevenue}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Scores */}
      <div className="space-y-2">
        <div className="flex justify-between items-center mb-3">
          <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
            Scores
          </span>
          <span className="text-sm font-semibold text-white">
            Total:{" "}
            <span className={scoreColor(result.totalScore / 8)}>
              {result.totalScore}
              <span className="text-zinc-500">/40</span>
            </span>
          </span>
        </div>
        <ScoreBar label="Buyer Clarity" value={result.scores.buyerClarity} />
        <ScoreBar label="Pain Urgency" value={result.scores.painUrgency} />
        <ScoreBar label="Market Exists" value={result.scores.marketExistence} />
        <ScoreBar label="Differentiation" value={result.scores.differentiation} />
        <ScoreBar label="Not Replaceable" value={result.scores.replaceability} />
        <ScoreBar label="Virality" value={result.scores.virality} />
        <ScoreBar label="Monetisation" value={result.scores.monetisation} />
        <ScoreBar label="Build Simplicity" value={result.scores.buildSimplicity} />
      </div>

      {/* Reason */}
      <p className="text-sm text-zinc-300 leading-relaxed">{result.reason}</p>

      {/* Monetisation + Viral */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-zinc-800/60 rounded-lg p-3">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
            Monetisation
          </p>
          <p className="text-sm text-zinc-200">{result.monetisationAngle}</p>
        </div>
        <div className="bg-zinc-800/60 rounded-lg p-3">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
            Viral Trigger
          </p>
          <p className="text-sm text-zinc-200">{result.viralTrigger}</p>
        </div>
      </div>

      {/* Region */}
      {result.region && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-800/30 p-4 space-y-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Region</span>
            <span className="text-xs px-2 py-0.5 rounded bg-zinc-700 text-zinc-200 font-semibold">
              {result.region.primary}
            </span>
            {result.region.secondary.map((s) => (
              <span key={s} className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                {s}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-emerald-600 mb-0.5">✓ Why it works</p>
              <p className="text-xs text-zinc-300">{result.region.whyWorks}</p>
            </div>
            <div>
              <p className="text-xs text-red-600 mb-0.5">✗ Where it fails</p>
              <p className="text-xs text-zinc-300">{result.region.whyFails}</p>
            </div>
          </div>
        </div>
      )}

      {/* Novelty flags */}
      {result.noveltyFlags && (
        <div className="flex flex-wrap gap-2">
          <span className="text-xs text-zinc-600">Novelty:</span>
          {(
            [
              ["domainTwist", "Domain Twist"],
              ["perspectiveFlip", "Perspective Flip"],
              ["outputTransformation", "Output Transformation"],
              ["constraintInjection", "Constraint Injection"],
            ] as const
          ).map(([key, label]) => (
            <span
              key={key}
              className={`text-xs px-2 py-0.5 rounded border ${result.noveltyFlags![key] ? "text-emerald-400 border-emerald-800 bg-emerald-950/30" : "text-zinc-600 border-zinc-800"}`}
            >
              {result.noveltyFlags![key] ? "✓" : "✗"} {label}
            </span>
          ))}
        </div>
      )}

      {/* Portfolio link */}
      {portfolioLink && (
        <div className="rounded-lg border border-indigo-800 bg-indigo-950/20 p-3">
          <p className="text-xs text-indigo-400 uppercase tracking-wider mb-1">Portfolio Link</p>
          <p className="text-sm text-indigo-200">{portfolioLink}</p>
        </div>
      )}

      {/* Improved idea */}
      {result.improvedIdea && (
        <div className="border border-amber-900/50 bg-amber-950/20 rounded-lg p-3">
          <p className="text-xs text-amber-500 uppercase tracking-wider mb-1">
            Improved Direction
          </p>
          <p className="text-sm text-amber-200">{result.improvedIdea}</p>
        </div>
      )}

      {/* Build prompt */}
      {result.decision === "BUILD" && result.buildPrompt && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
              Build Prompt
            </span>
            <button
              onClick={handleCopy}
              className="text-xs px-3 py-1.5 rounded-lg bg-emerald-900/50 text-emerald-300 hover:bg-emerald-800/60 border border-emerald-800 transition-colors"
            >
              {copied ? "Copied!" : "Copy Prompt"}
            </button>
          </div>
          <pre className="text-xs text-zinc-400 bg-zinc-950 rounded-lg p-4 overflow-auto max-h-48 leading-relaxed whitespace-pre-wrap">
            {result.buildPrompt}
          </pre>
        </div>
      )}

      {/* Fallback notice */}
      {result.fallbackUsed && (
        <p className="text-xs text-zinc-600 italic">
          AI response invalid — local scoring used.
        </p>
      )}

      {/* E2 — Queue for Build button */}
      {result.decision === "BUILD" &&
        result.runId != null &&
        onRunStatusChange && (
          <div className="flex items-center gap-2 pt-1">
            {result.runStatus === "QUEUED" || result.runStatus === "IN_PROGRESS" ? (
              <button
                onClick={() => onRunStatusChange(result.runId!, "DECIDED")}
                className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-400 hover:bg-zinc-700 border border-zinc-700 transition-colors"
              >
                Dequeue
              </button>
            ) : result.runStatus === "LAUNCHED" ? (
              <span className="text-xs px-3 py-1.5 rounded-lg bg-emerald-900/40 text-emerald-400 border border-emerald-800">
                Launched ✓
              </span>
            ) : (
              <button
                onClick={() => onRunStatusChange(result.runId!, "QUEUED")}
                className="text-xs px-3 py-1.5 rounded-lg bg-blue-900/50 text-blue-300 hover:bg-blue-800/60 border border-blue-800 transition-colors"
              >
                Queue for Build
              </button>
            )}
          </div>
        )}

      {/* PR #5 — Quantitative outcomes (read-only) */}
      {result.runId != null && result.runId > 0 && (
        <OutcomesSection runId={result.runId} />
      )}

      {/* PR #6 — Scaffold runnable app (BUILD ideas that have been persisted) */}
      {result.decision === "BUILD" && result.runId != null && result.runId > 0 && (
        <ScaffoldSection result={result} />
      )}
    </div>
  );
}

// =============================================================================
// Manual evaluation tab
// =============================================================================

function ManualTab({
  onResult,
}: {
  onResult: (r: IdeaEvaluationResult) => void;
}) {
  const [idea, setIdea] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IdeaEvaluationResult | null>(null);

  const handleEvaluate = async () => {
    if (!idea.trim()) {
      setError("Please enter an idea before evaluating.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await factoryClient.evaluateIdea({ idea: idea.trim() });
      setResult(res);
      onResult(res);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Evaluation failed. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <label className="block text-sm font-medium text-zinc-300">
          Describe your app idea
        </label>
        <textarea
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="e.g. A salary benchmarking tool for UAE professionals comparing their compensation against market rates by role, seniority and emirate"
          className="w-full h-32 px-4 py-3 bg-zinc-900 border border-zinc-700 rounded-xl text-zinc-100 text-sm placeholder-zinc-600 resize-none focus:outline-none focus:border-zinc-500 transition-colors"
          disabled={loading}
        />
      </div>

      <button
        onClick={handleEvaluate}
        disabled={loading || !idea.trim()}
        className="px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white text-sm font-medium transition-colors"
      >
        {loading ? "Evaluating…" : "Evaluate Idea"}
      </button>

      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {result && (
        <IdeaCard result={result} onClose={() => setResult(null)} />
      )}
    </div>
  );
}

// =============================================================================
// Generate Portfolio tab — ONE BUTTON, Dual Engine, Pattern-aware
// =============================================================================

function GeneratePortfolioTab({
  onResults,
  patterns,
}: {
  onResults: (ideas: IdeaEvaluationResult[]) => void;
  patterns: PatternEntry[];
}) {
  const [niche, setNiche] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [portfolio, setPortfolio] = useState<GeneratePortfolioResponse | null>(null);
  const [expanded, setExpanded] = useState<"revenue" | "viral" | "experimental" | null>(null);

  const handleGeneratePortfolio = async () => {
    setLoading(true);
    setError(null);
    setPortfolio(null);
    setExpanded(null);
    try {
      const res = await factoryClient.generatePortfolio({
        niche: niche.trim() || undefined,
        patterns: patterns.length > 0 ? patterns : undefined,
      });
      setPortfolio(res);
      onResults([res.revenueIdea, res.viralIdea, res.experimentalIdea]);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Generation failed. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  const ENGINE_CARDS = portfolio
    ? ([
        {
          key: "revenue" as const,
          idea: portfolio.revenueIdea,
          badge: "Revenue Engine",
          badgeColor: "text-emerald-300 bg-emerald-950/60 border-emerald-800",
          tagline: "Fastest path to paid users",
        },
        {
          key: "viral" as const,
          idea: portfolio.viralIdea,
          badge: "Viral Engine",
          badgeColor: "text-violet-300 bg-violet-950/60 border-violet-800",
          tagline: "< 30 sec to value · built to share",
        },
        {
          key: "experimental" as const,
          idea: portfolio.experimentalIdea,
          badge: "Experimental",
          badgeColor: "text-amber-300 bg-amber-950/60 border-amber-800",
          tagline: "Needs refinement — worth exploring",
        },
      ] as const)
    : null;

  return (
    <div className="space-y-6">
      {/* Description */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <p className="text-sm text-zinc-300 leading-relaxed">
          Generates exactly <span className="text-white font-semibold">3 ideas</span> using the{" "}
          <span className="text-emerald-400">Dual Engine method</span>:{" "}
          one optimised for <span className="text-emerald-300">Revenue</span>, one for{" "}
          <span className="text-violet-300">Virality</span>, and one <span className="text-amber-300">Experimental</span> concept.
          Each idea passes the <span className="text-white">Novelty Engine</span> (domain twist · perspective flip · output transformation · constraint injection)
          and includes <span className="text-white">Region Recognition</span>.{" "}
          {patterns.length > 0 && (
            <span className="text-indigo-400">
              Pattern Engine active — learning from {patterns.length} previous idea{patterns.length !== 1 ? "s" : ""}.
            </span>
          )}
        </p>
      </div>

      {/* Niche input + Generate button */}
      <div className="flex gap-3 items-end">
        <div className="flex-1 space-y-1.5">
          <label className="block text-xs font-medium text-zinc-400 uppercase tracking-wider">
            Target niche <span className="text-zinc-600 normal-case">(optional)</span>
          </label>
          <input
            type="text"
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            placeholder="e.g. UAE HR managers, Mauritius fintech founders, GCC freelancers…"
            className="w-full px-4 py-2.5 bg-zinc-900 border border-zinc-700 rounded-xl text-zinc-100 text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
            disabled={loading}
            onKeyDown={(e) => e.key === "Enter" && !loading && handleGeneratePortfolio()}
          />
        </div>
        <button
          onClick={handleGeneratePortfolio}
          disabled={loading}
          className="shrink-0 px-8 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white text-sm font-semibold transition-colors"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              Generating…
            </span>
          ) : (
            "Generate Portfolio"
          )}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Portfolio result */}
      {portfolio && ENGINE_CARDS && (
        <div className="space-y-4">
          {/* Portfolio link banner */}
          <div className="rounded-xl border border-indigo-800 bg-indigo-950/30 p-4 flex items-start gap-3">
            <span className="text-indigo-400 shrink-0 text-base mt-0.5">⇢</span>
            <div>
              <p className="text-xs text-indigo-400 uppercase tracking-wider font-medium mb-1">Portfolio Link</p>
              <p className="text-sm text-indigo-200">{portfolio.portfolioLink}</p>
            </div>
          </div>

          {portfolio.fallbackUsed && (
            <p className="text-xs text-zinc-600 italic">
              AI response invalid — local scoring used.
            </p>
          )}

          {/* 3 engine cards */}
          <div className="space-y-3">
            {ENGINE_CARDS.map(({ key, idea, badge, badgeColor, tagline }) => (
              <div key={key} className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
                {/* Summary row — always visible */}
                <button
                  onClick={() => setExpanded(expanded === key ? null : key)}
                  className="w-full flex items-center justify-between px-5 py-4 hover:bg-zinc-800/40 transition-colors text-left"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border shrink-0 ${badgeColor}`}>
                      {badge}
                    </span>
                    <div className="min-w-0">
                      <span className="font-semibold text-white truncate block">{idea.name}</span>
                      <span className="text-xs text-zinc-500">{tagline}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
                    <span className={`text-xs px-2 py-0.5 rounded border ${decisionColor(idea.decision)}`}>
                      {idea.decision}
                    </span>
                    <span className={`font-mono text-sm font-bold ${scoreColor(idea.totalScore / 8)}`}>
                      {idea.totalScore}/40
                    </span>
                    {idea.timeToFirstRevenue && (
                      <span className={`text-xs px-2 py-0.5 rounded border ${idea.timeToFirstRevenue === "Fast" ? "text-emerald-400 border-emerald-800" : idea.timeToFirstRevenue === "Medium" ? "text-amber-400 border-amber-800" : "text-red-400 border-red-800"}`}>
                        {idea.timeToFirstRevenue}
                      </span>
                    )}
                    <span className="text-zinc-500 text-sm">
                      {expanded === key ? "↑" : "↓"}
                    </span>
                  </div>
                </button>

                {/* Expanded detail */}
                {expanded === key && (
                  <div className="border-t border-zinc-800 p-5">
                    <IdeaCard
                      result={idea}
                      portfolioLink={key !== "experimental" ? portfolio.portfolioLink : undefined}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Legacy explorer tab (batch mode — kept for power users)
type GenerateMode = "fast-money" | "premium" | "viral";

function AutoTab({ onResults }: { onResults: (r: IdeaEvaluationResult[]) => void }) {
  const [niche, setNiche] = useState("");
  const [mode, setMode] = useState<GenerateMode>("premium");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ideas, setIdeas] = useState<IdeaEvaluationResult[]>([]);
  const [selected, setSelected] = useState<IdeaEvaluationResult | null>(null);

  const handleGenerateIdeas = async () => {
    setLoading(true);
    setError(null);
    setIdeas([]);
    setSelected(null);
    try {
      const res = await factoryClient.generateIdeas({
        niche: niche.trim() || undefined,
        mode,
      });
      setIdeas(res.ideas);
      onResults(res.ideas);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Generation failed. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  const modeOptions: { value: GenerateMode; label: string }[] = [
    { value: "fast-money", label: "Fast Money" },
    { value: "premium", label: "Premium" },
    { value: "viral", label: "Viral" },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className="block text-sm font-medium text-zinc-300">
            Niche <span className="text-zinc-600">(optional)</span>
          </label>
          <input
            type="text"
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            placeholder="e.g. UAE HR managers…"
            className="w-full px-4 py-2.5 bg-zinc-900 border border-zinc-700 rounded-xl text-zinc-100 text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
            disabled={loading}
          />
        </div>
        <div className="space-y-2">
          <label className="block text-sm font-medium text-zinc-300">Mode</label>
          <div className="flex gap-2">
            {modeOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setMode(opt.value)}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${mode === opt.value ? "bg-indigo-700 border-indigo-600 text-white" : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-zinc-600"}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <button
        onClick={handleGenerateIdeas}
        disabled={loading}
        className="px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white text-sm font-medium transition-colors"
      >
        {loading ? "Generating…" : "Generate 10 Ideas"}
      </button>
      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-4 text-sm text-red-300">{error}</div>
      )}
      {ideas.length > 0 && (
        <div className="space-y-3">
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/80">
                  <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider w-8">#</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Idea</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider hidden sm:table-cell">Buyer</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Score</th>
                  <th className="text-center px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Decision</th>
                  <th className="px-4 py-3 w-24" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {ideas.map((idea, i) => (
                  <IdeaRow
                    key={i}
                    rank={i + 1}
                    idea={idea}
                    onView={() => setSelected(selected?.name === idea.name ? null : idea)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {selected && <IdeaCard result={selected} onClose={() => setSelected(null)} />}
        </div>
      )}
    </div>
  );
}

function IdeaRow({
  rank,
  idea,
  onView,
}: {
  rank: number;
  idea: IdeaEvaluationResult;
  onView: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!idea.buildPrompt) return;
    const ok = await copyToClipboard(idea.buildPrompt);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <tr className="hover:bg-zinc-800/30 transition-colors">
      <td className="px-4 py-3 text-zinc-600 text-xs">{rank}</td>
      <td className="px-4 py-3">
        <span className="font-medium text-zinc-100">{idea.name}</span>
        <p className="text-xs text-zinc-500 mt-0.5 line-clamp-1">{idea.monetisationAngle}</p>
      </td>
      <td className="px-4 py-3 text-zinc-400 text-xs hidden sm:table-cell">
        {idea.buyer}
      </td>
      <td className="px-4 py-3 text-right">
        <span className={`font-mono text-sm font-semibold ${scoreColor(idea.totalScore / 8)}`}>
          {idea.totalScore}
        </span>
      </td>
      <td className="px-4 py-3 text-center">
        <span
          className={`text-xs font-bold px-2 py-0.5 rounded-full border ${decisionColor(idea.decision)}`}
        >
          {idea.decision}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2 justify-end">
          <button
            onClick={onView}
            className="text-xs px-2.5 py-1 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors border border-zinc-700"
          >
            Details
          </button>
          {idea.decision === "BUILD" && idea.buildPrompt && (
            <button
              onClick={handleCopy}
              className="text-xs px-2.5 py-1 rounded-lg bg-emerald-900/40 text-emerald-400 hover:bg-emerald-800/50 transition-colors border border-emerald-800"
            >
              {copied ? "✓" : "Copy"}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// =============================================================================
// History tab
// =============================================================================

function HistoryTab({
  history,
  onClear,
  onRunStatusChange,
}: {
  history: IdeaEvaluationResult[];
  onClear: () => void;
  onRunStatusChange?: (runId: number, status: RunStatus) => void;
}) {
  const [selected, setSelected] = useState<IdeaEvaluationResult | null>(null);
  // E9 — prompt version filter
  const [versionFilter, setVersionFilter] = useState<string>("all");

  // Collect distinct promptVersions from history
  const promptVersions = useMemo(() => {
    const vs = new Set<string>();
    for (const item of history) {
      if (item.promptVersion) vs.add(item.promptVersion);
    }
    return Array.from(vs).sort();
  }, [history]);

  const filtered = useMemo(() => {
    if (versionFilter === "all") return history;
    return history.filter((h) => h.promptVersion === versionFilter);
  }, [history, versionFilter]);

  if (history.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-10 text-center">
        <p className="text-zinc-500 text-sm">No ideas evaluated yet.</p>
        <p className="text-zinc-600 text-xs mt-1">
          Use Manual Evaluation or Generate Portfolio to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="text-sm text-zinc-400">
          {filtered.length} idea{filtered.length !== 1 ? "s" : ""}
          {versionFilter !== "all" && ` (${versionFilter})`}
        </span>
        <div className="flex items-center gap-3">
          {/* E9 — prompt version filter */}
          {promptVersions.length > 0 && (
            <select
              value={versionFilter}
              onChange={(e) => setVersionFilter(e.target.value)}
              className="text-xs bg-zinc-800 border border-zinc-700 text-zinc-300 rounded-lg px-2 py-1.5 focus:outline-none focus:border-zinc-600"
            >
              <option value="all">All versions</option>
              {promptVersions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => {
              setSelected(null);
              onClear();
            }}
            className="text-xs text-zinc-600 hover:text-red-400 transition-colors"
          >
            Clear history
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {filtered.map((item, i) => (
          <button
            key={i}
            onClick={() => setSelected(selected?.name === item.name ? null : item)}
            className={`group flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors text-left ${
              selected?.name === item.name
                ? "bg-zinc-700 border-zinc-600"
                : "bg-zinc-900 border-zinc-800 hover:border-zinc-600"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${item.decision === "BUILD" ? "bg-emerald-500" : item.decision === "REWORK" ? "bg-amber-500" : "bg-red-500"}`}
            />
            <span className="text-xs text-zinc-300 group-hover:text-white transition-colors max-w-48 truncate">
              {item.name}
            </span>
            {/* E2 — show queue status badge */}
            {item.runStatus && item.runStatus !== "DECIDED" && (
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                  item.runStatus === "LAUNCHED"
                    ? "bg-emerald-900/40 text-emerald-400 border-emerald-800"
                    : item.runStatus === "KILLED"
                      ? "bg-red-900/40 text-red-400 border-red-800"
                      : "bg-blue-900/40 text-blue-400 border-blue-800"
                }`}
              >
                {item.runStatus}
              </span>
            )}
          </button>
        ))}
      </div>
      {selected && (
        <IdeaCard
          result={selected}
          onClose={() => setSelected(null)}
          onRunStatusChange={onRunStatusChange}
        />
      )}
    </div>
  );
}

// =============================================================================
// Dashboard tab
// =============================================================================

const PIPELINE_STATUSES: PipelineStatus[] = [
  "Idea Generated",
  "Prompt Copied",
  "Building",
  "Built",
  "Launched",
  "Testing",
  "Killed",
];

function statusColor(s: PipelineStatus) {
  switch (s) {
    case "Launched":
      return "text-emerald-400 bg-emerald-950/60 border-emerald-800";
    case "Built":
      return "text-blue-400 bg-blue-950/60 border-blue-800";
    case "Building":
      return "text-indigo-400 bg-indigo-950/60 border-indigo-800";
    case "Testing":
      return "text-amber-400 bg-amber-950/60 border-amber-800";
    case "Killed":
      return "text-red-400 bg-red-950/60 border-red-800";
    case "Prompt Copied":
      return "text-violet-400 bg-violet-950/60 border-violet-800";
    default:
      return "text-zinc-400 bg-zinc-800/60 border-zinc-700";
  }
}

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: "green" | "amber" | "red" | "default";
}) {
  const colors = {
    green: "text-emerald-400",
    amber: "text-amber-400",
    red: "text-red-400",
    default: "text-white",
  };
  return (
    <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4 space-y-1">
      <p className="text-xs text-zinc-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold ${colors[accent ?? "default"]}`}>
        {value}
      </p>
      {sub && <p className="text-xs text-zinc-600">{sub}</p>}
    </div>
  );
}

function DashboardTab({
  history,
  pipeline,
  traction,
  onPipelineChange,
  onTractionChange,
  onAddToPipeline,
  onExportRuns,
  currentPromptVersion,
}: {
  history: IdeaEvaluationResult[];
  pipeline: PipelineEntry[];
  traction: TractionEntry[];
  onPipelineChange: (updated: PipelineEntry[]) => void;
  onTractionChange: (updated: TractionEntry[]) => void;
  onAddToPipeline: (idea: IdeaEvaluationResult) => void;
  onExportRuns?: (filter: "BUILD" | "all") => void;
  currentPromptVersion?: string;
}) {
  const builds = history.filter((h) => h.decision === "BUILD");
  const reworks = history.filter((h) => h.decision === "REWORK");
  const kills = history.filter((h) => h.decision === "KILL");
  // E2 — queue counts from DB runStatus
  const queued = history.filter((h) => h.runStatus === "QUEUED" || h.runStatus === "IN_PROGRESS");
  const launched = history.filter((h) => h.runStatus === "LAUNCHED");
  const bestScore = history.length
    ? Math.max(...history.map((h) => h.totalScore))
    : 0;
  const lastDate =
    history.length > 0
      ? new Date().toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : null;
  // E8 — advanced analytics
  const buildRate =
    history.length > 0 ? Math.round((builds.length / history.length) * 100) : 0;
  const avgScore =
    history.length > 0
      ? Math.round((history.reduce((s, h) => s + h.totalScore, 0) / history.length) * 10) / 10
      : 0;
  const fallbackRate =
    history.length > 0
      ? Math.round((history.filter((h) => h.fallbackUsed).length / history.length) * 100)
      : 0;
  // Ideas this week (based on evaluatedAt)
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const thisWeek = history.filter((h) => h.evaluatedAt && h.evaluatedAt >= oneWeekAgo).length;
  // Score distribution
  const buckets = { low: 0, medium: 0, high: 0 };
  for (const h of history) {
    if (h.totalScore >= 32) buckets.high++;
    else if (h.totalScore >= 24) buckets.medium++;
    else buckets.low++;
  }
  // Top domain
  const domainCounts: Record<string, number> = {};
  for (const h of history) {
    const t = h.idea.toLowerCase();
    let cat = "general";
    if (/salary|payroll|compensation|hr/.test(t)) cat = "hr-finance";
    else if (/legal|compliance|contract|visa|permit/.test(t)) cat = "legal-compliance";
    else if (/marketing|social|viral|share/.test(t)) cat = "marketing";
    else if (/resume|cv|career|job/.test(t)) cat = "career";
    else if (/invoice|proposal|freelance|client/.test(t)) cat = "freelance";
    else if (/tax|vat|accounting|finance/.test(t)) cat = "finance";
    domainCounts[cat] = (domainCounts[cat] ?? 0) + 1;
  }
  const topDomain = Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";

  // Top 3 opportunities
  const top3 = [...history]
    .filter((h) => h.decision === "BUILD")
    .sort((a, b) => {
      const scoreA =
        a.scores.monetisation * 2 +
        a.scores.virality * 1.5 +
        a.scores.buildSimplicity;
      const scoreB =
        b.scores.monetisation * 2 +
        b.scores.virality * 1.5 +
        b.scores.buildSimplicity;
      return scoreB - scoreA;
    })
    .slice(0, 3);

  // Alerts
  const alerts: { level: "warn" | "info"; text: string }[] = [];
  const highRevenueBUILD = builds.find(
    (h) => h.scores.monetisation >= 4,
  );
  const highRevenuePipelined = pipeline.find(
    (p) => p.scores.monetisation >= 4,
  );
  if (highRevenueBUILD && !highRevenuePipelined) {
    alerts.push({
      level: "warn",
      text: `High-revenue idea "${highRevenueBUILD.name}" has not been added to your pipeline yet.`,
    });
  }
  const viralBuild = builds.find((h) => h.scores.virality >= 4);
  const viralLaunched = pipeline.find(
    (p) => p.scores.virality >= 4 && p.status === "Launched",
  );
  if (viralBuild && !viralLaunched) {
    alerts.push({
      level: "warn",
      text: `Viral idea "${viralBuild.name}" has not been launched yet.`,
    });
  }
  const killedByKillConditions = pipeline.filter(
    (p) =>
      p.status !== "Killed" &&
      (p.scores.buyerClarity <= 2 ||
        p.scores.differentiation <= 2 ||
        p.scores.replaceability <= 2),
  );
  killedByKillConditions.forEach((p) => {
    alerts.push({
      level: "warn",
      text: `"${p.name}" meets kill conditions — consider marking it as Killed.`,
    });
  });
  const launchedWithNoTraction = pipeline.filter((p) => {
    if (p.status !== "Launched") return false;
    const t = traction.find((tr) => tr.name === p.name);
    return !t || (!t.revenue && !t.users && !t.sales);
  });
  launchedWithNoTraction.forEach((p) => {
    alerts.push({
      level: "info",
      text: `"${p.name}" is launched but has no traction data recorded.`,
    });
  });

  // Next best action
  let nextAction = "Generate your first portfolio of ideas to get started.";
  if (history.length === 0) {
    nextAction = "Generate your first portfolio of ideas to get started.";
  } else if (pipeline.length === 0 && builds.length > 0) {
    nextAction = `Add "${builds[0].name}" to your pipeline and copy its build prompt.`;
  } else if (
    pipeline.some((p) => p.status === "Idea Generated" || p.status === "Prompt Copied")
  ) {
    const p = pipeline.find(
      (p) => p.status === "Idea Generated" || p.status === "Prompt Copied",
    );
    nextAction = `Start building "${p!.name}" — the prompt is ready.`;
  } else if (pipeline.some((p) => p.status === "Built")) {
    const p = pipeline.find((p) => p.status === "Built");
    nextAction = `Launch "${p!.name}" — it's built and ready to go live.`;
  } else if (launchedWithNoTraction.length > 0) {
    nextAction = `Add traction data for "${launchedWithNoTraction[0].name}" to track progress.`;
  } else if (kills.length > reworks.length + builds.length) {
    nextAction = "Most ideas are being killed. Generate a new portfolio with a tighter niche.";
  } else {
    nextAction = "Keep building momentum — review traction data and update pipeline status.";
  }

  // Traction editing
  const [editingTraction, setEditingTraction] = useState<string | null>(null);
  const getTraction = (name: string): TractionEntry =>
    traction.find((t) => t.name === name) ?? {
      name,
      revenue: "",
      views: "",
      users: "",
      sales: "",
      shares: "",
      notes: "",
    };

  const updateTraction = (updated: TractionEntry) => {
    const next = [
      updated,
      ...traction.filter((t) => t.name !== updated.name),
    ];
    onTractionChange(next);
  };

  const updatePipelineStatus = (name: string, status: PipelineStatus) => {
    const next = pipeline.map((p) => (p.name === name ? { ...p, status } : p));
    onPipelineChange(next);
  };

  const removeFromPipeline = (name: string) => {
    onPipelineChange(pipeline.filter((p) => p.name !== name));
  };

  const buildsNotInPipeline = builds.filter(
    (b) => !pipeline.some((p) => p.name === b.name),
  );

  return (
    <div className="space-y-8">
      {/* Next Best Action */}
      <div className="rounded-xl border border-indigo-800 bg-indigo-950/30 p-5 flex items-start gap-4">
        <div className="w-8 h-8 rounded-lg bg-indigo-700/50 flex items-center justify-center shrink-0 mt-0.5">
          <span className="text-indigo-300 text-base">→</span>
        </div>
        <div>
          <p className="text-xs text-indigo-400 font-medium uppercase tracking-wider mb-1">
            Next Best Action
          </p>
          <p className="text-sm font-semibold text-white">{nextAction}</p>
        </div>
      </div>

      {/* Portfolio Summary */}
      <div className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
            Portfolio Summary
          </h2>
          {/* E6 — Export + E9 — prompt version */}
          <div className="flex items-center gap-3">
            {currentPromptVersion && (
              <span className="text-xs text-zinc-600 font-mono">
                prompt {currentPromptVersion}
              </span>
            )}
            {onExportRuns && history.length > 0 && (
              <button
                onClick={() => onExportRuns("BUILD")}
                className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700 transition-colors"
              >
                Export BUILD Queue
              </button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatCard label="Total Evaluated" value={history.length} />
          <StatCard label="BUILD" value={builds.length} accent="green" />
          <StatCard label="REWORK" value={reworks.length} accent="amber" />
          <StatCard label="KILL" value={kills.length} accent="red" />
          <StatCard
            label="Best Score"
            value={bestScore ? `${bestScore}/40` : "—"}
            accent={bestScore >= 32 ? "green" : bestScore >= 24 ? "amber" : "default"}
          />
          <StatCard
            label="Last Generated"
            value={lastDate ?? "—"}
            sub="date of last evaluation"
          />
          {/* E2 — Queue counts */}
          <StatCard label="Queued / In Progress" value={queued.length} accent="default" />
          <StatCard label="Launched" value={launched.length} accent="green" />
          {/* E8 — Analytics */}
          <StatCard label="BUILD Rate" value={`${buildRate}%`} accent={buildRate >= 30 ? "green" : "default"} />
          <StatCard label="Avg Score" value={`${avgScore}/40`} accent={avgScore >= 28 ? "green" : avgScore >= 20 ? "amber" : "default"} />
          <StatCard label="Fallback Rate" value={`${fallbackRate}%`} accent={fallbackRate > 30 ? "red" : "default"} sub="AI vs local scoring" />
          <StatCard label="Top Domain" value={topDomain} />
          <StatCard label="Ideas This Week" value={thisWeek} />
          <StatCard
            label="Score Distribution"
            value={`${buckets.high}H / ${buckets.medium}M / ${buckets.low}L`}
            sub="≥32 / 24-31 / <24"
          />
        </div>
      </div>

      {/* Attention Alerts */}
      {alerts.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
            Attention
          </h2>
          <div className="space-y-2">
            {alerts.map((a, i) => (
              <div
                key={i}
                className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
                  a.level === "warn"
                    ? "border-amber-800 bg-amber-950/20 text-amber-200"
                    : "border-zinc-700 bg-zinc-900/60 text-zinc-300"
                }`}
              >
                <span className="shrink-0 mt-0.5">
                  {a.level === "warn" ? "⚠" : "ℹ"}
                </span>
                <span>{a.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top Opportunities */}
      {top3.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
            Current Best Opportunities
          </h2>
          <div className="space-y-3">
            {top3.map((idea, i) => (
              <div
                key={i}
                className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 flex items-start justify-between gap-4"
              >
                <div className="space-y-1 flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-600 text-xs font-mono">#{i + 1}</span>
                    <span className="font-semibold text-white truncate">
                      {idea.name}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-500">{idea.buyer}</p>
                  <div className="flex flex-wrap gap-2 mt-2">
                    <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                      Revenue {idea.scores.monetisation}/5
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                      Viral {idea.scores.virality}/5
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                      Build {idea.scores.buildSimplicity}/5
                    </span>
                  </div>
                </div>
                {!pipeline.some((p) => p.name === idea.name) && (
                  <button
                    onClick={() => onAddToPipeline(idea)}
                    className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-indigo-700 hover:bg-indigo-600 text-white border border-indigo-600 transition-colors"
                  >
                    Add to Pipeline
                  </button>
                )}
                {pipeline.some((p) => p.name === idea.name) && (
                  <span className="shrink-0 text-xs px-2 py-1 rounded-lg bg-zinc-800 text-zinc-500 border border-zinc-700">
                    In pipeline
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* App Pipeline Tracker */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
            App Pipeline
          </h2>
          {buildsNotInPipeline.length > 0 && (
            <span className="text-xs text-zinc-600">
              {buildsNotInPipeline.length} BUILD idea
              {buildsNotInPipeline.length !== 1 ? "s" : ""} not in pipeline
            </span>
          )}
        </div>

        {pipeline.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-8 text-center">
            <p className="text-zinc-500 text-sm">No apps in pipeline yet.</p>
            <p className="text-zinc-600 text-xs mt-1">
              Add BUILD ideas from the opportunities section above or from history.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {pipeline.map((entry, i) => (
              <div
                key={i}
                className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-white truncate">{entry.name}</p>
                    <p className="text-xs text-zinc-500 mt-0.5">{entry.buyer}</p>
                  </div>
                  <button
                    onClick={() => removeFromPipeline(entry.name)}
                    className="text-zinc-700 hover:text-red-400 transition-colors text-lg leading-none shrink-0"
                    aria-label="Remove from pipeline"
                  >
                    ×
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {PIPELINE_STATUSES.map((s) => (
                    <button
                      key={s}
                      onClick={() => updatePipelineStatus(entry.name, s)}
                      className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                        entry.status === s
                          ? statusColor(s)
                          : "text-zinc-600 bg-transparent border-zinc-800 hover:border-zinc-600 hover:text-zinc-400"
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                {/* Traction quick view */}
                {(() => {
                  const t = traction.find((tr) => tr.name === entry.name);
                  if (!t) return null;
                  const hasData = t.revenue || t.users || t.sales;
                  if (!hasData) return null;
                  return (
                    <div className="flex flex-wrap gap-3 pt-1">
                      {t.revenue && (
                        <span className="text-xs text-zinc-400">
                          💰 {t.revenue}
                        </span>
                      )}
                      {t.users && (
                        <span className="text-xs text-zinc-400">
                          👤 {t.users} users
                        </span>
                      )}
                      {t.sales && (
                        <span className="text-xs text-zinc-400">
                          🛒 {t.sales} sales
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Revenue / Traction Snapshot */}
      {pipeline.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
            Revenue &amp; Traction
          </h2>
          <div className="space-y-2">
            {pipeline.map((entry, i) => {
              const t = getTraction(entry.name);
              const isEditing = editingTraction === entry.name;
              return (
                <div
                  key={i}
                  className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden"
                >
                  <button
                    onClick={() =>
                      setEditingTraction(isEditing ? null : entry.name)
                    }
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-zinc-800/40 transition-colors"
                  >
                    <span className="text-sm font-medium text-zinc-200">
                      {entry.name}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {isEditing ? "collapse ↑" : "edit ↓"}
                    </span>
                  </button>
                  {isEditing && (
                    <div className="px-4 pb-4 space-y-3 border-t border-zinc-800">
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-3">
                        {(
                          [
                            ["revenue", "Revenue ($)"],
                            ["views", "Views"],
                            ["users", "Users"],
                            ["sales", "Sales"],
                            ["shares", "Shares"],
                          ] as const
                        ).map(([field, label]) => (
                          <div key={field} className="space-y-1">
                            <label className="text-xs text-zinc-500">
                              {label}
                            </label>
                            <input
                              type="text"
                              value={t[field]}
                              onChange={(e) =>
                                updateTraction({ ...t, [field]: e.target.value })
                              }
                              className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:border-zinc-500 transition-colors"
                            />
                          </div>
                        ))}
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-zinc-500">
                          Notes / Learnings
                        </label>
                        <textarea
                          value={t.notes}
                          onChange={(e) =>
                            updateTraction({ ...t, notes: e.target.value })
                          }
                          rows={2}
                          className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 text-sm resize-none focus:outline-none focus:border-zinc-500 transition-colors"
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Main Factory page
// =============================================================================

type FactoryTab = "dashboard" | "portfolio" | "explore" | "manual" | "history";

export default function FactoryPage() {
  const [activeTab, setActiveTab] = useState<FactoryTab>("dashboard");
  const [pipeline, setPipeline] = useState<PipelineEntry[]>(loadPipeline);
  const [traction, setTraction] = useState<TractionEntry[]>(loadTraction);

  // All DB-backed state (history, systemStatus, mutations) is managed by the hook
  const {
    history,
    systemStatus,
    duplicateWarning,
    dismissDuplicateWarning,
    addToHistory,
    handleRunStatusChange,
    clearHistory,
    exportRuns,
  } = useFactoryRun();

  // Derived pattern data for Pattern Engine
  const patterns = useMemo(
    () => extractPatterns(history, pipeline, traction),
    [history, pipeline, traction],
  );

  const handlePipelineChange = (updated: PipelineEntry[]) => {
    setPipeline(updated);
    savePipeline(updated);
  };

  const handleTractionChange = (updated: TractionEntry[]) => {
    setTraction(updated);
    saveTraction(updated);
  };

  const handleAddToPipeline = (idea: IdeaEvaluationResult) => {
    if (pipeline.some((p) => p.name === idea.name)) return;
    const entry: PipelineEntry = {
      name: idea.name,
      buyer: idea.buyer,
      decision: idea.decision,
      totalScore: idea.totalScore,
      monetisationAngle: idea.monetisationAngle,
      viralTrigger: idea.viralTrigger,
      scores: idea.scores,
      status: "Idea Generated",
      addedAt: new Date().toISOString(),
    };
    const next = [entry, ...pipeline];
    setPipeline(next);
    savePipeline(next);
  };


  // Derive current prompt version from most recent history item that has one
  const currentPromptVersion = useMemo(
    () => history.find((h) => h.promptVersion)?.promptVersion,
    [history],
  );

  const tabs: { id: FactoryTab; label: string }[] = [
    { id: "dashboard", label: "Dashboard" },
    { id: "portfolio", label: "Generate Portfolio" },
    { id: "explore", label: "Explore Ideas" },
    { id: "manual", label: "Manual Evaluation" },
    { id: "history", label: "History" },
  ];

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-4xl mx-auto px-6 py-10 space-y-8">
        {/* Header */}
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-white">App Factory V3</h1>
          <p className="text-sm text-zinc-400">
            Dual-engine idea factory — generates, filters, and learns what works.
          </p>
        </div>

        {/* PR #1 — Missing OPENAI_API_KEY banner. Renderer-side, but the
            authoritative source is the main process which reads dotenv at
            startup; see registerFactoryHandlers' getSystemStatus handler. */}
        {systemStatus && !systemStatus.openaiKeyPresent && (
          <div
            role="alert"
            data-testid="factory-missing-key-banner"
            className="rounded-xl border border-red-800 bg-red-950/30 p-4 space-y-1"
          >
            <p className="text-xs text-red-400 font-medium uppercase tracking-wider">
              OpenAI API key missing
            </p>
            <p className="text-sm text-red-200">
              Set <code className="px-1 py-0.5 rounded bg-red-900/40">OPENAI_API_KEY</code>{" "}
              in your <code className="px-1 py-0.5 rounded bg-red-900/40">.env</code> file
              (or shell environment) and restart the app. Until then, Factory
              evaluation, idea generation, and portfolio generation will fail
              with a clear error rather than silently substituting placeholder
              data.
            </p>
          </div>
        )}

        {/* E1 — Duplicate warning banner */}
        {duplicateWarning && (
          <div className="rounded-xl border border-amber-800 bg-amber-950/30 p-4 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs text-amber-400 font-medium uppercase tracking-wider mb-1">
                Duplicate detected
              </p>
              <p className="text-sm text-amber-200">
                "{duplicateWarning.existing.name}" was already saved (run #{duplicateWarning.id}).
                No duplicate was created.
              </p>
            </div>
            <button
              onClick={dismissDuplicateWarning}
              className="text-amber-600 hover:text-amber-400 transition-colors text-lg leading-none shrink-0"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 bg-zinc-900 rounded-xl p-1 w-fit flex-wrap">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "bg-zinc-700 text-white"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === "dashboard" && (
          <DashboardTab
            history={history}
            pipeline={pipeline}
            traction={traction}
            onPipelineChange={handlePipelineChange}
            onTractionChange={handleTractionChange}
            onAddToPipeline={handleAddToPipeline}
            onExportRuns={exportRuns}
            currentPromptVersion={currentPromptVersion}
          />
        )}
        {activeTab === "portfolio" && (
          <GeneratePortfolioTab
            patterns={patterns}
            onResults={(rs) => {
              addToHistory(rs);
            }}
          />
        )}
        {activeTab === "explore" && (
          <AutoTab
            onResults={(rs) => {
              addToHistory(rs);
            }}
          />
        )}
        {activeTab === "manual" && (
          <ManualTab onResult={(r) => addToHistory(r)} />
        )}
        {activeTab === "history" && (
          <HistoryTab
            history={history}
            onClear={clearHistory}
            onRunStatusChange={handleRunStatusChange}
          />
        )}
      </div>
    </div>
  );
}
