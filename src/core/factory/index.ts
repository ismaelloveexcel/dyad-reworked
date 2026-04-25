/**
 * @dyad/factory-core
 *
 * Barrel export for the headless Factory business logic package.
 * All modules are pure (no Electron, no DB) and safe to import from
 * renderer code, unit tests, and the main-process handlers.
 */

export * from "./types";
export * from "./storage";
export * from "./patterns";
export * from "./expand";
export * from "./persist";
