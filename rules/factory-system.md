# Factory System Rules

Rules for extending or modifying the Factory V3 idea-evaluation engine.

---

## IPC Channels (as of v3.2)

| Channel                         | Contract Key          | Direction       | Purpose                                                                              |
| ------------------------------- | --------------------- | --------------- | ------------------------------------------------------------------------------------ |
| `factory:evaluate-idea`         | `evaluateIdea`        | renderer → main | Score a single idea text via GPT-4o                                                  |
| `factory:generate-ideas`        | `generateIdeas`       | renderer → main | Batch-generate 10 ideas (niche, mode)                                                |
| `factory:generate-portfolio`    | `generatePortfolio`   | renderer → main | Generate a portfolio of ideas with pattern context                                   |
| `factory:save-run`              | `saveRun`             | renderer → main | Persist an idea to SQLite; returns `{id, duplicate}`                                 |
| `factory:list-runs`             | `listRuns`            | renderer → main | List persisted runs, injecting `runId/runStatus/evaluatedAt`                         |
| `factory:delete-run`            | `deleteRun`           | renderer → main | Delete a single run by `id`                                                          |
| `factory:clear-runs`            | `clearRuns`           | renderer → main | Delete all runs                                                                      |
| `factory:update-run-status`     | `updateRunStatus`     | renderer → main | Change the `status` column of a run                                                  |
| `factory:export-runs`           | `exportRuns`          | renderer → main | Save runs to a JSON file via Electron `dialog.showSaveDialog`                        |
| `factory:update-launch-outcome` | `updateLaunchOutcome` | renderer → main | Record launch result and persist to both `ideaJson` blob and `launch_outcome` column |
| `factory:deploy-app`            | `deployApp`           | renderer → main | Deploy scaffolded dist/ to Vercel or Netlify; returns `{ url, provider }`            |
| `factory:save-netlify-token`    | `saveNetlifyToken`    | renderer → main | Validate and save Netlify personal-access token to encrypted settings                |

All contracts are defined in `src/ipc/types/factory.ts`. The client is auto-generated via `createClient(factoryContracts)`.

---

## Validation System

- All idea validation is done in `src/ipc/handlers/factory_validator.ts` (pure, Node-only, no Electron).
- `validateIdeaResult(raw, idea)` — parses LLM JSON, validates against `IdeaEvaluationResultSchema`, enriches with all derived fields.
- `deterministicFallback(idea)` — deterministic scoring when AI is unavailable; always sets `fallbackUsed: true`.
- `safeParseLlmJson(raw)` — strips markdown fences, parses JSON safely.
- Tests are in `src/__tests__/factory_validator.test.ts` with `// @vitest-environment node`.
- **Do not import Electron APIs** in `factory_validator.ts` — it must remain Node-only for unit testing.

---

## Persistence Model

Database table: `factory_runs` (SQLite via Drizzle ORM)

| Column           | Type                            | Notes                                                               |
| ---------------- | ------------------------------- | ------------------------------------------------------------------- |
| `id`             | INTEGER PK autoincrement        | Run identifier                                                      |
| `idea_json`      | TEXT NOT NULL                   | Full `IdeaEvaluationResult` blob (JSON)                             |
| `status`         | TEXT NOT NULL DEFAULT 'DECIDED' | One of: `DECIDED / QUEUED / IN_PROGRESS / LAUNCHED / KILLED`        |
| `fingerprint`    | TEXT                            | Deduplication key: `stableHash(name+buyer+idea[:200])`              |
| `launch_outcome` | TEXT                            | JSON blob of `LaunchOutcome` object                                 |
| `prompt_version` | TEXT                            | Prompt version string (e.g. `"v3.2"`)                               |
| `prompt_hash`    | TEXT                            | `stableHash(EVALUATE_PROMPT + GENERATE_PROMPT)` for drift detection |
| `created_at`     | INTEGER timestamp               | Defaults to `unixepoch()`                                           |

**IMPORTANT**: When saving an idea, always call `saveRun` from the renderer. Never write to `factory_runs` directly from the renderer — only the main process has DB access.

### Deduplication (E1)

`saveRun` computes a fingerprint and checks for an existing row before inserting. If a duplicate is found, it returns `{ id, duplicate: existingIdea }` without inserting. The UI shows a non-blocking warning banner.

### runId injection (E2)

