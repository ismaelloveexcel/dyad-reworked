/**
 * factory_embeddings.ts
 *
 * Main-process-only: fetches an embedding vector from OpenAI
 * text-embedding-3-small for the given text.
 *
 * Respects OPENAI_BASE_URL (same normalisation as factory_handlers.ts) so
 * tests can point at the fake-llm-server or a local stub.
 *
 * Do NOT import Electron APIs here — this module must remain unit-testable
 * with only Node.js globals.
 */

import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

// Normalize base URL (strip trailing /v1 or /v1/) same as factory_handlers.ts.
const OPENAI_EMBEDDINGS_URL = (() => {
  const base = process.env.OPENAI_BASE_URL;
  if (!base) return "https://api.openai.com/v1/embeddings";
  const normalized = base.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  return `${normalized}/v1/embeddings`;
})();

/** Pinned embedding model — text-embedding-3-small produces 1536-dim vectors. */
export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

/** Request timeout in milliseconds; prevents indefinite hangs in saveRun/getSimilarRuns. */
const EMBEDDING_TIMEOUT_MS = 15_000;

/**
 * Fetch an embedding vector for `text` from OpenAI text-embedding-3-small.
 * The returned vector has 1536 dimensions.
 * Throws a DyadError if the API key is missing, the request times out, or the
 * request fails / returns an invalid response.
 */
export async function fetchEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new DyadError(
      "OPENAI_API_KEY is not set. Embedding-based dedup requires an OpenAI key.",
      DyadErrorKind.MissingApiKey,
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_EMBEDDING_MODEL,
        input: text.slice(0, 8000), // token safety cap
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    throw new DyadError(
      isAbort
        ? `OpenAI embeddings request timed out after ${EMBEDDING_TIMEOUT_MS / 1000} s.`
        : `Network error calling OpenAI embeddings: ${err instanceof Error ? err.message : String(err)}`,
      isAbort ? DyadErrorKind.OpenAiTimeout : DyadErrorKind.External,
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new DyadError(
      `OpenAI embeddings error ${response.status}: ${body.slice(0, 200)}`,
      DyadErrorKind.External,
    );
  }

  try {
    const data = (await response.json()) as unknown;
    if (
      !data ||
      typeof data !== "object" ||
      !("data" in data) ||
      !Array.isArray((data as { data: unknown }).data) ||
      (data as { data: unknown[] }).data.length === 0
    ) {
      throw new DyadError(
        "OpenAI embeddings returned an invalid response shape.",
        DyadErrorKind.InvalidLlmResponse,
      );
    }
    const first = (data as { data: unknown[] }).data[0];
    if (
      !first ||
      typeof first !== "object" ||
      !("embedding" in first) ||
      !Array.isArray((first as { embedding: unknown }).embedding)
    ) {
      throw new DyadError(
        "OpenAI embeddings returned an invalid response shape.",
        DyadErrorKind.InvalidLlmResponse,
      );
    }
    const vec = (first as { embedding: unknown[] }).embedding;
    if (
      vec.length === 0 ||
      !vec.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      throw new DyadError(
        "OpenAI embeddings returned an invalid embedding vector.",
        DyadErrorKind.InvalidLlmResponse,
      );
    }
    return vec as number[];
  } catch (err) {
    if (err instanceof DyadError) throw err;
    throw new DyadError(
      `OpenAI embeddings returned invalid JSON or an unexpected response: ${err instanceof Error ? err.message : String(err)}`,
      DyadErrorKind.InvalidLlmResponse,
    );
  }
}
