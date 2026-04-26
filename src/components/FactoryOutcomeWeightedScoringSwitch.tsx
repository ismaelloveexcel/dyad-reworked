import { useSettings } from "@/hooks/useSettings";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { factoryClient } from "@/ipc/types/factory";

// PR #14 — Toggle for outcome-weighted scoring.
// When enabled, the evaluate-idea handler fetches embeddings for the candidate
// idea, finds semantically similar past runs, loads their quantitative outcome
// data, and injects a context block into the LLM scoring prompt so scores are
// calibrated against real-world results.  Requires OPENAI_API_KEY (for
// embeddings) and meaningful outcome data from PR #13.

export function FactoryOutcomeWeightedScoringSwitch() {
  const { settings, updateSettings } = useSettings();

  const enabled = settings?.factoryOutcomeWeightedScoring === true;

  const handleChange = async (checked: boolean) => {
    // Persist via IPC so main-process settings stay in sync
    await factoryClient.toggleOutcomeWeightedScoring({ enabled: checked });
    updateSettings({ factoryOutcomeWeightedScoring: checked });
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3">
        <Switch
          id="factory-outcome-weighted-scoring"
          aria-label="Factory outcome-weighted scoring"
          checked={enabled}
          onCheckedChange={handleChange}
        />
        <Label
          htmlFor="factory-outcome-weighted-scoring"
          className="text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Factory Outcome-Weighted Scoring
        </Label>
      </div>
      <div className="text-sm text-gray-500 dark:text-gray-400">
        {enabled
          ? "Outcome-weighted scoring is on. The LLM evaluator receives real revenue and conversion data from similar past ideas to calibrate scores. Requires OPENAI_API_KEY and outcome data from the nightly ingest job."
          : "Outcome-weighted scoring is off. Standard LLM scoring is used without historical outcome signals. Enable once the nightly ingest job has collected data from at least a few launched ideas."}
      </div>
    </div>
  );
}