`listRuns` injects `runId`, `runStatus`, and `evaluatedAt` from DB columns into each deserialized result. These fields are **not** stored in `ideaJson` (they come from dedicated columns).

---

## Prompt Versioning (E4)

- `PROMPT_VERSION = "v3.2"` is defined in `factory_handlers.ts`.
- `CURRENT_PROMPT_HASH` is computed lazily from the concatenated evaluate+generate prompt templates.
- Every result returned by `evaluateIdea`, `generateIdeas`, and `generatePortfolio` is passed through `enrichResult()` which adds `promptVersion` and `promptHash`.
- When saving a run, the handler stores these values in the dedicated `prompt_version` and `prompt_hash` columns.
- **When changing prompts**, bump `PROMPT_VERSION` (e.g. `v3.2` → `v3.3`). `CURRENT_PROMPT_HASH` updates automatically.

---

## Retry Logic (E5)

`callWithRetry(prompt)` wraps `callOpenAI(prompt)` with 3 attempts:

- Retries only on `OpenAiRateLimit` (429/503) and `OpenAiTimeout` (AbortError).
- Delays: 1 s → 3 s → 9 s (exponential backoff).
- Does **not** retry on 400/401 (bad request / auth), or `InvalidLlmResponse`.

---

## Pattern Engine (E3/E7)

`extractPatterns()` in `factory.tsx` builds a `PatternEntry[]` from history + pipeline + traction.

- Respects `runStatus` from DB: `LAUNCHED` → `"launched"`, `KILLED` → `"killed"`.
- Respects `launchOutcome` from DB: sets `revenue` from `revenueGenerated`.
- **Weighting**: entries where `status === "launched"` AND `revenue > 0` are appended **3× total** to the pattern array, reinforcing winning patterns in portfolio generation.

---

## Error Handling

All factory errors must use `DyadError` with one of these kinds:

- `DyadErrorKind.MissingApiKey` — no OPENAI_API_KEY configured.
- `DyadErrorKind.OpenAiTimeout` — AbortError from fetch.
- `DyadErrorKind.OpenAiRateLimit` — HTTP 429 or 503.
- `DyadErrorKind.InvalidLlmResponse` — empty or unparseable LLM response.
- `DyadErrorKind.FactoryPersistenceFailure` — any SQLite/Drizzle error.

---

## How to Extend

### Adding a new IPC handler

1. Add Zod input/output schemas + `defineContract(...)` to `src/ipc/types/factory.ts`.
2. Add the contract to `factoryContracts`.
3. Implement `createTypedHandler(factoryContracts.newChannel, async (event, input) => { ... })` inside `registerFactoryHandlers()` in `factory_handlers.ts`.
4. The renderer client picks it up automatically from `createClient(factoryContracts)`.

### Adding a new DB column

1. Write a new `drizzle/XXXX_description.sql` with `ALTER TABLE` statements.
2. Add the entry to `drizzle/meta/_journal.json` with the correct `idx` (next in sequence).
3. Update `src/db/schema.ts` to match.
4. Run `npm run ts` to verify no type errors.

### Adding a new score dimension

1. Add the field to `IdeaScoresSchema` in `src/ipc/types/factory.ts`.
2. Update `validateIdeaResult` in `factory_validator.ts` to read + clamp the new field.
3. Update `deterministicFallback` to produce a value for it.
4. Update `totalScore` calculation if needed.
5. Add a test to `src/__tests__/factory_validator.test.ts`.

---

## Brand / Design System (PR #7)

The scaffold template (`scaffold/`) ships a brand design system that the scaffolder codemod injects at build time.

### Key files

| File                                  | Role                                                           |
| ------------------------------------- | -------------------------------------------------------------- |
| `scaffold/src/brand.css`              | Default brand CSS custom properties (overridden by codemod)    |
| `scaffold/src/main.tsx`               | Imports `brand.css` after `globals.css` so it cascades cleanly |
| `scaffold/tailwind.config.ts`         | `fontFamily.sans` preset (Inter + system stack)                |
| `src/ipc/handlers/factory_brand.ts`   | Pure utilities: `hexToHsl()`, `buildBrandCss()`                |
| `src/__tests__/factory_brand.test.ts` | Unit tests for brand utilities                                 |

### How the brand codemod works

