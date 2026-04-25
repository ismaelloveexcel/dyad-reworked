import { useSettings } from "@/hooks/useSettings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

// PR #3 — Factory quality-gate threshold selector.
// Ideas that score below this value (out of 40) are refused by saveRun
// and are not persisted to the database.

const DEFAULT_THRESHOLD = 20;

interface ThresholdOption {
  value: string;
  label: string;
  description: string;
}

const OPTIONS: ThresholdOption[] = [
  {
    value: "0",
    label: "Off (0) — save everything",
    description:
      "No quality gate. Every idea is persisted regardless of score.",
  },
  {
    value: "16",
    label: "Lenient (16 / 40)",
    description: "Only the very weakest ideas (< 40 %) are rejected.",
  },
  {
    value: "20",
    label: `Default (${DEFAULT_THRESHOLD} / 40)`,
    description:
      "Ideas scoring below 50 % are not saved. Recommended starting point.",
  },
  {
    value: "24",
    label: "Strict (24 / 40)",
    description:
      "Only ideas scoring ≥ 60 % are persisted. Keeps the history lean.",
  },
  {
    value: "28",
    label: "Very strict (28 / 40)",
    description: "Only BUILD-quality ideas (≥ 70 %) reach the database.",
  },
];

export function FactoryScoreThresholdSetting() {
  const { settings, updateSettings } = useSettings();

  const currentValue = String(
    settings?.factoryScoreThreshold ?? DEFAULT_THRESHOLD,
  );
  const currentOption =
    OPTIONS.find((o) => o.value === currentValue) ?? OPTIONS[2];

  const handleChange = (value: string) => {
    updateSettings({ factoryScoreThreshold: parseInt(value, 10) });
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-4">
        <Label
          htmlFor="factory-score-threshold"
          className="text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Factory Quality Gate
        </Label>
        <Select
          value={currentValue}
          onValueChange={(v) => v && handleChange(v)}
        >
          <SelectTrigger className="w-[220px]" id="factory-score-threshold">
            <SelectValue placeholder="Select threshold" />
          </SelectTrigger>
          <SelectContent>
            {OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="text-sm text-gray-500 dark:text-gray-400">
        {currentOption.description}
      </div>
    </div>
  );
}
