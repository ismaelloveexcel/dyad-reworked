import { useState, useCallback } from "react";
import { factoryClient, type IdeaEvaluationResult } from "@/ipc/types/factory";

// =============================================================================
// Local storage persistence
// =============================================================================

const STORAGE_KEY = "factory-v3-history";

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
  } catch {
    // ignore quota errors
  }
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
// History panel
// =============================================================================

function HistoryPanel({
  history,
  onSelect,
  onClear,
}: {
  history: IdeaEvaluationResult[];
  onSelect: (r: IdeaEvaluationResult) => void;
  onClear: () => void;
}) {
  if (history.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-400">Recent Ideas</h3>
        <button
          onClick={onClear}
          className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
        >
          Clear history
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {history.map((item, i) => (
          <button
            key={i}
            onClick={() => onSelect(item)}
            className="group flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-zinc-600 transition-colors text-left"
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
    </div>
  );
}

// =============================================================================
// Main Factory page
// =============================================================================

export default function FactoryPage() {
  const [activeTab, setActiveTab] = useState<"manual" | "auto">("manual");
  const [history, setHistory] = useState<IdeaEvaluationResult[]>(loadHistory);
  const [historySelected, setHistorySelected] =
    useState<IdeaEvaluationResult | null>(null);

  const addToHistory = useCallback((items: IdeaEvaluationResult | IdeaEvaluationResult[]) => {
    setHistory((prev) => {
      const arr = Array.isArray(items) ? items : [items];
      // Deduplicate by name
      const names = new Set(arr.map((i) => i.name));
      const next = [
        ...arr,
        ...prev.filter((p) => !names.has(p.name)),
      ].slice(0, 50);
      saveHistory(next);
      return next;
    });
  }, []);

  const clearHistory = () => {
    setHistory([]);
    setHistorySelected(null);
    localStorage.removeItem(STORAGE_KEY);
  };

  const tabs = [
    { id: "manual" as const, label: "Manual Evaluation" },
    { id: "auto" as const, label: "Auto-Idea Generator" },
  ];

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-4xl mx-auto px-6 py-10 space-y-8">
        {/* Header */}
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-white">App Factory V3</h1>
          <p className="text-sm text-zinc-400">
            Evaluate ideas and generate ranked build candidates.
          </p>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-zinc-900 rounded-xl p-1 w-fit">
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
        {activeTab === "manual" ? (
          <ManualTab onResult={(r) => addToHistory(r)} />
        ) : (
          <AutoTab onResults={(rs) => addToHistory(rs)} />
        )}

        {/* History */}
        <HistoryPanel
          history={history}
          onSelect={(r) => {
            setHistorySelected(r);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          onClear={clearHistory}
        />

        {historySelected && (
          <IdeaCard
            result={historySelected}
            onClose={() => setHistorySelected(null)}
          />
        )}
      </div>
    </div>
  );
}
