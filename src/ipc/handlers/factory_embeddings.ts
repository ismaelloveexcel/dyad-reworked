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

/**
 * Fetch an embedding vector for `text` from OpenAI text-embedding-3-small.
 * The returned vector has 1536 dimensions.
 * Throws a DyadError if the API key is missing or the request fails.
 */
export async function fetchEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new DyadError(
      "OPENAI_API_KEY is not set. Embedding-based dedup requires an OpenAI key.",
      DyadErrorKind.MissingApiKey,
    );
  }

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
    });
  } catch (err) {
    throw new DyadError(
      `Network error calling OpenAI embeddings: ${err instanceof Error ? err.message : String(err)}`,
      DyadErrorKind.External,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new DyadError(
      `OpenAI embeddings error ${response.status}: ${body.slice(0, 200)}`,
      DyadErrorKind.External,
    );
  }

  const data = (await response.json()) as {
    data: { embedding: number[] }[];
  };
  const vec = data.data?.[0]?.embedding;
  if (!vec || vec.length === 0) {
    throw new DyadError(
      "OpenAI embeddings returned an empty vector.",
      DyadErrorKind.InvalidLlmResponse,
    );
  }
  return vec;
}
