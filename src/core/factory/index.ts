/**
 * @dyad/factory-core — renderer-safe barrel
 *
 * Only exports modules that are safe to load in the renderer process
 * (types, localStorage helpers, pattern extraction).
 *
 * Main-process-only concerns (prompt templates, portfolio parsing, DB
 * fingerprinting) live in `@/core/factory/main` to keep the renderer bundle
 * lean and the dependency boundary explicit.
 */

export * from "./types";
export * from "./storage";
export * from "./patterns";
