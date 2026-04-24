/**
 * safe_local_storage.ts
 *
 * A typed, defensive localStorage wrapper that:
 * - Wraps all reads in try/catch JSON.parse
 * - Runs a validator before returning
 * - Clears the key on parse or validation failure
 * - Enforces a maximum item count per key (trims oldest on overflow)
 * - Surfaces a visible warning when data is reset
 *
 * Use for pipeline and traction data in Factory (non-DB persistence).
 */

const MAX_ITEMS_PER_KEY = 200;

export class SafeLocalStorage {
  /**
   * Read and validate a value from localStorage.
   * Returns null (and clears the key) on parse failure or validation failure.
   */
  static get<T>(key: string, validator: (v: unknown) => v is T): T | null {
    let raw: string | null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return null;
    }

    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(
        `[SafeLocalStorage] Corrupt JSON for key "${key}" — clearing.`,
      );
      SafeLocalStorage._warn(key);
      SafeLocalStorage.clear(key);
      return null;
    }

    if (!validator(parsed)) {
      console.warn(
        `[SafeLocalStorage] Validation failed for key "${key}" — clearing.`,
      );
      SafeLocalStorage._warn(key);
      SafeLocalStorage.clear(key);
      return null;
    }

    return parsed;
  }

  /**
   * Write a value to localStorage.
   * If the value is an array and exceeds MAX_ITEMS_PER_KEY, it is trimmed from
   * the front (oldest items first).
   */
  static set(key: string, value: unknown): void {
    try {
      let toStore = value;
      if (Array.isArray(toStore) && toStore.length > MAX_ITEMS_PER_KEY) {
        toStore = toStore.slice(toStore.length - MAX_ITEMS_PER_KEY);
      }
      localStorage.setItem(key, JSON.stringify(toStore));
    } catch (err) {
      console.warn(`[SafeLocalStorage] Write error for key "${key}":`, err);
    }
  }

  /**
   * Remove a key from localStorage.
   */
  static clear(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  /** Dispatch a visible UI-level warning (shown once per key per session). */
  private static _warned = new Set<string>();
  private static _warn(key: string): void {
    if (SafeLocalStorage._warned.has(key)) return;
    SafeLocalStorage._warned.add(key);
    // Dispatch a custom event that the UI layer can listen to
    try {
      window.dispatchEvent(
        new CustomEvent("safe-local-storage:corruption", {
          detail: {
            key,
            message: "Factory history was reset due to data corruption.",
          },
        }),
      );
    } catch {
      /* non-browser environments (tests) — ignore */
    }
  }
}
