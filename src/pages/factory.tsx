import { useState, useCallback } from "react";
import { factoryClient, type IdeaEvaluationResult } from "@/ipc/types/factory";

// =============================================================================
// Local storage persistence
// =============================================================================

const STORAGE_KEY = "factory-v3-history";
const PIPELINE_KEY = "factory-v3-pipeline";
const TRACTION_KEY = "factory-v3-traction";

// =============================================================================
// Pipeline + Traction types
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

export interface TractionEntry {
  name: string;
  revenue: string;
  views: string;
  users: string;
  sales: string;
  shares: string;
  notes: string;
}

function loadHistory(): IdeaEvaluationResult[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as IdeaEvaluationResult[];
  } catch {
    return [];
  }
}

function saveHistory(items: IdeaEvaluationResult[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 50)));
  } catch {}
}

function loadPipeline(): PipelineEntry[] {
  try {
    const raw = localStorage.getItem(PIPELINE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as PipelineEntry[];
  } catch {
    return [];
  }
}

function savePipeline(items: PipelineEntry[]) {
  try {
    localStorage.setItem(PIPELINE_KEY, JSON.stringify(items));
  } catch {}
}

function loadTraction(): TractionEntry[] {
  try {
    const raw = localStorage.getItem(TRACTION_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as TractionEntry[];
  } catch {
    return [];
  }
}

function saveTraction(items: TractionEntry[]) {
  try {
    localStorage.setItem(TRACTION_KEY, JSON.stringify(items));
  } catch {}
}

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
// Idea card
// =============================================================================

function IdeaCard({
  result,
  onClose,
}: {
  result: IdeaEvaluationResult;
  onClose?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const ok = await copyToClipboard(result.buildPrompt);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-white">{result.name}</h3>
          <p className="text-sm text-zinc-400 mt-0.5">{result.buyer}</p>
        </div>
        <div className="flex items-center gap-3">
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
          AI unavailable — local scoring used.
        </p>
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
// Auto-generator tab
// =============================================================================

type GenerateMode = "fast-money" | "premium" | "viral";

function AutoTab({ onResults }: { onResults: (r: IdeaEvaluationResult[]) => void }) {
  const [niche, setNiche] = useState("");
  const [mode, setMode] = useState<GenerateMode>("premium");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ideas, setIdeas] = useState<IdeaEvaluationResult[]>([]);
  const [selected, setSelected] = useState<IdeaEvaluationResult | null>(null);

  const handleGenerate = async () => {
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
        err instanceof Error
          ? err.message
          : "Generation failed. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  const modeOptions: { value: GenerateMode; label: string; desc: string }[] = [
    { value: "fast-money", label: "Fast Money", desc: "Quick wins, easy sales" },
    { value: "premium", label: "Premium", desc: "High-value, $20+ products" },
    { value: "viral", label: "Viral", desc: "Shareable, social-first" },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className="block text-sm font-medium text-zinc-300">
            Niche or context{" "}
            <span className="text-zinc-600">(optional)</span>
          </label>
          <input
            type="text"
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            placeholder="e.g. UAE HR managers, Mauritius freelancers…"
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
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                  mode === opt.value
                    ? "bg-indigo-700 border-indigo-600 text-white"
                    : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-zinc-600"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <button
        onClick={handleGenerate}
        disabled={loading}
        className="px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white text-sm font-medium transition-colors"
      >
        {loading ? "Generating ideas…" : "Generate 10 Ideas"}
      </button>

      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {ideas.length > 0 && (
        <div className="space-y-3">
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/80">
                  <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider w-8">
                    #
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">
                    Idea
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider hidden sm:table-cell">
                    Buyer
                  </th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">
                    Score
                  </th>
                  <th className="text-center px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">
                    Decision
                  </th>
                  <th className="px-4 py-3 w-24" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {ideas.map((idea, i) => (
                  <IdeaRow
                    key={i}
                    rank={i + 1}
                    idea={idea}
                    onView={() =>
                      setSelected(selected?.name === idea.name ? null : idea)
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>

          {selected && (
            <IdeaCard result={selected} onClose={() => setSelected(null)} />
          )}
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
}: {
  history: IdeaEvaluationResult[];
  onClear: () => void;
}) {
  const [selected, setSelected] = useState<IdeaEvaluationResult | null>(null);

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
      <div className="flex items-center justify-between">
        <span className="text-sm text-zinc-400">
          {history.length} idea{history.length !== 1 ? "s" : ""} saved
        </span>
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
      <div className="flex flex-wrap gap-2">
        {history.map((item, i) => (
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
          </button>
        ))}
      </div>
      {selected && (
        <IdeaCard result={selected} onClose={() => setSelected(null)} />
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
}: {
  history: IdeaEvaluationResult[];
  pipeline: PipelineEntry[];
  traction: TractionEntry[];
  onPipelineChange: (updated: PipelineEntry[]) => void;
  onTractionChange: (updated: TractionEntry[]) => void;
  onAddToPipeline: (idea: IdeaEvaluationResult) => void;
}) {
  const builds = history.filter((h) => h.decision === "BUILD");
  const reworks = history.filter((h) => h.decision === "REWORK");
  const kills = history.filter((h) => h.decision === "KILL");
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
        <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
          Portfolio Summary
        </h2>
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

type FactoryTab = "dashboard" | "auto" | "manual" | "history";

export default function FactoryPage() {
  const [activeTab, setActiveTab] = useState<FactoryTab>("dashboard");
  const [history, setHistory] = useState<IdeaEvaluationResult[]>(loadHistory);
  const [pipeline, setPipeline] = useState<PipelineEntry[]>(loadPipeline);
  const [traction, setTraction] = useState<TractionEntry[]>(loadTraction);

  const addToHistory = useCallback(
    (items: IdeaEvaluationResult | IdeaEvaluationResult[]) => {
      setHistory((prev) => {
        const arr = Array.isArray(items) ? items : [items];
        const names = new Set(arr.map((i) => i.name));
        const next = [
          ...arr,
          ...prev.filter((p) => !names.has(p.name)),
        ].slice(0, 50);
        saveHistory(next);
        return next;
      });
    },
    [],
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

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem(STORAGE_KEY);
  };

  const tabs: { id: FactoryTab; label: string }[] = [
    { id: "dashboard", label: "Dashboard" },
    { id: "auto", label: "Generate Portfolio" },
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
            Evaluate ideas, build a pipeline, and track your first revenue.
          </p>
        </div>

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
          />
        )}
        {activeTab === "auto" && (
          <AutoTab
            onResults={(rs) => {
              addToHistory(rs);
              setActiveTab("dashboard");
            }}
          />
        )}
        {activeTab === "manual" && (
          <ManualTab onResult={(r) => addToHistory(r)} />
        )}
        {activeTab === "history" && (
          <HistoryTab history={history} onClear={clearHistory} />
        )}
      </div>
    </div>
  );
}
