/**
 * Classified application errors for IPC/main-process code.
 * Use {@link DyadError} with a {@link DyadErrorKind} so telemetry can ignore
 * high-volume, non-actionable failures (see `shouldFilterTelemetryException`).
 */

export enum DyadErrorKind {
  Validation = "validation",
  NotFound = "not_found",
  Auth = "auth",
  Precondition = "precondition",
  Conflict = "conflict",
  UserCancelled = "user_cancelled",
  RateLimited = "rate_limited",
  /** Upstream failures; reported to PostHog by default unless you add finer metadata later. */
  External = "external",
  /** Bugs, invariant violations, unexpected failures — always reported. */
  Internal = "internal",
  /** Unclassified; treated as reportable until call sites are migrated. */
  Unknown = "unknown",
  // === Factory-specific kinds ===
  /** OpenAI API key is absent or empty. */
  MissingApiKey = "missing_api_key",
  /** OpenAI request timed out or was aborted. */
  OpenAiTimeout = "openai_timeout",
  /** OpenAI returned HTTP 429 (rate-limited / quota exceeded). */
  OpenAiRateLimit = "openai_rate_limit",
  /** Anthropic request timed out or was aborted. */
  AnthropicTimeout = "anthropic_timeout",
  /** Anthropic returned HTTP 429 (rate-limited / quota exceeded). */
  AnthropicRateLimit = "anthropic_rate_limit",
  /** Google AI request timed out or was aborted. */
  GoogleTimeout = "google_timeout",
  /** Google AI returned HTTP 429 (rate-limited / quota exceeded). */
  GoogleRateLimit = "google_rate_limit",
  /** LLM output could not be parsed or failed schema validation. */
  InvalidLlmResponse = "invalid_llm_response",
  /** Factory persistence read/write failure. */
  FactoryPersistenceFailure = "factory_persistence_failure",
  /** Idea score is below the configured quality-gate threshold; not persisted. */
  QualityGateRejection = "quality_gate_rejection",
  /** factory:scaffoldApp failed to copy template, run codemods, or build. */
  ScaffoldFailure = "scaffold_failure",
  /** factory:generateLaunchKit failed to generate or export launch assets. */
  LaunchKitFailure = "launch_kit_failure",
  /** factory:deployApp failed to deploy to Vercel or Netlify. */
  DeployFailure = "deploy_failure",
  /** factory:ingest-payments failed to fetch or insert payment data. */
  PaymentIngestFailure = "payment_ingest_failure",
  /** factory:ingest-analytics failed to fetch or insert analytics data. */
  AnalyticsIngestFailure = "analytics_ingest_failure",
}

const TELEMETRY_FILTERED_KINDS: ReadonlySet<DyadErrorKind> = new Set([
  DyadErrorKind.Validation,
  DyadErrorKind.NotFound,
  DyadErrorKind.Auth,
  DyadErrorKind.Precondition,
  DyadErrorKind.Conflict,
  DyadErrorKind.UserCancelled,
  DyadErrorKind.RateLimited,
  // Factory-specific: these are expected non-bug conditions
  DyadErrorKind.MissingApiKey,
  DyadErrorKind.OpenAiRateLimit,
  DyadErrorKind.AnthropicRateLimit,
  DyadErrorKind.GoogleRateLimit,
  DyadErrorKind.InvalidLlmResponse,
  DyadErrorKind.QualityGateRejection,
  // Scaffold failures are user-visible build errors, not bugs — exclude from PostHog
  DyadErrorKind.ScaffoldFailure,
  // Launch-kit generation/export errors are user-visible, not bugs
  DyadErrorKind.LaunchKitFailure,
  // Deploy failures are user-visible (bad token, quota, network), not bugs
  DyadErrorKind.DeployFailure,
  // Payment ingest failures are user-visible (bad key, quota, network), not bugs
  DyadErrorKind.PaymentIngestFailure,
  // Analytics ingest failures are user-visible (bad key, site not found, network), not bugs
  DyadErrorKind.AnalyticsIngestFailure,
]);

/**
 * Returns true if this kind should not be sent to PostHog as an `$exception` event.
 */
export function isDyadErrorKindFilteredFromTelemetry(
  kind: DyadErrorKind,
): boolean {
  return TELEMETRY_FILTERED_KINDS.has(kind);
}

export class DyadError extends Error {
  readonly kind: DyadErrorKind;

  constructor(message: string, kind: DyadErrorKind) {
    super(message);
    this.name = "DyadError";
    this.kind = kind;
  }
}

export function isDyadError(error: unknown): error is DyadError {
  return error instanceof DyadError;
}
