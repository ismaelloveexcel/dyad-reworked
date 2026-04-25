import { useSettings } from "@/hooks/useSettings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

// PR #8 — Factory provider selector.
// Lets users choose which AI provider (OpenAI, Anthropic, Google) powers the
// Factory pipeline. The selected provider's API key must be set in .env.

type FactoryProviderOption = {
  value: "openai" | "anthropic" | "google";
  label: string;
  description: string;
  envVar: string;
};

const OPTIONS: FactoryProviderOption[] = [
  {
    value: "openai",
    label: "OpenAI (gpt-4o-mini)",
    description:
      "Uses OpenAI GPT-4o-mini. Requires OPENAI_API_KEY in your environment.",
    envVar: "OPENAI_API_KEY",
  },
  {
    value: "anthropic",
    label: "Anthropic (claude-haiku)",
    description:
      "Uses Anthropic Claude Haiku. Requires ANTHROPIC_API_KEY in your environment.",
    envVar: "ANTHROPIC_API_KEY",
  },
  {
    value: "google",
    label: "Google (gemini-2.0-flash)",
    description:
      "Uses Google Gemini 2.0 Flash. Requires GOOGLE_API_KEY in your environment.",
    envVar: "GOOGLE_API_KEY",
  },
];

export function FactoryProviderSetting() {
  const { settings, updateSettings } = useSettings();

  const currentValue =
    (settings?.factoryProvider as "openai" | "anthropic" | "google") ??
    "openai";
  const currentOption =
    OPTIONS.find((o) => o.value === currentValue) ?? OPTIONS[0];

  const handleChange = (value: string) => {
    updateSettings({
      factoryProvider: value as "openai" | "anthropic" | "google",
    });
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-4">
        <Label
          htmlFor="factory-provider"
          className="text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Factory AI Provider
        </Label>
        <Select
          value={currentValue}
          onValueChange={(v) => v && handleChange(v)}
        >
          <SelectTrigger className="w-[240px]" id="factory-provider">
            <SelectValue placeholder="Select provider" />
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
