// @vitest-environment node
/**
 * embeddings.test.ts
 *
 * Unit tests for pure embedding math utilities in
 * src/core/factory/embeddings.ts — no Electron, no DB, no API calls.
 */

import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  computeNoveltyScore,
  serializeEmbedding,
  deserializeEmbedding,
} from "@/core/factory/embeddings";

// =============================================================================
// cosineSimilarity
// =============================================================================

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [0.1, 0.2, 0.3, 0.4];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
  });

  it("returns ~0.5 for 60-degree angle", () => {
    // cos(60°) = 0.5; vectors [1,0] and [0.5, sqrt(3)/2] are 60° apart
    const a = [1, 0];
    const b = [0.5, Math.sqrt(3) / 2];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.5, 5);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for zero-magnitude vector", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("clamps negative dot products to 0", () => {
    // Opposite vectors should give 0, not -1 (we clamp to [0,1])
    const result = cosineSimilarity([1, 0], [-1, 0]);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it("handles normalised unit vectors correctly", () => {
    const a = [1 / Math.sqrt(2), 1 / Math.sqrt(2)];
    const b = [1 / Math.sqrt(2), 1 / Math.sqrt(2)];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });
});

// =============================================================================
// computeNoveltyScore
// =============================================================================

describe("computeNoveltyScore", () => {
  it("returns 1.0 when there are no stored embeddings", () => {
    expect(computeNoveltyScore([1, 0, 0], [])).toBe(1.0);
  });

  it("returns 0 when the new vector is identical to a stored one", () => {
    const v = [0.6, 0.8];
    expect(computeNoveltyScore(v, [v])).toBeCloseTo(0, 5);
  });

  it("returns value close to 1 for a very different vector", () => {
    const stored = [[1, 0, 0]];
    const newVec = [0, 1, 0]; // orthogonal → similarity 0 → novelty 1
    expect(computeNoveltyScore(newVec, stored)).toBeCloseTo(1.0, 5);
  });

  it("uses the maximum similarity across all stored vectors", () => {
    const newVec = [1, 0];
    const stored = [
      [0, 1], // sim = 0
      [1, 0], // sim = 1
    ];
    // max similarity is 1, so noveltyScore = 0
    expect(computeNoveltyScore(newVec, stored)).toBeCloseTo(0, 5);
  });

  it("returns a value in [0, 1]", () => {
    const newVec = [0.5, 0.5, 0.7071];
    const stored = [
      [0.1, 0.2, 0.3],
      [0.9, 0.1, 0.0],
    ];
    const score = computeNoveltyScore(newVec, stored);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// serializeEmbedding / deserializeEmbedding
// =============================================================================

describe("serializeEmbedding / deserializeEmbedding", () => {
  it("round-trips a vector unchanged", () => {
    const v = [0.12345678, -0.9876543, 0.0, 1.0];
    const serialized = serializeEmbedding(v);
    const recovered = deserializeEmbedding(serialized);
    expect(recovered).toHaveLength(v.length);
    v.forEach((x, i) => expect(recovered[i]).toBeCloseTo(x, 7));
  });

  it("returns empty array for invalid JSON", () => {
    expect(deserializeEmbedding("not-json")).toEqual([]);
  });

  it("returns empty array for non-array JSON", () => {
    expect(deserializeEmbedding('{"foo":1}')).toEqual([]);
  });

  it("returns empty array when the array contains non-finite values", () => {
    expect(deserializeEmbedding(JSON.stringify([1, Infinity, 3]))).toEqual([]);
    expect(deserializeEmbedding(JSON.stringify([1, NaN, 3]))).toEqual([]);
    expect(deserializeEmbedding(JSON.stringify([1, -Infinity, 3]))).toEqual([]);
  });

  it("returns empty array when the array contains non-number values", () => {
    expect(deserializeEmbedding(JSON.stringify([1, "two", 3]))).toEqual([]);
    expect(deserializeEmbedding(JSON.stringify([1, null, 3]))).toEqual([]);
  });

  it("serialises to a valid JSON string", () => {
    const v = [1, 2, 3];
    const s = serializeEmbedding(v);
    expect(() => JSON.parse(s)).not.toThrow();
    expect(JSON.parse(s)).toEqual(v);
  });
});
