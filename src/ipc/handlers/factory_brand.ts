/**
 * factory_brand.ts — PR #7 brand/design-system utilities.
 *
 * Pure, Node-only functions that generate brand CSS for scaffolded apps.
 * No Electron imports — safe to unit-test without the Electron binary.
 */

// =============================================================================
// hexToHsl
// =============================================================================

/** HSL components (integer-rounded). */
export type HslComponents = { h: number; s: number; l: number };

/**
 * Convert a 3- or 6-digit hex color string (with or without leading `#`) to
 * HSL integer components.
 *
 * @throws {Error} when the input is not a valid hex color.
 */
export function hexToHsl(hex: string): HslComponents {
  const clean = hex.replace(/^#/, "");

  // Expand 3-digit shorthand (e.g. "f0a" → "ff00aa")
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;

  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Invalid hex color: "${hex}"`);
  }

  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l: Math.round(l * 100) };
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h: number;
  if (max === r) {
    h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  } else if (max === g) {
    h = ((b - r) / d + 2) / 6;
  } else {
    h = ((r - g) / d + 4) / 6;
  }

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

// =============================================================================
// buildBrandCss
// =============================================================================

// Lightness threshold below which the primary is considered "dark" and we pair
// it with a near-white foreground; at or above this threshold we pair with a
// near-black foreground to maintain WCAG AA contrast.
const LIGHT_DARK_THRESHOLD = 60;

// Shadcn near-white and near-black token values (reused for foreground pairing)
const NEAR_WHITE = "210 40% 98%";
const NEAR_BLACK = "222 47% 11%";

// Dark-mode primary lightness: we lift the primary lightness to stay visible
// on dark-mode backgrounds.  The floor of 55 ensures a mid-range primary is
// still legible; the +20 boost is a comfortable starting offset; the cap of 85
// avoids washing out to near-white.
const MIN_DARK_LIGHTNESS = 55;
const LIGHTNESS_BOOST = 20;
const MAX_DARK_LIGHTNESS = 85;

/**
 * Build the complete `brand.css` content to write into a scaffolded app.
 *
 * The generated file overrides only the primary/ring/font CSS custom properties
 * so it cascades cleanly on top of the Shadcn `globals.css` defaults.
 *
 * Light-mode foreground: near-white for dark primaries (l < LIGHT_DARK_THRESHOLD),
 *   near-black for light primaries.
 * Dark-mode primary: lightness clamped to MAX_DARK_LIGHTNESS for contrast on
 *   dark backgrounds; foreground always near-black.
 *
 * @param primaryHex 3- or 6-digit hex color (with or without `#`), e.g. `"#4F46E5"` or `"#f0a"`.
 */
export function buildBrandCss(primaryHex: string): string {
  const { h, s, l } = hexToHsl(primaryHex);

  // Light-mode foreground: use white for dark primaries, dark for light ones
  const lightFg = l < LIGHT_DARK_THRESHOLD ? NEAR_WHITE : NEAR_BLACK;

  // Dark-mode: raise lightness so the color stays visible on dark backgrounds
  const darkL = Math.min(
    Math.max(l, MIN_DARK_LIGHTNESS) + LIGHTNESS_BOOST,
    MAX_DARK_LIGHTNESS,
  );
  const darkFg = NEAR_BLACK;

  return [
    "/* DYAD:BRAND_CSS — written by factory:scaffoldApp codemod (PR #7); do not edit manually */",
    "@layer base {",
    "  :root {",
    `    --primary: ${h} ${s}% ${l}%;`,
    `    --primary-foreground: ${lightFg};`,
    `    --ring: ${h} ${s}% ${l}%;`,
    "  }",
    "  .dark {",
    `    --primary: ${h} ${s}% ${darkL}%;`,
    `    --primary-foreground: ${darkFg};`,
    `    --ring: ${h} ${s}% ${darkL}%;`,
    "  }",
    "}",
    "",
  ].join("\n");
}
