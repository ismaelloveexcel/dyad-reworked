/**
 * embeddings.ts
 *
 * Pure, Node-only utilities for embedding-based similarity.
 * No Electron, no DB, no API calls — safe for unit testing.
 *
 * The actual OpenAI embeddings API call lives in factory_embeddings.ts
 * (main-process only) so that the API key never touches the renderer.
 */

// =============================================================================
// Cosine similarity
// =============================================================================

/**
 * Compute cosine similarity between two equal-length vectors.
 * Returns a value in [0, 1] (1 = identical direction, 0 = orthogonal).
 * Returns 0 if either vector is empty or lengths differ.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return Math.max(0, Math.min(1, dot / denom));
}

// =============================================================================
// Novelty score — 1 minus max cosine similarity against stored embeddings
// =============================================================================

/**
 * Compute novelty score for a new embedding relative to all stored embeddings.
 * Returns 1.0 (fully novel) when no stored embeddings exist.
 * Returns a value in [0, 1]: higher = more novel, lower = more similar to
 * existing ideas.
 */
export function computeNoveltyScore(
  newVec: number[],
  stored: number[][],
): number {
  if (stored.length === 0) return 1.0;
  let maxSimilarity = 0;
  for (const vec of stored) {
    const sim = cosineSimilarity(newVec, vec);
    if (sim > maxSimilarity) maxSimilarity = sim;
  }
  return Math.max(0, 1 - maxSimilarity);
}

// =============================================================================
// Serialisation helpers — store embeddings as JSON text in SQLite
// =============================================================================

export function serializeEmbedding(v: number[]): string {
  return JSON.stringify(v);
}

export function deserializeEmbedding(s: string): number[] {
  try {
    const parsed: unknown = JSON.parse(s);
    if (!Array.isArray(parsed)) return [];
    if (
      !parsed.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
    ) {
      return [];
    }
    return parsed as number[];
  } catch {
    return [];
  }
}
