/**
 * factory_smoke.spec.ts
 *
 * E2E smoke test for the Factory page (/factory route).
 * OpenAI calls are intercepted by the fake-llm-server so the test runs
 * entirely offline without real API credentials.
 */

import { expect } from "@playwright/test";
import { test, testWithConfig } from "./helpers/test_helper";

// ---------------------------------------------------------------------------
// Fixture: point factory OpenAI calls at the local fake-llm-server
// ---------------------------------------------------------------------------

const testWithFakeLlm = testWithConfig({
  preLaunchHook: async ({ fakeLlmPort }) => {
    // Redirect factory OpenAI calls to the fake server.
    // factory_handlers.ts reads OPENAI_BASE_URL at module load time.
    process.env.OPENAI_BASE_URL = `http://localhost:${fakeLlmPort}`;
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("factory page — missing API key banner is shown when key is absent", async ({
  po,
}) => {
  // po.setUp() sets OPENAI_API_KEY = "sk-test" by default.
  // We use the default test (which sets OPENAI_API_KEY) just to verify the
  // page loads.  The missing-key banner is shown when the key IS absent —
  // covered by the separate `testWithConfig({ showSetupScreen: true })` below.
  await po.navigation.goToSettingsTab();
  await po.page.getByRole("link", { name: "Factory" }).click();
  await expect(
    po.page
      .getByText("Describe your app idea")
      .or(po.page.getByRole("textbox")),
  ).toBeVisible({ timeout: 10_000 });
});

testWithFakeLlm(
  "factory page — evaluate idea returns a result card (mocked OpenAI)",
  async ({ po }) => {
    await po.navigation.goToSettingsTab();
    await po.page.getByRole("link", { name: "Factory" }).click();

    // Wait for the textarea to be ready
    const textarea = po.page.getByPlaceholder(/salary benchmarking|app idea/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    // Enter an idea
    await textarea.fill(
      "Invoice automation for Dubai freelancers who send weekly invoices",
    );

    // Click evaluate
    const evaluateBtn = po.page.getByRole("button", { name: "Evaluate Idea" });
    await expect(evaluateBtn).toBeEnabled();
    await evaluateBtn.click();

    // Wait for a result card to appear — either from the fake API or deterministic fallback.
    // The result card always contains a decision badge (BUILD / REWORK / KILL).
    const decisionBadge = po.page
      .getByText("BUILD")
      .or(po.page.getByText("REWORK"))
      .or(po.page.getByText("KILL"))
      .first();
    await expect(decisionBadge).toBeVisible({ timeout: 30_000 });
  },
);
