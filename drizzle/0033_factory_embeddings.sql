-- PR #9 — Embedding-based novelty / dedup
-- Stores the serialised text-embedding-3-small vector (JSON float array)
-- alongside each factory run so that saveRun can compute cosine similarity
-- against existing rows and attach a noveltyScore to each new idea.
ALTER TABLE `factory_runs` ADD `embedding` text;
