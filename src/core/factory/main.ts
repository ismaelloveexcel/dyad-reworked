/**
 * @dyad/factory-core — main-process entrypoint
 *
 * Exports prompt templates, parsing helpers, persistence utilities, and
 * embedding-based similarity helpers.
 * These modules are safe to import from the Electron main process and from
 * unit tests, but should NOT be imported directly by renderer code because
 * they pull in large prompt strings that inflate the renderer bundle.
 *
 * Renderer code should use `@/core/factory` (the renderer-safe barrel) or
 * the specific submodule imports instead.
 */

export * from "./expand";
export * from "./persist";
export * from "./embeddings";