`factory:scaffold-app` accepts an optional `primaryColor` hex string. After the Index.tsx codemod, the handler calls `buildBrandCss(primaryColor)` and writes the result to `<destDir>/src/brand.css`. This overrides only `--primary`, `--primary-foreground`, and `--ring` so the rest of Shadcn's design tokens remain intact.

### Extending the brand system

- Add new CSS custom properties to both the scaffold default `brand.css` and the `buildBrandCss()` generator in `factory_brand.ts`.
- Add new palette presets to `BRAND_PALETTES` in `src/pages/factory.tsx`.
- Always add a test to `src/__tests__/factory_brand.test.ts` for new brand utilities.
- `hexToHsl()` and `buildBrandCss()` must remain **pure and Node-only** — no Electron imports.

---

## One-click Deploy (PR #11)

`factory:deploy-app` deploys the scaffolded Vite app's `dist/` directory to Vercel or Netlify using their respective REST APIs (no CLI required).

| Provider | Token setting        | API base                         | Mechanism                                     |
| -------- | -------------------- | -------------------------------- | --------------------------------------------- |
| Vercel   | `vercelAccessToken`  | `https://api.vercel.com`         | `POST /v13/deployments` with inline file data |
| Netlify  | `netlifyAccessToken` | `https://api.netlify.com/api/v1` | SHA1 digest deploy + per-file PUT uploads     |

- Vercel token is already used by the main Dyad deployment flow and lives in `settings.vercelAccessToken`.
- Netlify token can be saved via `factory:save-netlify-token` (validated against `/api/v1/user`) and lives in `settings.netlifyAccessToken`.
- Both tokens are encrypted at rest via `safeStorage`.
- Deploy errors use `DyadErrorKind.DeployFailure` (excluded from PostHog telemetry).
- The handler derives the slug from the run's idea name (same algorithm as `scaffoldApp`) and looks for `userData/factory-apps/<slug>/dist/`. Returns `DyadErrorKind.DeployFailure` if `dist/` is not found.

---

- Unit tests: `npx vitest run src/__tests__/factory_validator.test.ts`
- Smoke test (Node-only): `npm run smoke`
- Brand tests: `npx vitest run src/__tests__/factory_brand.test.ts`
- Must always have `// @vitest-environment node` at top of test files touching factory validators.

---

## Security Notes

- OpenAI API key is read from `process.env.OPENAI_API_KEY` in the main process. Never pass it to the renderer.
- `safeParseLlmJson` strips markdown fences and limits parse attempts to prevent DoS via large payloads.
- All user-supplied `idea` strings are truncated to 2000 chars before being sent to the prompt.

---

## Launch Kit Generator (PR #10)

Generates structured launch assets (elevator pitch, social posts, landing-page copy, cold-email body, deploy checklist) for a BUILD idea that has been persisted to the database.

### IPC surface

| Channel                       | Input                               | Output             |
| ----------------------------- | ----------------------------------- | ------------------ |
| `factory:generate-launch-kit` | `{ runId: number }`                 | `LaunchKit`        |
| `factory:export-launch-kit`   | `{ runId: number; kit: LaunchKit }` | `{ path: string }` |

`LaunchKit` is defined in `src/ipc/types/factory.ts` (`LaunchKitSchema`).  
`factory:export-launch-kit` writes Markdown files to `userData/factory-apps/<slug>/launch-kit/` and returns the directory path.

### Error handling

- `DyadErrorKind.LaunchKitFailure` (`"launch_kit_failure"`) — thrown when the LLM call itself fails. Filtered from PostHog telemetry.
- `DyadErrorKind.InvalidLlmResponse` — thrown when the LLM response cannot be parsed as valid JSON or fails schema validation.
- `DyadErrorKind.NotFound` — thrown when the requested `runId` does not exist in `factory_runs`.

### UI integration

`LaunchKitSection` in `src/pages/factory.tsx` is rendered inside `IdeaCard` for BUILD ideas that have a `runId > 0`. It uses `useMutation` (not `useQuery`) because generation is an explicit user action.

### Mock-isolation note for tests

The `factory:list-outcomes` tests override `db.select` with a `callCount`-based implementation via `vi.mocked(db.select).mockImplementation(...)`. Because `vi.clearAllMocks()` only resets call history (not the implementation), subsequent test suites that need the standard `mockDbState`-based chain must restore it in a nested `beforeEach` — see `describe("factory:generate-launch-kit")` in `factory_handlers.test.ts`.
