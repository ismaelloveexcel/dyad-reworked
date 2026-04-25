import { useSettings } from "@/hooks/useSettings";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

// PR #9 — Toggle for embedding-based novelty / dedup.
// When enabled, saveRun fetches an OpenAI text-embedding-3-small vector and
// checks cosine similarity against all stored runs before inserting a new one.
// Ideas that are semantically very similar to an existing run are returned as
// soft duplicates without being persisted.  Requires OPENAI_API_KEY.

export function FactoryEmbeddingDedupSwitch() {
  const { settings, updateSettings } = useSettings();

  const enabled = settings?.factoryEmbeddingDedup !== false;
  const threshold = settings?.factoryEmbeddingSimilarityThreshold ?? 0.92;
  const thresholdPct = Math.round(threshold * 100);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3">
        <Switch
          id="factory-embedding-dedup"
          aria-label="Factory semantic dedup"
          checked={enabled}
          onCheckedChange={(checked) => {
            updateSettings({ factoryEmbeddingDedup: checked });
          }}
        />
        <Label
          htmlFor="factory-embedding-dedup"
          className="text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Factory Semantic Dedup
        </Label>
      </div>
      <div className="text-sm text-gray-500 dark:text-gray-400">
        {enabled
          ? `Embedding-based dedup is on. Near-duplicate ideas (cosine similarity ≥ ${thresholdPct}%) are flagged without being saved.`
          : "Embedding-based dedup is off. Only exact fingerprint matches are detected."}
      </div>
    </div>
  );
}
