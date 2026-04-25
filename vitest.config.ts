import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    globals: true,
    onConsoleLog(log, _type) {
      // Suppress known noisy logs while allowing useful debugging output
      const noisyPatterns = [
        // Retry/flakiness logs from test utilities
        /retry.*attempt/i,
        /retrying/i,
        // Settings-related noise during test setup
        /failed to.*settings/i,
        /settings.*error/i,
        // Processor warnings that don't indicate real issues
        /processor.*warning/i,
        // Known test fixture console outputs (not real errors)
        /\[test\]/i,
      ];

      for (const pattern of noisyPatterns) {
        if (pattern.test(log)) {
          return false;
        }
      }
      // Allow all other console output (including errors) for debugging
    },
    coverage: {
      provider: "v8",
      include: [
        "src/ipc/handlers/factory_handlers.ts",
        "src/pages/factory.tsx",
      ],
      thresholds: {
        // factory_handlers.ts is covered by factory_handlers.test.ts
        "src/ipc/handlers/factory_handlers.ts": {
          lines: 55,
          branches: 40,
          functions: 65,
        },
        // factory.tsx is a React page; coverage is primarily from E2E tests.
        // The unit threshold is intentionally low — raise it as component
        // tests are added in later PRs.
        "src/pages/factory.tsx": {
          lines: 5,
          branches: 5,
          functions: 5,
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
});
